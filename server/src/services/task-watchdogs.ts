import { createHash } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  approvals,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueApprovals,
  issueRelations,
  issues,
  issueThreadInteractions,
  issueWatchdogs,
  issueWorkProducts,
} from "@paperclipai/db";
import type { IssueWatchdog, IssueWatchdogSummary } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { parseObject } from "../adapters/utils.js";
import { logActivity } from "./activity-log.js";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";
import { issueService } from "./issues.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import {
  isPlainRecord,
  isTerminalWatchdogRunStatus,
  TASK_WATCHDOG_ORIGIN_KIND,
  TASK_WATCHDOG_TERMINAL_RUN_STATUSES,
} from "./task-watchdog-scope.js";

const TASK_WATCHDOG_STOP_FINGERPRINT_PREFIX = "task_watchdog_stop:";
const TASK_WATCHDOG_SUBTREE_MAX_DEPTH = 100;
const TASK_WATCHDOG_LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const TASK_WATCHDOG_WAKE_REQUEST_STATUSES = ["queued", "deferred_issue_execution"] as const;
const TASK_WATCHDOG_TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const;
// Grace window after an issue is created/assigned during which its first
// assignment run/wake may have been enqueued but is not yet visible to a
// watchdog evaluation (the eval can race the issue's own assignment run).
// Within this window a non-terminal issue that has never completed a run is
// treated as not-yet-stopped so the evaluation does not produce a
// false-positive stopped-subtree review. The periodic watchdog reconciler
// re-evaluates after the window, so a genuinely idle issue still triggers.
const TASK_WATCHDOG_FIRST_RUN_GRACE_MS = 15_000;

type ActorFields = {
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

export type IssueWatchdogUpsertInput = {
  agentId: string;
  instructions?: string | null;
  actor?: ActorFields;
};

type IssueWatchdogRow = typeof issueWatchdogs.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

export type TaskWatchdogClassifierIssue = Pick<
  IssueRow,
  | "id"
  | "companyId"
  | "identifier"
  | "title"
  | "status"
  | "parentId"
  | "assigneeAgentId"
  | "assigneeUserId"
  | "originKind"
  | "updatedAt"
> & {
  // Optional so existing callers/tests that do not care about the first-run
  // grace window keep working; the pending-first-run guard is skipped when
  // it (or `evaluatedAt`) is absent.
  createdAt?: Date | string | null;
  latestCommentAt?: Date | string | null;
  latestDocumentAt?: Date | string | null;
  latestWorkProductAt?: Date | string | null;
};

export type TaskWatchdogClassifierPath = {
  companyId: string;
  issueId: string | null;
  agentId?: string | null;
  status: string;
};

export type TaskWatchdogClassifierWaitingPath = {
  companyId: string;
  issueId: string;
  id?: string | null;
  kind?: string | null;
  status: string;
};

export type TaskWatchdogClassifierRelation = {
  companyId: string;
  blockerIssueId: string;
  blockedIssueId: string;
};

export type TaskWatchdogClassifierConfig = Pick<
  IssueWatchdogSummary,
  "companyId" | "issueId" | "lastReviewedFingerprint"
> & {
  lastReviewedStopSnapshot?: TaskWatchdogStopSnapshot | null;
};

export type TaskWatchdogStoppedLeaf = {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  blockerIssueIds: string[];
  pendingInteractionIds: string[];
  pendingApprovalIds: string[];
  updatedAt: string;
  latestCommentAt: string | null;
  latestDocumentAt: string | null;
  latestWorkProductAt: string | null;
};

export type TaskWatchdogMaterialLeaf = Pick<
  TaskWatchdogStoppedLeaf,
  | "issueId"
  | "status"
  | "assigneeAgentId"
  | "assigneeUserId"
  | "blockerIssueIds"
  | "pendingInteractionIds"
  | "pendingApprovalIds"
>;

export type TaskWatchdogWaitsByIssueId = Record<string, {
  pendingInteractionIds: string[];
  pendingApprovalIds: string[];
}>;

export type TaskWatchdogStopSnapshot = {
  version: 2;
  fingerprint: string;
  materialLeaves: TaskWatchdogMaterialLeaf[];
  waitsByIssueId: TaskWatchdogWaitsByIssueId;
};

// Every included issue in the watched subtree, terminal ones too, reduced to
// the same fields the stop fingerprint is built from. `materialLeaves` only
// carries the issues that were leaves at the time; this carries the rest, so a
// later diff can still tell what an issue looked like *before* it became a
// fingerprint input — by being reopened, or by its last live child going
// terminal. Without it such an issue would have to be admitted unchecked.
export type TaskWatchdogMaterialByIssueId = Record<string, TaskWatchdogMaterialLeaf>;

type TaskWatchdogPendingInteractionsByIssueId = Record<string, Array<{
  id: string;
  kind: string | null;
}>>;

export type TaskWatchdogClassifierResult =
  | {
    state: "not_applicable";
    reason: string;
    includedIssueIds: string[];
  }
  | {
    state: "live";
    reason: string;
    includedIssueIds: string[];
    liveIssueIds: string[];
    // Present on non-stopped states too, so a mutation guard can still diff the
    // fingerprint inputs. On these states it describes the subtree, not a
    // verdict: the subtree is *not* stopped and `fingerprint` inside it must
    // never be treated as one the watchdog may pin to or review.
    stopSnapshot: TaskWatchdogStopSnapshot;
    materialByIssueId: TaskWatchdogMaterialByIssueId;
  }
  | {
    state: "pending_first_run";
    reason: string;
    includedIssueIds: string[];
    pendingIssueIds: string[];
    stopSnapshot: TaskWatchdogStopSnapshot;
    materialByIssueId: TaskWatchdogMaterialByIssueId;
  }
  | {
    state: "already_reviewed";
    reason: string;
    includedIssueIds: string[];
    stopFingerprint: string;
    stoppedLeaves: TaskWatchdogStoppedLeaf[];
    stopSnapshot: TaskWatchdogStopSnapshot;
    materialByIssueId: TaskWatchdogMaterialByIssueId;
    pendingInteractionsByIssueId: TaskWatchdogPendingInteractionsByIssueId;
  }
  | {
    state: "stopped";
    reason: string;
    includedIssueIds: string[];
    stopFingerprint: string;
    stoppedLeaves: TaskWatchdogStoppedLeaf[];
    stopSnapshot: TaskWatchdogStopSnapshot;
    materialByIssueId: TaskWatchdogMaterialByIssueId;
    pendingInteractionsByIssueId: TaskWatchdogPendingInteractionsByIssueId;
  };

export type TaskWatchdogClassifierInput = {
  watchdog: TaskWatchdogClassifierConfig;
  issues: TaskWatchdogClassifierIssue[];
  activeRuns?: TaskWatchdogClassifierPath[];
  queuedWakeRequests?: TaskWatchdogClassifierPath[];
  blockers?: TaskWatchdogClassifierRelation[];
  pendingInteractions?: TaskWatchdogClassifierWaitingPath[];
  pendingApprovals?: TaskWatchdogClassifierWaitingPath[];
  // Timestamp the evaluation reads its snapshot at. When provided together
  // with a positive `firstRunGraceMs`, the classifier suppresses a
  // stopped-subtree verdict for issues created within the grace window that
  // have never completed a run (their first assignment run/wake may not yet
  // be visible). Omit to disable the guard (legacy behavior).
  evaluatedAt?: Date | string | null;
  firstRunGraceMs?: number | null;
  // Ids of included issues that have at least one run in a terminal status.
  // Such issues are never treated as "pending first run" — they have
  // demonstrably executed, so a stop is genuine rather than a snapshot race.
  completedRunIssueIds?: string[];
};

type TaskWatchdogWakeupOptions = {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
};

type TaskWatchdogWakeup = (
  agentId: string,
  opts?: TaskWatchdogWakeupOptions,
) => Promise<{ id: string } | null>;

export type TaskWatchdogServiceDeps = {
  enqueueWakeup?: TaskWatchdogWakeup;
};

function normalizeInstructions(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function summarizeIssueWatchdog(row: IssueWatchdogRow): IssueWatchdogSummary {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    watchdogAgentId: row.watchdogAgentId,
    instructions: row.instructions,
    status: row.status as IssueWatchdogSummary["status"],
    watchdogIssueId: row.watchdogIssueId,
    lastObservedFingerprint: row.lastObservedFingerprint,
    lastReviewedFingerprint: row.lastReviewedFingerprint,
    lastTriggeredAt: row.lastTriggeredAt,
    lastCompletedAt: row.lastCompletedAt,
    triggerCount: row.triggerCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toIssueWatchdog(row: IssueWatchdogRow): IssueWatchdog {
  return {
    ...summarizeIssueWatchdog(row),
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdByRunId: row.createdByRunId,
    updatedByAgentId: row.updatedByAgentId,
    updatedByUserId: row.updatedByUserId,
    updatedByRunId: row.updatedByRunId,
  };
}

function issueUpdatedAtIso(issue: Pick<TaskWatchdogClassifierIssue, "updatedAt">) {
  return issue.updatedAt instanceof Date
    ? issue.updatedAt.toISOString()
    : new Date(String(issue.updatedAt)).toISOString();
}

function optionalIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function toEpochMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function pathIssueIds(paths: TaskWatchdogClassifierPath[] | undefined, companyId: string) {
  return new Set(
    (paths ?? [])
      .filter((path) => path.companyId === companyId && typeof path.issueId === "string" && path.issueId.length > 0)
      .map((path) => path.issueId as string),
  );
}

function waitingPathIds(
  paths: TaskWatchdogClassifierWaitingPath[] | undefined,
  companyId: string,
  issueId: string,
) {
  return (paths ?? [])
    .filter((path) => path.companyId === companyId && path.issueId === issueId)
    .map((path) => path.id ?? `${path.status}:${path.issueId}`)
    .sort();
}

function stableStopFingerprint(input: {
  companyId: string;
  watchedIssueId: string;
  materialLeaves: TaskWatchdogMaterialLeaf[];
  waitsByIssueId: TaskWatchdogWaitsByIssueId;
}) {
  const payload = JSON.stringify({
    version: 2,
    companyId: input.companyId,
    watchedIssueId: input.watchedIssueId,
    materialLeaves: input.materialLeaves,
    waitsByIssueId: input.waitsByIssueId,
  });
  return `task_watchdog_stop:${createHash("sha256").update(payload).digest("hex")}`;
}

function materialLeaf(leaf: TaskWatchdogStoppedLeaf): TaskWatchdogMaterialLeaf {
  return {
    issueId: leaf.issueId,
    status: leaf.status,
    assigneeAgentId: leaf.assigneeAgentId,
    assigneeUserId: leaf.assigneeUserId,
    blockerIssueIds: leaf.blockerIssueIds,
    pendingInteractionIds: leaf.pendingInteractionIds,
    pendingApprovalIds: leaf.pendingApprovalIds,
  };
}

function parseStopSnapshot(value: unknown): TaskWatchdogStopSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<TaskWatchdogStopSnapshot>;
  if (
    candidate.version !== 2 ||
    typeof candidate.fingerprint !== "string" ||
    !Array.isArray(candidate.materialLeaves) ||
    !candidate.waitsByIssueId ||
    typeof candidate.waitsByIssueId !== "object"
  ) return null;
  return candidate as TaskWatchdogStopSnapshot;
}

// Snapshots loaded from jsonb columns come back with Postgres's normalized key
// order, so equality checks against freshly built snapshots must not depend on
// object key order.
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0
        ),
      )
      : val);
}

export const TASK_WATCHDOG_MATERIAL_LEAF_FIELDS = [
  "status",
  "assigneeAgentId",
  "assigneeUserId",
  "blockerIssueIds",
  "pendingInteractionIds",
  "pendingApprovalIds",
] as const;

