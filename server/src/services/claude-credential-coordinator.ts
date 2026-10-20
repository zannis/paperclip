// Keeps every concurrent run on one Claude subscription grant on the same
// refresh token.
//
// Anthropic rotates the refresh token on every use, so the first run to
// refresh invalidates the copy every other run holds. The refreshed document
// used to reach storage only when that run finished. A run staged in between
// got the invalidated refresh token, failed its first refresh and lost the
// credential. A long run therefore broke the connection every time the access
// token expired, about every eight hours, until it finished.
//
// The coordinator closes that window in three ways:
//   - It polls each run's `.credentials.json` and writes a changed document
//     back as soon as the CLI rewrites it, instead of at the end of the run.
//   - It copies a stored refresh into the files of the grant's other active
//     runs, so a sibling CLI can pick it up from disk instead of spending a
//     refresh token that is already invalid.
//   - When the stored access token is about to expire, the first run staged
//     becomes the refresher. Runs staged after it wait for its write-back and
//     then stage the refreshed document.
//
// The state is in-process. It covers the runs of one server process, which is
// how a single instance executes every run for a grant.

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { logger } from "../middleware/logger.js";
import {
  USE_SOURCE,
  claudeAccessTokenExpiresAtMs,
  claudeRefreshTokenFingerprint,
  decideClaudeAuthMerge,
} from "./claude-credential-document.js";

/** How often a run's credential file is checked for a refresh. */
export const CLAUDE_CREDENTIAL_POLL_MS = 2_000;
/**
 * A stored access token closer than this to expiry counts as about to be
 * refreshed. Claude Code refreshes ahead of the expiry, so the window
 * starts before the token has expired.
 */
export const CLAUDE_REFRESH_WINDOW_MS = 10 * 60_000;
/**
 * How long a refresher may hold the turn before followers stop waiting. A run
 * that never makes an API call never refreshes, and a follower must not stall
 * on it indefinitely.
 */
export const CLAUDE_REFRESH_TURN_MS = 90_000;

type TrackedRun = {
  id: string;
  authFile: string;
  /** The last document this run's file held that the coordinator has handled. */
  seen: string;
  writeBack: (refreshed: string, phase: "mid_run" | "run_end") => Promise<number | null>;
  /** Serializes this run's file reads and write-backs. */
  chain: Promise<void>;
  timer: NodeJS.Timeout | null;
};

type RefreshTurn = { holder: string; settled: Promise<void>; settle: () => void; timer: NodeJS.Timeout };

type GrantState = { runs: Map<string, TrackedRun>; turn: RefreshTurn | null };

const grants = new Map<string, GrantState>();

function grantState(grantId: string): GrantState {
  let state = grants.get(grantId);
  if (!state) {
    state = { runs: new Map(), turn: null };
    grants.set(grantId, state);
  }
  return state;
}

function dropIfIdle(grantId: string) {
  const state = grants.get(grantId);
  if (state && state.runs.size === 0 && !state.turn) grants.delete(grantId);
}

function endTurn(grantId: string, holder?: string) {
  const state = grants.get(grantId);
  const turn = state?.turn;
  if (!state || !turn || (holder && turn.holder !== holder)) return;
  clearTimeout(turn.timer);
  state.turn = null;
  turn.settle();
  dropIfIdle(grantId);
}

function needsRefresh(value: string, nowMs: number): boolean {
  const expiresAt = claudeAccessTokenExpiresAtMs(value);
  return expiresAt !== null && expiresAt - nowMs < CLAUDE_REFRESH_WINDOW_MS;
}

export type ClaudeRefreshClaim =
  | { kind: "wait"; settled: Promise<void> }
  | { kind: "proceed"; holder: string | null };

/**
 * Decides, synchronously, whether a run about to stage `stored` may proceed.
 * When the stored access token is about to expire and another run holds the
 * refresh turn, the caller waits on `settled` and reads the credential again.
 * Otherwise it proceeds; if the token is about to expire it takes the turn,
 * and `holder` identifies it to `trackClaudeRun` or `releaseClaudeRefresh`.
 */
