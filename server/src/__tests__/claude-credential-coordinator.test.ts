import { describe, expect, it } from "vitest";
import {
  CLAUDE_REFRESH_WINDOW_MS,
  claimClaudeRefresh,
  releaseClaudeRefresh,
} from "../services/claude-credential-coordinator.js";

const document = (expiresAt: number) =>
  JSON.stringify({ claudeAiOauth: { accessToken: "access", refreshToken: "refresh", expiresAt } });

describe("claimClaudeRefresh", () => {
  const now = 1_800_000_000_000;

  it("lets every run proceed while the stored access token is far from expiry", () => {
    const fresh = document(now + CLAUDE_REFRESH_WINDOW_MS * 2);
    expect(claimClaudeRefresh("grant-fresh", fresh, now)).toEqual({ kind: "proceed", holder: null });
    expect(claimClaudeRefresh("grant-fresh", fresh, now)).toEqual({ kind: "proceed", holder: null });
  });

  it("gives the refresh turn to one run and makes the next one wait", () => {
    const expiring = document(now + 60_000);
    const first = claimClaudeRefresh("grant-expiring", expiring, now);
    expect(first.kind).toBe("proceed");
    expect(first.kind === "proceed" && first.holder).toBeTruthy();
    expect(claimClaudeRefresh("grant-expiring", expiring, now).kind).toBe("wait");
    releaseClaudeRefresh("grant-expiring", first.kind === "proceed" ? first.holder : null);
  });

  it("wakes the waiting run and hands the turn on when staging fails before the run is tracked", async () => {
    const expiring = document(now + 60_000);
    const first = claimClaudeRefresh("grant-released", expiring, now);
    const second = claimClaudeRefresh("grant-released", expiring, now);
    if (first.kind !== "proceed" || second.kind !== "wait") throw new Error("unexpected claims");
    releaseClaudeRefresh("grant-released", first.holder);
    await second.settled;
    const next = claimClaudeRefresh("grant-released", expiring, now);
    expect(next.kind).toBe("proceed");
    releaseClaudeRefresh("grant-released", next.kind === "proceed" ? next.holder : null);
  });

  it("leaves a document without a readable expiry alone", () => {
    expect(claimClaudeRefresh("grant-bare", "bare-token", now)).toEqual({ kind: "proceed", holder: null });
  });
});