// The leaf fields one authorized request wrote, and the value it wrote them to.
// These come from the row the request's *own* statement returned, never from a
// later re-read of the issue: a re-read cannot distinguish the value this run
// wrote from a value a third party wrote over it a millisecond afterwards, and
// folding that second value in is precisely the laundering this guards against.
// A field the request did not write is absent, which asserts it did not change.
export type TaskWatchdogDeclaredLeafWrite = Partial<Pick<
  TaskWatchdogMaterialLeaf,
  (typeof TASK_WATCHDOG_MATERIAL_LEAF_FIELDS)[number]
>>;

export type TaskWatchdogAuthorizedMutation = {
  issueId: string;
  declared: TaskWatchdogDeclaredLeafWrite;
  // Set when the run created this issue during the mutation. A created issue
  // has no baseline to diff against, so `declared` must cover every material
  // field for it to be attributable at all.
  created?: boolean;
  // The parent the run created this issue *under*, taken from the creating
  // route's own row. A creation is what explains its parent dropping out of
  // the material leaves, and that explanation has to be pinned to the edge the
  // run actually made: resolving the parent from the child's *current* row
  // instead lets a third party reparent the child and have this run's ledger
  // account for the displacement their reparenting caused.
  parentId?: string | null;
  // Interactions this request resolved. Declared as a *delta* rather than as an
  // absolute `pendingInteractionIds`, deliberately: the resulting list is only
  // knowable from a fresh read, and a fresh read is exactly how a third party's
  // concurrently-created interaction would get folded into what this run is
  // allowed to call its own. Removing named ids from the baseline cannot launder
  // anything — an interaction somebody else added is still an id the run never
  // accounted for, and still stops it dead.
  resolvedInteractionIds?: string[];
  // Set by a route that actually enqueued a wake for this issue as part of the
  // request — the assignment/status/comment wakeups the update and comment
  // routes queue, the continuation wakeup an interaction resolution queues, the
  // assignment wakeup a creation queues.
  //
  // It is a *fact about this request*, not a property of the values it wrote,
  // and that distinction is the whole point: which writes wake anybody is the
  // route's decision, taken from state the guard cannot see (the interaction's
  // continuation policy and resolution outcome, the actor type, the execution
  // stage), and re-deriving it here from the declared values can only ever
  // produce a guess. A guess that says "yes" attributes a third party's run to
  // this one, which is the guard failing open.
  startsWork?: boolean;
};

// What a watchdog run has been authorized to do to the watched subtree so far,
// carried in the run's own context. `baseline` is the subtree as it stood when
// the run was last validated against the fingerprint it is pinned to, and
// `mutations` is every leaf write admitted since. Together they say exactly
// what the subtree should look like now if nobody but this run has touched it.
export type TaskWatchdogMutationLedger = {
  version: 1;
  baseline: TaskWatchdogStopSnapshot;
  baselineMaterialByIssueId: TaskWatchdogMaterialByIssueId;
  mutations: TaskWatchdogAuthorizedMutation[];
};

export type TaskWatchdogLedgerBaseline = {
  baseline: TaskWatchdogStopSnapshot;
  baselineMaterialByIssueId: TaskWatchdogMaterialByIssueId;
};

const EMPTY_RESOLVED_INTERACTION_IDS: ReadonlySet<string> = new Set<string>();

type TaskWatchdogMergedDeclaration = {
  declared: TaskWatchdogDeclaredLeafWrite;
  created: boolean;
  createdUnderParentId: string | null;
  resolvedInteractionIds: Set<string>;
};

function mergeDeclaredWrites(mutations: TaskWatchdogAuthorizedMutation[]) {
  const merged = new Map<string, TaskWatchdogMergedDeclaration>();
  for (const mutation of mutations) {
    if (!mutation || typeof mutation.issueId !== "string") continue;
    const current = merged.get(mutation.issueId)
      ?? {
        declared: {},
        created: false,
        createdUnderParentId: null,
        resolvedInteractionIds: new Set<string>(),
      };
    for (const interactionId of mutation.resolvedInteractionIds ?? []) {
      if (typeof interactionId === "string") current.resolvedInteractionIds.add(interactionId);
    }
    // Later writes in the same run supersede earlier ones on the same field.
    merged.set(mutation.issueId, {
      declared: { ...current.declared, ...(mutation.declared ?? {}) },
      created: current.created || mutation.created === true,
      createdUnderParentId: typeof mutation.parentId === "string"
        ? mutation.parentId
        : current.createdUnderParentId,
      resolvedInteractionIds: current.resolvedInteractionIds,
    });
  }
  return merged;
}

// Every mutation this run declared against one issue, in the order the run's
// requests made them. `mergeDeclaredWrites` collapses those into a final value,
// which is what the drift comparison wants; causation wants the steps, because
// a field that ends the run where it started may still have moved — and woken
// somebody — on the way.
function declaredMutationsByIssueId(mutations: TaskWatchdogAuthorizedMutation[]) {
  const byIssueId = new Map<string, TaskWatchdogAuthorizedMutation[]>();
  for (const mutation of mutations) {
    if (!mutation || typeof mutation.issueId !== "string") continue;
    const current = byIssueId.get(mutation.issueId);
    if (current) current.push(mutation);
    else byIssueId.set(mutation.issueId, [mutation]);
  }
  return byIssueId;
}

// A resolution takes a named interaction out of the issue's waiting paths and
// changes nothing else about them, so the expected list is the baseline minus
// the ids the run reported resolving. `filter` keeps the classifier's sort.
function withoutResolvedInteractions(pendingInteractionIds: string[], resolved: ReadonlySet<string>) {
  if (resolved.size === 0) return pendingInteractionIds;
  return pendingInteractionIds.filter((interactionId) => !resolved.has(interactionId));
}

function declarationCoversEveryMaterialField(declared: TaskWatchdogDeclaredLeafWrite) {
  return TASK_WATCHDOG_MATERIAL_LEAF_FIELDS.every((field) => declared[field] !== undefined);
}

// Which fingerprint inputs moved in a way this run cannot account for.
//
// The subtree as it stands now is compared against `baseline + declared`: every
// leaf must hold exactly the value it had at baseline, overwritten only by the
// fields an authorized request of this run reported writing. Anything else —
// a field nobody declared, a declared field that ended up at a different value,
// a leaf that appeared or vanished without a declaration explaining it — is
// somebody else's change, and the run must not be allowed to keep mutating a
// subtree that moved underneath it.
//
// The comparison is deliberately scoped to the fingerprint's own inputs (the
// material leaves and the waiting paths). A change to a watched issue that the
// fingerprint does not cover never blocked a watchdog run before and must not
// start to.
export function unattributedSubtreeChanges(input: {
  ledger: TaskWatchdogMutationLedger;
  next: TaskWatchdogStopSnapshot;
  nextMaterialByIssueId: TaskWatchdogMaterialByIssueId;
  parentByIssueId: Map<string, string | null>;
}): string[] {
  const declaredByIssueId = mergeDeclaredWrites(input.ledger.mutations ?? []);
  const baselineMaterial = input.ledger.baselineMaterialByIssueId ?? {};
  const baselineLeafIds = new Set(input.ledger.baseline.materialLeaves.map((leaf) => leaf.issueId));
  const nextLeaves = new Map(input.next.materialLeaves.map((leaf) => [leaf.issueId, leaf]));
  const unattributed = new Set<string>();
  const attributableNewLeafParentIds = new Set<string>();
  // A creation only explains the parent the run actually hung it off, and only
  // while the child is still hanging there. The declared parent is the edge the
  // run made; the current parent is where the child sits now. Requiring the two
  // to agree rejects both directions of a third party moving it: reparented to
  // some other leaf, that leaf's displacement is theirs and not attributable
  // here, and moved away from the declared parent, the creation no longer
  // explains anything about it either.
  const attributeCreatedChildToItsParent = (
    issueId: string,
    declared: TaskWatchdogMergedDeclaration,
  ) => {
    const declaredParentId = declared.createdUnderParentId;
    if (declaredParentId == null) return;
    if (input.parentByIssueId.get(issueId) !== declaredParentId) return;
    attributableNewLeafParentIds.add(declaredParentId);
  };

  for (const [issueId, leaf] of nextLeaves) {
    const declared = declaredByIssueId.get(issueId);
    const before = baselineMaterial[issueId] ?? null;
    if (before) {
      const expected = { ...before, ...(declared?.declared ?? {}), issueId };
      if (declared?.resolvedInteractionIds.size) {
        expected.pendingInteractionIds = withoutResolvedInteractions(
          expected.pendingInteractionIds,
          declared.resolvedInteractionIds,
        );
      }
      if (canonicalJson(expected) !== canonicalJson(leaf)) unattributed.add(issueId);
      continue;
    }
    // The issue did not exist in the watched subtree at baseline, so there is
    // nothing to diff it against. Only a request that reported creating it, and
    // reported every field it created it with, can account for it.
    if (!declared?.created || !declarationCoversEveryMaterialField(declared.declared)) {
      unattributed.add(issueId);
      continue;
    }
    if (canonicalJson({ ...declared.declared, issueId }) !== canonicalJson(leaf)) {
      unattributed.add(issueId);
      continue;
    }
    attributeCreatedChildToItsParent(issueId, declared);
  }

  // A created issue displaces the leaf it hangs off whether or not it is still
  // a material leaf itself: it may have gained a child of its own, or the run
  // may have closed it, and either takes it out of `materialLeaves` while
  // leaving the displacement it caused just as real. Attributing only from the
  // current leaf set left the run rejected for a leaf its own creation removed.
  for (const [issueId, declared] of declaredByIssueId) {
    if (!declared.created || nextLeaves.has(issueId) || unattributed.has(issueId)) continue;
    // Same bar as a created leaf: a half-described creation could be carrying
    // somebody else's edit, and cannot speak for anything.
    if (!declarationCoversEveryMaterialField(declared.declared)) continue;
    // Leaving the leaf set does not take the issue out of the subtree, and it
    // is the only way a subtree issue escapes every comparison in this
    // function: a created child has no baseline entry to be diffed against
    // above, and `waitsByIssueId` carries non-terminal issues only, so a third
    // party closing the run's own follow-up child would otherwise go entirely
    // unnoticed — while the same closure on a child that existed at baseline is
    // caught by the leaf-loss loop below. Held to the same bar as a created
    // leaf: the state it is in now must be the state the run created it in.
    const current = input.nextMaterialByIssueId[issueId];
    if (!current || canonicalJson({ ...declared.declared, issueId }) !== canonicalJson(current)) {
      unattributed.add(issueId);
    }
    // The drift above is the child's own and is reported as the child's. It
    // does not take the parent's explanation away: the creation is still why
    // the parent stopped being a leaf, whoever changed the child afterwards.
    //
    // An issue the run created and that is no longer under the parent the run
    // created it under cannot be why a leaf there is missing — the agreement
    // check inside the helper covers both that and its leaving the subtree
    // entirely, since neither leaves the declared parent in `parentByIssueId`.
    attributeCreatedChildToItsParent(issueId, declared);
  }

  // A leaf leaves the fingerprint when it goes terminal or gains a child. Both
  // have to be explained: the run declared a terminal status for it, or the run
  // created the child that displaced it. The two are not interchangeable — a
  // created child says nothing about a leaf somebody else closed — so a leaf
  // that went terminal is only ever explained by the run declaring that.
  for (const issueId of baselineLeafIds) {
    if (nextLeaves.has(issueId)) continue;
    const declaredStatus = declaredByIssueId.get(issueId)?.declared.status;
    const wentTerminalOnPurpose = declaredStatus != null && isTerminalIssueStatus(declaredStatus);
    const stillOpen = !isTerminalIssueStatus(input.nextMaterialByIssueId[issueId]?.status ?? "done");
    if (wentTerminalOnPurpose || (stillOpen && attributableNewLeafParentIds.has(issueId))) continue;
    unattributed.add(issueId);
  }

  // Waiting paths are a fingerprint input in their own right and are tracked
  // for non-terminal issues whether or not they are leaves, so they get the
  // same baseline-plus-declared treatment.
  const waitIssueIds = new Set([
    ...Object.keys(input.ledger.baseline.waitsByIssueId),
    ...Object.keys(input.next.waitsByIssueId),
  ]);
  for (const issueId of waitIssueIds) {
    if (unattributed.has(issueId)) continue;
    const declaration = declaredByIssueId.get(issueId);
    const declared = declaration?.declared ?? {};
    const before = baselineMaterial[issueId] ?? null;
    const baselineWaits = input.ledger.baseline.waitsByIssueId[issueId] ?? null;
    const pendingInteractionIds = withoutResolvedInteractions(
      declared.pendingInteractionIds
        ?? before?.pendingInteractionIds
        ?? baselineWaits?.pendingInteractionIds
        ?? [],
      declaration?.resolvedInteractionIds ?? EMPTY_RESOLVED_INTERACTION_IDS,
    );
    const pendingApprovalIds = declared.pendingApprovalIds
      ?? before?.pendingApprovalIds
      ?? baselineWaits?.pendingApprovalIds
      ?? [];
    const status = declared.status ?? before?.status ?? null;
    const expected = (status != null && isTerminalIssueStatus(status))
        || (pendingInteractionIds.length === 0 && pendingApprovalIds.length === 0)
      ? null
      : { pendingInteractionIds, pendingApprovalIds };
    if (canonicalJson(expected) !== canonicalJson(input.next.waitsByIssueId[issueId] ?? null)) {
      unattributed.add(issueId);
    }
  }

  return [...unattributed].sort();
}

