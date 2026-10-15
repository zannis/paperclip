import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  plugins,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { environmentRuntimeService, ReusableSandboxResumeError } from "../services/environment-runtime.ts";
import { environmentService } from "../services/environments.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { remoteExecutionHasStopped } from "../services/remote-execution-termination.ts";
import { stopBlocksIssueClaimSql } from "../services/kept-workspace-leases.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres kept workspace lease tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const IDLE_TIMEOUT_MS = 15 * 60_000;

interface FakeSandbox {
  replicas: number;
  resumeEpoch: number;
  stopEpoch: number;
  files: Map<string, string>;
  volumeId: string;
}

/**
 * The provider plugin worker, the only faked boundary. It models what the
 * Kubernetes plugin does with a Sandbox whose /workspace is a PVC: a stop sets
 * replicas 0 and keeps the volume, a resume sets replicas 1 on the same
 * volume, a destroy removes both, and both stop and resume are fenced on the
 * epoch the server passes.
 */
function fakeProvider(options: {
  keepsWorkspace?: boolean;
  stopFails?: () => boolean;
  resumeFails?: () => boolean;
  onStop?: (providerLeaseId: string) => Promise<void>;
  onResume?: (providerLeaseId: string) => Promise<void>;
} = {}) {
  const sandboxes = new Map<string, FakeSandbox>();
  const destroyed: string[] = [];
  let created = 0;
  const keepsWorkspace = options.keepsWorkspace ?? true;
  const call = vi.fn(async (_pluginId: string, method: string, input: {
    providerLeaseId?: string;
    leaseMetadata?: Record<string, unknown>;
  }) => {
    const epoch = typeof input.leaseMetadata?.sandboxEpoch === "number" ? input.leaseMetadata.sandboxEpoch : null;
    switch (method) {
      case "environmentAcquireLease": {
        created += 1;
        const providerLeaseId = `pc-${created}`;
        sandboxes.set(providerLeaseId, {
          replicas: 1, resumeEpoch: 0, stopEpoch: -1, files: new Map(), volumeId: `vol-${created}`,
        });
        return {
          providerLeaseId,
          metadata: { remoteCwd: "/workspace", backend: "sandbox-cr", workspaceSurvivesStop: keepsWorkspace },
        };
      }
      case "environmentResumeLease": {
        await options.onResume?.(input.providerLeaseId!);
        const sandbox = sandboxes.get(input.providerLeaseId!);
        if (!sandbox) return { providerLeaseId: null, metadata: { expired: true } };
        if (options.resumeFails?.()) throw new Error("cold pod not ready");
        if (keepsWorkspace) {
          if (epoch === null) throw new Error("resume without an epoch");
          if (sandbox.stopEpoch >= epoch) throw new Error("resume fenced by a newer stop");
          sandbox.resumeEpoch = epoch;
        }
        const coldResumed = sandbox.replicas === 0;
        sandbox.replicas = 1;
        return {
          providerLeaseId: input.providerLeaseId,
          metadata: {
            remoteCwd: "/workspace", backend: "sandbox-cr", workspaceSurvivesStop: keepsWorkspace, coldResumed,
          },
        };
      }
      case "environmentStopLease": {
        await options.onStop?.(input.providerLeaseId!);
        if (options.stopFails?.()) throw new Error("patch sandboxes: forbidden");
        const sandbox = sandboxes.get(input.providerLeaseId!);
        if (!sandbox) return { providerLeaseId: input.providerLeaseId, state: "destroyed" };
        if (epoch === null) throw new Error("stop without an epoch");
        if (sandbox.resumeEpoch > epoch) {
          throw Object.assign(new Error("superseded"), { code: "sandbox_stop_superseded" });
        }
        sandbox.stopEpoch = epoch;
        sandbox.replicas = 0;
        return { providerLeaseId: input.providerLeaseId, state: "stopped" };
      }
      case "environmentDestroyLease":
      case "environmentReleaseLease": {
        sandboxes.delete(input.providerLeaseId!);
        destroyed.push(input.providerLeaseId!);
        return { providerLeaseId: input.providerLeaseId, state: "destroyed" };
      }
      default:
        throw new Error(`Unexpected provider method: ${method}`);
    }
  });
  const pluginWorkerManager = {
    isRunning: () => true,
    getWorker: () => ({
      supportedMethods: [
        "environmentAcquireLease",
        "environmentResumeLease",
        "environmentReleaseLease",
        "environmentDestroyLease",
        "environmentStopLease",
      ],
    }),
    call,
  } as unknown as PluginWorkerManager;
  return {
    sandboxes,
    destroyed,
    call,
    pluginWorkerManager,
    methods: () => call.mock.calls.map((c) => c[1]),
  };
}

