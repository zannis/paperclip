import { describe, expect, it, vi } from "vitest";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import {
  REUSABLE_SANDBOX_RESUME_FAILED_CODE,
  ReusableSandboxResumeError,
  reusableSandboxResumeFailureCode,
} from "../services/environment-runtime.ts";
import { EnvironmentRunError } from "../services/environment-run-orchestrator.ts";

// A run that cannot resume its kept workspace fails before any provider work.
// The cause can be a slow cold start, so the run gets the bounded transient
// retry instead of failing the issue's execution for good.
describe("reusableSandboxResumeFailureCode", () => {
  it("classifies a resume failure wrapped by the lease acquisition", () => {
    const resumeError = new ReusableSandboxResumeError({ provider: "kubernetes", providerLeaseId: "pc-1" });
    const wrapped = new EnvironmentRunError("lease_acquire_failed", "Failed to acquire lease", { cause: resumeError });

    expect(reusableSandboxResumeFailureCode(wrapped)).toBe(REUSABLE_SANDBOX_RESUME_FAILED_CODE);
    expect(reusableSandboxResumeFailureCode(resumeError)).toBe(REUSABLE_SANDBOX_RESUME_FAILED_CODE);
  });

  it("leaves other setup failures alone", () => {
    expect(reusableSandboxResumeFailureCode(new Error("boom"))).toBeNull();
    expect(reusableSandboxResumeFailureCode(
      new EnvironmentRunError("lease_acquire_failed", "Failed", { cause: new Error("quota exceeded") }),
    )).toBeNull();
    expect(reusableSandboxResumeFailureCode(undefined)).toBeNull();
  });
});
