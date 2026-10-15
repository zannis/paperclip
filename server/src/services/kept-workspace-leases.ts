import { sql } from "drizzle-orm";
import { environmentLeases } from "@paperclipai/db";

/**
 * A reusable sandbox lease whose provider keeps the workspace volume across a
 * stop. The Kubernetes provider stops such a Sandbox by deleting its pod
 * (replicas 0) and keeps the Sandbox and its workspace PVC, so an idle lease
 * gives back its CPU and memory and the next run resumes on the same files.
 *
 * Such a lease moves through `stopped`, a status distinct from `released`: the
 * compute is gone (or being stopped) but the provider still holds the volume,
 * so `cleanupStatus` stays `pending` until a terminal path destroys it.
 *
 * Every resume claim bumps `sandboxEpoch`, and the provider fences both stop
 * and resume on it. A stop is confirmed only for the epoch it ran at, so a
 * resume that claimed the lease after the last confirmed stop leaves the row
 * unconfirmed and the reconciler stops the Sandbox again once that run ends.
 */

export const KEPT_WORKSPACE_STOP_KEY = "sandboxStop";
/** The key as a SQL literal: a bound parameter has no type for jsonb operators. */
export const STOP_KEY_SQL = sql.raw(`'${KEPT_WORKSPACE_STOP_KEY}'`);

export interface KeptWorkspaceStopState {
  attemptId?: string;
  epoch?: number;
  retryAfterMs?: number;
  attempts?: number;
  lastError?: string;
  confirmedEpoch?: number;
  confirmedAt?: string;
}

type LeaseMetadataHolder = { metadata: Record<string, unknown> | null };

export function leaseKeepsWorkspace(lease: LeaseMetadataHolder): boolean {
  return lease.metadata?.workspaceSurvivesStop === true && lease.metadata?.sandboxProviderPlugin === true;
}

/** True when the provider said this lease's files would NOT survive a stop. */
export function leaseLosesWorkspaceOnStop(lease: LeaseMetadataHolder): boolean {
  return lease.metadata?.workspaceSurvivesStop === false && lease.metadata?.sandboxProviderPlugin === true;
}

export function leaseSandboxEpoch(lease: LeaseMetadataHolder): number {
  const epoch = lease.metadata?.sandboxEpoch;
  return typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : 0;
}

export function readKeptWorkspaceStop(lease: LeaseMetadataHolder): KeptWorkspaceStopState {
  const value = lease.metadata?.[KEPT_WORKSPACE_STOP_KEY];
  return value && typeof value === "object" && !Array.isArray(value) ? value as KeptWorkspaceStopState : {};
}

export function keptWorkspaceStopConfirmed(lease: LeaseMetadataHolder): boolean {
  return readKeptWorkspaceStop(lease).confirmedEpoch === leaseSandboxEpoch(lease);
}

export function keepsWorkspaceSql() {
  return sql`coalesce(${environmentLeases.metadata}->'workspaceSurvivesStop' = 'true'::jsonb, false)
    and coalesce(${environmentLeases.metadata}->'sandboxProviderPlugin' = 'true'::jsonb, false)`;
}

/** The lease's run, or the run holding its resume claim, is still live. */
export function leaseHasLiveRunSql() {
  return sql`exists (
    select 1 from heartbeat_runs as live_run
    where live_run.status in ('queued', 'scheduled_retry', 'running')
      and (live_run.id = ${environmentLeases.heartbeatRunId}
        or live_run.id::text = ${environmentLeases.metadata}->>'resumeClaimRunId')
  )`;
}

/**
 * Metadata for a lease that just became `stopped` without a confirmed stop: a
 * fresh stop state that the reconciler picks up on its next tick.
 *
 * `blocksIssueClaim` marks a stop whose run did not end cleanly (a cancelled
 * or crashed run): its agent may still be running in the pod, so no new run
 * may claim the issue until the provider confirms the stop. An idle stop of a
 * warm lease whose run already ended never blocks a claim.
 */
export function unconfirmedStopMetadataSql(options: { blocksIssueClaim?: boolean } = {}) {
  return sql`(coalesce(${environmentLeases.metadata}, '{}'::jsonb) - ${STOP_KEY_SQL})
    || jsonb_build_object(${STOP_KEY_SQL}, ${JSON.stringify({
      attempts: 0, retryAfterMs: 0, ...(options.blocksIssueClaim ? { blocksIssueClaim: true } : {}),
    })}::jsonb)`;
}

/** A stop of a run that did not end cleanly, not yet confirmed by the provider. */
export function stopBlocksIssueClaimSql() {
  return sql`(${environmentLeases.status} = 'stopped'
    and coalesce(${environmentLeases.metadata}->${STOP_KEY_SQL}->'blocksIssueClaim' = 'true'::jsonb, false)
    and coalesce((${environmentLeases.metadata}->${STOP_KEY_SQL}->>'confirmedEpoch')::int, -1)
      <> coalesce((${environmentLeases.metadata}->>'sandboxEpoch')::int, 0))`;
}

/** Metadata for a lease whose stop the provider confirmed at its current epoch. */
export function confirmedStopMetadataSql(receipt: Record<string, unknown> | undefined) {
  return sql`(coalesce(${environmentLeases.metadata}, '{}'::jsonb) - ${STOP_KEY_SQL} - 'remoteExecutionTermination')
    || jsonb_build_object(${STOP_KEY_SQL}, jsonb_build_object(
      'attempts', 0, 'retryAfterMs', 0,
      'confirmedEpoch', coalesce((${environmentLeases.metadata}->>'sandboxEpoch')::int, 0),
      'confirmedAt', ${new Date().toISOString()}::text))
    || ${JSON.stringify(receipt ? { remoteExecutionTermination: receipt } : {})}::jsonb`;
}
