import { describe, it, expect, vi } from "vitest";
import {
  RESUME_EPOCH_ANNOTATION,
  STOP_EPOCH_ANNOTATION,
  WORKSPACE_VOLUME_UID_ANNOTATION,
  SandboxColdResumeNotReadyError,
  SandboxResumeFencedError,
  SandboxStopSupersededError,
  resumeSuspendableSandbox,
  stopSuspendableSandbox,
  waitForSandboxGone,
} from "../../src/sandbox-suspend.js";
import type { KubeClients } from "../../src/kube-client.js";

interface FakeSandbox {
  metadata: {
    name: string;
    generation: number;
    resourceVersion: string;
    annotations: Record<string, string>;
  };
  spec: { replicas: number };
  status: { conditions: Array<Record<string, unknown>>; podName?: string };
}

/**
 * A Sandbox CR plus a minimal agent-sandbox controller. `settleAfterGets`
 * counts how many reads pass before the controller reconciles the pod to the
 * spec, so a test can observe stale conditions first.
 */
function fakeCluster(input: {
  replicas?: number;
  annotations?: Record<string, string>;
  pvcUid?: string | null;
  settleAfterGets?: number;
  neverReady?: boolean;
  conflictOnFirstPatch?: boolean;
  missing?: boolean;
  beforePatch?: (cr: FakeSandbox) => void;
} = {}) {
  let cr: FakeSandbox | null = input.missing
    ? null
    : {
        metadata: {
          name: "pc-abc",
          generation: 1,
          resourceVersion: "1",
          annotations: { ...(input.annotations ?? {}) },
        },
        spec: { replicas: input.replicas ?? 1 },
        status: { conditions: [], podName: undefined },
      };
  let rv = 1;
  let podRunning = (input.replicas ?? 1) === 1;
  let pendingGets = 0;
  let conflictArmed = input.conflictOnFirstPatch === true;
  const secret: { data: Record<string, string>; resourceVersion: string } = {
    data: {
      BOOTSTRAP_TOKEN: Buffer.from("boot-1").toString("base64"),
      OLD_KEY: Buffer.from("old").toString("base64"),
    },
    resourceVersion: "s1",
  };
  const pvcUid = input.pvcUid === undefined ? "pvc-uid-1" : input.pvcUid;

  function reconcile() {
    if (!cr) return;
    if (pendingGets > 0) {
      pendingGets -= 1;
      return;
    }
    const gen = cr.metadata.generation;
    if (cr.spec.replicas === 0) {
      podRunning = false;
      cr.status.conditions = [
        { type: "Ready", status: "False", reason: "SandboxSuspended", observedGeneration: gen },
        { type: "Suspended", status: "True", reason: "PodTerminated", observedGeneration: gen },
      ];
    } else if (!input.neverReady) {
      podRunning = true;
      cr.status.conditions = [
        { type: "Ready", status: "True", reason: "DependenciesReady", observedGeneration: gen },
        // The controller leaves a stale Suspended=True behind after a resume.
        ...cr.status.conditions.filter((c) => c.type === "Suspended"),
      ];
    }
  }

  const notFound = () => Object.assign(new Error("not found"), { code: 404 });
  const custom = {
    getNamespacedCustomObject: vi.fn(async () => {
      if (!cr) throw notFound();
      reconcile();
      return structuredClone(cr);
    }),
    patchNamespacedCustomObject: vi.fn(async (req: { body: Record<string, unknown> }) => {
      if (!cr) throw notFound();
      input.beforePatch?.(cr);
      const body = req.body as {
        metadata?: { resourceVersion?: string; annotations?: Record<string, string> };
        spec?: { replicas?: number };
      };
      if (conflictArmed) {
        conflictArmed = false;
        rv += 1;
        cr.metadata.resourceVersion = String(rv);
      }
      if (body.metadata?.resourceVersion && body.metadata.resourceVersion !== cr.metadata.resourceVersion) {
        throw Object.assign(new Error("conflict"), { code: 409 });
      }
      if (body.metadata?.annotations) {
        Object.assign(cr.metadata.annotations, body.metadata.annotations);
      }
      if (body.spec?.replicas !== undefined && body.spec.replicas !== cr.spec.replicas) {
        cr.spec.replicas = body.spec.replicas;
        cr.metadata.generation += 1;
        pendingGets = input.settleAfterGets ?? 0;
      }
      rv += 1;
      cr.metadata.resourceVersion = String(rv);
      return structuredClone(cr);
    }),
    deleteNamespacedCustomObject: vi.fn(async () => {
      cr = null;
    }),
  };
  const core = {
    // agent-sandbox names the pod after the Sandbox; v1alpha1 status carries
    // no pod name, so the plugin resolves it with an exact-name GET.
    readNamespacedPod: vi.fn(async () => {
      if (!podRunning) throw notFound();
      return { metadata: { name: "pc-abc" }, status: { phase: "Running" } };
    }),
    listNamespacedPod: vi.fn(async () => ({ items: [] })),
    readNamespacedPersistentVolumeClaim: vi.fn(async () => {
      if (!pvcUid) throw notFound();
      return { metadata: { name: "workspace-pc-abc", uid: pvcUid } };
    }),
    readNamespacedSecret: vi.fn(async () => ({
      metadata: { name: "pc-abc-env", resourceVersion: secret.resourceVersion },
      data: { ...secret.data },
    })),
    replaceNamespacedSecret: vi.fn(async (req: { body: { metadata?: { resourceVersion?: string }; data?: Record<string, string>; stringData?: Record<string, string> } }) => {
      if (req.body.metadata?.resourceVersion !== secret.resourceVersion) {
        throw Object.assign(new Error("conflict"), { code: 409 });
      }
      const next: Record<string, string> = { ...(req.body.data ?? {}) };
      for (const [k, v] of Object.entries(req.body.stringData ?? {})) {
        next[k] = Buffer.from(v).toString("base64");
      }
      secret.data = next;
      secret.resourceVersion = "s2";
      return {};
    }),
  };
  return {
    clients: { custom, core } as unknown as KubeClients,
    custom,
    core,
    get cr() {
      return cr;
    },
    get podRunning() {
      return podRunning;
    },
    secretValue(key: string): string | undefined {
      const v = secret.data[key];
      return v === undefined ? undefined : Buffer.from(v, "base64").toString();
    },
    setReplicas(replicas: number) {
      if (!cr) return;
      cr.spec.replicas = replicas;
      cr.metadata.generation += 1;
      rv += 1;
      cr.metadata.resourceVersion = String(rv);
    },
  };
}