// Whether this run is why a run is now live on that issue.
//
// Ledger membership alone is too coarse to answer this: a run that only touched
// some field which leaves the issue idle has not started anything, so a run
// appearing on it afterwards is somebody else's and must not be waved through
// on the strength of the issue merely being "known".
//
// Neither is the declared *value* enough, and that is the sharper trap, because
// reasoning about values gets close enough to look right. Which writes actually
// start work is not a function of the leaf fields at all — it is a decision the
// routes take, from state that never reaches this ledger: an interaction's
// continuation policy and its resolution outcome (`wake_assignee`,
// `wake_assignee_on_accept` only on an accepted or answered verdict, a rejected
// plan confirmation, a lost review path), the actor type, the execution stage,
// and, for status, a specific enumerated set of transitions rather than "the
// value moved" (`statusChangedFromBacklog`, `statusChangedFromBlockedToTodo`,
// `statusChangedFromClosedToTodo`, `userResumedFromReviewToTodo`). A `todo ->
// in_progress` PATCH is a real change to a non-terminal status and wakes
// nobody; an interaction resolved under a policy that does not wake wakes
// nobody either. Re-deriving any of that from the declaration produces a guess,
// and a guess that says "yes" hands a third party's run to this run's ledger as
// its own — the guard failing open in exactly the place it is supposed to hold.
//
// So the routes say it instead. `startsWork` is set by the request that
// actually enqueued the wake, next to the enqueue itself, and this asks nothing
// else. A route that wakes somebody and does not declare it is conservative,
// not unsafe: the liveness reads as a third party's and the run's next mutation
// is rejected, which is the behaviour that predates any of this.
function declaredStepsCanStartWork(mutations: TaskWatchdogAuthorizedMutation[]) {
  return mutations.some((mutation) => mutation?.startsWork === true);
}

// Whether the reason the subtree is no longer stopped is this run's own doing.
// A watchdog that reopens a leaf or creates a follow-up child makes the subtree
// live or pending-first-run by design — that is the recovery working — and the
// mandate then asks it to record what it did. Liveness nobody in this run's
// ledger accounts for is a third party and still stops the run dead.
//
// `creationExplains` separates the two verdicts this runs for. A `live` issue
// has an actual run or a queued wake on it, and only a wake this run enqueued
// accounts for that. A `pending_first_run` issue has neither: the classifier
// defers on it because it is newly created and has never completed a run, so
// what has to be accounted for is the *creation*, which the ledger records as a
// fact and `unattributedSubtreeChanges` has already checked field by field. A
// follow-up this run created and left unassigned wakes nobody and is still
// exactly why the subtree reads pending.
function unattributedLivenessIssueIds(
  ledger: TaskWatchdogMutationLedger,
  livenessIssueIds: string[],
  creationExplains: boolean,
) {
  const mutationsByIssueId = declaredMutationsByIssueId(ledger.mutations ?? []);
  return livenessIssueIds
    .filter((issueId) => {
      const mutations = mutationsByIssueId.get(issueId);
      if (!mutations) return true;
      if (creationExplains && mutations.some((mutation) => mutation?.created === true)) return false;
      return !declaredStepsCanStartWork(mutations);
    })
    .sort();
}

function parseMutationLedger(value: unknown): TaskWatchdogMutationLedger | null {
  if (!isPlainRecord(value)) return null;
  const candidate = value as Partial<TaskWatchdogMutationLedger>;
  if (candidate.version !== 1) return null;
  const baseline = parseStopSnapshot(candidate.baseline);
  if (!baseline) return null;
  if (!isPlainRecord(candidate.baselineMaterialByIssueId)) return null;
  if (!Array.isArray(candidate.mutations)) return null;
  return {
    version: 1,
    baseline,
    baselineMaterialByIssueId: candidate.baselineMaterialByIssueId as TaskWatchdogMaterialByIssueId,
    mutations: candidate.mutations as TaskWatchdogAuthorizedMutation[],
  };
}

function isShrinkOfReviewedSnapshot(
  current: TaskWatchdogStopSnapshot,
  reviewed: TaskWatchdogStopSnapshot | null | undefined,
) {
  if (!reviewed || canonicalJson(current.waitsByIssueId) !== canonicalJson(reviewed.waitsByIssueId)) return false;
  const reviewedLeaves = new Map(reviewed.materialLeaves.map((leaf) => [leaf.issueId, leaf]));
  return current.materialLeaves.every((leaf) => {
    const previous = reviewedLeaves.get(leaf.issueId);
    return previous != null && canonicalJson(previous) === canonicalJson(leaf);
  });
}

export function classifyTaskWatchdogSubtree(input: TaskWatchdogClassifierInput): TaskWatchdogClassifierResult {
  const issuesById = new Map(input.issues.map((issue) => [issue.id, issue]));
  const root = issuesById.get(input.watchdog.issueId);
  if (!root || root.companyId !== input.watchdog.companyId) {
    return { state: "not_applicable", reason: "Watched issue is missing.", includedIssueIds: [] };
  }
  if (root.originKind === TASK_WATCHDOG_ORIGIN_KIND) {
    return {
      state: "not_applicable",
      reason: "Task watchdog origin issues cannot themselves be watched.",
      includedIssueIds: [],
    };
  }

  const childrenByParentId = new Map<string, TaskWatchdogClassifierIssue[]>();
  for (const issue of input.issues) {
    if (issue.companyId !== input.watchdog.companyId || !issue.parentId) continue;
    const list = childrenByParentId.get(issue.parentId) ?? [];
    list.push(issue);
    childrenByParentId.set(issue.parentId, list);
  }
  for (const children of childrenByParentId.values()) {
    children.sort((left, right) => left.id.localeCompare(right.id));
  }

  const included: TaskWatchdogClassifierIssue[] = [];
  const visit = (issue: TaskWatchdogClassifierIssue) => {
    if (issue.originKind === TASK_WATCHDOG_ORIGIN_KIND) return;
    included.push(issue);
    for (const child of childrenByParentId.get(issue.id) ?? []) {
      visit(child);
    }
  };
  visit(root);
  if (included.length === 0) {
    return { state: "not_applicable", reason: "Watched subtree has no non-watchdog issues.", includedIssueIds: [] };
  }

  const includedIds = included.map((issue) => issue.id);
  const includedIdSet = new Set(includedIds);

  const includedChildrenByParentId = new Map<string, string[]>();
  for (const issue of included) {
    if (!issue.parentId || !includedIdSet.has(issue.parentId)) continue;
    const list = includedChildrenByParentId.get(issue.parentId) ?? [];
    list.push(issue.id);
    includedChildrenByParentId.set(issue.parentId, list);
  }
  const blockersByIssueId = new Map<string, string[]>();
  for (const relation of input.blockers ?? []) {
    if (relation.companyId !== input.watchdog.companyId) continue;
    if (!includedIdSet.has(relation.blockedIssueId)) continue;
    const list = blockersByIssueId.get(relation.blockedIssueId) ?? [];
    list.push(relation.blockerIssueId);
    blockersByIssueId.set(relation.blockedIssueId, list);
  }

  const nonTerminalIssues = included
    .filter((issue) => !isTerminalIssueStatus(issue.status))
    .sort((left, right) => left.id.localeCompare(right.id));
  const waitsByIssueId = Object.fromEntries(nonTerminalIssues
    .map((issue) => [issue.id, {
      pendingInteractionIds: waitingPathIds(input.pendingInteractions, input.watchdog.companyId, issue.id),
      pendingApprovalIds: waitingPathIds(input.pendingApprovals, input.watchdog.companyId, issue.id),
    }] as const)
    .filter(([, waits]) => waits.pendingInteractionIds.length > 0 || waits.pendingApprovalIds.length > 0));
  const pendingInteractionsByIssueId = Object.fromEntries(nonTerminalIssues
    .map((issue) => [issue.id, (input.pendingInteractions ?? [])
      .filter((path) => path.companyId === input.watchdog.companyId && path.issueId === issue.id)
      .map((path) => ({ id: path.id ?? `${path.status}:${path.issueId}`, kind: path.kind ?? null }))
      .sort((left, right) => left.id.localeCompare(right.id))] as const)
    .filter(([, waits]) => waits.length > 0));

  const leaves = included
    .filter((issue) => (includedChildrenByParentId.get(issue.id) ?? []).length === 0)
    .filter((issue) => !isTerminalIssueStatus(issue.status))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((issue) => ({
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
      blockerIssueIds: [...new Set(blockersByIssueId.get(issue.id) ?? [])].sort(),
      pendingInteractionIds: waitingPathIds(input.pendingInteractions, input.watchdog.companyId, issue.id),
      pendingApprovalIds: waitingPathIds(input.pendingApprovals, input.watchdog.companyId, issue.id),
      updatedAt: issueUpdatedAtIso(issue),
      latestCommentAt: optionalIso(issue.latestCommentAt),
      latestDocumentAt: optionalIso(issue.latestDocumentAt),
      latestWorkProductAt: optionalIso(issue.latestWorkProductAt),
    }));
  const materialLeaves = leaves.map(materialLeaf);
  const stopFingerprint = stableStopFingerprint({
    companyId: input.watchdog.companyId,
    watchedIssueId: input.watchdog.issueId,
    materialLeaves,
    waitsByIssueId,
  });
  const currentStopSnapshot: TaskWatchdogStopSnapshot = {
    version: 2,
    fingerprint: stopFingerprint,
    materialLeaves,
    waitsByIssueId,
  };
  const materialByIssueId: TaskWatchdogMaterialByIssueId = Object.fromEntries(included
    .map((issue) => [issue.id, {
      issueId: issue.id,
      status: issue.status,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
      blockerIssueIds: [...new Set(blockersByIssueId.get(issue.id) ?? [])].sort(),
      pendingInteractionIds: waitingPathIds(input.pendingInteractions, input.watchdog.companyId, issue.id),
      pendingApprovalIds: waitingPathIds(input.pendingApprovals, input.watchdog.companyId, issue.id),
    }] as const));

  // The live and pending-first-run verdicts are decided *after* the fingerprint
  // inputs are built, not before, so that both carry `stopSnapshot` /
  // `materialByIssueId`. A watchdog run that has already taken a sanctioned
  // action needs to diff those inputs even when its own action left the subtree
  // non-stopped; nothing about the verdicts themselves changed.
  const liveIssueIds = [
    ...pathIssueIds(input.activeRuns, input.watchdog.companyId),
    ...pathIssueIds(input.queuedWakeRequests, input.watchdog.companyId),
  ].filter((issueId) => includedIdSet.has(issueId));
  const uniqueLiveIssueIds = [...new Set(liveIssueIds)].sort();
  if (uniqueLiveIssueIds.length > 0) {
    return {
      state: "live",
      reason: "At least one issue in the watched subtree has a live run, queued wake, or scheduled retry.",
      includedIssueIds: includedIds,
      liveIssueIds: uniqueLiveIssueIds,
      stopSnapshot: currentStopSnapshot,
      materialByIssueId,
    };
  }

  // Pending-first-run guard: a watchdog evaluation triggered as part of issue
  // (or watchdog) creation can read its snapshot before the issue's own
  // assignment run/wake is committed/visible, making an actively-starting
  // subtree look idle. Suppress the stopped verdict for non-terminal issues
  // created within the first-run grace window that have never completed a run.
  const evaluatedAtMs = toEpochMs(input.evaluatedAt);
  const graceMs = input.firstRunGraceMs ?? 0;
  if (evaluatedAtMs != null && graceMs > 0) {
    const completedRunIssueIds = new Set(input.completedRunIssueIds ?? []);
    const pendingIssueIds = included
      .filter((issue) => {
        if (isTerminalIssueStatus(issue.status)) return false;
        if (completedRunIssueIds.has(issue.id)) return false;
        const createdAtMs = toEpochMs(issue.createdAt);
        if (createdAtMs == null) return false;
        return evaluatedAtMs - createdAtMs < graceMs;
      })
      .map((issue) => issue.id)
      .sort();
    if (pendingIssueIds.length > 0) {
      return {
        state: "pending_first_run",
        reason:
          "A watched issue was created within the first-run grace window and has not yet completed a run; deferring evaluation until its first assignment run/wake is observable.",
        includedIssueIds: includedIds,
        pendingIssueIds,
        stopSnapshot: currentStopSnapshot,
        materialByIssueId,
      };
    }
  }

  if (
    input.watchdog.lastReviewedFingerprint === stopFingerprint ||
    isShrinkOfReviewedSnapshot(currentStopSnapshot, input.watchdog.lastReviewedStopSnapshot)
  ) {
    return {
      state: "already_reviewed",
      reason: "The current stopped subtree fingerprint was already reviewed by the watchdog.",
      includedIssueIds: includedIds,
      stopFingerprint,
      stoppedLeaves: leaves,
      stopSnapshot: currentStopSnapshot,
      materialByIssueId,
      pendingInteractionsByIssueId,
    };
  }

  return {
    state: "stopped",
    reason: "No issue in the watched subtree has a live execution path.",
    includedIssueIds: includedIds,
    stopFingerprint,
    stoppedLeaves: leaves,
    stopSnapshot: currentStopSnapshot,
    materialByIssueId,
    pendingInteractionsByIssueId,
  };
}

