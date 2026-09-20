import { describe, expect, it } from "vitest";
import { classifyContinuationFailure } from "../services/recovery/service.js";

const run = (errorCode: string) => ({ errorCode } as Parameters<typeof classifyContinuationFailure>[0]);

describe("classifyContinuationFailure", () => {
  it.each(["acpx_transient_upstream", "claude_transient_upstream", "codex_transient_upstream"])(
    "gives %s the transient budget with exponential backoff",
    (errorCode) => {
      expect(classifyContinuationFailure(run(errorCode))).toMatchObject({
        kind: "transient_infra",
        maxAttempts: 6,
        baseBackoffMs: 60_000,
        errorCode,
      });
    },
  );

  it("keeps a bare turn failure on the single default retry", () => {
    expect(classifyContinuationFailure(run("acpx_turn_failed"))).toMatchObject({
      kind: "default",
      maxAttempts: 1,
    });
  });
});
