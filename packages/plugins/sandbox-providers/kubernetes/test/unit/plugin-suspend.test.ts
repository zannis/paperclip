import { describe, it, expect, vi, beforeEach } from "vitest";

// Handler routing only: the suspend/resume mechanics are covered against a
// fake Sandbox CR in sandbox-suspend.test.ts.
const h = vi.hoisted(() => ({
  clients: {} as Record<string, unknown>,
  stop: vi.fn(),
  resume: vi.fn(),
  waitGone: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

vi.mock("../../src/sandbox-suspend.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/sandbox-suspend.js")>()),
  stopSuspendableSandbox: h.stop,
  resumeSuspendableSandbox: h.resume,
  waitForSandboxGone: h.waitGone,
}));

vi.mock("../../src/lease-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lease-lifecycle.js")>()),
  destroyLeaseResources: h.destroy,
}));

import plugin, { leaseWorkspaceSurvivesStop } from "../../src/plugin.js";

const CONFIG = { inCluster: true, backend: "sandbox-cr" };

function flaggedMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    namespace: "paperclip-acme",
    jobName: "pc-abc",
    podName: "pc-abc",
    secretName: "pc-abc-env",
    phase: "Running",
    backend: "sandbox-cr",
    remoteCwd: "/workspace",
    adapterType: "claude_local",
    workspaceSurvivesStop: true,
    sandboxEpoch: 4,
    scopedNetworkPolicyName: null,
    scopedNetworkEgress: { allowFqdns: [], allowCidrs: [] },
    ...overrides,
  };
}

const BASE = {
  driverKey: "kubernetes",
  companyId: "acme",
  environmentId: "env-1",
  config: CONFIG,
  providerLeaseId: "pc-abc",
};

beforeEach(() => {
  h.clients = {};
  h.stop.mockReset();
  h.resume.mockReset();
  h.waitGone.mockReset();
  h.destroy.mockReset();
});

describe("leaseWorkspaceSurvivesStop", () => {
  it("is true only for a sandbox-cr Sandbox built with workspace storage", () => {
    expect(leaseWorkspaceSurvivesStop({
      backend: "sandbox-cr",
      workspaceStorage: { storageClassName: "local-path", size: "1Gi" },
    })).toBe(true);
    expect(leaseWorkspaceSurvivesStop({ backend: "sandbox-cr" })).toBe(false);
    expect(leaseWorkspaceSurvivesStop({ backend: "job" })).toBe(false);
  });
});

describe("onEnvironmentStopLease", () => {
  it("suspends a lease whose workspace survives a stop and returns a stopped receipt", async () => {
    h.stop.mockResolvedValue("stopped");

    const receipt = await plugin.definition.onEnvironmentStopLease!({
      ...BASE,
      leaseMetadata: flaggedMetadata(),
    });

    expect(receipt).toEqual({ providerLeaseId: "pc-abc", state: "stopped" });
    expect(h.stop).toHaveBeenCalledWith(h.clients, expect.objectContaining({
      namespace: "paperclip-acme",
      name: "pc-abc",
      epoch: 4,
    }));
  });

  it("returns a destroyed receipt when the Sandbox is already gone", async () => {
    h.stop.mockResolvedValue("destroyed");

    await expect(plugin.definition.onEnvironmentStopLease!({
      ...BASE,
      leaseMetadata: flaggedMetadata(),
    })).resolves.toEqual({ providerLeaseId: "pc-abc", state: "destroyed" });
  });

  it("refuses a lease whose files would not survive, and never destroys it", async () => {
    await expect(plugin.definition.onEnvironmentStopLease!({
      ...BASE,
      leaseMetadata: flaggedMetadata({ workspaceSurvivesStop: false }),
    })).rejects.toThrow(/cannot retain/);
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.destroy).not.toHaveBeenCalled();
  });

  it("refuses a lease without an epoch", async () => {
    await expect(plugin.definition.onEnvironmentStopLease!({
      ...BASE,
      leaseMetadata: flaggedMetadata({ sandboxEpoch: undefined }),
    })).rejects.toThrow(/epoch/);
  });
});

describe("onEnvironmentResumeLease for a lease whose workspace survives a stop", () => {
  it("resumes through the fenced path and keeps the flag and the same lease id", async () => {
    h.resume.mockResolvedValue({ outcome: "ready", podName: "pc-abc", coldStart: true });

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      ...BASE,
      leaseMetadata: flaggedMetadata(),
    });

    expect(lease.providerLeaseId).toBe("pc-abc");
    expect(lease.metadata).toEqual(expect.objectContaining({
      workspaceSurvivesStop: true,
      adapterType: "claude_local",
      remoteCwd: "/workspace",
      podName: "pc-abc",
      coldResumed: true,
      resumedLease: true,
    }));
    expect(h.resume).toHaveBeenCalledWith(h.clients, expect.objectContaining({
      name: "pc-abc",
      epoch: 4,
      secretName: "pc-abc-env",
      adapterEnv: expect.objectContaining({
        PAPERCLIP_NETWORK_EGRESS_POLICY: "kubernetes-default-deny",
      }),
    }));
  });

  it("reports a re-created volume as a workspace identity mismatch, not a silent resume", async () => {
    h.resume.mockResolvedValue({ outcome: "volume_replaced" });

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      ...BASE,
      leaseMetadata: flaggedMetadata(),
    });

    expect(lease.providerLeaseId).toBeNull();
    expect(lease.metadata).toEqual(expect.objectContaining({
      workspaceSentinel: expect.objectContaining({ result: "volume_replaced" }),
    }));
  });

  it("reports a missing Sandbox as expired", async () => {
    h.resume.mockResolvedValue({ outcome: "missing" });

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      ...BASE,
      leaseMetadata: flaggedMetadata(),
    });

    expect(lease).toEqual({ providerLeaseId: null, metadata: expect.objectContaining({ expired: true }) });
  });
});

describe("onEnvironmentDestroyLease for a lease whose workspace survives a stop", () => {
  it("waits until the Sandbox, and with it the workspace PVC, is gone", async () => {
    h.destroy.mockResolvedValue(undefined);
    h.waitGone.mockResolvedValue(undefined);

    await plugin.definition.onEnvironmentDestroyLease!({
      ...BASE,
      leaseMetadata: flaggedMetadata(),
    });

    expect(h.destroy).toHaveBeenCalled();
    expect(h.waitGone).toHaveBeenCalledWith(h.clients, expect.objectContaining({ name: "pc-abc" }));
  });

  it("does not wait for leases without a kept workspace", async () => {
    h.destroy.mockResolvedValue(undefined);

    await plugin.definition.onEnvironmentDestroyLease!({
      ...BASE,
      leaseMetadata: flaggedMetadata({ workspaceSurvivesStop: undefined }),
    });

    expect(h.waitGone).not.toHaveBeenCalled();
  });
});
