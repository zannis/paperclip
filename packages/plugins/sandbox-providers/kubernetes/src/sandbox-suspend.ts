/**
 * Suspend / resume for Sandbox CRs whose /workspace lives on a PVC.
 *
 * agent-sandbox treats `spec.replicas: 0` as "terminate the backing pod but
 * keep the Sandbox object and its volumes". Stopping an idle lease therefore
 * frees the pod's CPU and memory while the `workspace-<sandbox>` PVC stays,
 * and resuming sets replicas back to 1 for a cold pod on the same volume under
 * the same Sandbox name, so the provider lease id never changes.
 *
 * The server issues stops and resumes from different processes and retries,
 * and a worker keeps running a call the server already timed out. The server
 * therefore numbers every resume claim with an epoch, and both operations are
 * fenced on the CR with a resourceVersion precondition:
 * - stop(e) is refused once a resume with a newer epoch has stamped the CR;
 * - resume(e) is refused once a stop at the same or a newer epoch has landed.
 * A late resume after a re-stop and a stale stop after a newer resume are
 * both no-ops at the provider.
 */

import { PatchStrategy, setHeaderOptions } from "@kubernetes/client-node";
import type { KubeClients } from "./kube-client.js";
import { isKubeNotFoundError } from "./lease-lifecycle.js";
import { findPodForSandbox } from "./sandbox-cr-orchestrator.js";

const SANDBOX_GROUP = "agents.x-k8s.io";
const SANDBOX_VERSION = "v1alpha1";
const SANDBOX_PLURAL = "sandboxes";

export const RESUME_EPOCH_ANNOTATION = "paperclip.ai/resume-epoch";
export const STOP_EPOCH_ANNOTATION = "paperclip.ai/stop-epoch";
/** Uid of the workspace PVC recorded at the first confirmed stop. */
export const WORKSPACE_VOLUME_UID_ANNOTATION = "paperclip.ai/workspace-volume-uid";

const MAX_CONFLICT_RETRIES = 5;

/** A newer resume owns the Sandbox; this stop must not touch it. */
export class SandboxStopSupersededError extends Error {
  readonly code = "sandbox_stop_superseded";
  constructor(name: string, epoch: number, resumeEpoch: number) {
    super(`Stop of Sandbox ${name} at epoch ${epoch} superseded by resume epoch ${resumeEpoch}`);
    this.name = "SandboxStopSupersededError";
  }
}

/** A stop at this or a newer epoch already landed; this resume is stale. */
export class SandboxResumeFencedError extends Error {
  readonly code = "sandbox_resume_fenced";
  constructor(name: string, epoch: number, stopEpoch: number) {
    super(`Resume of Sandbox ${name} at epoch ${epoch} refused: stopped at epoch ${stopEpoch}`);
    this.name = "SandboxResumeFencedError";
  }
}

/**
 * The cold pod did not become Ready in the bounded wait. The message avoids
 * "timeout" wording on purpose: the server retries resume failures that look
 * transient, and repeating a cold start inside one acquisition only stacks
 * pod starts on a slow node.
 */
export class SandboxColdResumeNotReadyError extends Error {
  readonly code = "sandbox_cold_resume_not_ready";
  constructor(name: string, waitedMs: number) {
    super(`Sandbox ${name} pod was not Ready after ${waitedMs}ms of cold start`);
    this.name = "SandboxColdResumeNotReadyError";
  }
}

interface SandboxObject {
  metadata?: {
    generation?: number;
    resourceVersion?: string;
    annotations?: Record<string, string>;
  };
  spec?: { replicas?: number };
  status?: {
    conditions?: Array<{
      type?: string;
      status?: string;
      reason?: string;
      observedGeneration?: number;
    }>;
  };
}