describeEmbeddedPostgres("kept workspace lease lifecycle", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-kept-workspace-lease-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(environments);
    await db.delete(plugins);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const pluginId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `K${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.kept-workspace-provider",
      packageName: "@acme/kept-workspace-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.kept-workspace-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Kept Workspace Provider",
        description: "Test provider whose workspace survives a stop",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            supportsReusableLeases: true,
            configSchema: { type: "object", properties: { image: { type: "string" }, reuseLease: { type: "boolean" } } },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    await db.insert(environments).values({
      id: environmentId,
      name: "Warm Sandbox",
      driver: "sandbox",
      status: "active",
      config: {
        provider: "fake-plugin",
        image: "fake:test",
        reuseLease: true,
        runnerLifecycleMode: "warm",
        runnerIdleTimeoutMs: IDLE_TIMEOUT_MS,
      },
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Warm work", status: "in_progress", assigneeAgentId: agentId,
    });
    return { companyId, agentId, environmentId, pluginId, issueId };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  async function newRun(seeded: Seeded, status = "running") {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: seeded.companyId, agentId: seeded.agentId,
      invocationSource: "on_demand", status, nextEventSeq: 1,
    });
    return runId;
  }

  async function finishRun(runId: string, status = "succeeded") {
    await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, runId));
  }

  function toLease(row: typeof environmentLeases.$inferSelect) {
    return { ...row, metadata: (row.metadata as Record<string, unknown> | null) ?? null } as any;
  }

  async function leaseRow(id: string) {
    const [row] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, id));
    return row!;
  }

  async function makeIdle(id: string, minutes = 16) {
    const since = new Date(Date.now() - minutes * 60_000);
    await db.update(environmentLeases)
      .set({ lastUsedAt: since, updatedAt: since })
      .where(eq(environmentLeases.id, id));
  }

  // Lets a stop that failed earlier be retried now instead of after backoff.
  async function expireStopBackoff(id: string) {
    await db.update(environmentLeases)
      .set({ metadata: sql`jsonb_set(${environmentLeases.metadata}, '{sandboxStop,retryAfterMs}', '0'::jsonb)` })
      .where(eq(environmentLeases.id, id));
  }

  function services(provider: ReturnType<typeof fakeProvider>) {
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: provider.pluginWorkerManager });
    const heartbeat = heartbeatService(db, { pluginWorkerManager: provider.pluginWorkerManager });
    return { runtime, heartbeat };
  }

  // One lease cleanup tick, in production order.
  async function cleanupTick(provider: ReturnType<typeof fakeProvider>) {
    const { heartbeat } = services(provider);
    await heartbeat.sweepIdleRetainedLeases();
    await heartbeat.sweepKeptWorkspaceLeases();
    await heartbeat.sweepPendingCleanupLeases({ backoffMs: 5 * 60_000 });
  }

  async function acquire(seeded: Seeded, provider: ReturnType<typeof fakeProvider>, runId: string) {
    const { runtime } = services(provider);
    const environment = (await environmentService(db).getById(seeded.environmentId))!;
    return await runtime.acquireRunLease({
      companyId: seeded.companyId,
      environment,
      issueId: seeded.issueId,
      agentId: seeded.agentId,
      adapterType: "claude_local",
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });
  }

  // A warm turn: acquire (create or resume), write a file, end warm.
  async function warmTurn(seeded: Seeded, provider: ReturnType<typeof fakeProvider>, write?: [string, string]) {
    const runId = await newRun(seeded);
    const acquired = await acquire(seeded, provider, runId);
    if (write) provider.sandboxes.get(acquired.lease.providerLeaseId!)!.files.set(write[0], write[1]);
    await finishRun(runId);
    await services(provider).runtime.releaseRunLeases(runId, "released", undefined, "keep_running");
    return { runId, lease: acquired.lease };
  }

  // A retained warm lease left idle and stopped by one cleanup tick.
  async function stoppedLease(seeded: Seeded, provider: ReturnType<typeof fakeProvider>) {
    const turn = await warmTurn(seeded, provider, ["notes.md", "from run 1"]);
    await makeIdle(turn.lease.id);
    await cleanupTick(provider);
    return turn;
  }

  describe("idle stop", () => {
    it("stops an idle warm Sandbox and keeps its workspace volume", async () => {
      const seeded = await seed();
      const provider = fakeProvider();
      const turn = await warmTurn(seeded, provider, ["notes.md", "from run 1"]);
      await makeIdle(turn.lease.id);

      await cleanupTick(provider);

      const sandbox = provider.sandboxes.get(turn.lease.providerLeaseId!)!;
      expect(sandbox.replicas).toBe(0);
      expect(sandbox.files.get("notes.md")).toBe("from run 1");
      expect(provider.destroyed).toEqual([]);
      const row = await leaseRow(turn.lease.id);
      expect(row.status).toBe("stopped");
      expect(row.cleanupStatus).toBe("pending");
      expect(row.metadata?.sandboxStop).toMatchObject({ confirmedEpoch: 0 });
    });

    it("keeps a lease still inside runnerIdleTimeoutMs running", async () => {
      const seeded = await seed();
      const provider = fakeProvider();
      const turn = await warmTurn(seeded, provider);
      await makeIdle(turn.lease.id, 14);

      await cleanupTick(provider);

      expect(provider.sandboxes.get(turn.lease.providerLeaseId!)!.replicas).toBe(1);
      expect((await leaseRow(turn.lease.id)).status).toBe("retained");
    });

    it("never destroys a Sandbox whose stop fails, and retries the stop later", async () => {
      const seeded = await seed();
      let fail = true;
      const provider = fakeProvider({ stopFails: () => fail });
      const turn = await warmTurn(seeded, provider, ["notes.md", "kept"]);
      await makeIdle(turn.lease.id);

      await cleanupTick(provider);
      await cleanupTick(provider);

      expect(provider.destroyed).toEqual([]);
      let row = await leaseRow(turn.lease.id);
      expect(row.status).toBe("stopped");
      expect(row.metadata?.sandboxStop).toMatchObject({ attempts: 1 });
      expect(row.metadata?.sandboxStop).not.toHaveProperty("confirmedEpoch");

      fail = false;
      await expireStopBackoff(turn.lease.id);
      await cleanupTick(provider);

      row = await leaseRow(turn.lease.id);
      expect(row.metadata?.sandboxStop).toMatchObject({ confirmedEpoch: 0 });
      expect(provider.sandboxes.get(turn.lease.providerLeaseId!)!.files.get("notes.md")).toBe("kept");
    });

    it("records a Sandbox that is already gone as expired, not as stopped", async () => {
      const seeded = await seed();
      const provider = fakeProvider();
      const turn = await warmTurn(seeded, provider);
      await makeIdle(turn.lease.id);
      provider.sandboxes.delete(turn.lease.providerLeaseId!);

      await cleanupTick(provider);

      expect(await leaseRow(turn.lease.id)).toMatchObject({ status: "expired", cleanupStatus: "success" });
    });

    it("takes the destroy path for a lease whose workspace would not survive a stop", async () => {
      const seeded = await seed();
      const provider = fakeProvider({ keepsWorkspace: false });
      const turn = await warmTurn(seeded, provider);
      await makeIdle(turn.lease.id);

      await cleanupTick(provider);

      expect(provider.methods()).not.toContain("environmentStopLease");
      expect(provider.destroyed).toEqual([turn.lease.providerLeaseId]);
      expect(await leaseRow(turn.lease.id)).toMatchObject({ status: "expired", cleanupStatus: "success" });
    });
  });

  describe("resume of a kept workspace", () => {
    it("brings the stopped Sandbox back on the same volume with the earlier files", async () => {
      const seeded = await seed();
      const provider = fakeProvider();
      const first = await stoppedLease(seeded, provider);

      const runId = await newRun(seeded);
      const next = await acquire(seeded, provider, runId);

      expect(next.lease).toMatchObject({ status: "active", providerLeaseId: first.lease.providerLeaseId });
      expect(next.lease.metadata?.sandboxEpoch).toBe(1);
      const sandbox = provider.sandboxes.get(first.lease.providerLeaseId!)!;
      expect(sandbox.replicas).toBe(1);
      expect(sandbox.files.get("notes.md")).toBe("from run 1");
      expect(await leaseRow(first.lease.id)).toMatchObject({ status: "expired", cleanupStatus: null });
      expect(provider.destroyed).toEqual([]);
    });

    it("resumes the kept workspace after a plugin upgrade and a secret change instead of resetting it", async () => {
      const seeded = await seed();
      const provider = fakeProvider();
      const first = await stoppedLease(seeded, provider);
      await db.update(plugins).set({ version: "1.1.0" }).where(eq(plugins.id, seeded.pluginId));
      await db.update(environments)
        .set({ config: sql`${environments.config} || '{"image":"fake:next"}'::jsonb` })
        .where(eq(environments.id, seeded.environmentId));

      const runId = await newRun(seeded);
      const next = await acquire(seeded, provider, runId);

      expect(next.lease.providerLeaseId).toBe(first.lease.providerLeaseId);
      expect(provider.destroyed).toEqual([]);
      expect(provider.sandboxes.get(first.lease.providerLeaseId!)!.files.get("notes.md")).toBe("from run 1");
      expect(next.lease.metadata?.reusableSandboxLease).toMatchObject({
        resumedAcrossConfigChange: expect.any(Object),
      });
    });

    it("keeps the stopped lease and creates nothing new when the resume fails, then stops it again", async () => {
      const seeded = await seed();
      const provider = fakeProvider({ resumeFails: () => true });
      const first = await stoppedLease(seeded, provider);

      const runId = await newRun(seeded);
      const error = await acquire(seeded, provider, runId).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ReusableSandboxResumeError);
      expect(provider.methods()).not.toContain("environmentDestroyLease");
      expect(provider.methods().filter((m) => m === "environmentAcquireLease")).toHaveLength(1);
      let row = await leaseRow(first.lease.id);
      expect(row.status).toBe("stopped");
      // The claim moved the epoch on, so the earlier confirmation no longer counts.
      expect(row.metadata?.sandboxEpoch).toBe(1);

      // While the run is live nothing re-stops it; once it ends, the reconciler does.
      await cleanupTick(provider);
      expect((await leaseRow(first.lease.id)).metadata?.sandboxStop).toMatchObject({ confirmedEpoch: 0 });
      await finishRun(runId, "failed");
      await cleanupTick(provider);
      row = await leaseRow(first.lease.id);
      expect(row.metadata?.sandboxStop).toMatchObject({ confirmedEpoch: 1 });
      expect(provider.sandboxes.get(first.lease.providerLeaseId!)!.replicas).toBe(0);
    });

    it("re-stops a Sandbox whose resume claim was abandoned mid-acquisition", async () => {
      const seeded = await seed();
      const provider = fakeProvider();
      const first = await stoppedLease(seeded, provider);
      // A resume that reached the provider and then lost its server.
      const runId = await newRun(seeded);
      await db.update(environmentLeases).set({
        metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({
          sandboxEpoch: 1, resumeClaimRunId: runId, resumeClaimedAt: new Date().toISOString(),
        })}::jsonb`,
      }).where(eq(environmentLeases.id, first.lease.id));
      const sandbox = provider.sandboxes.get(first.lease.providerLeaseId!)!;
      sandbox.replicas = 1;
      sandbox.resumeEpoch = 1;
      await finishRun(runId, "failed");

      await cleanupTick(provider);

      expect(sandbox.replicas).toBe(0);
      expect((await leaseRow(first.lease.id)).metadata?.sandboxStop).toMatchObject({ confirmedEpoch: 1 });
    });

    it("lets a resume win over a stop that is still in flight, without losing the pod", async () => {
      const seeded = await seed();
      let resumeDuringStop: Promise<unknown> | null = null;
      let runId = "";
      const provider = fakeProvider({
        onStop: async () => {
          if (resumeDuringStop) return;
          runId = await newRun(seeded);
          resumeDuringStop = acquire(seeded, provider, runId);
          await resumeDuringStop;
        },
      });
      const turn = await warmTurn(seeded, provider, ["notes.md", "kept"]);
      await makeIdle(turn.lease.id);

      await cleanupTick(provider);

      const sandbox = provider.sandboxes.get(turn.lease.providerLeaseId!)!;
      expect(sandbox.replicas).toBe(1);
      expect(sandbox.files.get("notes.md")).toBe("kept");
      const [active] = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, runId));
      expect(active).toMatchObject({ status: "active", providerLeaseId: turn.lease.providerLeaseId });
    });
  });

  describe("provider call budgets", () => {
    it("gives kept-workspace resume and destroy calls the full lifecycle budget", async () => {
      const seeded = await seed();
      const provider = fakeProvider();
      const first = await stoppedLease(seeded, provider);
      const runId = await newRun(seeded);
      await acquire(seeded, provider, runId);
      await finishRun(runId);
      await services(provider).runtime.releaseRunLeases(runId, "released", undefined, "keep_running");
      await services(provider).runtime.destroyReusableSandboxLeases({
        companyId: seeded.companyId, issueId: seeded.issueId, failureReason: "issue_terminal_done",
      });

      const timeoutOf = (method: string) => provider.call.mock.calls.find((c) => c[1] === method)?.[3];
      // The provider waits up to 40 s for a cold pod or for the volume to go;
      // the default 30 s plugin RPC timeout would cut that short.
      expect(timeoutOf("environmentResumeLease")).toBeGreaterThan(40_000);
      expect(timeoutOf("environmentDestroyLease")).toBeGreaterThanOrEqual(60_000);
      expect(timeoutOf("environmentStopLease")).toBeGreaterThanOrEqual(60_000);
      expect(provider.sandboxes.has(first.lease.providerLeaseId!)).toBe(false);
    });
  });

  describe("issue claims", () => {
    it("block on an unconfirmed stop of a cancelled run, not on an idle stop", async () => {
      const seeded = await seed();
      const provider = fakeProvider({ stopFails: () => true });
      const idle = await warmTurn(seeded, provider);
      await makeIdle(idle.lease.id);
      await cleanupTick(provider);
      const cancelledRun = await newRun(seeded);
      await db.update(environmentLeases).set({ status: "expired" }).where(eq(environmentLeases.id, idle.lease.id));
      const cancelled = await acquire(seeded, provider, cancelledRun);
      await finishRun(cancelledRun, "cancelled");
      await services(provider).runtime.releaseRunLeases(cancelledRun, "released", undefined, "stop_and_retain");
      await db.update(environmentLeases).set({ status: "stopped" }).where(eq(environmentLeases.id, idle.lease.id));

      const blocking = await db.select({ id: environmentLeases.id }).from(environmentLeases)
        .where(stopBlocksIssueClaimSql());

      expect((await leaseRow(idle.lease.id)).status).toBe("stopped");
      expect((await leaseRow(cancelled.lease.id)).status).toBe("stopped");
      expect(blocking.map((row) => row.id)).toEqual([cancelled.lease.id]);
    });
  });

  describe("terminal paths delete the kept volume", () => {
    it("keeps an unreachable kept workspace while another run still holds a resume claim on it", async () => {
      const seeded = await seed();
      const provider = fakeProvider();
      const first = await stoppedLease(seeded, provider);
      const claimingRun = await newRun(seeded);
      await db.update(environmentLeases).set({
        metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({
          sandboxEpoch: 1, resumeClaimRunId: claimingRun, resumeClaimedAt: new Date().toISOString(),
        })}::jsonb`,
      }).where(eq(environmentLeases.id, first.lease.id));

      const runId = await newRun(seeded);
      const environment = (await environmentService(db).getById(seeded.environmentId))!;
      await services(provider).runtime.acquireRunLease({
        companyId: seeded.companyId, environment, issueId: seeded.issueId, agentId: seeded.agentId,
        adapterType: "codex_local", heartbeatRunId: runId, persistedExecutionWorkspace: null,
      });

      expect(provider.sandboxes.has(first.lease.providerLeaseId!)).toBe(true);
      expect((await leaseRow(first.lease.id)).status).toBe("stopped");
    });

    it("destroys a stopped kept workspace that an adapter change made unreachable", async () => {
      const seeded = await seed();
      const provider = fakeProvider();
      const first = await stoppedLease(seeded, provider);

      const runId = await newRun(seeded);
      const { runtime } = services(provider);
      const environment = (await environmentService(db).getById(seeded.environmentId))!;
      const next = await runtime.acquireRunLease({
        companyId: seeded.companyId, environment, issueId: seeded.issueId, agentId: seeded.agentId,
        adapterType: "codex_local", heartbeatRunId: runId, persistedExecutionWorkspace: null,
      });

      expect(next.lease.providerLeaseId).not.toBe(first.lease.providerLeaseId);
      expect(provider.sandboxes.has(first.lease.providerLeaseId!)).toBe(false);
      expect(await leaseRow(first.lease.id)).toMatchObject({ status: "expired", cleanupStatus: "success" });
    });

    it("does not let the closed-issue sweep reach a lease bound to an open execution workspace", async () => {
      const seeded = await seed();
      const provider = fakeProvider();
      const bound = await warmTurn(seeded, provider);
      const projectId = randomUUID();
      await db.insert(projects).values({ id: projectId, companyId: seeded.companyId, name: "Lab" });
      const workspaceId = randomUUID();
      await db.insert(executionWorkspaces).values({
        id: workspaceId, companyId: seeded.companyId, projectId, mode: "isolated_workspace",
        strategyType: "git_worktree", name: "lane", status: "active",
      } as any);
      await db.update(environmentLeases).set({ executionWorkspaceId: workspaceId })
        .where(eq(environmentLeases.id, bound.lease.id));
      const projectless = await stoppedLease(seeded, provider);
      expect(projectless.lease.providerLeaseId).not.toBe(bound.lease.providerLeaseId);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, seeded.issueId));

      await cleanupTick(provider);

      expect(provider.sandboxes.has(projectless.lease.providerLeaseId!)).toBe(false);
      expect(provider.sandboxes.has(bound.lease.providerLeaseId!)).toBe(true);
      expect((await leaseRow(bound.lease.id)).status).toBe("retained");
    });


    it("destroys a stopped Sandbox and its volume when the issue closes", async () => {
      const seeded = await seed();
      const provider = fakeProvider();
      const first = await stoppedLease(seeded, provider);

      await services(provider).runtime.destroyReusableSandboxLeases({
        companyId: seeded.companyId, issueId: seeded.issueId, failureReason: "issue_terminal_done",
      });

      expect(provider.sandboxes.has(first.lease.providerLeaseId!)).toBe(false);
      expect(await leaseRow(first.lease.id)).toMatchObject({ status: "expired", cleanupStatus: "success" });
    });

    it("destroys a stopped Sandbox on a consented environment delete, and a plain delete is refused", async () => {
      const seeded = await seed();
      const provider = fakeProvider();
      const first = await stoppedLease(seeded, provider);

      expect(await environmentService(db).removeIfDeletable(seeded.environmentId)).toBeNull();

      const result = await services(provider).runtime.destroyReusableSandboxLeasesForEnvironment({
        environmentId: seeded.environmentId,
      });
      expect(result).toMatchObject({ destroyed: 1 });
      expect(provider.sandboxes.has(first.lease.providerLeaseId!)).toBe(false);
    });

    it("destroys instead of finishing a stop when the issue closes while the stop is in flight", async () => {
      const seeded = await seed();
      let closed = false;
      const provider = fakeProvider({
        onStop: async () => {
          if (closed) return;
          closed = true;
          await services(provider).runtime.destroyReusableSandboxLeases({
            companyId: seeded.companyId, issueId: seeded.issueId, failureReason: "issue_terminal_done",
          });
        },
      });
      const turn = await warmTurn(seeded, provider);
      await makeIdle(turn.lease.id);

      await cleanupTick(provider);
      await cleanupTick(provider);

      expect(provider.sandboxes.has(turn.lease.providerLeaseId!)).toBe(false);
      expect(await leaseRow(turn.lease.id)).toMatchObject({ status: "expired", cleanupStatus: "success" });
    });

    it("does not destroy a Sandbox a live run is resuming when the issue closes", async () => {
      const seeded = await seed();
      const provider = fakeProvider();
      const first = await stoppedLease(seeded, provider);
      const runId = await newRun(seeded);
      await db.update(environmentLeases).set({
        metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({
          sandboxEpoch: 1, resumeClaimRunId: runId, resumeClaimedAt: new Date().toISOString(),
        })}::jsonb`,
      }).where(eq(environmentLeases.id, first.lease.id));

      await services(provider).runtime.destroyReusableSandboxLeases({
        companyId: seeded.companyId, issueId: seeded.issueId, failureReason: "issue_terminal_done",
      });

      expect(provider.destroyed).toEqual([]);
      expect((await leaseRow(first.lease.id)).status).toBe("stopped");
    });

    it("destroys a stopped Sandbox of a closed execution workspace, but not of a reopened one", async () => {
      const seeded = await seed();
      const provider = fakeProvider();
      const first = await stoppedLease(seeded, provider);
      const projectId = randomUUID();
      await db.insert(projects).values({ id: projectId, companyId: seeded.companyId, name: "Lab" });
      const workspaceId = randomUUID();
      await db.insert(executionWorkspaces).values({
        id: workspaceId, companyId: seeded.companyId, projectId, mode: "isolated_workspace",
        strategyType: "git_worktree", name: "lane", status: "active",
      } as any);
      await db.update(environmentLeases).set({ executionWorkspaceId: workspaceId })
        .where(eq(environmentLeases.id, first.lease.id));

      await cleanupTick(provider);
      expect((await leaseRow(first.lease.id)).status).toBe("stopped");

      await db.update(executionWorkspaces).set({ status: "archived" }).where(eq(executionWorkspaces.id, workspaceId));
      await cleanupTick(provider);

      expect(provider.sandboxes.has(first.lease.providerLeaseId!)).toBe(false);
      expect(await leaseRow(first.lease.id)).toMatchObject({ status: "expired", cleanupStatus: "success" });
    });

    it("destroys a stopped Sandbox on a closed issue even when the close hook never ran", async () => {
      const seeded = await seed();
      const provider = fakeProvider();
      const first = await stoppedLease(seeded, provider);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, seeded.issueId));

      await cleanupTick(provider);

      expect(provider.sandboxes.has(first.lease.providerLeaseId!)).toBe(false);
      expect(await leaseRow(first.lease.id)).toMatchObject({ status: "expired", cleanupStatus: "success" });
    });
  });

  describe("recovery paths", () => {
    it("stops, instead of destroying, a kept-workspace lease orphaned by a crashed run", async () => {
      const seeded = await seed();
      const provider = fakeProvider();
      const runId = await newRun(seeded);
      const acquired = await acquire(seeded, provider, runId);
      await finishRun(runId, "failed");
      await db.update(environmentLeases)
        .set({ updatedAt: new Date(Date.now() - 60 * 60_000) })
        .where(eq(environmentLeases.id, acquired.lease.id));

      await services(provider).heartbeat.sweepOrphanedActiveLeases({ backoffMs: 5 * 60_000 });
      await cleanupTick(provider);

      expect(provider.destroyed).toEqual([]);
      expect(provider.sandboxes.get(acquired.lease.providerLeaseId!)!.replicas).toBe(0);
      expect((await leaseRow(acquired.lease.id)).status).toBe("stopped");
    });

    it("settles a stop-and-retain release as stopped, and the run counts as stopped once confirmed", async () => {
      const seeded = await seed();
      const provider = fakeProvider();
      const runId = await newRun(seeded);
      const acquired = await acquire(seeded, provider, runId);
      await finishRun(runId, "cancelled");

      await services(provider).runtime.releaseRunLeases(runId, "released", undefined, "stop_and_retain");

      // The release stops the pod itself; it does not wait for a sweep tick.
      expect(await leaseRow(acquired.lease.id)).toMatchObject({ status: "stopped", cleanupStatus: "pending" });
      expect(provider.sandboxes.get(acquired.lease.providerLeaseId!)!.replicas).toBe(0);
      expect(await remoteExecutionHasStopped(db, seeded.companyId, runId)).toBe(true);

      // A later resume does not take that proof away from the stopped run.
      const nextRun = await newRun(seeded);
      await acquire(seeded, provider, nextRun);
      expect(await remoteExecutionHasStopped(db, seeded.companyId, runId)).toBe(true);
    });

    it("moves the epoch past the last stop when a lifecycle resume brings a stopped Sandbox back", async () => {
      const seeded = await seed();
      const provider = fakeProvider();
      const runId = await newRun(seeded);
      const acquired = await acquire(seeded, provider, runId);
      await finishRun(runId);
      // A released lease whose Sandbox a stop-only cleanup suspended at epoch 0.
      await db.update(environmentLeases).set({ status: "released", releasedAt: new Date() })
        .where(eq(environmentLeases.id, acquired.lease.id));
      const sandbox = provider.sandboxes.get(acquired.lease.providerLeaseId!)!;
      sandbox.replicas = 0;
      sandbox.stopEpoch = 0;
      const environment = (await environmentService(db).getById(seeded.environmentId))!;

      const resumed = await services(provider).runtime.resumeRunLease({
        environment, lease: toLease(await leaseRow(acquired.lease.id)),
      });

      expect(resumed?.providerLeaseId).toBe(acquired.lease.providerLeaseId);
      expect(sandbox.replicas).toBe(1);
      expect((await leaseRow(acquired.lease.id)).metadata?.sandboxEpoch).toBe(1);
    });

    it("leaves a stopped kept workspace to acquisition, which records the claiming run", async () => {
      const seeded = await seed();
      const provider = fakeProvider();
      const first = await stoppedLease(seeded, provider);
      const environment = (await environmentService(db).getById(seeded.environmentId))!;

      await expect(services(provider).runtime.resumeRunLease({
        environment, lease: toLease(await leaseRow(first.lease.id)),
      })).rejects.toThrow(/acquiring it/);
      expect(provider.sandboxes.get(first.lease.providerLeaseId!)!.replicas).toBe(0);
    });

    it("releases a Paperclip Runner lease instead of suspending it when its turn is stopped", async () => {
      const seeded = await seed();
      const provider = fakeProvider();
      const runId = await newRun(seeded);
      const acquired = await acquire(seeded, provider, runId);
      await db.update(environmentLeases).set({
        metadata: sql`${environmentLeases.metadata} || '{"reusableSandboxLease":{"version":1,"adapterType":"paperclip_runner"}}'::jsonb`,
      }).where(eq(environmentLeases.id, acquired.lease.id));
      await finishRun(runId, "cancelled");

      await services(provider).runtime.releaseRunLeases(runId, "released", undefined, "stop_and_retain");

      expect(provider.methods()).not.toContain("environmentStopLease");
      expect(provider.sandboxes.has(acquired.lease.providerLeaseId!)).toBe(false);
    });

    it("keeps a Paperclip Runner lease out of the stopped lifecycle when its run crashed", async () => {
      const seeded = await seed();
      const provider = fakeProvider();
      const runId = await newRun(seeded);
      const acquired = await acquire(seeded, provider, runId);
      await db.update(environmentLeases).set({
        updatedAt: new Date(Date.now() - 60 * 60_000),
        metadata: sql`${environmentLeases.metadata} || '{"reusableSandboxLease":{"version":1,"adapterType":"paperclip_runner"}}'::jsonb`,
      }).where(eq(environmentLeases.id, acquired.lease.id));
      await finishRun(runId, "failed");

      await services(provider).heartbeat.sweepOrphanedActiveLeases({ backoffMs: 5 * 60_000 });

      expect(provider.methods()).not.toContain("environmentStopLease");
      expect((await leaseRow(acquired.lease.id)).status).toBe("pending_cleanup");
    });

    it("releases, rather than stops, an ephemeral lease even when its files would survive", async () => {
      const seeded = await seed();
      await db.update(environments)
        .set({ config: sql`${environments.config} || '{"reuseLease":false}'::jsonb` })
        .where(eq(environments.id, seeded.environmentId));
      const provider = fakeProvider();
      const runId = await newRun(seeded);
      const acquired = await acquire(seeded, provider, runId);
      expect(acquired.lease.leasePolicy).toBe("ephemeral");
      await finishRun(runId, "cancelled");

      await services(provider).runtime.releaseRunLeases(runId, "released", undefined, "stop_and_retain");

      expect(provider.methods()).not.toContain("environmentStopLease");
      expect(provider.sandboxes.has(acquired.lease.providerLeaseId!)).toBe(false);
      expect((await leaseRow(acquired.lease.id)).status).not.toBe("stopped");
    });

    it("releases, rather than stops, a lease whose workspace would not survive", async () => {
      const seeded = await seed();
      const provider = fakeProvider({ keepsWorkspace: false });
      const runId = await newRun(seeded);
      const acquired = await acquire(seeded, provider, runId);
      await finishRun(runId, "cancelled");

      await services(provider).runtime.releaseRunLeases(runId, "released", undefined, "stop_and_retain");

      expect(provider.methods()).not.toContain("environmentStopLease");
      expect(provider.sandboxes.has(acquired.lease.providerLeaseId!)).toBe(false);
      expect((await leaseRow(acquired.lease.id)).status).not.toBe("pending_cleanup");
    });
  });
});