export function claimClaudeRefresh(grantId: string, stored: string, nowMs = Date.now()): ClaudeRefreshClaim {
  if (!needsRefresh(stored, nowMs)) return { kind: "proceed", holder: null };
  const state = grantState(grantId);
  if (state.turn) return { kind: "wait", settled: state.turn.settled };
  const holder = randomUUID();
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const timer = setTimeout(() => endTurn(grantId, holder), CLAUDE_REFRESH_TURN_MS);
  timer.unref();
  state.turn = { holder, settled, settle, timer };
  return { kind: "proceed", holder };
}

/** Gives up a refresh turn whose run was never tracked, e.g. when staging failed. */
export function releaseClaudeRefresh(grantId: string, holder: string | null) {
  if (holder) endTurn(grantId, holder);
}

/**
 * Waits for the refresh turn the caller was told to wait on, bounded by the
 * turn's own timeout. Resolves once the refresher stored a document, finished
 * or timed out.
 */
export async function awaitClaudeRefresh(grantId: string, settled: Promise<void>) {
  const started = Date.now();
  await settled;
  logger.info(
    { event: "claude_credential_refresh_wait", grantId, waitedMs: Date.now() - started },
    "Claude run waited for a concurrent refresh before staging",
  );
}

async function writeAtomically(file: string, value: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, file);
}

// After `source` stored `value`, hand it to every sibling whose file still
// holds what the coordinator last saw there. A file the sibling's CLI has
// rewritten is left for that run's own poll to judge.
async function propagate(grantId: string, source: TrackedRun, value: string) {
  const state = grants.get(grantId);
  if (!state) return;
  for (const sibling of state.runs.values()) {
    if (sibling.id === source.id) continue;
    const next = sibling.chain.then(async () => {
      const current = await readFile(sibling.authFile, "utf8").catch(() => null);
      if (current === null || current !== sibling.seen) return;
      if (decideClaudeAuthMerge(value, current) !== USE_SOURCE) return;
      await writeAtomically(sibling.authFile, value);
      sibling.seen = value;
      logger.info(
        {
          event: "claude_credential_propagated",
          grantId,
          refreshTokenFingerprint: claudeRefreshTokenFingerprint(value),
        },
        "Claude refreshed credential copied into a concurrent run",
      );
    });
    sibling.chain = next.catch((error) =>
      logger.warn({ err: error, grantId }, "Claude credential propagation to a concurrent run failed"),
    );
  }
}

function check(grantId: string, run: TrackedRun, phase: "mid_run" | "run_end") {
  const next = run.chain.then(async () => {
    const current = await readFile(run.authFile, "utf8").catch(() => null);
    if (current === null || current === run.seen) return;
    run.seen = current;
    const decision = await run.writeBack(current, phase);
    if (decision !== USE_SOURCE) return;
    // A stored document that is itself still about to expire does not end
    // the turn: followers would stage it and refresh it again.
    if (!needsRefresh(current, Date.now())) endTurn(grantId);
    await propagate(grantId, run, current);
  });
  run.chain = next.catch((error) =>
    logger.warn({ err: error, grantId, phase }, "Claude credential write-back failed"),
  );
  return run.chain;
}

export type TrackedClaudeRun = {
  /**
   * Stops polling, writes back whatever the run's file holds now, and
   * removes the run. Returns true when the file still held the document the
   * run was staged with, i.e. the run never refreshed.
   */
  finish: () => Promise<boolean>;
};

/**
 * Starts watching a staged run's credential file. `writeBack` persists a
 * changed document and returns the merge decision, or null when the grant
 * no longer accepts write-backs.
 */
export function trackClaudeRun(input: {
  grantId: string;
  authFile: string;
  staged: string;
  holder: string | null;
  writeBack: TrackedRun["writeBack"];
}): TrackedClaudeRun {
  const state = grantState(input.grantId);
  const run: TrackedRun = {
    id: input.holder ?? randomUUID(),
    authFile: input.authFile,
    seen: input.staged,
    writeBack: input.writeBack,
    chain: Promise.resolve(),
    timer: null,
  };
  state.runs.set(run.id, run);
  run.timer = setInterval(() => void check(input.grantId, run, "mid_run"), CLAUDE_CREDENTIAL_POLL_MS);
  run.timer.unref();
  return {
    finish: async () => {
      if (run.timer) clearInterval(run.timer);
      run.timer = null;
      await check(input.grantId, run, "run_end");
      grants.get(input.grantId)?.runs.delete(run.id);
      endTurn(input.grantId, run.id);
      dropIfIdle(input.grantId);
      return run.seen === input.staged;
    },
  };
}
