import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
  issues,
  plugins,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { environmentService } from "../services/environments.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres retained warm lease reclaim tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const IDLE_TIMEOUT_MS = 15 * 60_000;

// A retained warm lease keeps its provider Sandbox running between turns. These
// tests drive the server against a real Postgres. Only the provider plugin
// worker is faked: it is the external boundary that owns the Sandbox.
describeEmbeddedPostgres("retained warm lease reclaim", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-retained-warm-lease-reclaim-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(environments);
    await db.delete(plugins);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function fakeProvider(options: { destroyFails?: boolean } = {}) {
    const destroyed: string[] = [];
    const call = vi.fn(async (_pluginId: string, method: string, input: { providerLeaseId?: string }) => {
      if (method === "environmentDestroyLease") {
        if (options.destroyFails) throw new Error("provider destroy failed");
        destroyed.push(input.providerLeaseId!);
        return { providerLeaseId: input.providerLeaseId, state: "destroyed" };
      }
      throw new Error(`Unexpected provider method: ${method}`);
    });
    const pluginWorkerManager = {
      isRunning: () => true,
      getWorker: () => ({ supportedMethods: ["environmentReleaseLease", "environmentDestroyLease"] }),
      call,
    } as unknown as PluginWorkerManager;
    return { destroyed, call, pluginWorkerManager };
  }

  async function seed(input: {
    lifecycle?: Record<string, unknown>;
    issueStatus?: string;
    runStatus?: string;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const pluginId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.warm-sandbox-provider",
      packageName: "@acme/warm-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.warm-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Warm Sandbox Provider",
        description: "Test provider with reusable lease support",
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
        ...(input.lifecycle ?? { runnerLifecycleMode: "warm", runnerIdleTimeoutMs: IDLE_TIMEOUT_MS }),
      },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Warm work",
      status: input.issueStatus ?? "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: input.runStatus ?? "succeeded",
      nextEventSeq: 1,
    });
    return { companyId, agentId, environmentId, pluginId, issueId, runId };
  }

  async function insertLease(seeded: Awaited<ReturnType<typeof seed>>, input: {
    status: "active" | "retained" | "released";
    lastUsedAt?: Date;
    providerLeaseId?: string;
    metadata?: Record<string, unknown>;
  }) {
    const id = randomUUID();
    await db.insert(environmentLeases).values({
      id,
      companyId: seeded.companyId,
      environmentId: seeded.environmentId,
      issueId: seeded.issueId,
      heartbeatRunId: seeded.runId,
      status: input.status,
      leasePolicy: "reuse_by_environment",
      provider: "fake-plugin",
      providerLeaseId: input.providerLeaseId ?? `pc-${id.slice(0, 8)}`,
      lastUsedAt: input.lastUsedAt ?? new Date(),
      cleanupStatus: input.status === "active" ? null : "success",
      releasedAt: input.status === "released" ? new Date() : null,
      metadata: {
        ...input.metadata,
        agentId: seeded.agentId,
        driver: "sandbox",
        pluginId: seeded.pluginId,
        pluginKey: "acme.warm-sandbox-provider",
        sandboxProviderPlugin: true,
        provider: "fake-plugin",
        image: "fake:test",
        reuseLease: true,
      },
    });
    return id;
  }

  async function leaseRow(id: string) {
    const [row] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, id));
    return row!;
  }

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  describe("idle reclaim", () => {
    it("destroys a retained lease's Sandbox once it has been idle longer than runnerIdleTimeoutMs", async () => {
      const seeded = await seed();
      const leaseId = await insertLease(seeded, { status: "retained", lastUsedAt: minutesAgo(16) });
      const provider = fakeProvider();
      const runtime = environmentRuntimeService(db, { pluginWorkerManager: provider.pluginWorkerManager });

      const result = await runtime.reclaimIdleRetainedLeases();

      expect(result).toMatchObject({ reclaimed: 1, failed: 0 });
      const row = await leaseRow(leaseId);
      expect(provider.destroyed).toEqual([row.providerLeaseId]);
      expect(row.status).toBe("expired");
      expect(row.cleanupStatus).toBe("success");
      expect(row.failureReason).toBe("retained_lease_idle_timeout");
      expect(row.releasedAt).not.toBeNull();
    });

    it("keeps a retained lease that is still inside runnerIdleTimeoutMs", async () => {
      const seeded = await seed();
      const leaseId = await insertLease(seeded, { status: "retained", lastUsedAt: minutesAgo(14) });
      const provider = fakeProvider();
      const runtime = environmentRuntimeService(db, { pluginWorkerManager: provider.pluginWorkerManager });

      expect(await runtime.reclaimIdleRetainedLeases()).toMatchObject({ reclaimed: 0, failed: 0 });

      expect(provider.call).not.toHaveBeenCalled();
      expect(await leaseRow(leaseId)).toMatchObject({ status: "retained", cleanupStatus: "success", releasedAt: null });
    });

    it("keeps a lease a run picked up before the bound, and restarts the idle clock when it is retained again", async () => {
      const seeded = await seed();
      const leaseId = await insertLease(seeded, { status: "retained", lastUsedAt: minutesAgo(10) });
      const provider = fakeProvider();
      const runtime = environmentRuntimeService(db, { pluginWorkerManager: provider.pluginWorkerManager });

      // A new run re-acquires the retained Sandbox before the bound expires.
      const nextRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: nextRunId, companyId: seeded.companyId, agentId: seeded.agentId,
        invocationSource: "on_demand", status: "running", nextEventSeq: 1,
      });
      await db.update(environmentLeases)
        .set({ status: "active", heartbeatRunId: nextRunId, lastUsedAt: minutesAgo(10), releasedAt: null, cleanupStatus: null })
        .where(eq(environmentLeases.id, leaseId));
      // Even once the original idle window has passed, an active lease is in use.
      await db.update(environmentLeases).set({ lastUsedAt: minutesAgo(20) }).where(eq(environmentLeases.id, leaseId));
      expect(await runtime.reclaimIdleRetainedLeases()).toMatchObject({ reclaimed: 0 });
      expect((await leaseRow(leaseId)).status).toBe("active");

      // The run ends warm: releasing it as retained stamps a fresh lastUsedAt.
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, nextRunId));
      await runtime.releaseRunLeases(nextRunId, "released", undefined, "keep_running");
      expect((await leaseRow(leaseId)).status).toBe("retained");
      expect(await runtime.reclaimIdleRetainedLeases()).toMatchObject({ reclaimed: 0 });

      expect(provider.call).not.toHaveBeenCalled();
      expect((await leaseRow(leaseId)).status).toBe("retained");
    });

    it("keeps today's behaviour when the environment has no warm idle timeout", async () => {
      const seeded = await seed({ lifecycle: { runnerLifecycleMode: "per_turn" } });
      const leaseId = await insertLease(seeded, { status: "retained", lastUsedAt: minutesAgo(24 * 60) });
      const provider = fakeProvider();
      const runtime = environmentRuntimeService(db, { pluginWorkerManager: provider.pluginWorkerManager });

      expect(await runtime.reclaimIdleRetainedLeases()).toMatchObject({ reclaimed: 0, failed: 0 });

      expect(provider.call).not.toHaveBeenCalled();
      expect((await leaseRow(leaseId)).status).toBe("retained");
    });

    it("records a failed provider destroy as a failure, never as cleaned up", async () => {
      const seeded = await seed();
      const leaseId = await insertLease(seeded, { status: "retained", lastUsedAt: minutesAgo(16) });
      const provider = fakeProvider({ destroyFails: true });
      const runtime = environmentRuntimeService(db, { pluginWorkerManager: provider.pluginWorkerManager });

      expect(await runtime.reclaimIdleRetainedLeases()).toMatchObject({ reclaimed: 0, failed: 1 });

      expect(provider.call.mock.calls.map((call) => call[1])).toEqual(["environmentDestroyLease"]);
      const row = await leaseRow(leaseId);
      expect(row.status).toBe("pending_cleanup");
      expect(row.cleanupStatus).toBe("failed");
      // The pending_cleanup sweep retries it on its normal backoff.
      expect(row.metadata).toMatchObject({ pendingCleanupInFlight: false });
      expect(row.metadata?.pendingCleanupRetryAfterMs).toBeGreaterThan(Date.now());
      expect(row.metadata?.pendingCleanupRetryAfterMs).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    });

    it("runs on the heartbeat lease cleanup sweep", async () => {
      const seeded = await seed();
      const leaseId = await insertLease(seeded, { status: "retained", lastUsedAt: minutesAgo(16) });
      const provider = fakeProvider();
      const heartbeat = heartbeatService(db, { pluginWorkerManager: provider.pluginWorkerManager });

      await heartbeat.sweepIdleRetainedLeases();

      const row = await leaseRow(leaseId);
      expect(provider.destroyed).toEqual([row.providerLeaseId]);
      expect(row).toMatchObject({ status: "expired", cleanupStatus: "success" });
    });
    it("reclaims a Sandbox once when two sweeps race for it", async () => {
      const seeded = await seed();
      const leaseId = await insertLease(seeded, { status: "retained", lastUsedAt: minutesAgo(16) });
      const provider = fakeProvider();
      const first = environmentRuntimeService(db, { pluginWorkerManager: provider.pluginWorkerManager });
      const second = environmentRuntimeService(db, { pluginWorkerManager: provider.pluginWorkerManager });

      const results = await Promise.all([first.reclaimIdleRetainedLeases(), second.reclaimIdleRetainedLeases()]);

      expect(results.reduce((sum, result) => sum + result.reclaimed, 0)).toBe(1);
      expect(provider.destroyed).toHaveLength(1);
      expect(await leaseRow(leaseId)).toMatchObject({ status: "expired", cleanupStatus: "success" });
    });

    it("leaves a Paperclip Runner lease alone, because its next turn needs the lease to restore harness state", async () => {
      const seeded = await seed();
      const leaseId = await insertLease(seeded, {
        status: "retained",
        lastUsedAt: minutesAgo(16),
        metadata: { reusableSandboxLease: { version: 1, adapterType: "paperclip_runner" } },
      });
      const provider = fakeProvider();
      const runtime = environmentRuntimeService(db, { pluginWorkerManager: provider.pluginWorkerManager });

      expect(await runtime.reclaimIdleRetainedLeases()).toMatchObject({ reclaimed: 0, failed: 0 });

      expect(provider.call).not.toHaveBeenCalled();
      expect((await leaseRow(leaseId)).status).toBe("retained");
    });

    it("waits for the provider worker instead of parking the lease as a failed cleanup", async () => {
      const seeded = await seed();
      const leaseId = await insertLease(seeded, { status: "retained", lastUsedAt: minutesAgo(16) });
      const provider = fakeProvider();
      const runtime = environmentRuntimeService(db, {
        pluginWorkerManager: { ...provider.pluginWorkerManager, isRunning: () => false } as unknown as PluginWorkerManager,
      });

      expect(await runtime.reclaimIdleRetainedLeases()).toEqual({ reclaimed: 0, failed: 0 });

      expect(provider.call).not.toHaveBeenCalled();
      expect(await leaseRow(leaseId)).toMatchObject({ status: "retained", cleanupStatus: "success" });
    });

    it("never destroys a Sandbox another reusable lease row still holds", async () => {
      const seeded = await seed();
      const providerLeaseId = "pc-shared";
      const leaseId = await insertLease(seeded, { status: "retained", lastUsedAt: minutesAgo(16), providerLeaseId });
      await insertLease(seeded, { status: "released", providerLeaseId });
      const provider = fakeProvider();
      const runtime = environmentRuntimeService(db, { pluginWorkerManager: provider.pluginWorkerManager });

      expect(await runtime.reclaimIdleRetainedLeases()).toEqual({ reclaimed: 0, failed: 0 });

      expect(provider.call).not.toHaveBeenCalled();
      expect((await leaseRow(leaseId)).status).toBe("retained");
    });

    it("does not destroy a Sandbox that a new run is resuming when the sweep runs", async () => {
      const seeded = await seed({ runStatus: "running" });
      const destroyed: string[] = [];
      let sweepDuringResume: { reclaimed: number; failed: number } | null = null;
      let runtime!: ReturnType<typeof environmentRuntimeService>;
      const call = vi.fn(async (_pluginId: string, method: string, input: { providerLeaseId?: string }) => {
        if (method === "environmentAcquireLease") {
          return { providerLeaseId: "pc-warm", metadata: { remoteCwd: "/workspace" } };
        }
        if (method === "environmentResumeLease") {
          // The sweep ticks while the provider is still resuming the Sandbox.
          sweepDuringResume = await runtime.reclaimIdleRetainedLeases();
          return { providerLeaseId: "pc-warm", metadata: { remoteCwd: "/workspace" } };
        }
        if (method === "environmentDestroyLease") {
          destroyed.push(input.providerLeaseId!);
          return { providerLeaseId: input.providerLeaseId, state: "destroyed" };
        }
        throw new Error(`Unexpected provider method: ${method}`);
      });
      runtime = environmentRuntimeService(db, {
        pluginWorkerManager: {
          isRunning: () => true,
          getWorker: () => ({
            supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"],
          }),
          call,
        } as unknown as PluginWorkerManager,
      });
      const environment = (await environmentService(db).getById(seeded.environmentId))!;
      const acquire = (heartbeatRunId: string) => runtime.acquireRunLease({
        companyId: seeded.companyId,
        environment,
        issueId: seeded.issueId,
        agentId: seeded.agentId,
        heartbeatRunId,
        persistedExecutionWorkspace: null,
      });

      const first = await acquire(seeded.runId);
      expect(first.lease.leasePolicy).toBe("reuse_by_environment");
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, seeded.runId));
      await runtime.releaseRunLeases(seeded.runId, "released", undefined, "keep_running");
      await db.update(environmentLeases).set({ lastUsedAt: minutesAgo(16) }).where(eq(environmentLeases.id, first.lease.id));

      const nextRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: nextRunId, companyId: seeded.companyId, agentId: seeded.agentId,
        invocationSource: "on_demand", status: "running", nextEventSeq: 1,
      });
      const next = await acquire(nextRunId);

      expect(sweepDuringResume).toEqual({ reclaimed: 0, failed: 0 });
      expect(destroyed).toEqual([]);
      expect(next.lease).toMatchObject({ status: "active", providerLeaseId: "pc-warm" });
    });
  });

  describe("in-turn self-close", () => {
    it("destroys the warm Sandbox when the run closed its own issue", async () => {
      const seeded = await seed({ issueStatus: "done" });
      const leaseId = await insertLease(seeded, { status: "active" });
      const provider = fakeProvider();
      const heartbeat = heartbeatService(db, { pluginWorkerManager: provider.pluginWorkerManager });

      await heartbeat.releaseEnvironmentLeasesForRun({
        runId: seeded.runId,
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        status: "succeeded",
        providerResourceDisposition: "keep_running",
      });

      const row = await leaseRow(leaseId);
      expect(provider.destroyed).toEqual([row.providerLeaseId]);
      expect(row.status).toBe("expired");
      expect(row.cleanupStatus).toBe("success");
      expect(row.failureReason).toBe("issue_terminal_done");
    });

    it("keeps a Paperclip Runner lease on the existing retention lifecycle", async () => {
      const seeded = await seed({ issueStatus: "done" });
      const leaseId = await insertLease(seeded, {
        status: "active",
        metadata: { reusableSandboxLease: { version: 1, adapterType: "paperclip_runner" } },
      });
      const provider = fakeProvider();
      const heartbeat = heartbeatService(db, { pluginWorkerManager: provider.pluginWorkerManager });

      await heartbeat.releaseEnvironmentLeasesForRun({
        runId: seeded.runId,
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        status: "succeeded",
        providerResourceDisposition: "keep_running",
      });

      expect(provider.call).not.toHaveBeenCalled();
      expect((await leaseRow(leaseId)).status).toBe("retained");
    });

    it("keeps the warm Sandbox when the issue is still open", async () => {
      const seeded = await seed({ issueStatus: "in_progress" });
      const leaseId = await insertLease(seeded, { status: "active" });
      const provider = fakeProvider();
      const heartbeat = heartbeatService(db, { pluginWorkerManager: provider.pluginWorkerManager });

      await heartbeat.releaseEnvironmentLeasesForRun({
        runId: seeded.runId,
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        status: "succeeded",
        providerResourceDisposition: "keep_running",
      });

      expect(provider.call).not.toHaveBeenCalled();
      expect(await leaseRow(leaseId)).toMatchObject({ status: "retained", cleanupStatus: "success" });
    });
  });

  describe("lease row truth", () => {
    it("does not record a handed-off lease as cleaned up while its Sandbox keeps running", async () => {
      const seeded = await seed();
      const providerLeaseId = "pc-handoff";
      const oldLeaseId = await insertLease(seeded, { status: "retained", providerLeaseId });
      const nextRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: nextRunId, companyId: seeded.companyId, agentId: seeded.agentId,
        invocationSource: "on_demand", status: "running", nextEventSeq: 1,
      });

      const next = await environmentService(db).acquireLease({
        companyId: seeded.companyId,
        environmentId: seeded.environmentId,
        issueId: seeded.issueId,
        heartbeatRunId: nextRunId,
        leasePolicy: "reuse_by_environment",
        provider: "fake-plugin",
        providerLeaseId,
        metadata: { agentId: seeded.agentId },
        replacesReusableLeaseId: oldLeaseId,
      });

      expect(next).toMatchObject({ status: "active", providerLeaseId });
      const old = await leaseRow(oldLeaseId);
      expect(old.status).toBe("expired");
      expect(old.cleanupStatus).toBeNull();
      // A handoff is the normal warm path, not a failure.
      expect(old.failureReason).toBeNull();
    });

    it("keeps the confirmed stop of a released lease when a new run takes its Sandbox over", async () => {
      const seeded = await seed();
      const providerLeaseId = "pc-stopped";
      const oldLeaseId = await insertLease(seeded, { status: "released", providerLeaseId });
      const nextRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: nextRunId, companyId: seeded.companyId, agentId: seeded.agentId,
        invocationSource: "on_demand", status: "running", nextEventSeq: 1,
      });

      await environmentService(db).acquireLease({
        companyId: seeded.companyId,
        environmentId: seeded.environmentId,
        issueId: seeded.issueId,
        heartbeatRunId: nextRunId,
        leasePolicy: "reuse_by_environment",
        provider: "fake-plugin",
        providerLeaseId,
        metadata: { agentId: seeded.agentId },
        replacesReusableLeaseId: oldLeaseId,
      });

      expect(await leaseRow(oldLeaseId)).toMatchObject({
        status: "expired", cleanupStatus: "success", failureReason: null,
      });
    });
  });
});
