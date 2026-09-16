import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("./onlybots-sync.sh", import.meta.url));
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Patch queue test",
  GIT_AUTHOR_EMAIL: "patch-queue@example.invalid",
  GIT_COMMITTER_NAME: "Patch queue test",
  GIT_COMMITTER_EMAIL: "patch-queue@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
const run = (cwd, cmd, args, extraEnv = {}) => exec(cmd, args, { cwd, env: { ...env, ...extraEnv } });
const git = async (cwd, ...args) => (await run(cwd, "git", args)).stdout.trim();
const sync = (cwd, ...args) => run(cwd, "bash", [script, ...args]);

async function fixture(t, conflict = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "onlybots-sync-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "upstream.git");
  const origin = path.join(root, "origin.git");
  await mkdir(repo);
  await git(root, "init", "--bare", remote);
  await git(root, "init", "--bare", origin);
  await git(repo, "init", "-b", "master");
  await writeFile(path.join(repo, "base.txt"), "base\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "base");
  const base = await git(repo, "rev-parse", "HEAD");
  await git(repo, "remote", "add", "upstream", remote);
  await git(repo, "remote", "add", "origin", origin);
  await git(repo, "push", "upstream", "master");
  await git(repo, "switch", "-c", "patches/onlybots");
  await writeFile(path.join(repo, conflict ? "base.txt" : "patch.txt"), "local patch\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "local patch");
  const source = await git(repo, "rev-parse", "HEAD");
  await git(repo, "push", "origin", "patches/onlybots");
  await git(repo, "switch", "master");
  await writeFile(path.join(repo, "base.txt"), "upstream change\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "upstream change");
  const upstream = await git(repo, "rev-parse", "HEAD");
  await git(repo, "push", "upstream", "master");
  const candidate = path.join(root, "candidate");
  return { root, repo, candidate, source, base, upstream };
}

test("prepare preserves the queue, rebases a candidate, and records immutable inputs", async (t) => {
  const f = await fixture(t);
  await sync(f.repo, "prepare", f.candidate, "sync/test");
  assert.equal(await git(f.repo, "rev-parse", "patches/onlybots"), f.source);
  assert.equal(await git(f.candidate, "rev-parse", "HEAD^"), f.upstream);
  assert.equal(await readFile(path.join(f.candidate, "patch.txt"), "utf8"), "local patch\n");
  assert.equal(await git(f.repo, "rev-parse", "refs/onlybots-sync/sync/test/source"), f.source);
  assert.equal(await git(f.repo, "rev-parse", "refs/onlybots-sync/sync/test/old-base"), f.base);
  await sync(f.candidate, "report");
  await assert.rejects(sync(f.candidate, "promote"), /has not passed verify/);
});

test("conflicts retain the candidate and never change the queue", async (t) => {
  const f = await fixture(t, true);
  await assert.rejects(sync(f.repo, "prepare", f.candidate, "sync/conflict"), /Candidate retained/);
  assert.equal(await git(f.repo, "rev-parse", "patches/onlybots"), f.source);
  assert.match(await git(f.candidate, "status", "--porcelain"), /UU base.txt/);
});

test("prepare rejects an unpublished local queue divergence", async (t) => {
  const f = await fixture(t);
  await git(f.repo, "update-ref", "refs/heads/patches/onlybots", f.base, f.source);
  await assert.rejects(sync(f.repo, "prepare", f.candidate, "sync/diverged"), /Local and remote.*differ/);
});

test("prepare does nothing when upstream is already contained in the queue", async (t) => {
  const f = await fixture(t);
  await sync(f.repo, "prepare", f.candidate, "sync/initial");
  const updated = await git(f.candidate, "rev-parse", "HEAD");
  await git(f.repo, "update-ref", "refs/heads/patches/onlybots", updated, f.source);
  await git(f.repo, "push", "--force-with-lease", "origin", "patches/onlybots");
  const result = await sync(f.repo, "prepare", path.join(f.root, "unused"), "sync/unchanged");
  assert.match(result.stdout, /no candidate created/);
  await assert.rejects(git(f.repo, "rev-parse", "--verify", "refs/heads/sync/unchanged"));
  assert.equal(await git(f.repo, "rev-parse", "patches/onlybots"), updated);
});

test("verification gates promotion on the exact clean commit and queue compare-and-swap", async (t) => {
  const f = await fixture(t);
  await sync(f.repo, "prepare", f.candidate, "sync/verified");
  const bin = path.join(f.root, "bin");
  await mkdir(bin);
  const log = path.join(f.root, "pnpm.log");
  // Fixture commands simulate tool outcomes; they do not certify real app tests.
  await writeFile(path.join(bin, "pnpm"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ONLYBOTS_TEST_LOG"\nif [ "$*" = "test:run" ] && [ "${ONLYBOTS_TEST_FAIL:-}" = 1 ]; then exit 1; fi\n', { mode: 0o755 });
  const check = (fail) => run(f.candidate, "bash", [script, "verify"], {
    PATH: `${bin}:${env.PATH}`,
    ONLYBOTS_TEST_LOG: log,
    ONLYBOTS_TEST_FAIL: fail ? "1" : "0",
  });
  await assert.rejects(check(true));
  await assert.rejects(sync(f.candidate, "promote"), /has not passed verify/);
  await check(false);
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n").slice(-4), [
    "install --frozen-lockfile", "build", "-r typecheck", "test:run",
  ]);
  await assert.rejects(check(true));
  await assert.rejects(sync(f.candidate, "promote"), /has not passed verify/);
  await check(false);
  await writeFile(path.join(f.candidate, "untracked.txt"), "dirty\n");
  await assert.rejects(sync(f.candidate, "promote"), /Commit or stash/);
  await rm(path.join(f.candidate, "untracked.txt"));
  await git(f.repo, "switch", "patches/onlybots");
  await assert.rejects(sync(f.candidate, "promote"), /checked out in another worktree/);
  await git(f.repo, "switch", "master");
  await git(f.repo, "update-ref", "refs/heads/patches/onlybots", f.base, f.source);
  await assert.rejects(sync(f.candidate, "promote"), /expected/);
  await git(f.repo, "update-ref", "refs/heads/patches/onlybots", f.source, f.base);
  await sync(f.candidate, "promote");
  assert.equal(await git(f.repo, "rev-parse", "patches/onlybots"), await git(f.candidate, "rev-parse", "HEAD"));
  assert.equal(await git(f.repo, "rev-parse", "origin/patches/onlybots"), f.source);
  await writeFile(path.join(f.candidate, "patch.txt"), "changed after verification\n");
  await git(f.candidate, "add", ".");
  await git(f.candidate, "commit", "-m", "unverified revision");
  await assert.rejects(sync(f.candidate, "promote"), /has not passed verify/);
});