async function assertWatchedIssue(dbOrTx: any, companyId: string, issueId: string) {
  const issue = await dbOrTx
    .select({ id: issues.id, companyId: issues.companyId })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .then((rows: Array<{ id: string; companyId: string }>) => rows[0] ?? null);
  if (!issue) throw notFound("Issue not found");
  return issue;
}

async function assertWatchdogAgentInvokable(dbOrTx: any, companyId: string, agentId: string) {
  const agent = await dbOrTx
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      reportsTo: agents.reportsTo,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows: Array<{
      id: string;
      companyId: string;
      name: string;
      reportsTo: string | null;
      status: string;
    }>) => rows[0] ?? null);
  if (!agent || agent.companyId !== companyId) {
    throw notFound("Watchdog agent not found");
  }
  const invokability = await evaluateAgentInvokabilityFromDb(dbOrTx as Db, agent);
  if (!invokability.invokable) {
    throw conflict("Cannot assign watchdog to an agent that is not invokable", invokability);
  }
  return agent;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function issueIdFromRunContext(contextSnapshot: unknown) {
  const context = parseObject(contextSnapshot);
  return readNonEmptyString(context.issueId) ?? readNonEmptyString(context.taskId);
}

function issueIdFromWakePayload(payload: unknown) {
  const parsed = parseObject(payload);
  const nested = parseObject(parsed._paperclipWakeContext);
  return readNonEmptyString(parsed.issueId) ??
    readNonEmptyString(parsed.taskId) ??
    readNonEmptyString(nested.issueId) ??
    readNonEmptyString(nested.taskId);
}

function normalizeStopFingerprint(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed?.startsWith(TASK_WATCHDOG_STOP_FINGERPRINT_PREFIX) ? trimmed : null;
}

function stopFingerprintFromText(value: string | null | undefined) {
  const match = value?.match(/task_watchdog_stop:[a-f0-9]+/i);
  return normalizeStopFingerprint(match?.[0] ?? null);
}

function reviewedFingerprintForWatchdogIssue(issue: Pick<IssueRow, "originFingerprint" | "description">) {
  return normalizeStopFingerprint(issue.originFingerprint) ?? stopFingerprintFromText(issue.description);
}

function taskWatchdogWakeIdempotencyKey(watchdogId: string, stopFingerprint: string) {
  return `task_watchdog:${watchdogId}:${stopFingerprint}`;
}

function buildStoppedFingerprintComment(input: {
  sourceIssue: Pick<IssueRow, "identifier" | "id">;
  stopFingerprint: string;
  stoppedLeaves: TaskWatchdogStoppedLeaf[];
  pendingInteractionsByIssueId: TaskWatchdogPendingInteractionsByIssueId;
  resumed: boolean;
}) {
  const shortId = (id: string) => id.length > 8 ? `${id.slice(0, 8)}…` : id;
  const leafLines = input.stoppedLeaves.slice(0, 12).map((leaf) => {
    const interactionKinds = new Map(
      (input.pendingInteractionsByIssueId[leaf.issueId] ?? []).map((wait) => [wait.id, wait.kind]),
    );
    const waits = [
      ...leaf.pendingInteractionIds.map((id) => `${interactionKinds.get(id) ?? "interaction"} ${shortId(id)}`),
      ...leaf.pendingApprovalIds.map((id) => `approval ${shortId(id)}`),
    ];
    return `- ${leaf.identifier ?? leaf.issueId}: ${leaf.status}${waits.length > 0 ? ` (pending ${waits.join(", ")})` : ""}`;
  });
  const more = input.stoppedLeaves.length > leafLines.length
    ? `\n- ...and ${input.stoppedLeaves.length - leafLines.length} more stopped leaves`
    : "";
  return [
    input.resumed ? "Task watchdog resumed for stopped subtree." : "Task watchdog started for stopped subtree.",
    "",
    `Watched issue: ${input.sourceIssue.identifier ?? input.sourceIssue.id}`,
    `Stopped fingerprint: \`${input.stopFingerprint}\``,
    "",
    "Stopped leaves:",
    ...(leafLines.length > 0 ? leafLines : ["- No leaf issues found."]),
    more,
  ].filter((line) => line !== "").join("\n");
}

function stoppedFingerprintMetadata(input: {
  sourceIssueId: string;
  stopFingerprint: string;
  waitsByIssueId: TaskWatchdogWaitsByIssueId;
  resumed: boolean;
}) {
  const pendingWaitCount = Object.values(input.waitsByIssueId).reduce(
    (count, waits) => count + waits.pendingInteractionIds.length + waits.pendingApprovalIds.length,
    0,
  );
  return {
    version: 1 as const,
    sections: [
      {
        title: "Task Watchdog",
        rows: [
          { type: "text" as const, label: "Watched issue", text: input.sourceIssueId },
          { type: "text" as const, label: "Stopped fingerprint", text: input.stopFingerprint },
          { type: "text" as const, label: "Pending waits", text: String(pendingWaitCount) },
          { type: "text" as const, label: "Resume intent", text: input.resumed ? "true" : "false" },
        ],
      },
    ],
  };
}

function watchdogWakeContext(input: {
  watchdog: IssueWatchdogRow;
  watchdogIssue: IssueRow;
  sourceIssue: IssueRow;
  classification: Extract<TaskWatchdogClassifierResult, { state: "stopped" }>;
}) {
  return {
    issueId: input.watchdogIssue.id,
    taskId: input.watchdogIssue.id,
    wakeReason: "task_watchdog_stopped_subtree",
    source: TASK_WATCHDOG_ORIGIN_KIND,
    taskWatchdog: {
      watchedIssueId: input.sourceIssue.id,
      watchedIssueIdentifier: input.sourceIssue.identifier,
      watchedIssueTitle: input.sourceIssue.title,
      stopFingerprint: input.classification.stopFingerprint,
      pendingInteractions: input.classification.pendingInteractionsByIssueId,
      pendingApprovals: Object.fromEntries(Object.entries(input.classification.stopSnapshot.waitsByIssueId)
        .filter(([, waits]) => waits.pendingApprovalIds.length > 0)
        .map(([issueId, waits]) => [issueId, waits.pendingApprovalIds])),
      capabilities: {
        targetScope: {
          watchedIssueId: input.sourceIssue.id,
          watchedIssueIdentifier: input.sourceIssue.identifier,
          watchdogIssueId: input.watchdogIssue.id,
          includeNonWatchdogDescendants: true,
          excludedOriginKinds: [TASK_WATCHDOG_ORIGIN_KIND],
        },
        operations: [
          "comment_on_watched_subtree_issues",
          "transition_watched_subtree_issue_status",
          "reassign_watched_subtree_issues",
          "create_child_issues_under_non_watchdog_watched_subtree",
          "create_product_bug_followups_outside_watched_subtree",
          "resolve_issue_thread_interactions_through_ordinary_audience_policy",
          "update_reusable_watchdog_issue",
        ],
        deniedOperations: [
          "create_visible_probe_issues_or_throwaway_tasks",
          "create_product_bug_followups_as_source_tree_children",
          "mutate_task_watchdog_descendants",
          "mutate_outside_watched_subtree",
          "resolve_human_only_interactions_or_security_sensitive_approvals",
          "create_nested_task_watchdogs",
        ],
      },
    },
    watchdogId: input.watchdog.id,
    watchedIssueId: input.sourceIssue.id,
    watchedIssueIdentifier: input.sourceIssue.identifier,
    stopFingerprint: input.classification.stopFingerprint,
    stoppedLeaves: input.classification.stoppedLeaves,
    customInstructions: input.watchdog.instructions,
    resumeIntent: true,
    followUpRequested: true,
  };
}

function isTerminalIssueStatus(status: string) {
  return TASK_WATCHDOG_TERMINAL_ISSUE_STATUSES.includes(
    status as (typeof TASK_WATCHDOG_TERMINAL_ISSUE_STATUSES)[number],
  );
}

function isWatchdogReviewDisposition(issue: Pick<
  IssueRow,
  "status" | "assigneeUserId" | "executionState" | "monitorNextCheckAt"
>, hasPendingReviewPath: boolean) {
  if (issue.status === "done" || issue.status === "blocked") return true;
  if (issue.status !== "in_review") return false;
  return Boolean(issue.assigneeUserId || issue.executionState || issue.monitorNextCheckAt || hasPendingReviewPath);
}