const BASE = { namespace: "paperclip-acme", name: "pc-abc", timeoutMs: 2_000, pollMs: 1 };

describe("stopSuspendableSandbox", () => {
  it("suspends the Sandbox, waits for Suspended at the patched generation and records the volume uid", async () => {
    const cluster = fakeCluster({ settleAfterGets: 2 });

    const result = await stopSuspendableSandbox(cluster.clients, { ...BASE, epoch: 3 });

    expect(result).toBe("stopped");
    expect(cluster.cr?.spec.replicas).toBe(0);
    expect(cluster.podRunning).toBe(false);
    expect(cluster.cr?.metadata.annotations[STOP_EPOCH_ANNOTATION]).toBe("3");
    expect(cluster.cr?.metadata.annotations[WORKSPACE_VOLUME_UID_ANNOTATION]).toBe("pvc-uid-1");
  });

  it("does not confirm on a Suspended condition from an older generation", async () => {
    const cluster = fakeCluster({
      neverReady: true,
      settleAfterGets: 1_000_000,
    });
    // A stale Suspended=True left behind at generation 1.
    cluster.cr!.status.conditions = [
      { type: "Suspended", status: "True", reason: "PodTerminated", observedGeneration: 1 },
    ];

    await expect(
      stopSuspendableSandbox(cluster.clients, { ...BASE, epoch: 1, timeoutMs: 30 }),
    ).rejects.toThrow(/not confirmed/);
  });

  it("does not confirm from a stale Suspended condition once a newer resume took the Sandbox", async () => {
    const cluster = fakeCluster();
    const get = cluster.custom.getNamespacedCustomObject.getMockImplementation()!;
    let reads = 0;
    cluster.custom.getNamespacedCustomObject.mockImplementation(async () => {
      reads += 1;
      const cr = await get();
      if (reads === 2) {
        // The controller confirmed the suspend, then a resume at epoch 5
        // patched the Sandbox before the controller saw it.
        cluster.setReplicas(1);
        cluster.cr!.metadata.annotations[RESUME_EPOCH_ANNOTATION] = "5";
        return structuredClone(cluster.cr!);
      }
      return cr;
    });

    await expect(
      stopSuspendableSandbox(cluster.clients, { ...BASE, epoch: 4 }),
    ).rejects.toBeInstanceOf(SandboxStopSupersededError);
  });

  it("is idempotent on an already suspended Sandbox", async () => {
    const cluster = fakeCluster({ replicas: 0, annotations: { [STOP_EPOCH_ANNOTATION]: "2" } });

    await expect(stopSuspendableSandbox(cluster.clients, { ...BASE, epoch: 2 })).resolves.toBe("stopped");
  });

  it("reports destroyed when the Sandbox CR is gone", async () => {
    const cluster = fakeCluster({ missing: true });

    await expect(stopSuspendableSandbox(cluster.clients, { ...BASE, epoch: 1 })).resolves.toBe("destroyed");
  });

  it("refuses a stale stop once a newer resume has claimed the Sandbox", async () => {
    const cluster = fakeCluster({ annotations: { [RESUME_EPOCH_ANNOTATION]: "5" } });

    await expect(
      stopSuspendableSandbox(cluster.clients, { ...BASE, epoch: 4 }),
    ).rejects.toBeInstanceOf(SandboxStopSupersededError);
    expect(cluster.cr?.spec.replicas).toBe(1);
  });

  it("never lowers the stop fence when a stale stop lands after a newer one", async () => {
    const cluster = fakeCluster({
      replicas: 0,
      annotations: { [STOP_EPOCH_ANNOTATION]: "5", [RESUME_EPOCH_ANNOTATION]: "4" },
    });

    await stopSuspendableSandbox(cluster.clients, { ...BASE, epoch: 4 });

    expect(cluster.cr?.metadata.annotations[STOP_EPOCH_ANNOTATION]).toBe("5");
    // A late resume at epoch 5 is therefore still refused.
    await expect(resumeSuspendableSandbox(cluster.clients, {
      ...BASE, epoch: 5, secretName: "pc-abc-env", adapterEnv: {},
    })).rejects.toBeInstanceOf(SandboxResumeFencedError);
  });

  it("re-reads and re-checks the fence when the patch loses a resourceVersion race", async () => {
    const cluster = fakeCluster({
      conflictOnFirstPatch: true,
      // The racing writer is a newer resume.
      beforePatch: (cr) => {
        if (!cr.metadata.annotations[RESUME_EPOCH_ANNOTATION]) {
          cr.metadata.annotations[RESUME_EPOCH_ANNOTATION] = "9";
        }
      },
    });

    await expect(
      stopSuspendableSandbox(cluster.clients, { ...BASE, epoch: 4 }),
    ).rejects.toBeInstanceOf(SandboxStopSupersededError);
    expect(cluster.cr?.spec.replicas).toBe(1);
  });
});