export interface SuspendableSandboxRef {
  namespace: string;
  name: string;
  timeoutMs: number;
  pollMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isConflict(err: unknown): boolean {
  const code = (err as { code?: number; statusCode?: number }).code
    ?? (err as { code?: number; statusCode?: number }).statusCode;
  return code === 409;
}

function readEpoch(cr: SandboxObject, annotation: string): number {
  const raw = cr.metadata?.annotations?.[annotation];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : -1;
}

async function getSandbox(clients: KubeClients, ref: SuspendableSandboxRef): Promise<SandboxObject | null> {
  try {
    return await clients.custom.getNamespacedCustomObject({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace: ref.namespace,
      plural: SANDBOX_PLURAL,
      name: ref.name,
    }) as SandboxObject;
  } catch (err) {
    if (isKubeNotFoundError(err)) return null;
    throw err;
  }
}

async function patchSandbox(
  clients: KubeClients,
  ref: SuspendableSandboxRef,
  body: Record<string, unknown>,
): Promise<SandboxObject> {
  return await clients.custom.patchNamespacedCustomObject(
    {
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace: ref.namespace,
      plural: SANDBOX_PLURAL,
      name: ref.name,
      body,
    },
    setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
  ) as SandboxObject;
}

function conditionAt(
  cr: SandboxObject,
  type: string,
  minGeneration: number,
): { status?: string; reason?: string } | null {
  const condition = (cr.status?.conditions ?? []).find((c) => c.type === type);
  if (!condition) return null;
  if ((condition.observedGeneration ?? -1) < minGeneration) return null;
  return condition;
}

async function readWorkspaceVolumeUid(clients: KubeClients, ref: SuspendableSandboxRef): Promise<string | null> {
  try {
    const pvc = await clients.core.readNamespacedPersistentVolumeClaim({
      namespace: ref.namespace,
      name: `workspace-${ref.name}`,
    }) as { metadata?: { uid?: string } };
    return pvc.metadata?.uid ?? null;
  } catch (err) {
    if (isKubeNotFoundError(err)) return null;
    throw err;
  }
}

/**
 * Apply a fenced patch: read, check the fence, patch with the read
 * resourceVersion as a precondition, and on a conflict start over so the fence
 * is re-checked against the writer that won.
 */
async function fencedPatch(
  clients: KubeClients,
  ref: SuspendableSandboxRef,
  build: (cr: SandboxObject) => Record<string, unknown> | null,
): Promise<{ cr: SandboxObject; patched: SandboxObject | null } | null> {
  for (let attempt = 0; ; attempt += 1) {
    const cr = await getSandbox(clients, ref);
    if (!cr) return null;
    const body = build(cr);
    if (!body) return { cr, patched: null };
    try {
      const patched = await patchSandbox(clients, ref, {
        ...body,
        metadata: {
          ...(body.metadata as Record<string, unknown> | undefined),
          resourceVersion: cr.metadata?.resourceVersion,
        },
      });
      return { cr, patched };
    } catch (err) {
      if (isKubeNotFoundError(err)) return null;
      if (!isConflict(err) || attempt >= MAX_CONFLICT_RETRIES) throw err;
    }
  }
}

/**
 * Suspend the Sandbox and wait until the controller confirms its pod is gone.
 * Returns "destroyed" when the CR no longer exists (nothing left to stop).
 */
export async function stopSuspendableSandbox(
  clients: KubeClients,
  input: SuspendableSandboxRef & { epoch: number },
): Promise<"stopped" | "destroyed"> {
  const result = await fencedPatch(clients, input, (cr) => {
    const resumeEpoch = readEpoch(cr, RESUME_EPOCH_ANNOTATION);
    if (resumeEpoch > input.epoch) {
      throw new SandboxStopSupersededError(input.name, input.epoch, resumeEpoch);
    }
    // Never lower the fence: a stale stop must not re-open it for a resume
    // that a newer stop already refused.
    const stopEpoch = Math.max(readEpoch(cr, STOP_EPOCH_ANNOTATION), input.epoch);
    return {
      metadata: { annotations: { [STOP_EPOCH_ANNOTATION]: String(stopEpoch) } },
      spec: { replicas: 0 },
    };
  });
  if (!result) return "destroyed";
  const targetGeneration = result.patched?.metadata?.generation ?? result.cr.metadata?.generation ?? 0;

  const pollMs = input.pollMs ?? 1_000;
  const deadline = Date.now() + input.timeoutMs;
  let cr: SandboxObject | null = result.patched ?? result.cr;
  while (true) {
    cr = await getSandbox(clients, input);
    if (!cr) return "destroyed";
    // A resume that landed after this stop owns the Sandbox now; a Suspended
    // condition the controller wrote before seeing it is no confirmation.
    const resumeEpoch = readEpoch(cr, RESUME_EPOCH_ANNOTATION);
    if (resumeEpoch > input.epoch) {
      throw new SandboxStopSupersededError(input.name, input.epoch, resumeEpoch);
    }
    const suspended = (cr.spec?.replicas ?? 1) === 0
      ? conditionAt(cr, "Suspended", Math.max(targetGeneration, cr.metadata?.generation ?? 0))
      : null;
    if (suspended?.status === "True" && suspended.reason === "PodTerminated") break;
    if (Date.now() >= deadline) {
      throw new Error(
        `Suspend of Sandbox ${input.namespace}/${input.name} not confirmed at generation ${targetGeneration}`,
      );
    }
    await sleep(pollMs);
  }

  // Record which volume this stop kept, once, so a resume can tell the kept
  // workspace from an empty PVC the controller re-created after a loss.
  if (!cr.metadata?.annotations?.[WORKSPACE_VOLUME_UID_ANNOTATION]) {
    const uid = await readWorkspaceVolumeUid(clients, input);
    if (uid) {
      await patchSandbox(clients, input, {
        metadata: { annotations: { [WORKSPACE_VOLUME_UID_ANNOTATION]: uid } },
      });
    }
  }
  return "stopped";
}

export type SuspendableResumeResult =
  | { outcome: "ready"; podName: string | null; coldStart: boolean }
  | { outcome: "missing" }
  | { outcome: "volume_replaced" };

async function refreshEnvSecret(
  clients: KubeClients,
  input: { namespace: string; secretName: string; adapterEnv: Record<string, string> },
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const current = await clients.core.readNamespacedSecret({
      namespace: input.namespace,
      name: input.secretName,
    }) as { metadata?: Record<string, unknown>; data?: Record<string, string> };
    const bootstrapToken = current.data?.BOOTSTRAP_TOKEN;
    try {
      await clients.core.replaceNamespacedSecret({
        namespace: input.namespace,
        name: input.secretName,
        body: {
          ...current,
          metadata: current.metadata,
          data: bootstrapToken ? { BOOTSTRAP_TOKEN: bootstrapToken } : {},
          stringData: { ...input.adapterEnv },
        },
      });
      return;
    } catch (err) {
      if (!isConflict(err) || attempt >= MAX_CONFLICT_RETRIES) throw err;
    }
  }
}