function isUniqueConstraintConflict(error: unknown, constraintName: string) {
  const queue: unknown[] = [error];
  const messages: string[] = [];
  let hasUniqueCode = false;
  let hasConstraint = false;
  for (const candidate of queue) {
    if (!candidate || typeof candidate !== "object") continue;
    const typed = candidate as {
      code?: string;
      constraint?: string;
      constraint_name?: string;
      cause?: unknown;
      message?: string;
    };
    if (typed.code === "23505") hasUniqueCode = true;
    if (typed.constraint === constraintName || typed.constraint_name === constraintName) hasConstraint = true;
    if (typed.message) messages.push(typed.message);
    if (typed.cause) queue.push(typed.cause);
  }
  const message = messages.join("\n");
  return (hasUniqueCode || message.includes("duplicate key value violates unique constraint")) &&
    (hasConstraint || message.includes(constraintName));
}

function isActiveTaskWatchdogUniqueConflict(error: unknown) {
  return isUniqueConstraintConflict(error, "issues_active_task_watchdog_uq");
}

function isIssueWatchdogUniqueConflict(error: unknown) {
  return isUniqueConstraintConflict(error, "issue_watchdogs_company_issue_uq");
}

async function updateIssueWatchdogRow(
  dbOrTx: any,
  existing: IssueWatchdogRow,
  input: IssueWatchdogUpsertInput,
  now: Date,
) {
  const [updated] = await dbOrTx
    .update(issueWatchdogs)
    .set({
      watchdogAgentId: input.agentId,
      instructions: normalizeInstructions(input.instructions),
      status: "active",
      updatedByAgentId: input.actor?.agentId ?? null,
      updatedByUserId: input.actor?.userId ?? null,
      updatedByRunId: input.actor?.runId ?? null,
      updatedAt: now,
    })
    .where(eq(issueWatchdogs.id, existing.id))
    .returning();
  return updated;
}

export async function upsertIssueWatchdogForIssue(
  dbOrTx: any,
  companyId: string,
  issueId: string,
  input: IssueWatchdogUpsertInput,
): Promise<{ watchdog: IssueWatchdog; created: boolean }> {
  await assertWatchedIssue(dbOrTx, companyId, issueId);
  await assertWatchdogAgentInvokable(dbOrTx, companyId, input.agentId);

  const now = new Date();
  const existing = await dbOrTx
    .select()
    .from(issueWatchdogs)
    .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, issueId)))
    .then((rows: IssueWatchdogRow[]) => rows[0] ?? null);

  if (existing) {
    const updated = await updateIssueWatchdogRow(dbOrTx, existing, input, now);
    return { watchdog: toIssueWatchdog(updated), created: false };
  }

  const insertResult: { row: IssueWatchdogRow; created: boolean } = await dbOrTx
    .insert(issueWatchdogs)
    .values({
      companyId,
      issueId,
      watchdogAgentId: input.agentId,
      instructions: normalizeInstructions(input.instructions),
      status: "active",
      createdByAgentId: input.actor?.agentId ?? null,
      createdByUserId: input.actor?.userId ?? null,
      createdByRunId: input.actor?.runId ?? null,
      updatedByAgentId: input.actor?.agentId ?? null,
      updatedByUserId: input.actor?.userId ?? null,
      updatedByRunId: input.actor?.runId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .then((rows: IssueWatchdogRow[]) => ({ row: rows[0], created: true }))
    .catch(async (error: unknown) => {
      if (!isIssueWatchdogUniqueConflict(error)) throw error;
      const winner = await dbOrTx
        .select()
        .from(issueWatchdogs)
        .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, issueId)))
        .then((rows: IssueWatchdogRow[]) => rows[0] ?? null);
      if (!winner) throw error;
      const updated = await updateIssueWatchdogRow(dbOrTx, winner, input, now);
      return { row: updated, created: false };
    });
  return { watchdog: toIssueWatchdog(insertResult.row), created: insertResult.created };
}