describe("resumeSuspendableSandbox", () => {
  const REFRESH = { secretName: "pc-abc-env", adapterEnv: { NEW_KEY: "new" } };

  it("un-suspends, refreshes the env Secret keeping the bootstrap token, and waits for Ready", async () => {
    const cluster = fakeCluster({
      replicas: 0,
      annotations: { [STOP_EPOCH_ANNOTATION]: "2", [WORKSPACE_VOLUME_UID_ANNOTATION]: "pvc-uid-1" },
      settleAfterGets: 2,
    });

    const result = await resumeSuspendableSandbox(cluster.clients, { ...BASE, ...REFRESH, epoch: 3 });

    expect(result).toEqual({ outcome: "ready", podName: "pc-abc", coldStart: true });
    expect(cluster.cr?.spec.replicas).toBe(1);
    expect(cluster.cr?.metadata.annotations[RESUME_EPOCH_ANNOTATION]).toBe("3");
    expect(cluster.secretValue("BOOTSTRAP_TOKEN")).toBe("boot-1");
    expect(cluster.secretValue("NEW_KEY")).toBe("new");
    expect(cluster.secretValue("OLD_KEY")).toBeUndefined();
  });

  it("stamps the epoch on a running Sandbox without touching its Secret", async () => {
    const cluster = fakeCluster({ replicas: 1 });

    const result = await resumeSuspendableSandbox(cluster.clients, { ...BASE, ...REFRESH, epoch: 1 });

    expect(result).toEqual({ outcome: "ready", podName: "pc-abc", coldStart: false });
    expect(cluster.cr?.metadata.annotations[RESUME_EPOCH_ANNOTATION]).toBe("1");
    expect(cluster.core.replaceNamespacedSecret).not.toHaveBeenCalled();
  });

  it("refuses a late resume after a stop at the same epoch", async () => {
    const cluster = fakeCluster({ replicas: 0, annotations: { [STOP_EPOCH_ANNOTATION]: "3" } });

    await expect(
      resumeSuspendableSandbox(cluster.clients, { ...BASE, ...REFRESH, epoch: 3 }),
    ).rejects.toBeInstanceOf(SandboxResumeFencedError);
    expect(cluster.cr?.spec.replicas).toBe(0);
  });

  it("refuses a stale resume once a newer resume has stamped the Sandbox", async () => {
    const cluster = fakeCluster({ replicas: 1, annotations: { [RESUME_EPOCH_ANNOTATION]: "6" } });

    await expect(
      resumeSuspendableSandbox(cluster.clients, { ...BASE, ...REFRESH, epoch: 5 }),
    ).rejects.toBeInstanceOf(SandboxResumeFencedError);
    expect(cluster.cr?.metadata.annotations[RESUME_EPOCH_ANNOTATION]).toBe("6");
  });

  it("refreshes the Secret when a stop lands between its first read and its patch", async () => {
    let raced = false;
    const cluster = fakeCluster({
      replicas: 1,
      conflictOnFirstPatch: true,
      beforePatch: (cr) => {
        if (raced) return;
        raced = true;
        // An in-flight stop at the previous epoch suspends the Sandbox.
        cr.spec.replicas = 0;
        cr.metadata.generation += 1;
        cr.metadata.annotations[STOP_EPOCH_ANNOTATION] = "1";
      },
    });

    const result = await resumeSuspendableSandbox(cluster.clients, { ...BASE, ...REFRESH, epoch: 2 });

    expect(result).toEqual({ outcome: "ready", podName: "pc-abc", coldStart: true });
    expect(cluster.secretValue("NEW_KEY")).toBe("new");
    expect(cluster.cr?.spec.replicas).toBe(1);
  });

  it("reports missing when the Sandbox is deleted right after it became Ready", async () => {
    const cluster = fakeCluster({ replicas: 1 });
    cluster.core.readNamespacedPod.mockImplementation(async () => {
      // The Sandbox, and its pod with it, is deleted after the Ready read.
      await cluster.custom.deleteNamespacedCustomObject();
      throw Object.assign(new Error("not found"), { code: 404 });
    });

    await expect(
      resumeSuspendableSandbox(cluster.clients, { ...BASE, ...REFRESH, epoch: 1 }),
    ).resolves.toEqual({ outcome: "missing" });
  });

  it("never reports a Sandbox that still exists as missing when its pod cannot be named", async () => {
    const cluster = fakeCluster({ replicas: 1 });
    cluster.core.readNamespacedPod.mockImplementation(async () => {
      throw Object.assign(new Error("not found"), { code: 404 });
    });

    await expect(
      resumeSuspendableSandbox(cluster.clients, { ...BASE, ...REFRESH, epoch: 1 }),
    ).resolves.toEqual({ outcome: "ready", podName: null, coldStart: false });
  });

  it("reports missing when the Sandbox CR is gone", async () => {
    const cluster = fakeCluster({ missing: true });

    await expect(
      resumeSuspendableSandbox(cluster.clients, { ...BASE, ...REFRESH, epoch: 1 }),
    ).resolves.toEqual({ outcome: "missing" });
  });

  it("reports volume_replaced when the controller re-created the workspace PVC", async () => {
    const cluster = fakeCluster({
      replicas: 0,
      annotations: { [WORKSPACE_VOLUME_UID_ANNOTATION]: "pvc-uid-1" },
      pvcUid: "pvc-uid-2",
    });

    await expect(
      resumeSuspendableSandbox(cluster.clients, { ...BASE, ...REFRESH, epoch: 2 }),
    ).resolves.toEqual({ outcome: "volume_replaced" });
    expect(cluster.cr?.spec.replicas).toBe(0);
  });

  it("throws a non-transient error, without the word timeout, when the cold pod never becomes Ready", async () => {
    const cluster = fakeCluster({ replicas: 0, neverReady: true });

    const error = await resumeSuspendableSandbox(cluster.clients, {
      ...BASE,
      ...REFRESH,
      epoch: 2,
      timeoutMs: 20,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxColdResumeNotReadyError);
    expect((error as Error).message).not.toMatch(/timeout|timed out/i);
    expect((error as { code?: string }).code).toBe("sandbox_cold_resume_not_ready");
    // No re-suspend: the server's reconciler owns every re-stop.
    expect(cluster.cr?.spec.replicas).toBe(1);
  });
});

describe("waitForSandboxGone", () => {
  it("resolves once the CR returns 404", async () => {
    const cluster = fakeCluster({ missing: true });
    await expect(waitForSandboxGone(cluster.clients, BASE)).resolves.toBeUndefined();
  });

  it("throws while the CR is still present at the deadline", async () => {
    const cluster = fakeCluster();
    await expect(waitForSandboxGone(cluster.clients, { ...BASE, timeoutMs: 20 })).rejects.toThrow(
      /still present/,
    );
  });
});