/**
 * Resume a Sandbox that may be suspended. A suspended Sandbox gets its env
 * Secret rebuilt from the current adapter env (the bootstrap token is kept)
 * before replicas goes back to 1, so the cold pod starts with current values.
 * The pod template itself is never rewritten.
 */
export async function resumeSuspendableSandbox(
  clients: KubeClients,
  input: SuspendableSandboxRef & {
    epoch: number;
    secretName: string;
    adapterEnv: Record<string, string>;
  },
): Promise<SuspendableResumeResult> {
  const initial = await getSandbox(clients, input);
  if (!initial) return { outcome: "missing" };

  const recordedVolumeUid = initial.metadata?.annotations?.[WORKSPACE_VOLUME_UID_ANNOTATION];
  if (recordedVolumeUid) {
    const liveVolumeUid = await readWorkspaceVolumeUid(clients, input);
    if (liveVolumeUid !== recordedVolumeUid) return { outcome: "volume_replaced" };
  }

  const fenceResume = (cr: SandboxObject) => {
    const stopEpoch = readEpoch(cr, STOP_EPOCH_ANNOTATION);
    if (stopEpoch >= input.epoch) {
      throw new SandboxResumeFencedError(input.name, input.epoch, stopEpoch);
    }
    // A newer resume owns the Sandbox; this one is stale.
    const resumeEpoch = readEpoch(cr, RESUME_EPOCH_ANNOTATION);
    if (resumeEpoch > input.epoch) {
      throw new SandboxResumeFencedError(input.name, input.epoch, resumeEpoch);
    }
  };

  // Decide on a cold start from the read the patch is conditioned on, so a
  // stop that lands after the first read still gets a refreshed Secret.
  let refreshed = false;
  let coldStart = false;
  let targetGeneration = 0;
  for (let attempt = 0; ; attempt += 1) {
    const cr = await getSandbox(clients, input);
    if (!cr) return { outcome: "missing" };
    fenceResume(cr);
    const suspended = (cr.spec?.replicas ?? 1) === 0;
    if (suspended && !refreshed) {
      await refreshEnvSecret(clients, {
        namespace: input.namespace,
        secretName: input.secretName,
        adapterEnv: input.adapterEnv,
      });
      refreshed = true;
      continue;
    }
    try {
      const patched = await patchSandbox(clients, input, {
        metadata: {
          annotations: { [RESUME_EPOCH_ANNOTATION]: String(input.epoch) },
          resourceVersion: cr.metadata?.resourceVersion,
        },
        spec: { replicas: 1 },
      });
      coldStart = suspended;
      targetGeneration = patched.metadata?.generation ?? cr.metadata?.generation ?? 0;
      break;
    } catch (err) {
      if (isKubeNotFoundError(err)) return { outcome: "missing" };
      if (!isConflict(err) || attempt >= MAX_CONFLICT_RETRIES) throw err;
    }
  }

  const pollMs = input.pollMs ?? 1_000;
  const startedAt = Date.now();
  while (true) {
    const cr = await getSandbox(clients, input);
    if (!cr) return { outcome: "missing" };
    const ready = conditionAt(cr, "Ready", targetGeneration);
    if (ready?.status === "True") {
      return { outcome: "ready", podName: await findPodForSandbox(clients, input.namespace, input.name), coldStart };
    }
    if (Date.now() - startedAt >= input.timeoutMs) {
      throw new SandboxColdResumeNotReadyError(input.name, Date.now() - startedAt);
    }
    await sleep(pollMs);
  }
}

/**
 * Wait until the Sandbox CR is gone. The workspace PVC carries a controller
 * ownerReference with blockOwnerDeletion, so with Foreground deletion the CR
 * disappears only after the PVC does.
 */
export async function waitForSandboxGone(clients: KubeClients, ref: SuspendableSandboxRef): Promise<void> {
  const pollMs = ref.pollMs ?? 1_000;
  const deadline = Date.now() + ref.timeoutMs;
  while (true) {
    if (!(await getSandbox(clients, ref))) return;
    if (Date.now() >= deadline) {
      throw new Error(`Sandbox ${ref.namespace}/${ref.name} still present ${ref.timeoutMs}ms after delete`);
    }
    await sleep(pollMs);
  }
}