export function taskWatchdogService(db: Db, deps: TaskWatchdogServiceDeps = {}) {
  const issuesSvc = issueService(db);

  async function loadWatchdogSubtreeIssues(companyId: string, watchedIssueId: string) {
    const rows = await db.execute(sql`
      WITH RECURSIVE watched_issues AS (
        SELECT
          id,
          company_id,
          identifier,
          title,
          status,
          parent_id,
          assignee_agent_id,
          assignee_user_id,
          origin_kind,
          updated_at,
          created_at,
          0 AS depth
        FROM issues
        WHERE company_id = ${companyId}
          AND id = ${watchedIssueId}
          AND hidden_at IS NULL
          AND harness_kind IS NULL
        UNION ALL
        SELECT
          child.id,
          child.company_id,
          child.identifier,
          child.title,
          child.status,
          child.parent_id,
          child.assignee_agent_id,
          child.assignee_user_id,
          child.origin_kind,
          child.updated_at,
          child.created_at,
          watched_issues.depth + 1
        FROM issues child
        JOIN watched_issues ON child.parent_id = watched_issues.id
        WHERE child.company_id = ${companyId}
          AND child.hidden_at IS NULL
          AND child.harness_kind IS NULL
          AND child.origin_kind <> ${TASK_WATCHDOG_ORIGIN_KIND}
          AND watched_issues.depth < ${TASK_WATCHDOG_SUBTREE_MAX_DEPTH - 1}
      )
      SELECT
        id,
        company_id AS "companyId",
        identifier,
        title,
        status,
        parent_id AS "parentId",
        assignee_agent_id AS "assigneeAgentId",
        assignee_user_id AS "assigneeUserId",
        origin_kind AS "originKind",
        updated_at AS "updatedAt",
        created_at AS "createdAt"
      FROM watched_issues
    `);

    return (Array.isArray(rows) ? rows : []) as TaskWatchdogClassifierIssue[];
  }

  async function collectClassifierInput(companyId: string, watchdog: IssueWatchdogRow) {
    const issueRows = await loadWatchdogSubtreeIssues(companyId, watchdog.issueId);
    const subtreeIssueIds = issueRows.map((issue) => issue.id);
    if (subtreeIssueIds.length === 0) {
      return {
        watchdog: summarizeIssueWatchdog(watchdog),
        issues: [],
        activeRuns: [],
        queuedWakeRequests: [],
        blockers: [],
        pendingInteractions: [],
        pendingApprovals: [],
        evaluatedAt: new Date(),
        firstRunGraceMs: TASK_WATCHDOG_FIRST_RUN_GRACE_MS,
        completedRunIssueIds: [],
      } satisfies TaskWatchdogClassifierInput;
    }

    const [
      activeRunRows,
      activeIssueRunRows,
      wakeRows,
      blockerRows,
      interactionRows,
      approvalRows,
      commentActivityRows,
      documentActivityRows,
      workProductActivityRows,
    ] = await Promise.all([
      db
        .select({
          companyId: heartbeatRuns.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, [...TASK_WATCHDOG_LIVE_RUN_STATUSES]),
          or(
            inArray(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`, subtreeIssueIds),
            inArray(sql`${heartbeatRuns.contextSnapshot}->>'taskId'`, subtreeIssueIds),
          ),
        )),
      db
        .select({
          companyId: issues.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          issueId: issues.id,
        })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(and(
          eq(issues.companyId, companyId),
          inArray(issues.id, subtreeIssueIds),
          visibleIssueCondition(),
          inArray(heartbeatRuns.status, [...TASK_WATCHDOG_LIVE_RUN_STATUSES]),
        )),
      db
        .select({
          companyId: agentWakeupRequests.companyId,
          agentId: agentWakeupRequests.agentId,
          status: agentWakeupRequests.status,
          payload: agentWakeupRequests.payload,
        })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, [...TASK_WATCHDOG_WAKE_REQUEST_STATUSES]),
          or(
            inArray(sql`${agentWakeupRequests.payload}->>'issueId'`, subtreeIssueIds),
            inArray(sql`${agentWakeupRequests.payload}->>'taskId'`, subtreeIssueIds),
            inArray(sql`${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'issueId'`, subtreeIssueIds),
            inArray(sql`${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'taskId'`, subtreeIssueIds),
          ),
        )),
      db
        .select({
          companyId: issueRelations.companyId,
          blockerIssueId: issueRelations.issueId,
          blockedIssueId: issueRelations.relatedIssueId,
        })
        .from(issueRelations)
        .where(and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
          inArray(issueRelations.relatedIssueId, subtreeIssueIds),
        )),
      db
        .select({
          companyId: issueThreadInteractions.companyId,
          issueId: issueThreadInteractions.issueId,
          id: issueThreadInteractions.id,
          kind: issueThreadInteractions.kind,
          status: issueThreadInteractions.status,
        })
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, companyId),
          inArray(issueThreadInteractions.issueId, subtreeIssueIds),
          eq(issueThreadInteractions.status, "pending"),
        )),
      db
        .select({
          companyId: issueApprovals.companyId,
          issueId: issueApprovals.issueId,
          id: approvals.id,
          status: approvals.status,
        })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(and(
          eq(issueApprovals.companyId, companyId),
          inArray(issueApprovals.issueId, subtreeIssueIds),
          inArray(approvals.status, ["pending", "revision_requested"]),
        )),
      db
        .select({
          issueId: issueComments.issueId,
          latestAt: sql<Date | null>`MAX(${issueComments.updatedAt})`,
        })
        .from(issueComments)
        .where(and(
          eq(issueComments.companyId, companyId),
          inArray(issueComments.issueId, subtreeIssueIds),
          isNull(issueComments.deletedAt),
        ))
        .groupBy(issueComments.issueId),
      db
        .select({
          issueId: issueDocuments.issueId,
          latestAt: sql<Date | null>`MAX(${issueDocuments.updatedAt})`,
        })
        .from(issueDocuments)
        .where(and(
          eq(issueDocuments.companyId, companyId),
          inArray(issueDocuments.issueId, subtreeIssueIds),
        ))
        .groupBy(issueDocuments.issueId),
      db
        .select({
          issueId: issueWorkProducts.issueId,
          latestAt: sql<Date | null>`MAX(${issueWorkProducts.updatedAt})`,
        })
        .from(issueWorkProducts)
        .where(and(
          eq(issueWorkProducts.companyId, companyId),
          inArray(issueWorkProducts.issueId, subtreeIssueIds),
        ))
        .groupBy(issueWorkProducts.issueId),
    ]);
    const latestCommentByIssueId = new Map(commentActivityRows.map((row) => [row.issueId, row.latestAt]));
    const latestDocumentByIssueId = new Map(documentActivityRows.map((row) => [row.issueId, row.latestAt]));
    const latestWorkProductByIssueId = new Map(workProductActivityRows.map((row) => [row.issueId, row.latestAt]));

    const evaluatedAt = new Date();
    const evaluatedAtMs = evaluatedAt.getTime();
    // Only the issues created within the first-run grace window can be racing
    // their own assignment run; scope the (potentially expensive) terminal-run
    // lookup to those few issues so the common path stays a no-op.
    const freshIssueIds = issueRows
      .filter((row) => {
        if (isTerminalIssueStatus(row.status)) return false;
        const createdAtMs = toEpochMs(row.createdAt);
        return createdAtMs != null && evaluatedAtMs - createdAtMs < TASK_WATCHDOG_FIRST_RUN_GRACE_MS;
      })
      .map((row) => row.id);
    const completedRunIssueIds = await collectCompletedRunIssueIds(companyId, freshIssueIds);

    return {
      watchdog: {
        ...summarizeIssueWatchdog(watchdog),
        lastReviewedStopSnapshot: parseStopSnapshot(watchdog.lastReviewedStopSnapshot),
      },
      issues: issueRows.map((issue) => ({
        ...issue,
        latestCommentAt: latestCommentByIssueId.get(issue.id) ?? null,
        latestDocumentAt: latestDocumentByIssueId.get(issue.id) ?? null,
        latestWorkProductAt: latestWorkProductByIssueId.get(issue.id) ?? null,
      })),
      activeRuns: activeRunRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: issueIdFromRunContext(row.contextSnapshot),
      })).concat(activeIssueRunRows),
      queuedWakeRequests: wakeRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: issueIdFromWakePayload(row.payload),
      })),
      blockers: blockerRows,
      pendingInteractions: interactionRows,
      pendingApprovals: approvalRows,
      evaluatedAt,
      firstRunGraceMs: TASK_WATCHDOG_FIRST_RUN_GRACE_MS,
      completedRunIssueIds,
    } satisfies TaskWatchdogClassifierInput;
  }

  // Returns the subset of `issueIds` that already have at least one run in a
  // terminal status. Such issues have demonstrably executed, so a stopped
  // subtree is genuine and must not be masked by the pending-first-run guard.
  async function collectCompletedRunIssueIds(companyId: string, issueIds: string[]) {
    if (issueIds.length === 0) return [];
    const candidates = new Set(issueIds);
    const [contextRuns, executionRuns] = await Promise.all([
      db
        .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, [...TASK_WATCHDOG_TERMINAL_RUN_STATUSES]),
          or(
            inArray(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`, issueIds),
            inArray(sql`${heartbeatRuns.contextSnapshot}->>'taskId'`, issueIds),
          ),
        )),
      db
        .select({ issueId: issues.id })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(and(
          eq(issues.companyId, companyId),
          inArray(issues.id, issueIds),
          inArray(heartbeatRuns.status, [...TASK_WATCHDOG_TERMINAL_RUN_STATUSES]),
        )),
    ]);
    const completed = new Set<string>();
    for (const row of contextRuns) {
      const issueId = issueIdFromRunContext(row.contextSnapshot);
      if (issueId && candidates.has(issueId)) completed.add(issueId);
    }
    for (const row of executionRuns) {
      completed.add(row.issueId);
    }
    return [...completed];
  }

  async function findTaskWatchdogIssue(companyId: string, watchedIssueId: string) {
    return db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, TASK_WATCHDOG_ORIGIN_KIND),
        eq(issues.originId, watchedIssueId),
        visibleIssueCondition(),
      ))
      .orderBy(asc(issues.createdAt), asc(issues.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function hasLivePathForIssue(companyId: string, issueId: string) {
    const [run, issueRun, wake] = await Promise.all([
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, [...TASK_WATCHDOG_LIVE_RUN_STATUSES]),
          sql`(${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}
            OR ${heartbeatRuns.contextSnapshot}->>'taskId' = ${issueId})`,
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: heartbeatRuns.id })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(and(
          eq(issues.companyId, companyId),
          eq(issues.id, issueId),
          inArray(heartbeatRuns.status, [...TASK_WATCHDOG_LIVE_RUN_STATUSES]),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, [...TASK_WATCHDOG_WAKE_REQUEST_STATUSES]),
          sql`(${agentWakeupRequests.payload}->>'issueId' = ${issueId}
            OR ${agentWakeupRequests.payload}->>'taskId' = ${issueId}
            OR ${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'issueId' = ${issueId}
            OR ${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'taskId' = ${issueId})`,
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(run || issueRun || wake);
  }

  async function sameFingerprintWatchdogReviewIsStillOpen(
    watchdogIssue: IssueRow | null,
    stopFingerprint: string,
  ) {
    if (!watchdogIssue) return false;
    if (watchdogIssue.originFingerprint !== stopFingerprint) return false;
    if (isTerminalIssueStatus(watchdogIssue.status) || watchdogIssue.status === "backlog") return false;
    if (watchdogIssue.status === "in_review") {
      const hasPendingReviewPath = await watchdogIssueHasPendingReviewPath(watchdogIssue.companyId, watchdogIssue.id);
      return isWatchdogReviewDisposition(watchdogIssue, hasPendingReviewPath);
    }
    return true;
  }

  async function watchdogIssueNeedsFreshWake(watchdogIssue: IssueRow) {
    if (watchdogIssue.status !== "in_review") return false;
    const hasPendingReviewPath = await watchdogIssueHasPendingReviewPath(watchdogIssue.companyId, watchdogIssue.id);
    return !isWatchdogReviewDisposition(watchdogIssue, hasPendingReviewPath);
  }

  async function watchdogIssueHasPendingReviewPath(companyId: string, issueId: string) {
    const [interaction, approval] = await Promise.all([
      db
        .select({ id: issueThreadInteractions.id })
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.issueId, issueId),
          eq(issueThreadInteractions.status, "pending"),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: approvals.id })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(and(
          eq(issueApprovals.companyId, companyId),
          eq(issueApprovals.issueId, issueId),
          inArray(approvals.status, ["pending", "revision_requested"]),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(interaction || approval);
  }

  async function markTerminalWatchdogIssueReviewed(watchdog: IssueWatchdogRow, opts: { runId?: string | null } = {}) {
    if (!watchdog.watchdogIssueId || !watchdog.lastObservedFingerprint) return watchdog;
    const watchdogIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, watchdog.companyId), eq(issues.id, watchdog.watchdogIssueId)))
      .then((rows) => rows[0] ?? null);
    if (!watchdogIssue) return watchdog;
    const hasPendingReviewPath = watchdogIssue.status === "in_review"
      ? await watchdogIssueHasPendingReviewPath(watchdog.companyId, watchdogIssue.id)
      : false;
    if (!isWatchdogReviewDisposition(watchdogIssue, hasPendingReviewPath)) return watchdog;
    const reviewedFingerprint = reviewedFingerprintForWatchdogIssue(watchdogIssue);
    if (!reviewedFingerprint) return watchdog;
    const observedSnapshot = parseStopSnapshot(watchdog.lastObservedStopSnapshot);
    const reviewedStopSnapshot = observedSnapshot?.fingerprint === reviewedFingerprint
      ? observedSnapshot
      : null;
    if (
      watchdog.lastReviewedFingerprint === reviewedFingerprint &&
      canonicalJson(parseStopSnapshot(watchdog.lastReviewedStopSnapshot)) === canonicalJson(reviewedStopSnapshot)
    ) return watchdog;
    const [updated] = await db
      .update(issueWatchdogs)
      .set({
        lastReviewedFingerprint: reviewedFingerprint,
        lastReviewedStopSnapshot: reviewedStopSnapshot,
        lastCompletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(issueWatchdogs.id, watchdog.id))
      .returning();
    await logActivity(db, {
      companyId: watchdog.companyId,
      actorType: "system",
      actorId: "system",
      agentId: watchdog.watchdogAgentId,
      runId: opts.runId ?? null,
      action: "issue.task_watchdog_fingerprint_reviewed",
      entityType: "issue",
      entityId: watchdog.issueId,
      details: {
        source: "task_watchdogs.review_disposition",
        watchdogId: watchdog.id,
        watchdogIssueId: watchdogIssue.id,
        reviewedFingerprint,
        lastObservedFingerprint: watchdog.lastObservedFingerprint,
        reviewedStopSnapshot,
        watchdogIssueStatus: watchdogIssue.status,
      },
    });
    return updated ?? watchdog;
  }

  async function ensureReusableWatchdogIssue(input: {
    watchdog: IssueWatchdogRow;
    sourceIssue: IssueRow;
    classification: Extract<TaskWatchdogClassifierResult, { state: "stopped" }>;
    runId?: string | null;
  }) {
    const existing = input.watchdog.watchdogIssueId
      ? await db
        .select()
        .from(issues)
        .where(and(
          eq(issues.companyId, input.watchdog.companyId),
          eq(issues.id, input.watchdog.watchdogIssueId),
          visibleIssueCondition(),
        ))
        .then((rows) => rows[0] ?? null)
      : null;
    const fallback = existing ?? await findTaskWatchdogIssue(input.watchdog.companyId, input.sourceIssue.id);

    if (fallback) {
      const shouldReopen = isTerminalIssueStatus(fallback.status) ||
        fallback.status === "backlog" ||
        await watchdogIssueNeedsFreshWake(fallback);
      const watchdogIssue = shouldReopen
        ? await issuesSvc.update(fallback.id, {
          status: "todo",
          assigneeAgentId: input.watchdog.watchdogAgentId,
          parentId: input.sourceIssue.id,
          projectId: input.sourceIssue.projectId,
          goalId: input.sourceIssue.goalId,
          billingCode: input.sourceIssue.billingCode,
          originFingerprint: input.classification.stopFingerprint,
        }) ?? fallback
        : fallback;
      if (!shouldReopen && watchdogIssue.originFingerprint !== input.classification.stopFingerprint) {
        await db
          .update(issues)
          .set({ originFingerprint: input.classification.stopFingerprint, updatedAt: new Date() })
          .where(and(eq(issues.companyId, input.watchdog.companyId), eq(issues.id, watchdogIssue.id)));
        watchdogIssue.originFingerprint = input.classification.stopFingerprint;
      }
      await issuesSvc.addComment(
        watchdogIssue.id,
        buildStoppedFingerprintComment({
          sourceIssue: input.sourceIssue,
          stopFingerprint: input.classification.stopFingerprint,
          stoppedLeaves: input.classification.stoppedLeaves,
          pendingInteractionsByIssueId: input.classification.pendingInteractionsByIssueId,
          resumed: true,
        }),
        { runId: input.runId ?? null },
        {
          authorType: "system",
          metadata: stoppedFingerprintMetadata({
            sourceIssueId: input.sourceIssue.id,
            stopFingerprint: input.classification.stopFingerprint,
            waitsByIssueId: input.classification.stopSnapshot.waitsByIssueId,
            resumed: true,
          }),
        },
      );
      return watchdogIssue;
    }

    const created = await issuesSvc.create(input.sourceIssue.companyId, {
        title: `Watchdog review for ${input.sourceIssue.identifier ?? input.sourceIssue.title}`,
        description: [
          "Task watchdog review issue.",
          "",
          `Watched issue: ${input.sourceIssue.identifier ?? input.sourceIssue.id}`,
          `Stopped fingerprint: ${input.classification.stopFingerprint}`,
          "",
          "The watchdog agent should verify the stopped subtree and either confirm the disposition or restore a valid live path.",
        ].join("\n"),
        status: "todo",
        priority: input.sourceIssue.priority,
        parentId: input.sourceIssue.id,
        projectId: input.sourceIssue.projectId,
        goalId: input.sourceIssue.goalId,
        assigneeAgentId: input.watchdog.watchdogAgentId,
        originKind: TASK_WATCHDOG_ORIGIN_KIND,
        originId: input.sourceIssue.id,
        originFingerprint: input.classification.stopFingerprint,
        billingCode: input.sourceIssue.billingCode,
        inheritExecutionWorkspaceFromIssueId: input.sourceIssue.id,
      })
      .catch(async (error: unknown) => {
        if (!isActiveTaskWatchdogUniqueConflict(error)) throw error;
        const winner = await findTaskWatchdogIssue(input.watchdog.companyId, input.sourceIssue.id);
        if (!winner) throw error;
        return winner;
      });
    await issuesSvc.addComment(
      created.id,
      buildStoppedFingerprintComment({
        sourceIssue: input.sourceIssue,
        stopFingerprint: input.classification.stopFingerprint,
        stoppedLeaves: input.classification.stoppedLeaves,
        pendingInteractionsByIssueId: input.classification.pendingInteractionsByIssueId,
        resumed: false,
      }),
      { runId: input.runId ?? null },
      {
        authorType: "system",
        metadata: stoppedFingerprintMetadata({
          sourceIssueId: input.sourceIssue.id,
          stopFingerprint: input.classification.stopFingerprint,
          waitsByIssueId: input.classification.stopSnapshot.waitsByIssueId,
          resumed: false,
        }),
      },
    );
    return created;
  }

  async function evaluateWatchdog(row: IssueWatchdogRow, opts: { runId?: string | null } = {}) {
    const watchdog = await markTerminalWatchdogIssueReviewed(row, opts);
    const sourceIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, watchdog.companyId), eq(issues.id, watchdog.issueId), visibleIssueCondition()))
      .then((rows) => rows[0] ?? null);
    if (!sourceIssue || sourceIssue.originKind === TASK_WATCHDOG_ORIGIN_KIND) {
      return { state: "skipped" as const, reason: "watched_issue_not_applicable" };
    }

    const input = await collectClassifierInput(watchdog.companyId, watchdog);
    const classification = classifyTaskWatchdogSubtree(input);
    if (classification.state !== "stopped") {
      return { state: classification.state, reason: classification.reason, classification };
    }

    const existingWatchdogIssueId = watchdog.watchdogIssueId ?? (await findTaskWatchdogIssue(
      watchdog.companyId,
      sourceIssue.id,
    ))?.id ?? null;
    if (existingWatchdogIssueId && await hasLivePathForIssue(watchdog.companyId, existingWatchdogIssueId)) {
      await db
        .update(issueWatchdogs)
        .set({
          watchdogIssueId: existingWatchdogIssueId,
          lastObservedFingerprint: classification.stopFingerprint,
          lastObservedStopSnapshot: classification.stopSnapshot,
          updatedAt: new Date(),
        })
        .where(eq(issueWatchdogs.id, watchdog.id));
      return { state: "watchdog_live" as const, classification, watchdogIssueId: existingWatchdogIssueId };
    }
    const existingWatchdogIssue = existingWatchdogIssueId
      ? await db
        .select()
        .from(issues)
        .where(and(
          eq(issues.companyId, watchdog.companyId),
          eq(issues.id, existingWatchdogIssueId),
          visibleIssueCondition(),
        ))
        .then((rows) => rows[0] ?? null)
      : null;
    if (await sameFingerprintWatchdogReviewIsStillOpen(existingWatchdogIssue, classification.stopFingerprint)) {
      if (
        watchdog.watchdogIssueId !== existingWatchdogIssue!.id ||
        watchdog.lastObservedFingerprint !== classification.stopFingerprint ||
        canonicalJson(parseStopSnapshot(watchdog.lastObservedStopSnapshot)) !== canonicalJson(classification.stopSnapshot)
      ) {
        await db
          .update(issueWatchdogs)
          .set({
            watchdogIssueId: existingWatchdogIssue!.id,
            lastObservedFingerprint: classification.stopFingerprint,
            lastObservedStopSnapshot: classification.stopSnapshot,
            updatedAt: new Date(),
          })
          .where(eq(issueWatchdogs.id, watchdog.id));
      }
      return {
        state: "watchdog_review_open" as const,
        classification,
        watchdogIssueId: existingWatchdogIssue!.id,
      };
    }

    const watchdogIssue = await ensureReusableWatchdogIssue({
      watchdog,
      sourceIssue,
      classification,
      runId: opts.runId ?? null,
    });
    const now = new Date();
    await db
      .update(issueWatchdogs)
      .set({
        watchdogIssueId: watchdogIssue.id,
        lastObservedFingerprint: classification.stopFingerprint,
        lastObservedStopSnapshot: classification.stopSnapshot,
        lastTriggeredAt: now,
        triggerCount: sql`${issueWatchdogs.triggerCount} + 1`,
        updatedAt: now,
      })
      .where(eq(issueWatchdogs.id, watchdog.id));

    await logActivity(db, {
      companyId: sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: watchdog.watchdogAgentId,
      runId: opts.runId ?? null,
      action: "issue.task_watchdog_triggered",
      entityType: "issue",
      entityId: sourceIssue.id,
      details: {
        source: "task_watchdogs.evaluate",
        watchdogId: watchdog.id,
        watchdogIssueId: watchdogIssue.id,
        stopFingerprint: classification.stopFingerprint,
        stopSnapshot: classification.stopSnapshot,
        stoppedLeaves: classification.stoppedLeaves,
      },
    });

    const context = watchdogWakeContext({
      watchdog,
      watchdogIssue,
      sourceIssue,
      classification,
    });
    const wake = deps.enqueueWakeup
      ? await deps.enqueueWakeup(watchdog.watchdogAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "task_watchdog_stopped_subtree",
        payload: context,
        contextSnapshot: context,
        idempotencyKey: taskWatchdogWakeIdempotencyKey(watchdog.id, classification.stopFingerprint),
        requestedByActorType: "system",
        requestedByActorId: null,
      })
      : null;

    return {
      state: "triggered" as const,
      classification,
      watchdogIssueId: watchdogIssue.id,
      wakeupRunId: wake?.id ?? null,
    };
  }

  async function listActiveWatchdogsForCompany(companyId?: string | null) {
    return db
      .select()
      .from(issueWatchdogs)
      .where(and(
        eq(issueWatchdogs.status, "active"),
        ...(companyId ? [eq(issueWatchdogs.companyId, companyId)] : []),
      ));
  }

  async function activeWatchdogsForIssueAndAncestors(companyId: string, issueId: string) {
    const ancestorRows = await db.execute(sql`
      WITH RECURSIVE ancestors(id, parent_id, depth) AS (
        SELECT id, parent_id, 0
        FROM issues
        WHERE company_id = ${companyId}
          AND id = ${issueId}
          AND hidden_at IS NULL
          AND harness_kind IS NULL
        UNION ALL
        SELECT parent.id, parent.parent_id, ancestors.depth + 1
        FROM issues parent
        JOIN ancestors ON parent.id = ancestors.parent_id
        WHERE parent.company_id = ${companyId}
          AND parent.hidden_at IS NULL
          AND parent.harness_kind IS NULL
          AND ancestors.depth < ${TASK_WATCHDOG_SUBTREE_MAX_DEPTH - 1}
      )
      SELECT id FROM ancestors
    `);
    const ancestorIds = (Array.isArray(ancestorRows) ? ancestorRows : [])
      .map((row) => typeof row === "object" && row !== null ? (row as Record<string, unknown>).id : null)
      .filter((id): id is string => typeof id === "string");
    if (ancestorIds.length === 0) return [];
    return db
      .select()
      .from(issueWatchdogs)
      .where(and(
        eq(issueWatchdogs.companyId, companyId),
        eq(issueWatchdogs.status, "active"),
        inArray(issueWatchdogs.issueId, ancestorIds),
      ));
  }

  // The freshness guard every watched-subtree mutation passes through, and the
  // only place drift is adjudicated. It runs *before* the route mutates
  // anything, so a subtree that moved underneath this run is rejected while
  // rejecting it still means something: nothing has been written yet.
  //
  // Three ways in:
  //
  //  1. The subtree still hashes to the fingerprint the run's wake pinned. The
  //     original fast path, unchanged.
  //  2. The fingerprint moved, but the run holds a mutation ledger and every
  //     fingerprint input that moved is `baseline + what this run declared it
  //     wrote`. That is the run's own sanctioned action catching up with it —
  //     the lockout this issue is about — and it is admitted.
  //  3. Anything else, including a subtree that is no longer stopped for
  //     reasons this run's ledger does not account for. Rejected, as before.
  //
  // Note what is *not* here any more: nothing re-reads the subtree after a
  // mutation to work out what the run did. The run says what it wrote, from its
  // own `RETURNING` row, and that claim is checked here before the next write.
  async function revalidateMutationScope(scope: {
    kind: "watchdog";
    watchdogId: string;
    companyId: string;
    watchedIssueId: string;
    stopFingerprint: string | null;
    runId?: string | null;
    mutationLedger?: unknown;
  }, opts: {
    // What the request is actually trying to do. A comment that only adds a
    // comment is inert by construction — `materialLeaf` strips
    // `latestCommentAt`, so it can neither rotate the stop fingerprint nor
    // change the classification — and it is the one write the mandate still
    // requires from a run whose own recovery already restarted the subtree.
    // Anything else is a state change and is held to the stricter rule below.
    //
    // The caller decides this per *request*, not per route: the comment route
    // also carries `resume`/`reopen`/`interrupt` and approval markers, each of
    // which moves issue state while wearing a comment's clothes. See
    // `issueCommentWatchdogIntent` in the issue routes.
    intent?: "comment" | "mutate";
    // The issue this request is about to write. Needed to tell a state change
    // aimed at an idle leaf from one aimed at a leaf that now has an owner of
    // its own; absent, a state change is refused rather than guessed at.
    targetIssueId?: string | null;
  } = {}) {
    const intent = opts.intent ?? "mutate";
    const targetIssueId = opts.targetIssueId ?? null;
    if (!scope.stopFingerprint) {
      return {
        allowed: false as const,
        reason: "Task-watchdog run context is missing the stopped fingerprint required for mutation revalidation.",
      };
    }

    // Re-asserted here and not only in the scope resolver. `issueWatchdogs`
    // going inactive is the only expiry the rest of this function knows about,
    // and a watchdog does not go inactive when a run ends — so without this the
    // guard's own answer would still be "fresh" for a run that is over. The
    // resolver checks the same thing a moment earlier; this closes the window
    // between the two, and covers every caller that builds a scope by other
    // means.
    if (scope.runId) {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, scope.runId))
        .then((rows) => rows[0] ?? null);
      if (!run || isTerminalWatchdogRunStatus(run.status)) {
        return {
          allowed: false as const,
          reason: "Task-watchdog run has already finished; its mutation scope no longer applies.",
        };
      }
    }

    const watchdog = await db
      .select()
      .from(issueWatchdogs)
      .where(and(
        eq(issueWatchdogs.id, scope.watchdogId),
        eq(issueWatchdogs.companyId, scope.companyId),
        eq(issueWatchdogs.issueId, scope.watchedIssueId),
        eq(issueWatchdogs.status, "active"),
      ))
      .then((rows) => rows[0] ?? null);
    if (!watchdog) {
      return {
        allowed: false as const,
        reason: "Task-watchdog run context is not backed by an active persisted watchdog.",
      };
    }

    const input = await collectClassifierInput(watchdog.companyId, watchdog);
    const classification = classifyTaskWatchdogSubtree(input);
    if (classification.state === "stopped" && classification.stopFingerprint === scope.stopFingerprint) {
      return {
        allowed: true as const,
        classification,
        ledgerBaseline: {
          baseline: classification.stopSnapshot,
          baselineMaterialByIssueId: classification.materialByIssueId,
        } satisfies TaskWatchdogLedgerBaseline,
      };
    }

    const staleReason = classification.state === "stopped"
      ? "Task-watchdog review is stale because the watched subtree stop fingerprint changed; refresh the source state before mutating it."
      : "Task-watchdog review is stale because the watched subtree now has a live, waiting, already-reviewed, or not-applicable path; refresh the source state before mutating it.";

    // A malformed or absent ledger is simply no ledger: the run has nothing on
    // record that could account for the drift, so the guard rejects as it
    // always did rather than trusting a shape it does not recognise.
    const ledger = parseMutationLedger(scope.mutationLedger);
    if (!ledger) return { allowed: false as const, reason: staleReason, classification };
    // Every state that carries a `stopSnapshot` can be adjudicated against the
    // ledger, and `already_reviewed` is one of them. It is reached routinely by
    // a run's *own* first sanctioned action: closing a stale leaf makes the
    // current snapshot a shrink of the reviewed one, which is precisely
    // `isShrinkOfReviewedSnapshot`. Excluding it left the mandated summary
    // comment 409ing after an ordinary recovery — the same lockout by another
    // route. `not_applicable` genuinely carries no subtree to diff, so it stays
    // a rejection.
    if (
      classification.state !== "stopped"
      && classification.state !== "live"
      && classification.state !== "pending_first_run"
      && classification.state !== "already_reviewed"
    ) {
      return { allowed: false as const, reason: staleReason, classification };
    }

    const unattributedIssueIds = unattributedSubtreeChanges({
      ledger,
      next: classification.stopSnapshot,
      nextMaterialByIssueId: classification.materialByIssueId,
      parentByIssueId: new Map(input.issues.map((issue) => [issue.id, issue.parentId ?? null])),
    });
    const unattributedLiveness = classification.state === "live"
      ? unattributedLivenessIssueIds(ledger, classification.liveIssueIds, false)
      : classification.state === "pending_first_run"
      ? unattributedLivenessIssueIds(ledger, classification.pendingIssueIds, true)
      : [];
    if (unattributedIssueIds.length > 0 || unattributedLiveness.length > 0) {
      return {
        allowed: false as const,
        reason: staleReason,
        classification,
        unattributedIssueIds,
        unattributedLivenessIssueIds: unattributedLiveness,
      };
    }

    // Everything above answers one question: is the subtree still the one this
    // run was authorized against, or has somebody else moved it? That is a
    // freshness verdict, and on its own it is not an authorization — it says
    // nothing about *what* the request is about to do. Handing the same
    // `allowed: true` to a summary comment, a status PATCH, a child creation
    // and an interaction resolution is what turned the narrow grant this guard
    // exists to restore into general authority over the subtree.
    //
    // The distinction that matters is ownership. Once the recovery has done its
    // job the subtree has a live path again, and the issue carrying it has an
    // owner that is not this watchdog. Closing, blocking or reassigning that
    // issue now races a running agent — an authority the watchdog never needed
    // and was never meant to have. The mandated audit comment is different in
    // kind: it cannot rotate the fingerprint or change the classification, so
    // it stays admitted, which is the whole point of the relaxation.
    //
    // Idle leaves elsewhere in the subtree are untouched by this: the run may
    // still finish the rest of its recovery on them. It is specifically the
    // issue that now has its own live or imminent execution path that is off
    // limits, and a state change that will not say what it targets is refused
    // rather than assumed harmless.
    if (intent !== "comment") {
      const ownedIssueIds = classification.state === "live"
        ? classification.liveIssueIds
        : classification.state === "pending_first_run"
        ? classification.pendingIssueIds
        : [];
      if (ownedIssueIds.length > 0 && (targetIssueId == null || ownedIssueIds.includes(targetIssueId))) {
        return {
          allowed: false as const,
          reason: targetIssueId == null
            ? "Task-watchdog runs may only add a comment once the watched subtree has a live execution path; this request did not declare which issue it writes."
            : "Task-watchdog runs may only add a comment to an issue that now has its own live execution path; its owner is not the watchdog.",
          classification,
          liveOwnedIssueIds: ownedIssueIds,
        };
      }
    }

    // The baseline stays put. Drift is always measured from the state the run
    // was last genuinely validated against, so a run cannot walk the subtree
    // away from its wake one attributable step at a time.
    return {
      allowed: true as const,
      classification,
      ledgerBaseline: {
        baseline: ledger.baseline,
        baselineMaterialByIssueId: ledger.baselineMaterialByIssueId,
      } satisfies TaskWatchdogLedgerBaseline,
    };
  }

  // Records what a watchdog run was authorized to write, in the run's own
  // context, so the guard above can tell the run's own drift from anybody
  // else's on the next request.
  //
  // This reads no subtree state at all. Everything it persists — the baseline
  // the guard admitted this request against, and the fields the request
  // reported writing — was already known before the mutation ran, which is what
  // makes it immune to a third party landing a change in the same window.
  //
  // Failing to record is fail-closed: the run's next watched-subtree mutation
  // sees a fingerprint it cannot account for and is rejected, exactly as it
  // would have been before any of this existed.
  async function recordAuthorizedMutation(
    scope: {
      kind: "watchdog";
      watchdogId: string;
      companyId: string;
      watchedIssueId: string;
      stopFingerprint: string | null;
      runId: string | null;
    },
    entry: {
      ledgerBaseline: TaskWatchdogLedgerBaseline | null;
      mutations: TaskWatchdogAuthorizedMutation[];
    },
  ) {
    if (!scope.runId) return { recorded: false as const, reason: "missing_run_id" };
    if (!scope.stopFingerprint) return { recorded: false as const, reason: "missing_stop_fingerprint" };
    if (!entry.ledgerBaseline) return { recorded: false as const, reason: "missing_ledger_baseline" };
    if (entry.mutations.length === 0) return { recorded: false as const, reason: "no_mutations" };

    const run = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scope.runId))
      .then((rows) => rows[0] ?? null);
    if (!run || run.companyId !== scope.companyId) {
      return { recorded: false as const, reason: "run_not_found" };
    }

    // `taskWatchdog` may legitimately be the literal `true`, in which case the
    // scope resolver falls back to reading the top level of the context. Write
    // the ledger to whichever of the two places that resolver will read.
    const nested = isPlainRecord(parseObject(run.contextSnapshot).taskWatchdog);
    const ledgerPath = nested
      ? sql`array['taskWatchdog', 'mutationLedger']`
      : sql`array['mutationLedger']`;
    const existingLedger = nested
      ? sql`${heartbeatRuns.contextSnapshot} #> array['taskWatchdog', 'mutationLedger']`
      : sql`${heartbeatRuns.contextSnapshot} #> array['mutationLedger']`;
    const freshLedger: TaskWatchdogMutationLedger = {
      version: 1,
      baseline: entry.ledgerBaseline.baseline,
      baselineMaterialByIssueId: entry.ledgerBaseline.baselineMaterialByIssueId,
      mutations: entry.mutations,
    };

    // One statement, so two concurrent requests of the same run both land:
    // appending to the array Postgres reads inside the same update cannot lose
    // the other's entry the way a read-modify-write would. An existing ledger
    // keeps its baseline — drift is always measured from the state the run was
    // last genuinely validated against, never from a later one.
    //
    // The `where` clause mirrors the resolver's read precedence and pins the
    // write to the run context this request was resolved from, so a ledger is
    // never grafted onto a run whose pin somebody moved in the meantime.
    const currentPin = sql`coalesce(
      ${heartbeatRuns.contextSnapshot} #>> array['taskWatchdog', 'stopFingerprint'],
      ${heartbeatRuns.contextSnapshot} #>> array['stopFingerprint']
    )`;
    const updated = await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: sql`jsonb_set(
          case
            when jsonb_typeof(${heartbeatRuns.contextSnapshot}) = 'object'
              then ${heartbeatRuns.contextSnapshot}
            else '{}'::jsonb
          end,
          ${ledgerPath},
          case
            when ${existingLedger} -> 'version' = '1'::jsonb
              then jsonb_set(
                ${existingLedger},
                array['mutations'],
                coalesce(${existingLedger} -> 'mutations', '[]'::jsonb)
                  || ${JSON.stringify(entry.mutations)}::jsonb
              )
            else ${JSON.stringify(freshLedger)}::jsonb
          end,
          true
        )`,
      })
      .where(and(
        eq(heartbeatRuns.id, run.id),
        sql`${currentPin} is not distinct from ${scope.stopFingerprint}::text`,
      ))
      .returning({ id: heartbeatRuns.id });
    if (updated.length === 0) {
      return { recorded: false as const, reason: "run_context_changed" };
    }

    return { recorded: true as const, mutations: entry.mutations };
  }

  return {
    getActiveForIssue: async (companyId: string, issueId: string): Promise<IssueWatchdog | null> => {
      const row = await db
        .select()
        .from(issueWatchdogs)
        .where(and(
          eq(issueWatchdogs.companyId, companyId),
          eq(issueWatchdogs.issueId, issueId),
          eq(issueWatchdogs.status, "active"),
        ))
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWatchdog(row) : null;
    },

    listActiveSummariesForIssues: async (
      companyId: string,
      issueIds: string[],
      dbOrTx: any = db,
    ): Promise<Map<string, IssueWatchdogSummary>> => {
      if (issueIds.length === 0) return new Map();
      const rows = await dbOrTx
        .select()
        .from(issueWatchdogs)
        .where(and(
          eq(issueWatchdogs.companyId, companyId),
          inArray(issueWatchdogs.issueId, [...new Set(issueIds)]),
          eq(issueWatchdogs.status, "active"),
        ));
      return new Map(rows.map((row: IssueWatchdogRow) => [row.issueId, summarizeIssueWatchdog(row)]));
    },

    upsertForIssue: async (
      companyId: string,
      issueId: string,
      input: IssueWatchdogUpsertInput,
    ): Promise<{ watchdog: IssueWatchdog; created: boolean }> => {
      return upsertIssueWatchdogForIssue(db, companyId, issueId, input);
    },

    disableForIssue: async (
      companyId: string,
      issueId: string,
      actor: ActorFields = {},
    ): Promise<IssueWatchdog | null> => {
      await assertWatchedIssue(db, companyId, issueId);
      const existing = await db
        .select()
        .from(issueWatchdogs)
        .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, issueId)))
        .then((rows) => rows[0] ?? null);
      if (!existing || existing.status === "disabled") return null;
      const [updated] = await db
        .update(issueWatchdogs)
        .set({
          status: "disabled",
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedByRunId: actor.runId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(issueWatchdogs.id, existing.id))
        .returning();
      return toIssueWatchdog(updated);
    },

    reconcileTaskWatchdogs: async (opts: {
      companyId?: string | null;
      runId?: string | null;
      issueCreatedAtGte?: Date | null;
    } = {}) => {
      let rows = await listActiveWatchdogsForCompany(opts.companyId ?? null);
      if (opts.issueCreatedAtGte) {
        const watchdogIssueIds = [...new Set(rows.map((row) => row.issueId))];
        const eligibleIssueIds = new Set(
          watchdogIssueIds.length === 0
            ? []
            : (await db
                .select({ id: issues.id })
                .from(issues)
                .where(and(
                  inArray(issues.id, watchdogIssueIds),
                  gte(issues.createdAt, opts.issueCreatedAtGte),
                )))
                .map((issue) => issue.id),
        );
        rows = rows.filter((row) => eligibleIssueIds.has(row.issueId));
      }
      const result = {
        checked: 0,
        triggered: 0,
        live: 0,
        pendingFirstRun: 0,
        alreadyReviewed: 0,
        skipped: 0,
        watchdogIssueIds: [] as string[],
      };
      for (const row of rows) {
        result.checked += 1;
        const evaluated = await evaluateWatchdog(row, { runId: opts.runId ?? null });
        if (evaluated.state === "triggered") {
          result.triggered += 1;
          result.watchdogIssueIds.push(evaluated.watchdogIssueId);
        } else if (
          evaluated.state === "live" ||
          evaluated.state === "watchdog_live" ||
          evaluated.state === "watchdog_review_open"
        ) {
          result.live += 1;
        } else if (evaluated.state === "pending_first_run") {
          result.pendingFirstRun += 1;
        } else if (evaluated.state === "already_reviewed") {
          result.alreadyReviewed += 1;
        } else {
          result.skipped += 1;
        }
      }
      return result;
    },

    reconcileForIssueAndAncestors: async (
      companyId: string,
      issueId: string,
      opts: { runId?: string | null } = {},
    ) => {
      const rows = await activeWatchdogsForIssueAndAncestors(companyId, issueId);
      const result = {
        checked: 0,
        triggered: 0,
        pendingFirstRun: 0,
        skipped: 0,
        watchdogIssueIds: [] as string[],
      };
      for (const row of rows) {
        result.checked += 1;
        const evaluated = await evaluateWatchdog(row, { runId: opts.runId ?? null });
        if (evaluated.state === "triggered") {
          result.triggered += 1;
          result.watchdogIssueIds.push(evaluated.watchdogIssueId);
        } else if (evaluated.state === "pending_first_run") {
          result.pendingFirstRun += 1;
        } else if (
          evaluated.state === "watchdog_review_open" ||
          evaluated.state === "watchdog_live" ||
          evaluated.state === "live"
        ) {
          // Existing review work is already open for this stopped state.
        } else {
          result.skipped += 1;
        }
      }
      return result;
    },

    revalidateMutationScope,
    recordAuthorizedMutation,
  };
}
