import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { waitForSettledCredentialFile } from "../services/local-ai-login.js";

// `claude auth login` can rewrite `.credentials.json` after its first write.
// Completion must read the copy the CLI left behind, not the first readable one.
const timings = { settleMs: 300, timeoutMs: 3_000, pollMs: 25 };

describe("waitForSettledCredentialFile", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-settle-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("returns at once when the file is already older than the settle window", async () => {
    const file = path.join(directory, ".credentials.json");
    await writeFile(file, "{}");
    const old = new Date(Date.now() - 60_000);
    await utimes(file, old, old);
    const started = Date.now();
    await expect(waitForSettledCredentialFile(directory, "anthropic", timings)).resolves.toBe(true);
    expect(Date.now() - started).toBeLessThan(timings.settleMs);
  });

  it("waits out a late rewrite before returning", async () => {
    const file = path.join(directory, ".credentials.json");
    await writeFile(file, "first");
    let rewrittenAt = 0;
    const rewrite = new Promise<void>((resolve) =>
      setTimeout(() => void writeFile(file, "second").then(() => { rewrittenAt = Date.now(); resolve(); }), 150));
    await expect(waitForSettledCredentialFile(directory, "anthropic", timings)).resolves.toBe(true);
    await rewrite;
    expect(rewrittenAt).toBeGreaterThan(0);
    expect(Date.now() - rewrittenAt).toBeGreaterThanOrEqual(timings.settleMs - timings.pollMs);
  });

  it("does not wait for a missing file or for other providers", async () => {
    await expect(waitForSettledCredentialFile(directory, "anthropic", timings)).resolves.toBe(true);
    await writeFile(path.join(directory, ".credentials.json"), "{}");
    const started = Date.now();
    await expect(waitForSettledCredentialFile(directory, "openai", timings)).resolves.toBe(true);
    expect(Date.now() - started).toBeLessThan(timings.settleMs);
  });

  it("gives up after the timeout when the file keeps changing", async () => {
    const file = path.join(directory, ".credentials.json");
    await writeFile(file, "start");
    const churn = setInterval(() => void writeFile(file, String(Date.now())), 50);
    try {
      await expect(waitForSettledCredentialFile(directory, "anthropic", { ...timings, timeoutMs: 600 })).resolves.toBe(false);
    } finally {
      clearInterval(churn);
    }
  });
});
