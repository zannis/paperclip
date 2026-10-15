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
  blocksIssueClaim?: boolean;
}

type LeaseMetadataHolder = { metadata: Record<string, unknown> | null };

/**
 * The provider keeps this lease's volume across a stop, so it fences stop and
 * resume on the sandbox epoch. Every resume of such a lease must move the
 * epoch on, whatever lifecycle the lease follows.
 */
export function leaseFencesSandboxEpoch(lease: LeaseMetadataHolder): boolean {
  return lease.metadata?.workspaceSurvivesStop === true && lease.metadata?.sandboxProviderPlugin === true;
}

function isPaperclipRunnerLease(lease: LeaseMetadataHolder): boolean {
  const scope = lease.metadata?.reusableSandboxLease;
  const scopeAdapter = scope && typeof scope === "object" && !Array.isArray(scope)
    ? (scope as Record<string, unknown>).adapterType
    : undefined;
  return (scopeAdapter ?? lease.metadata?.adapterType) === "paperclip_runner";
}

/**
 * The lease follows the kept-workspace lifecycle (`stopped`, cold resume on
 * the same volume). Paperclip Runner leases do not: their harness state lives
 * outside /workspace, so a cold pod could not continue their session, and
 * they keep their existing retention.
 */
export function leaseKeepsWorkspace(lease: LeaseMetadataHolder): boolean {
  return leaseFencesSandboxEpoch(lease) && !isPaperclipRunnerLease(lease);
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

/** The SQL twin of `!isPaperclipRunnerLease`: one definition of a Runner lease. */
export function notPaperclipRunnerLeaseMetadataSql() {
  return sql`coalesce(${environmentLeases.metadata}->'reusableSandboxLease'->>'adapterType',
    ${environmentLeases.metadata}->>'adapterType', '') <> 'paperclip_runner'`;
}

export function keepsWorkspaceSql() {
  return sql`(coalesce(${environmentLeases.metadata}->'workspaceSurvivesStop' = 'true'::jsonb, false)
    and coalesce(${environmentLeases.metadata}->'sandboxProviderPlugin' = 'true'::jsonb, false)
    and ${notPaperclipRunnerLeaseMetadataSql()})`;
}

/** The SQL twin of `leaseSandboxEpoch`: the one place SQL reads the epoch. */
export function sandboxEpochSql() {
  return sql`coalesce((${environmentLeases.metadata}->>'sandboxEpoch')::int, 0)`;
}

/** Lease metadata with the sandbox epoch moved on by one. */
export function bumpSandboxEpochSql() {
  return sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || jsonb_build_object(
    'sandboxEpoch', ${sandboxEpochSql()} + 1)`;
}

/** The run id holding a resume claim, as a uuid the primary key can match. */
export function resumeClaimRunIdSql() {
  return sql`(case when ${environmentLeases.metadata}->>'resumeClaimRunId'
      ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then (${environmentLeases.metadata}->>'resumeClaimRunId')::uuid end)`;
}

/** The lease's run, or the run holding its resume claim, is still live. */
export function leaseHasLiveRunSql() {
  return sql`(exists (
    select 1 from heartbeat_runs as live_run
    where live_run.id = ${environmentLeases.heartbeatRunId}
      and live_run.status in ('queued', 'scheduled_retry', 'running')
  ) or exists (
    select 1 from heartbeat_runs as live_run
    where live_run.id = ${resumeClaimRunIdSql()}
      and live_run.status in ('queued', 'scheduled_retry', 'running')
  ))`;
}

/** No provider stop has been confirmed at the lease's current epoch. */
export function stopUnconfirmedSql() {
  return sql`coalesce((${environmentLeases.metadata}->${STOP_KEY_SQL}->>'confirmedEpoch')::int, -1)
    <> ${sandboxEpochSql()}`;
}

/** The stop state recording a provider-confirmed stop at the current epoch. */
export function confirmedStopStateSql(confirmedAt: Date = new Date()) {
  return sql`jsonb_build_object(${STOP_KEY_SQL}, jsonb_build_object(
    'attempts', 0, 'retryAfterMs', 0,
    'confirmedEpoch', ${sandboxEpochSql()},
    'confirmedAt', ${confirmedAt.toISOString()}::text))`;
}

/**
 * Metadata for a lease that just became `stopped` without a confirmed stop: a
 * fresh stop state that the reconciler picks up on its next tick.
 *
 * `blocksIssueClaim` marks a stop whose run did not succeed (failed, timed
 * out, cancelled or crashed): its remote process may still be running in the
 * pod, so no new run may take the workspace over until the provider confirms
 * the stop. An idle stop of a warm lease whose run succeeded never blocks.
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
    and ${stopUnconfirmedSql()})`;
}

/** Metadata for a lease whose stop the provider confirmed at its current epoch. */
export function confirmedStopMetadataSql(receipt: Record<string, unknown> | undefined) {
  return sql`(coalesce(${environmentLeases.metadata}, '{}'::jsonb) - ${STOP_KEY_SQL} - 'remoteExecutionTermination')
    || ${confirmedStopStateSql()}
    || ${JSON.stringify(receipt ? { remoteExecutionTermination: receipt } : {})}::jsonb`;
}
