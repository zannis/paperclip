import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  createDb,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueApprovals,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  issueWatchdogs,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { taskWatchdogService } from "../services/task-watchdogs.ts";
import { resolveTaskWatchdogMutationScope } from "../services/task-watchdog-scope.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres task watchdog scheduler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("task watchdog scheduler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-task-watchdogs-scheduler-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueThreadInteractions);
    await db.delete(issueWorkProducts);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueWatchdogs);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Watchdog Co",
      issuePrefix: `WD${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      issueCounter: 0,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const id = overrides.id ?? randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: overrides.name ?? "Watchdog Agent",
      role: overrides.role ?? "engineer",
      status: overrides.status ?? "active",
      adapterType: overrides.adapterType ?? "codex_local",
      adapterConfig: overrides.adapterConfig ?? {},
      runtimeConfig: overrides.runtimeConfig ?? {},
      permissions: overrides.permissions ?? {},
      reportsTo: overrides.reportsTo,
    });
    return id;
  }

  async function seedIssue(companyId: string, overrides: Partial<typeof issues.$inferInsert> = {}) {
    const id = overrides.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: overrides.title ?? "Watched issue",
      status: overrides.status ?? "done",
      priority: overrides.priority ?? "medium",
      identifier: overrides.identifier ?? `WDOG-${Math.floor(Math.random() * 10_000)}`,
      issueNumber: overrides.issueNumber ?? Math.floor(Math.random() * 10_000),
      parentId: overrides.parentId,
      assigneeAgentId: overrides.assigneeAgentId,
      originKind: overrides.originKind,
      originId: overrides.originId,
      originFingerprint: overrides.originFingerprint,
      updatedAt: overrides.updatedAt,
      // Default to an "established" issue (created well before the first-run
      // grace window) so the pending-first-run guard does not defer it. Tests
      // exercising the create-race pass an explicit recent `createdAt`.
      createdAt: overrides.createdAt ?? new Date(Date.now() - 60 * 60 * 1000),
    });
    return id;
  }

  async function seedIssueDocument(companyId: string, issueId: string, updatedAt: Date) {
    const [document] = await db.insert(documents).values({
      companyId,
      title: "Plan",
      latestBody: "Plan body",
      updatedAt,
    }).returning();
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId: document!.id,
      key: "plan",
      updatedAt,
    });
  }

  async function seedIssueWorkProduct(companyId: string, issueId: string, updatedAt: Date) {
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "artifact",
      provider: "test",
      title: "Report",
      status: "ready",
      updatedAt,
    });
  }

  async function seedWatchdog(companyId: string, issueId: string, agentId: string) {
    const [row] = await db.insert(issueWatchdogs).values({
      companyId,
      issueId,
      watchdogAgentId: agentId,
      instructions: "Verify stopped work.",
      status: "active",
    }).returning();
    return row;
  }

  function createService() {
    const wakes: Array<{ agentId: string; opts: Record<string, unknown> | undefined }> = [];
    const service = taskWatchdogService(db, {
      enqueueWakeup: async (agentId, opts) => {
        wakes.push({ agentId, opts });
        return { id: randomUUID() };
      },
    });
    return { service, wakes };
  }

  it("creates one reusable watchdog issue and wakes the watchdog on the initial stopped state", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-1", status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.agentId).toBe(agentId);
    expect(wakes[0]?.opts?.reason).toBe("task_watchdog_stopped_subtree");
    expect(wakes[0]?.opts?.idempotencyKey).toMatch(/^task_watchdog:[^:]+:task_watchdog_stop:/);
    expect(wakes[0]?.opts?.contextSnapshot).toMatchObject({
      taskWatchdog: {
        watchedIssueId: sourceId,
        watchedIssueIdentifier: "WDOG-1",
        capabilities: {
          targetScope: {
            watchedIssueId: sourceId,
            includeNonWatchdogDescendants: true,
            excludedOriginKinds: ["task_watchdog"],
          },
          operations: expect.arrayContaining([
            "comment_on_watched_subtree_issues",
            "create_child_issues_under_non_watchdog_watched_subtree",
            "create_product_bug_followups_outside_watched_subtree",
            "update_reusable_watchdog_issue",
          ]),
          deniedOperations: expect.arrayContaining([
            "create_visible_probe_issues_or_throwaway_tasks",
            "create_product_bug_followups_as_source_tree_children",
            "mutate_task_watchdog_descendants",
          ]),
        },
      },
    });

    const watchdogIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogIssues).toHaveLength(1);
    expect(watchdogIssues[0]).toMatchObject({
      parentId: sourceId,
      originId: sourceId,
      assigneeAgentId: agentId,
      status: "todo",
    });

    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(watchdog?.watchdogIssueId).toBe(watchdogIssues[0]?.id);
    expect(watchdog?.lastObservedFingerprint).toMatch(/^task_watchdog_stop:/);
    expect(watchdog?.lastObservedStopSnapshot).toMatchObject({
      version: 2,
      fingerprint: watchdog?.lastObservedFingerprint,
      materialLeaves: [],
      waitsByIssueId: {},
    });
    expect(watchdog?.triggerCount).toBe(1);
  });

  it("does not append duplicate review comments for an already-open same-fingerprint review", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-DUPE", status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const first = await service.reconcileTaskWatchdogs({ companyId });
    expect(first).toMatchObject({ checked: 1, triggered: 1 });

    const [firstWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const watchdogIssueId = firstWatchdog!.watchdogIssueId!;
    const initialComments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, watchdogIssueId));
    expect(initialComments).toHaveLength(1);

    const second = await service.reconcileTaskWatchdogs({ companyId });

    expect(second).toMatchObject({ checked: 1, triggered: 0, live: 1 });
    expect(wakes).toHaveLength(1);
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, watchdogIssueId));
    expect(comments).toHaveLength(1);
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(watchdog?.lastObservedFingerprint).toBe(firstWatchdog?.lastObservedFingerprint);
    expect(watchdog?.triggerCount).toBe(1);
  });

  it("re-wakes a same-fingerprint watchdog review stuck in stale in_review", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-STALE", status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const first = await service.reconcileTaskWatchdogs({ companyId });
    expect(first).toMatchObject({ checked: 1, triggered: 1 });

    const [firstWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const watchdogIssueId = firstWatchdog!.watchdogIssueId!;
    await db
      .update(issues)
      .set({
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: null,
        executionState: null,
        monitorNextCheckAt: null,
      })
      .where(eq(issues.id, watchdogIssueId));

    const second = await service.reconcileTaskWatchdogs({ companyId });

    expect(second).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes).toHaveLength(2);
    const [watchdogIssue] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(watchdogIssue).toMatchObject({
      status: "todo",
      assigneeAgentId: agentId,
      originFingerprint: firstWatchdog?.lastObservedFingerprint,
    });
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, watchdogIssueId));
    expect(comments).toHaveLength(2);
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(watchdog?.triggerCount).toBe(2);
  });

  it("does not trigger while a non-watchdog descendant has live work", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-2", status: "in_progress" });
    const childId = await seedIssue(companyId, { parentId: sourceId, status: "in_progress" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "queued",
      invocationSource: "assignment",
      contextSnapshot: { issueId: childId },
    });
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 0, live: 1 });
    expect(wakes).toHaveLength(0);
    const watchdogIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogIssues).toHaveLength(0);
  });

  it("does not trigger while a descendant has a queued assignment wake", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-WAKE", status: "in_progress" });
    const childId = await seedIssue(companyId, { parentId: sourceId, status: "todo" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      status: "queued",
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: childId },
    });
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 0, live: 1 });
    expect(wakes).toHaveLength(0);
    const watchdogIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogIssues).toHaveLength(0);
  });

  it("does not keep the source live for runs under a nested task-watchdog issue", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-NEST", status: "done" });
    const agentId = await seedAgent(companyId);
    const nestedWatchdogIssueId = await seedIssue(companyId, {
      parentId: sourceId,
      status: "in_progress",
      originKind: "task_watchdog",
      originId: sourceId,
      originFingerprint: `task_watchdog:${companyId}:${sourceId}`,
    });
    const nestedChildId = await seedIssue(companyId, {
      parentId: nestedWatchdogIssueId,
      status: "in_progress",
    });
    await seedWatchdog(companyId, sourceId, agentId);
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: nestedChildId },
    });
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 1, live: 0 });
    expect(wakes).toHaveLength(1);
  });

  it("reconciles ancestor watchdogs for a descendant issue mutation", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-ANCESTOR", status: "done" });
    const childId = await seedIssue(companyId, { parentId: sourceId, status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const result = await service.reconcileForIssueAndAncestors(companyId, childId);

    expect(result).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes).toHaveLength(1);
  });

  it("marks a completed watchdog fingerprint reviewed, then reuses the same issue for a later stopped state", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-3", status: "done" });
    const childId = await seedIssue(companyId, { parentId: sourceId, status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    await service.reconcileTaskWatchdogs({ companyId });
    const [firstWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const watchdogIssueId = firstWatchdog!.watchdogIssueId!;
    const [firstWatchdogIssue] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(firstWatchdogIssue?.originFingerprint).toBe(firstWatchdog?.lastObservedFingerprint);
    await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, watchdogIssueId));

    const reviewed = await service.reconcileTaskWatchdogs({ companyId });
    expect(reviewed).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    const [reviewedWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(reviewedWatchdog?.lastReviewedFingerprint).toBe(firstWatchdog?.lastObservedFingerprint);
    expect(reviewedWatchdog?.lastReviewedStopSnapshot).toEqual(firstWatchdog?.lastObservedStopSnapshot);

    await db
      .update(issues)
      .set({ status: "blocked", updatedAt: new Date(Date.now() + 60_000) })
      .where(eq(issues.id, childId));
    const retriggered = await service.reconcileTaskWatchdogs({ companyId });

    expect(retriggered).toMatchObject({ checked: 1, triggered: 1 });
    const watchdogIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogIssues).toHaveLength(1);
    expect(watchdogIssues[0]).toMatchObject({ id: watchdogIssueId, status: "todo" });
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, watchdogIssueId));
    expect(comments.some((comment) => comment.body.includes("Stopped fingerprint"))).toBe(true);
    expect(wakes.length).toBe(2);
  });

  it("suppresses a shrink-only stop after review when the snapshot round-trips through jsonb", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-SHRINK", status: "in_review" });
    const waitingLeafId = await seedIssue(companyId, { parentId: sourceId, status: "in_review" });
    const siblingLeafId = await seedIssue(companyId, { parentId: sourceId, status: "in_progress" });
    const agentId = await seedAgent(companyId);
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId: waitingLeafId,
      kind: "request_confirmation",
      status: "pending",
      payload: { version: 1, prompt: "Confirm the stop." },
      createdByAgentId: agentId,
    });
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const first = await service.reconcileTaskWatchdogs({ companyId });
    expect(first).toMatchObject({ checked: 1, triggered: 1 });

    const [triggeredWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    await db
      .update(issues)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(issues.id, triggeredWatchdog!.watchdogIssueId!));
    const reviewed = await service.reconcileTaskWatchdogs({ companyId });
    expect(reviewed).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    const [reviewedWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(reviewedWatchdog?.lastReviewedStopSnapshot).not.toBeNull();

    // The sibling completing shrinks the material leaf set while the wait set
    // is unchanged; the reviewed snapshot loaded back from jsonb (which does
    // not preserve object key order) must still suppress the wake.
    await db
      .update(issues)
      .set({ status: "done", updatedAt: new Date(Date.now() + 60_000) })
      .where(eq(issues.id, siblingLeafId));
    const afterShrink = await service.reconcileTaskWatchdogs({ companyId });

    expect(afterShrink).toMatchObject({ checked: 1, triggered: 0, alreadyReviewed: 1 });
    expect(wakes).toHaveLength(1);
  });

  it("does not let an old terminal watchdog review mark a newer observed fingerprint reviewed", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-STALE", status: "done" });
    const childId = await seedIssue(companyId, { parentId: sourceId, status: "done" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    await service.reconcileTaskWatchdogs({ companyId });
    const [firstWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const oldFingerprint = firstWatchdog!.lastObservedFingerprint!;
    const watchdogIssueId = firstWatchdog!.watchdogIssueId!;
    const watchdogRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: watchdogRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: watchdogIssueId },
    });

    await db
      .update(issues)
      .set({ status: "blocked", updatedAt: new Date(Date.now() + 60_000) })
      .where(eq(issues.id, childId));
    const changedWhileReviewLive = await service.reconcileTaskWatchdogs({ companyId });
    expect(changedWhileReviewLive).toMatchObject({ checked: 1, triggered: 0, live: 1 });

    const [observedWhileLive] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const newerFingerprint = observedWhileLive!.lastObservedFingerprint!;
    expect(newerFingerprint).not.toBe(oldFingerprint);
    const [stillBoundReview] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(stillBoundReview?.originFingerprint).toBe(oldFingerprint);

    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, watchdogRunId));
    await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, watchdogIssueId));
    const afterOldReviewCompletes = await service.reconcileTaskWatchdogs({ companyId });

    expect(afterOldReviewCompletes).toMatchObject({ checked: 1, triggered: 1 });
    const [reviewedWatchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(reviewedWatchdog?.lastReviewedFingerprint).toBe(oldFingerprint);
    expect(reviewedWatchdog?.lastReviewedFingerprint).not.toBe(newerFingerprint);
    expect(reviewedWatchdog?.lastReviewedStopSnapshot).toBeNull();
    const [reopenedWatchdogIssue] = await db.select().from(issues).where(eq(issues.id, watchdogIssueId));
    expect(reopenedWatchdogIssue).toMatchObject({
      status: "todo",
      originFingerprint: newerFingerprint,
    });
    const reviewActivities = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, sourceId), eq(activityLog.action, "issue.task_watchdog_fingerprint_reviewed")));
    expect(reviewActivities).toHaveLength(1);
    expect(reviewActivities[0]?.details).toMatchObject({
      reviewedFingerprint: oldFingerprint,
      lastObservedFingerprint: newerFingerprint,
    });
    expect(wakes.length).toBe(2);
  });

  it("keeps watchdog mutation scope valid across metadata-only source evidence", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-REVALIDATE", status: "blocked" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service } = createService();

    await service.reconcileTaskWatchdogs({ companyId });
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const originalFingerprint = watchdog!.lastObservedFingerprint!;
    expect(originalFingerprint).toMatch(/^task_watchdog_stop:/);

    const later = new Date(Date.now() + 60_000);
    await db.insert(issueComments).values({
      companyId,
      issueId: sourceId,
      authorType: "agent",
      body: "Fresh source evidence.",
      updatedAt: later,
      createdAt: later,
    });
    await seedIssueDocument(companyId, sourceId, new Date(later.getTime() + 1_000));
    await seedIssueWorkProduct(companyId, sourceId, new Date(later.getTime() + 2_000));

    const revalidated = await service.revalidateMutationScope({
      kind: "watchdog",
      watchdogId: watchdog!.id,
      companyId,
      watchedIssueId: sourceId,
      stopFingerprint: originalFingerprint,
    });

    expect(revalidated.allowed).toBe(true);
    expect(revalidated.classification?.state).toBe("stopped");
    if (revalidated.classification?.state !== "stopped") throw new Error("Expected stopped classification");
    expect(revalidated.classification.stopFingerprint).toBe(originalFingerprint);
    expect(revalidated.classification.stoppedLeaves[0]).toMatchObject({
      latestCommentAt: later.toISOString(),
      latestDocumentAt: new Date(later.getTime() + 1_000).toISOString(),
      latestWorkProductAt: new Date(later.getTime() + 2_000).toISOString(),
    });
  });

  // Seeds a watchdog that has already woken, plus a run pinned to the
  // fingerprint that wake observed — the state a watchdog run is actually in
  // when it starts taking recovery actions. `establishedChildren` are leaves
  // that were already part of the subtree when the wake observed it, so they
  // are inputs to the pinned fingerprint and are past the first-run grace
  // window; they stand in for the stopped leaves a recovery run acts on.
  async function seedWokenWatchdogRun(
    identifier: string,
    options: {
      establishedChildren?: string[];
      // Runs before the watchdog is reconciled, so anything it seeds is part of
      // the state the run gets pinned to rather than drift against it.
      beforePin?: (seeded: { companyId: string; sourceId: string; agentId: string; childIds: string[] }) => Promise<void>;
    } = {},
  ) {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier, status: "done" });
    const agentId = await seedAgent(companyId);
    const childIds: string[] = [];
    for (const childIdentifier of options.establishedChildren ?? []) {
      childIds.push(await seedIssue(companyId, {
        identifier: childIdentifier,
        status: "todo",
        parentId: sourceId,
      }));
    }
    await seedWatchdog(companyId, sourceId, agentId);
    await options.beforePin?.({ companyId, sourceId, agentId, childIds });
    const { service } = createService();

    await service.reconcileTaskWatchdogs({ companyId });
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const pinnedFingerprint = watchdog!.lastObservedFingerprint!;
    expect(pinnedFingerprint).toMatch(/^task_watchdog_stop:/);

    const [run] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: {
        taskWatchdog: { watchedIssueId: sourceId, stopFingerprint: pinnedFingerprint },
      },
    }).returning();

    const actor = { type: "agent", agentId, companyId, runId: run!.id };
    const resolveScope = async () => {
      const scope = await resolveTaskWatchdogMutationScope(db, actor);
      if (scope.kind !== "watchdog") throw new Error(`Expected watchdog scope, got ${scope.kind}`);
      return scope;
    };

    // Passing the freshness guard is what authorizes a mutation, and what hands
    // back the baseline the run's ledger stays anchored to.
    const admitMutation = async (scope: Awaited<ReturnType<typeof resolveScope>>) => {
      const revalidated = await service.revalidateMutationScope(scope);
      expect(revalidated.allowed).toBe(true);
      if (!("ledgerBaseline" in revalidated) || !revalidated.ledgerBaseline) {
        throw new Error("Expected an admitted mutation to carry a ledger baseline");
      }
      return revalidated;
    };

    // Stands in for the route declaring, after its own write, what it wrote.
    const recordMutations = async (
      scope: Awaited<ReturnType<typeof resolveScope>>,
      admitted: Awaited<ReturnType<typeof admitMutation>>,
      mutations: Parameters<typeof service.recordAuthorizedMutation>[1]["mutations"],
    ) =>
      service.recordAuthorizedMutation(scope, {
        ledgerBaseline: "ledgerBaseline" in admitted ? admitted.ledgerBaseline ?? null : null,
        mutations,
      });

    return {
      companyId,
      sourceId,
      agentId,
      childIds,
      runId: run!.id,
      service,
      pinnedFingerprint,
      resolveScope,
      admitMutation,
      recordMutations,
    };
  }

  // The leaf values a request would have reported writing, in the shape the
  // route declares them from its own `RETURNING` row.
  const declaredLeaf = (overrides: Record<string, unknown> = {}) => ({
    status: "todo",
    assigneeAgentId: null,
    assigneeUserId: null,
    ...overrides,
  });

  // Installs a reviewed snapshot the run's wake state is *not* a shrink of —
  // it omits `leafId`, which is still a live material leaf — so the run wakes
  // `stopped`. Once the run closes that leaf, the leaves that remain are
  // exactly the reviewed ones and `isShrinkOfReviewedSnapshot` starts holding,
  // which is how an ordinary recovery lands in `already_reviewed`.
  async function seedReviewedSnapshotWithout(sourceId: string, leafId: string) {
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const observed = watchdog!.lastObservedStopSnapshot as {
      materialLeaves: { issueId: string }[];
    };
    expect(observed.materialLeaves.some((leaf) => leaf.issueId === leafId)).toBe(true);
    await db.update(issueWatchdogs)
      .set({
        lastReviewedStopSnapshot: {
          ...observed,
          materialLeaves: observed.materialLeaves.filter((leaf) => leaf.issueId !== leafId),
        },
      })
      .where(eq(issueWatchdogs.id, watchdog!.id));
  }

  const declaredCreatedLeaf = (overrides: Record<string, unknown> = {}) => ({
    status: "todo",
    assigneeAgentId: null,
    assigneeUserId: null,
    blockerIssueIds: [],
    pendingInteractionIds: [],
    pendingApprovalIds: [],
    ...overrides,
  });

  it("lets a watchdog run keep mutating the subtree after its own sanctioned action rotated the fingerprint", async () => {
    const { agentId, childIds, service, pinnedFingerprint, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-REPIN", { establishedChildren: ["WDOG-REPIN-LEAF"] });
    const leafId = childIds[0]!;

    const scope = await resolveScope();
    expect(scope.stopFingerprint).toBe(pinnedFingerprint);
    const admitted = await admitMutation(scope);

    // The run's first sanctioned recovery action: reassign a stopped leaf. The
    // assignee is an input to `materialLeaf`, so this allowed operation rotates
    // the very fingerprint the run is pinned to while the subtree stays
    // stopped. This is the interleaving that was actually reported.
    await db.update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, leafId));
    expect((await recordMutations(scope, admitted, [
      { issueId: leafId, declared: declaredLeaf({ assigneeAgentId: agentId }) },
    ])).recorded).toBe(true);

    // The next request in the same run re-reads its ledger from the run
    // context. The pin has *not* moved — the fingerprint no longer matches it —
    // but every leaf that moved is the run's own declared write, so the guard
    // admits it (this is the summary comment the run previously could not post).
    const nextScope = await resolveScope();
    expect(nextScope.stopFingerprint).toBe(pinnedFingerprint);
    const after = await service.revalidateMutationScope(nextScope);
    expect(after.allowed).toBe(true);
    expect(after.classification?.state).toBe("stopped");
    expect(
      after.classification && "stopFingerprint" in after.classification
        ? after.classification.stopFingerprint
        : null,
    ).not.toBe(pinnedFingerprint);
  });

  it("still rejects a concurrent third-party change to another leaf once the run holds a ledger", async () => {
    const { agentId, childIds, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-REPIN-CONTROL", {
        establishedChildren: ["WDOG-REPIN-CONTROL-A", "WDOG-REPIN-CONTROL-B"],
      });
    const [ownLeafId, otherLeafId] = childIds as [string, string];

    const scope = await resolveScope();
    const admitted = await admitMutation(scope);
    await db.update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, ownLeafId));
    expect((await recordMutations(scope, admitted, [
      { issueId: ownLeafId, declared: declaredLeaf({ assigneeAgentId: agentId }) },
    ])).recorded).toBe(true);
    expect((await service.revalidateMutationScope(await resolveScope())).allowed).toBe(true);

    // Somebody other than this run now moves the watched subtree. This is the
    // property the freshness guard exists for and it must survive the ledger.
    await db.update(issues)
      .set({ status: "in_progress", updatedAt: new Date() })
      .where(eq(issues.id, otherLeafId));

    const afterExternalChange = await service.revalidateMutationScope(await resolveScope());
    expect(afterExternalChange.allowed).toBe(false);
    expect(afterExternalChange.reason).toContain("stop fingerprint changed");
    expect(
      "unattributedIssueIds" in afterExternalChange ? afterExternalChange.unattributedIssueIds : null,
    ).toEqual([otherLeafId]);
  });

  // WDOG-001. The run and a board user write the *same* leaf in the same
  // window. Exempting a leaf from the diff just because the run was authorized
  // to touch it folds the board user's edit into what the run is allowed to
  // treat as its own; comparing against the value the run reported writing does
  // not.
  it("rejects a concurrent third-party change to the very issue the run mutated", async () => {
    const { agentId, childIds, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-SAME-LEAF", { establishedChildren: ["WDOG-SAME-LEAF-A"] });
    const leafId = childIds[0]!;

    const scope = await resolveScope();
    const admitted = await admitMutation(scope);

    // The run's own write, and what it reported writing.
    await db.update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, leafId));
    expect((await recordMutations(scope, admitted, [
      { issueId: leafId, declared: declaredLeaf({ assigneeAgentId: agentId }) },
    ])).recorded).toBe(true);

    // A board user moves the same leaf on a field the run never wrote.
    await db.update(issues)
      .set({ status: "in_progress", updatedAt: new Date() })
      .where(eq(issues.id, leafId));

    const revalidated = await service.revalidateMutationScope(await resolveScope());
    expect(revalidated.allowed).toBe(false);
    expect(
      "unattributedIssueIds" in revalidated ? revalidated.unattributedIssueIds : null,
    ).toEqual([leafId]);
  });

  it("admits the run when the same leaf ends up at exactly the value the run wrote", async () => {
    const { agentId, childIds, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-SAME-LEAF-OK", { establishedChildren: ["WDOG-SAME-LEAF-OK-A"] });
    const leafId = childIds[0]!;
    const scope = await resolveScope();
    const admitted = await admitMutation(scope);

    await db.update(issues)
      .set({ assigneeAgentId: agentId, status: "in_progress", updatedAt: new Date() })
      .where(eq(issues.id, leafId));
    expect((await recordMutations(scope, admitted, [
      { issueId: leafId, declared: declaredLeaf({ assigneeAgentId: agentId, status: "in_progress" }) },
    ])).recorded).toBe(true);

    expect((await service.revalidateMutationScope(await resolveScope())).allowed).toBe(true);
  });

  // WDOG-002. Creating a follow-up child is one of the granted recovery
  // operations and is the exact trace this issue was reported from: the child
  // is non-terminal, inside the first-run grace window and has never completed
  // a run, so the classifier answers `pending_first_run` — a state that carries
  // no fingerprint to pin to. The run must still be able to say what it did.
  it("lets the run keep working after its own follow-up child left the subtree pending-first-run", async () => {
    const { companyId, sourceId, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-FOLLOWUP");

    const scope = await resolveScope();
    const admitted = await admitMutation(scope);

    const childId = await seedIssue(companyId, {
      identifier: "WDOG-FOLLOWUP-CHILD",
      status: "todo",
      parentId: sourceId,
      createdAt: new Date(),
    });
    // Creating an assigned, non-backlog issue queues its assignment wake, and
    // the create route reports that alongside the creation.
    expect((await recordMutations(scope, admitted, [
      {
        issueId: childId,
        created: true,
        parentId: sourceId,
        declared: declaredCreatedLeaf(),
        startsWork: true,
      },
    ])).recorded).toBe(true);

    const duringGrace = await service.revalidateMutationScope(await resolveScope());
    expect(duringGrace.classification?.state).toBe("pending_first_run");
    expect(duringGrace.allowed).toBe(true);
  });

  it("rejects a follow-up child this run did not create", async () => {
    const { companyId, sourceId, childIds, agentId, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-FOLLOWUP-FOREIGN", {
        establishedChildren: ["WDOG-FOLLOWUP-FOREIGN-A"],
      });
    const leafId = childIds[0]!;
    const scope = await resolveScope();
    const admitted = await admitMutation(scope);

    await db.update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, leafId));
    expect((await recordMutations(scope, admitted, [
      { issueId: leafId, declared: declaredLeaf({ assigneeAgentId: agentId }) },
    ])).recorded).toBe(true);

    // Somebody else files a child under the watched issue. The run's ledger
    // says nothing about it, so it is not the run's own drift.
    const foreignChildId = await seedIssue(companyId, {
      identifier: "WDOG-FOLLOWUP-FOREIGN-CHILD",
      status: "todo",
      parentId: sourceId,
      createdAt: new Date(),
    });

    const revalidated = await service.revalidateMutationScope(await resolveScope());
    expect(revalidated.allowed).toBe(false);
    const unattributed = "unattributedIssueIds" in revalidated ? revalidated.unattributedIssueIds ?? [] : [];
    const unattributedLiveness = "unattributedLivenessIssueIds" in revalidated
      ? revalidated.unattributedLivenessIssueIds ?? []
      : [];
    expect([...unattributed, ...unattributedLiveness]).toContain(foreignChildId);
  });

  it("rejects a follow-up child that no longer holds the values the run created it with", async () => {
    const { companyId, sourceId, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-FOLLOWUP-EDITED");
    const scope = await resolveScope();
    const admitted = await admitMutation(scope);

    const childId = await seedIssue(companyId, {
      identifier: "WDOG-FOLLOWUP-EDITED-CHILD",
      status: "todo",
      parentId: sourceId,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    expect((await recordMutations(scope, admitted, [
      { issueId: childId, created: true, parentId: sourceId, declared: declaredCreatedLeaf() },
    ])).recorded).toBe(true);
    expect((await service.revalidateMutationScope(await resolveScope())).allowed).toBe(true);

    // A board user edits the run's freshly created child. The run declared what
    // it created the child with, so the edit is visible rather than inherited.
    await db.update(issues)
      .set({ status: "in_progress", updatedAt: new Date() })
      .where(eq(issues.id, childId));

    const revalidated = await service.revalidateMutationScope(await resolveScope());
    expect(revalidated.allowed).toBe(false);
    expect(
      "unattributedIssueIds" in revalidated ? revalidated.unattributedIssueIds : null,
    ).toEqual([childId]);
  });

  it("lets the run keep working when its own action left the watched subtree live", async () => {
    const { companyId, sourceId, childIds, agentId, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-REPIN-LIVE", { establishedChildren: ["WDOG-REPIN-LIVE-A"] });
    const leafId = childIds[0]!;
    const scope = await resolveScope();
    const admitted = await admitMutation(scope);

    await db.update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, leafId));
    // The reassignment is a real change of assignee on a non-backlog issue, so
    // the update route enqueued an assignment wake and reported it.
    expect((await recordMutations(scope, admitted, [
      { issueId: leafId, declared: declaredLeaf({ assigneeAgentId: agentId }), startsWork: true },
    ])).recorded).toBe(true);

    // The reassignment starts a run on the leaf, which is the recovery working.
    // The mandate then asks the watchdog to record what it did, so a liveness
    // this run's own ledger accounts for must not lock it out.
    const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId));
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent!.id,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: leafId },
    });

    const revalidated = await service.revalidateMutationScope(await resolveScope());
    expect(revalidated.classification?.state).toBe("live");
    expect(revalidated.allowed).toBe(true);
    expect(sourceId).toBeTruthy();
  });

  it("rejects a live path this run's ledger does not account for", async () => {
    const { companyId, sourceId, childIds, agentId, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-LIVE-FOREIGN", {
        establishedChildren: ["WDOG-LIVE-FOREIGN-A", "WDOG-LIVE-FOREIGN-B"],
      });
    const [ownLeafId] = childIds as [string, string];
    const scope = await resolveScope();
    const admitted = await admitMutation(scope);
    await db.update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, ownLeafId));
    expect((await recordMutations(scope, admitted, [
      { issueId: ownLeafId, declared: declaredLeaf({ assigneeAgentId: agentId }) },
    ])).recorded).toBe(true);

    // A run starts on the watched issue itself, which nothing in the ledger
    // explains.
    const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId));
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent!.id,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: sourceId },
    });

    const revalidated = await service.revalidateMutationScope(await resolveScope());
    expect(revalidated.allowed).toBe(false);
    expect(
      "unattributedLivenessIssueIds" in revalidated ? revalidated.unattributedLivenessIssueIds : null,
    ).toEqual([sourceId]);
  });

  // WDOG-001B. Ledger membership is not causation. Of the writes the mandate
  // grants, only creating an issue, transitioning its status, reassigning it,
  // and resolving one of its interactions can start work on it. A run that
  // touched some other field has not started anything, so a run appearing on
  // that leaf afterwards is a third party's and must still stop this run dead.
  it("rejects a live path on a leaf this run only touched in a way that starts nothing", async () => {
    const { companyId, childIds, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-LIVE-INERT", { establishedChildren: ["WDOG-LIVE-INERT-A"] });
    const leafId = childIds[0]!;
    const scope = await resolveScope();
    const admitted = await admitMutation(scope);

    // A blocker-list write. It is declared, so the leaf is in the ledger — but
    // it leaves the issue exactly as idle as it was.
    expect((await recordMutations(scope, admitted, [
      { issueId: leafId, declared: { blockerIssueIds: [] } },
    ])).recorded).toBe(true);

    // Somebody else now starts a run on that same leaf.
    const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId));
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent!.id,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: leafId },
    });

    const revalidated = await service.revalidateMutationScope(await resolveScope());
    expect(revalidated.allowed).toBe(false);
    expect(
      "unattributedLivenessIssueIds" in revalidated ? revalidated.unattributedLivenessIssueIds : null,
    ).toEqual([leafId]);
  });

  // WDOG-001B. Potential causation is not causation. Which writes start work is
  // the route's decision, not a property of the values written, so the ledger
  // asks the route: a request that woke somebody says so. A declaration that
  // does not — here, writing a leaf's status back to the status it already
  // held, which fires no wake — accounts for the write and for nothing else,
  // and a run appearing on that leaf afterwards is still a third party's.
  it("rejects a live path on a leaf whose declared status never moved", async () => {
    const { companyId, childIds, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-LIVE-NOOP", { establishedChildren: ["WDOG-LIVE-NOOP-A"] });
    const leafId = childIds[0]!;
    const scope = await resolveScope();
    const admitted = await admitMutation(scope);

    // The leaf was seeded `todo` and is still `todo`. Declaring `todo` over it
    // is a write that changed nothing.
    expect((await recordMutations(scope, admitted, [
      { issueId: leafId, declared: declaredLeaf({ status: "todo" }) },
    ])).recorded).toBe(true);

    // Somebody else now starts a run on that same leaf.
    const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId));
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent!.id,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: leafId },
    });

    const revalidated = await service.revalidateMutationScope(await resolveScope());
    expect(revalidated.allowed).toBe(false);
    expect(
      "unattributedLivenessIssueIds" in revalidated ? revalidated.unattributedLivenessIssueIds : null,
    ).toEqual([leafId]);
  });

  // The same gap reached through the other value-dependent write: re-assigning
  // a leaf to the agent that already held it wakes nobody either.
  it("rejects a live path on a leaf re-assigned to the agent that already held it", async () => {
    let heldByAgentId = "";
    const { companyId, childIds, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-LIVE-SAME-ASSIGNEE", {
        establishedChildren: ["WDOG-LIVE-SAME-ASSIGNEE-A"],
        beforePin: async ({ agentId, childIds: seeded }) => {
          heldByAgentId = agentId;
          await db.update(issues)
            .set({ assigneeAgentId: agentId })
            .where(eq(issues.id, seeded[0]!));
        },
      });
    const leafId = childIds[0]!;
    const scope = await resolveScope();
    const admitted = await admitMutation(scope);

    expect((await recordMutations(scope, admitted, [
      { issueId: leafId, declared: declaredLeaf({ assigneeAgentId: heldByAgentId }) },
    ])).recorded).toBe(true);

    const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId));
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent!.id,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: leafId },
    });

    const revalidated = await service.revalidateMutationScope(await resolveScope());
    expect(revalidated.allowed).toBe(false);
    expect(
      "unattributedLivenessIssueIds" in revalidated ? revalidated.unattributedLivenessIssueIds : null,
    ).toEqual([leafId]);
  });

  // The same gap through the write whose wake is the least value-shaped of all.
  // Whether resolving an interaction wakes the issue's assignee depends on the
  // interaction's continuation policy and on the verdict it was resolved with —
  // `wake_assignee`, or `wake_assignee_on_accept` and only then on an accepted
  // or answered outcome — none of which is knowable from the leaf fields the
  // ledger carries. A resolution under a policy that wakes nobody accounts for
  // the waiting-path shrink it caused and licenses no liveness at all.
  it("rejects a live path licensed only by a resolution that woke nobody", async () => {
    const interactionId = randomUUID();
    const { companyId, childIds, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-LIVE-INERT-INTERACTION", {
        establishedChildren: ["WDOG-LIVE-INERT-INTERACTION-A"],
        beforePin: async ({ companyId: seededCompanyId, agentId, childIds: seeded }) => {
          await db.insert(issueThreadInteractions).values({
            id: interactionId,
            companyId: seededCompanyId,
            issueId: seeded[0]!,
            kind: "request_confirmation",
            status: "pending",
            continuationPolicy: "none",
            payload: { version: 1, prompt: "Confirm the recovery." },
            createdByAgentId: agentId,
          });
        },
      });
    const leafId = childIds[0]!;
    const scope = await resolveScope();
    const admitted = await admitMutation(scope);

    await db.update(issueThreadInteractions)
      .set({ status: "accepted" })
      .where(eq(issueThreadInteractions.id, interactionId));
    // Declared, so the shrink in the waiting paths is accounted for — and no
    // more than that, because the route queued no continuation wake.
    expect((await recordMutations(scope, admitted, [
      { issueId: leafId, declared: {}, resolvedInteractionIds: [interactionId] },
    ])).recorded).toBe(true);

    const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId));
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent!.id,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: leafId },
    });

    const revalidated = await service.revalidateMutationScope(await resolveScope());
    expect(revalidated.allowed).toBe(false);
    expect(
      "unattributedLivenessIssueIds" in revalidated ? revalidated.unattributedLivenessIssueIds : null,
    ).toEqual([leafId]);
  });

  // And its control: the same resolution under a policy that does wake, which
  // the route reports. The run's own continuation must not lock it out.
  it("lets the run keep working after a resolution it reported waking", async () => {
    const interactionId = randomUUID();
    const { companyId, childIds, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-LIVE-WAKING-INTERACTION", {
        establishedChildren: ["WDOG-LIVE-WAKING-INTERACTION-A"],
        beforePin: async ({ companyId: seededCompanyId, agentId, childIds: seeded }) => {
          await db.insert(issueThreadInteractions).values({
            id: interactionId,
            companyId: seededCompanyId,
            issueId: seeded[0]!,
            kind: "request_confirmation",
            status: "pending",
            continuationPolicy: "wake_assignee",
            payload: { version: 1, prompt: "Confirm the recovery." },
            createdByAgentId: agentId,
          });
        },
      });
    const leafId = childIds[0]!;
    const scope = await resolveScope();
    const admitted = await admitMutation(scope);

    await db.update(issueThreadInteractions)
      .set({ status: "accepted" })
      .where(eq(issueThreadInteractions.id, interactionId));
    expect((await recordMutations(scope, admitted, [
      { issueId: leafId, declared: {}, resolvedInteractionIds: [interactionId] },
      { issueId: leafId, declared: {}, startsWork: true },
    ])).recorded).toBe(true);

    const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId));
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent!.id,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: leafId },
    });

    const revalidated = await service.revalidateMutationScope(await resolveScope());
    expect(revalidated.classification?.state).toBe("live");
    expect(
      revalidated.allowed,
      "unattributedLivenessIssueIds" in revalidated
        ? JSON.stringify(revalidated.unattributedLivenessIssueIds)
        : "",
    ).toBe(true);
  });

  // The positive control for the two above. The same leaf, the same net
  // declaration — and this time the route reported that one of those writes
  // actually enqueued a wake. That report, not the values, is what licenses the
  // liveness: a run that really did wake its assignee on the way through must
  // not then be locked out of the rest of its own recovery.
  it("lets the run keep working on a leaf whose write it reported waking", async () => {
    const { companyId, childIds, agentId, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-LIVE-ROUNDTRIP", {
        establishedChildren: ["WDOG-LIVE-ROUNDTRIP-A"],
      });
    const leafId = childIds[0]!;
    const scope = await resolveScope();
    const admitted = await admitMutation(scope);

    expect((await recordMutations(scope, admitted, [
      {
        issueId: leafId,
        declared: declaredLeaf({ status: "in_progress", assigneeAgentId: agentId }),
        startsWork: true,
      },
      { issueId: leafId, declared: declaredLeaf({ status: "todo" }) },
    ])).recorded).toBe(true);

    const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId));
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent!.id,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: leafId },
    });

    const revalidated = await service.revalidateMutationScope(await resolveScope());
    expect(revalidated.classification?.state).toBe("live");
    expect(
      revalidated.allowed,
      "unattributedLivenessIssueIds" in revalidated
        ? JSON.stringify(revalidated.unattributedLivenessIssueIds)
        : "",
    ).toBe(true);
  });

  // WDOG-006. Resolving an interaction is one of the four granted operations
  // that rotate the fingerprint: the waiting paths are a fingerprint input in
  // their own right. Without a declaration the resolution reads as somebody
  // else's change and the run is locked out of its own summary comment, which
  // is the exact defect this whole mechanism exists to fix.
  it("lets the run keep working after resolving an interaction it declared", async () => {
    const interactionId = randomUUID();
    const { childIds, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-INTERACTION", {
        establishedChildren: ["WDOG-INTERACTION-A"],
        beforePin: async ({ companyId, agentId, childIds: seeded }) => {
          await db.insert(issueThreadInteractions).values({
            id: interactionId,
            companyId,
            issueId: seeded[0]!,
            kind: "request_confirmation",
            status: "pending",
            payload: { version: 1, prompt: "Confirm the recovery." },
            createdByAgentId: agentId,
          });
        },
      });
    const leafId = childIds[0]!;

    const scope = await resolveScope();
    const admitted = await admitMutation(scope);
    // The run's sanctioned resolution.
    await db.update(issueThreadInteractions)
      .set({ status: "accepted" })
      .where(eq(issueThreadInteractions.id, interactionId));
    expect((await recordMutations(scope, admitted, [
      { issueId: leafId, declared: {}, resolvedInteractionIds: [interactionId] },
    ])).recorded).toBe(true);

    const revalidated = await service.revalidateMutationScope(await resolveScope());
    expect(revalidated.allowed).toBe(true);
  });

  it("rejects an interaction that left the waiting paths without this run declaring it", async () => {
    const interactionId = randomUUID();
    const { agentId, childIds, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-INTERACTION-FOREIGN", {
        establishedChildren: ["WDOG-INTERACTION-FOREIGN-A"],
        beforePin: async ({ companyId, agentId: seededAgentId, childIds: seeded }) => {
          await db.insert(issueThreadInteractions).values({
            id: interactionId,
            companyId,
            issueId: seeded[0]!,
            kind: "request_confirmation",
            status: "pending",
            payload: { version: 1, prompt: "Confirm the recovery." },
            createdByAgentId: seededAgentId,
          });
        },
      });
    const leafId = childIds[0]!;

    const scope = await resolveScope();
    const admitted = await admitMutation(scope);
    expect((await recordMutations(scope, admitted, [
      { issueId: leafId, declared: declaredLeaf({ assigneeAgentId: agentId }) },
    ])).recorded).toBe(true);
    await db.update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, leafId));

    // A board user answers the interaction. The run declared nothing about it,
    // so the shrink in the waiting paths is nobody's but theirs.
    await db.update(issueThreadInteractions)
      .set({ status: "accepted" })
      .where(eq(issueThreadInteractions.id, interactionId));

    const revalidated = await service.revalidateMutationScope(await resolveScope());
    expect(revalidated.allowed).toBe(false);
    expect(
      "unattributedIssueIds" in revalidated ? revalidated.unattributedIssueIds : null,
    ).toEqual([leafId]);
  });

  // WDOG-008. A leaf leaves the fingerprint the moment it gains a child, and
  // the child that displaced it can itself stop being a leaf — by gaining a
  // child of its own, or by being closed. Attributing displacement only from
  // the issues that are *currently* leaves left the run rejected for a leaf its
  // own creation removed, which is this issue's lockout one edge further out.
  it("explains a displaced leaf through a follow-up child that has a child of its own", async () => {
    const { companyId, childIds, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-NESTED", { establishedChildren: ["WDOG-NESTED-A"] });
    const leafId = childIds[0]!;
    const scope = await resolveScope();
    const admitted = await admitMutation(scope);

    // Aged past the first-run grace window so the subtree classifies `stopped`
    // and this test is about attribution rather than the pending-first-run path.
    const aged = new Date(Date.now() - 60 * 60 * 1000);
    const childId = await seedIssue(companyId, {
      identifier: "WDOG-NESTED-CHILD",
      status: "todo",
      parentId: leafId,
      createdAt: aged,
    });
    const grandchildId = await seedIssue(companyId, {
      identifier: "WDOG-NESTED-GRANDCHILD",
      status: "todo",
      parentId: childId,
      createdAt: aged,
    });
    expect((await recordMutations(scope, admitted, [
      { issueId: childId, created: true, parentId: leafId, declared: declaredCreatedLeaf() },
      { issueId: grandchildId, created: true, parentId: childId, declared: declaredCreatedLeaf() },
    ])).recorded).toBe(true);

    // Only the grandchild is a material leaf now: the child gained one, and the
    // established leaf gained the child. Both displacements are this run's.
    const revalidated = await service.revalidateMutationScope(await resolveScope());
    expect(
      revalidated.allowed,
      "unattributedIssueIds" in revalidated ? JSON.stringify(revalidated.unattributedIssueIds) : "",
    ).toBe(true);
  });

  it("explains a displaced leaf through a follow-up child the run then closed", async () => {
    const { companyId, childIds, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-CLOSED-CHILD", { establishedChildren: ["WDOG-CLOSED-CHILD-A"] });
    const leafId = childIds[0]!;
    const scope = await resolveScope();
    const admitted = await admitMutation(scope);

    const childId = await seedIssue(companyId, {
      identifier: "WDOG-CLOSED-CHILD-FOLLOWUP",
      status: "done",
      parentId: leafId,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    // A terminal child never appears in `materialLeaves` at all, so nothing in
    // the current leaf set can speak for the leaf it displaced.
    expect((await recordMutations(scope, admitted, [
      { issueId: childId, created: true, parentId: leafId, declared: declaredCreatedLeaf({ status: "done" }) },
    ])).recorded).toBe(true);

    const revalidated = await service.revalidateMutationScope(await resolveScope());
    expect(
      revalidated.allowed,
      "unattributedIssueIds" in revalidated ? JSON.stringify(revalidated.unattributedIssueIds) : "",
    ).toBe(true);
  });

  // WDOG-009. A created child only ever explains the displacement of the parent
  // it was created *under*. Resolving that parent from the child's current row
  // instead lets a third party who reparents the child onto another branch have
  // this run's creation explain away the leaf their reparenting displaced there.
  it("still rejects a leaf displaced by a third party reparenting the run's created child onto it", async () => {
    const { companyId, childIds, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-REPARENT", {
        establishedChildren: ["WDOG-REPARENT-A", "WDOG-REPARENT-B"],
      });
    const [ownParentId, otherLeafId] = childIds as [string, string];
    const scope = await resolveScope();
    const admitted = await admitMutation(scope);

    const childId = await seedIssue(companyId, {
      identifier: "WDOG-REPARENT-FOLLOWUP",
      status: "todo",
      parentId: ownParentId,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    expect((await recordMutations(scope, admitted, [
      { issueId: childId, created: true, parentId: ownParentId, declared: declaredCreatedLeaf() },
    ])).recorded).toBe(true);
    expect((await service.revalidateMutationScope(await resolveScope())).allowed).toBe(true);

    // A third party moves the run's follow-up onto the other established leaf.
    // That leaf leaving the fingerprint is their doing, not this run's — and
    // the run's own parent becomes a leaf again, so nothing here is explained.
    await db.update(issues)
      .set({ parentId: otherLeafId, updatedAt: new Date() })
      .where(eq(issues.id, childId));

    const revalidated = await service.revalidateMutationScope(await resolveScope());
    expect(revalidated.allowed).toBe(false);
    expect(
      "unattributedIssueIds" in revalidated ? revalidated.unattributedIssueIds ?? [] : [],
    ).toContain(otherLeafId);
  });

  // The negative control for the two above. A leaf can stop being a leaf for
  // two different reasons, and the run's created child only speaks for one of
  // them: if the leaf went terminal under this run without the run declaring
  // it, that is somebody else closing work the watchdog is standing on.
  it("still rejects a displaced leaf that a third party closed under the run", async () => {
    const { companyId, childIds, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-CLOSED-PARENT", { establishedChildren: ["WDOG-CLOSED-PARENT-A"] });
    const leafId = childIds[0]!;
    const scope = await resolveScope();
    const admitted = await admitMutation(scope);

    const childId = await seedIssue(companyId, {
      identifier: "WDOG-CLOSED-PARENT-FOLLOWUP",
      status: "todo",
      parentId: leafId,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    expect((await recordMutations(scope, admitted, [
      { issueId: childId, created: true, parentId: leafId, declared: declaredCreatedLeaf() },
    ])).recorded).toBe(true);
    expect((await service.revalidateMutationScope(await resolveScope())).allowed).toBe(true);

    // A board user closes the leaf the run's follow-up hangs off.
    await db.update(issues)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(issues.id, leafId));

    const revalidated = await service.revalidateMutationScope(await resolveScope());
    expect(revalidated.allowed).toBe(false);
    expect(
      "unattributedIssueIds" in revalidated ? revalidated.unattributedIssueIds : null,
    ).toEqual([leafId]);
  });

  // WDOG-CREATED-TERMINAL-DRIFT. A child the run created and somebody else then
  // closed slips through every comparison the guard makes: it has no baseline
  // entry to be diffed against, and going terminal takes it out of the material
  // leaves and out of the waiting paths at once. Its parent's leaf-loss stays
  // honestly explained by the creation, so nothing else flags it either — while
  // the identical closure of a child that *existed* at baseline is rejected by
  // the leaf-loss check. The creation is not a licence for whatever happens to
  // the created issue afterwards.
  it("rejects a follow-up child a third party closed under the run", async () => {
    const { companyId, childIds, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-CREATED-CLOSED", {
        establishedChildren: ["WDOG-CREATED-CLOSED-A"],
      });
    const leafId = childIds[0]!;
    const scope = await resolveScope();
    const admitted = await admitMutation(scope);

    const childId = await seedIssue(companyId, {
      identifier: "WDOG-CREATED-CLOSED-FOLLOWUP",
      status: "todo",
      parentId: leafId,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    expect((await recordMutations(scope, admitted, [
      { issueId: childId, created: true, parentId: leafId, declared: declaredCreatedLeaf() },
    ])).recorded).toBe(true);
    expect((await service.revalidateMutationScope(await resolveScope())).allowed).toBe(true);

    // A board user closes the follow-up itself. It stays a child of the leaf,
    // so the leaf's displacement is still the run's own — but this transition
    // is not.
    await db.update(issues)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(issues.id, childId));

    const revalidated = await service.revalidateMutationScope(await resolveScope());
    expect(revalidated.allowed).toBe(false);
    // The child alone: the parent's leaf-loss is not the third party's doing
    // and must not be reported as though it were.
    expect(
      "unattributedIssueIds" in revalidated ? revalidated.unattributedIssueIds : null,
    ).toEqual([childId]);
  });

  // The control: the run closing its own follow-up is a declared write like any
  // other, and the same shape must still land.
  it("lets the run keep working after closing the follow-up child it created", async () => {
    const { companyId, childIds, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-CREATED-SELF-CLOSED", {
        establishedChildren: ["WDOG-CREATED-SELF-CLOSED-A"],
      });
    const leafId = childIds[0]!;
    const scope = await resolveScope();
    const admitted = await admitMutation(scope);

    const childId = await seedIssue(companyId, {
      identifier: "WDOG-CREATED-SELF-CLOSED-FOLLOWUP",
      status: "todo",
      parentId: leafId,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await db.update(issues)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(issues.id, childId));
    expect((await recordMutations(scope, admitted, [
      { issueId: childId, created: true, parentId: leafId, declared: declaredCreatedLeaf() },
      { issueId: childId, declared: { status: "done" } },
    ])).recorded).toBe(true);

    expect((await service.revalidateMutationScope(await resolveScope())).allowed).toBe(true);
  });

  // WDOG-001B. A declaration licenses the liveness it could have caused, and
  // closing an issue causes none: nothing wakes work on an issue this run just
  // took out of the running. A run appearing there afterwards is a third
  // party's, whatever else the ledger says about that leaf.
  it("rejects a live path on a leaf this run closed", async () => {
    const { companyId, childIds, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-LIVE-CLOSED", {
        establishedChildren: ["WDOG-LIVE-CLOSED-A", "WDOG-LIVE-CLOSED-B"],
      });
    const [closedLeafId] = childIds as [string, string];
    const scope = await resolveScope();
    const admitted = await admitMutation(scope);

    await db.update(issues)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(issues.id, closedLeafId));
    expect((await recordMutations(scope, admitted, [
      { issueId: closedLeafId, declared: declaredLeaf({ status: "done" }) },
    ])).recorded).toBe(true);

    const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId));
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent!.id,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: closedLeafId },
    });

    const revalidated = await service.revalidateMutationScope(await resolveScope());
    expect(revalidated.allowed).toBe(false);
    expect(
      "unattributedLivenessIssueIds" in revalidated ? revalidated.unattributedLivenessIssueIds : null,
    ).toEqual([closedLeafId]);
  });

  // WDOG-002. Closing a stale leaf makes the current snapshot a shrink of the
  // reviewed one, so an ordinary recovery lands the subtree in
  // `already_reviewed` on the run's *first* sanctioned action. Skipping ledger
  // attribution for that state left the mandated summary comment 409ing — the
  // reported lockout, reached by a different classifier branch.
  it("lets the run keep working when its own action left the subtree already-reviewed", async () => {
    const { sourceId, childIds, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-REVIEWED", {
        establishedChildren: ["WDOG-REVIEWED-A", "WDOG-REVIEWED-B"],
      });
    const [closedLeafId] = childIds as [string, string];
    await seedReviewedSnapshotWithout(sourceId, closedLeafId);

    const scope = await resolveScope();
    const admitted = await admitMutation(scope);
    await db.update(issues)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(issues.id, closedLeafId));
    expect((await recordMutations(scope, admitted, [
      { issueId: closedLeafId, declared: declaredLeaf({ status: "done" }) },
    ])).recorded).toBe(true);

    const revalidated = await service.revalidateMutationScope(await resolveScope());
    expect(revalidated.classification?.state).toBe("already_reviewed");
    expect(revalidated.allowed).toBe(true);
  });

  it("still rejects a third-party change once the subtree is already-reviewed", async () => {
    const { sourceId, childIds, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-REVIEWED-CONTROL", {
        establishedChildren: ["WDOG-REVIEWED-CONTROL-A", "WDOG-REVIEWED-CONTROL-B"],
      });
    const [closedLeafId, otherLeafId] = childIds as [string, string];
    await seedReviewedSnapshotWithout(sourceId, closedLeafId);

    const scope = await resolveScope();
    const admitted = await admitMutation(scope);
    await db.update(issues)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(issues.id, closedLeafId));
    expect((await recordMutations(scope, admitted, [
      { issueId: closedLeafId, declared: declaredLeaf({ status: "done" }) },
    ])).recorded).toBe(true);

    // Admitting `already_reviewed` into ledger attribution must not admit
    // anybody else's change along with it.
    await db.update(issues)
      .set({ status: "in_progress", updatedAt: new Date() })
      .where(eq(issues.id, otherLeafId));

    const revalidated = await service.revalidateMutationScope(await resolveScope());
    expect(revalidated.allowed).toBe(false);
    expect(
      "unattributedIssueIds" in revalidated ? revalidated.unattributedIssueIds : null,
    ).toEqual([otherLeafId]);
  });

  // The ledger's baseline is the state the run was last genuinely validated
  // against, and it stays there. Otherwise a run could walk the subtree away
  // from what its wake observed one attributable step at a time, and a change
  // that landed during an earlier step would stop being visible.
  it("keeps measuring drift from the state the run woke to, not from its last mutation", async () => {
    const { agentId, childIds, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-BASELINE", {
        establishedChildren: ["WDOG-BASELINE-A", "WDOG-BASELINE-B"],
      });
    const [ownLeafId, otherLeafId] = childIds as [string, string];

    const first = await resolveScope();
    const firstAdmitted = await admitMutation(first);
    await db.update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, ownLeafId));
    // A board user moves a different leaf, and the run does not notice yet.
    await db.update(issues)
      .set({ status: "in_progress", updatedAt: new Date() })
      .where(eq(issues.id, otherLeafId));
    expect((await recordMutations(first, firstAdmitted, [
      { issueId: ownLeafId, declared: declaredLeaf({ assigneeAgentId: agentId }) },
    ])).recorded).toBe(true);

    const revalidated = await service.revalidateMutationScope(await resolveScope());
    expect(revalidated.allowed).toBe(false);
    expect(
      "unattributedIssueIds" in revalidated ? revalidated.unattributedIssueIds : null,
    ).toEqual([otherLeafId]);
  });

  it("appends later authorized mutations to the ledger the run already holds", async () => {
    const { agentId, childIds, runId, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-LEDGER-APPEND", {
        establishedChildren: ["WDOG-LEDGER-APPEND-A", "WDOG-LEDGER-APPEND-B"],
      });
    const [firstLeafId, secondLeafId] = childIds as [string, string];

    const first = await resolveScope();
    const firstAdmitted = await admitMutation(first);
    await db.update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, firstLeafId));
    await recordMutations(first, firstAdmitted, [
      { issueId: firstLeafId, declared: declaredLeaf({ assigneeAgentId: agentId }) },
    ]);

    const second = await resolveScope();
    const secondAdmitted = await admitMutation(second);
    await db.update(issues)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(issues.id, secondLeafId));
    expect((await recordMutations(second, secondAdmitted, [
      { issueId: secondLeafId, declared: declaredLeaf({ status: "done" }) },
    ])).recorded).toBe(true);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const ledger = (run!.contextSnapshot as {
      taskWatchdog: { mutationLedger: { baseline: { fingerprint: string }; mutations: Array<{ issueId: string }> } };
    }).taskWatchdog.mutationLedger;
    expect(ledger.mutations.map((entry) => entry.issueId)).toEqual([firstLeafId, secondLeafId]);
    // The second record kept the first record's baseline rather than rebasing
    // onto the state the first mutation produced.
    expect(ledger.baseline.fingerprint).toBe(
      firstAdmitted.ledgerBaseline!.baseline.fingerprint,
    );
    expect((await service.revalidateMutationScope(await resolveScope())).allowed).toBe(true);
  });

  it("does not record a mutation without the baseline the guard admitted it against", async () => {
    const { childIds, agentId, service, resolveScope } = await seedWokenWatchdogRun("WDOG-NO-BASELINE", {
      establishedChildren: ["WDOG-NO-BASELINE-A"],
    });
    const scope = await resolveScope();
    const outcome = await service.recordAuthorizedMutation(scope, {
      ledgerBaseline: null,
      mutations: [{ issueId: childIds[0]!, declared: declaredLeaf({ assigneeAgentId: agentId }) }],
    });
    expect(outcome.recorded).toBe(false);
    expect(outcome.reason).toBe("missing_ledger_baseline");
  });

  it("does not clobber a run context that another writer changed after the scope was read", async () => {
    const { agentId, childIds, runId, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-LEDGER-CAS", { establishedChildren: ["WDOG-LEDGER-CAS-LEAF"] });
    const leafId = childIds[0]!;
    const scope = await resolveScope();
    const admitted = await admitMutation(scope);
    await db.update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, leafId));

    await db.update(heartbeatRuns)
      .set({
        contextSnapshot: sql`jsonb_set(
          ${heartbeatRuns.contextSnapshot},
          array['taskWatchdog', 'stopFingerprint'],
          to_jsonb(${"task_watchdog_stop:sibling"}::text),
          true
        )`,
      })
      .where(eq(heartbeatRuns.id, runId));

    const outcome = await recordMutations(scope, admitted, [
      { issueId: leafId, declared: declaredLeaf({ assigneeAgentId: agentId }) },
    ]);
    expect(outcome.recorded).toBe(false);
    expect(outcome.reason).toBe("run_context_changed");

    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const afterContext = after!.contextSnapshot as {
      taskWatchdog: { stopFingerprint: string; mutationLedger?: unknown };
    };
    expect(afterContext.taskWatchdog.stopFingerprint).toBe("task_watchdog_stop:sibling");
    expect(afterContext.taskWatchdog.mutationLedger).toBeUndefined();
  });

  it("writes only the ledger, leaving the rest of the run context intact", async () => {
    const { agentId, childIds, runId, service, resolveScope, admitMutation, recordMutations } =
      await seedWokenWatchdogRun("WDOG-LEDGER-MERGE", {
        establishedChildren: ["WDOG-LEDGER-MERGE-LEAF"],
      });
    const leafId = childIds[0]!;
    const scope = await resolveScope();
    const admitted = await admitMutation(scope);
    await db.update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, leafId));

    // A key another subsystem writes on the same column (the native-question
    // cancellation marker is a real example) must survive the record.
    await db.update(heartbeatRuns)
      .set({
        contextSnapshot: sql`jsonb_set(
          ${heartbeatRuns.contextSnapshot},
          array['nativeQuestionCancellation'],
          '{"version":1}'::jsonb,
          true
        )`,
      })
      .where(eq(heartbeatRuns.id, runId));

    expect((await recordMutations(scope, admitted, [
      { issueId: leafId, declared: declaredLeaf({ assigneeAgentId: agentId }) },
    ])).recorded).toBe(true);

    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const afterContext = after!.contextSnapshot as {
      taskWatchdog: { watchedIssueId: string; stopFingerprint: string; mutationLedger: { version: number } };
      nativeQuestionCancellation?: { version: number };
    };
    expect(afterContext.nativeQuestionCancellation).toEqual({ version: 1 });
    expect(afterContext.taskWatchdog.mutationLedger.version).toBe(1);
    expect(afterContext.taskWatchdog.watchedIssueId).toBeTruthy();
    // The pin itself is untouched: drift is explained, not papered over.
    expect((await resolveScope()).stopFingerprint).toBe(scope.stopFingerprint);
    expect(service).toBeTruthy();
  });

  it("surfaces pending interaction kinds and approval ids in the wake and watchdog comment", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-WAITS", status: "in_review" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const interactionId = randomUUID();
    const approvalId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId: sourceId,
      kind: "request_confirmation",
      status: "pending",
      payload: { version: 1, prompt: "Confirm the reviewed stop." },
      createdByAgentId: agentId,
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      requestedByAgentId: agentId,
      status: "pending",
      payload: { summary: "Approve the reviewed stop." },
    });
    await db.insert(issueApprovals).values({
      companyId,
      issueId: sourceId,
      approvalId,
      linkedByAgentId: agentId,
    });
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes[0]?.opts?.contextSnapshot).toMatchObject({
      taskWatchdog: {
        pendingInteractions: {
          [sourceId]: [{ id: interactionId, kind: "request_confirmation" }],
        },
        pendingApprovals: {
          [sourceId]: [approvalId],
        },
      },
    });
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(watchdog?.lastObservedStopSnapshot).toMatchObject({
      waitsByIssueId: {
        [sourceId]: {
          pendingInteractionIds: [interactionId],
          pendingApprovalIds: [approvalId],
        },
      },
    });
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, watchdog!.watchdogIssueId!));
    expect(comments.at(-1)?.body).toContain(`pending request_confirmation ${interactionId.slice(0, 8)}…`);
    expect(comments.at(-1)?.body).toContain(`approval ${approvalId.slice(0, 8)}…`);
    const metadata = comments.at(-1)?.metadata as { sections?: Array<{ rows?: unknown[] }> } | null;
    expect(metadata?.sections?.[0]?.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Pending waits", text: "2" }),
    ]));
  });

  it("revalidates a stale watchdog review as live when the source gets a fresh run path", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-LIVE-REVALIDATE", status: "blocked" });
    const agentId = await seedAgent(companyId);
    await seedWatchdog(companyId, sourceId, agentId);
    const { service } = createService();

    await service.reconcileTaskWatchdogs({ companyId });
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    const originalFingerprint = watchdog!.lastObservedFingerprint!;
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: sourceId },
    });

    const revalidated = await service.revalidateMutationScope({
      kind: "watchdog",
      watchdogId: watchdog!.id,
      companyId,
      watchedIssueId: sourceId,
      stopFingerprint: originalFingerprint,
    });

    expect(revalidated.allowed).toBe(false);
    expect(revalidated.reason).toContain("now has a live");
    expect(revalidated.classification?.state).toBe("live");
  });

  it("does not raise a stopped-subtree review while a freshly-created assigned issue's first run is starting", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    // Issue + watchdog created in the same flow; the assignment run row is not
    // yet visible to this evaluation (create-race).
    const sourceId = await seedIssue(companyId, {
      identifier: "WDOG-RACE",
      status: "todo",
      assigneeAgentId: agentId,
      createdAt: new Date(),
    });
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 0, pendingFirstRun: 1 });
    expect(wakes).toHaveLength(0);
    const watchdogIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogIssues).toHaveLength(0);
    const [watchdog] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, sourceId));
    expect(watchdog?.triggerCount).toBe(0);
  });

  it("still triggers a genuinely idle assigned issue once it is past the first-run grace window", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    // Established issue (default createdAt is an hour ago), assigned, non-terminal,
    // with no live run or queued wake.
    const sourceId = await seedIssue(companyId, {
      identifier: "WDOG-IDLE",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await seedWatchdog(companyId, sourceId, agentId);
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes).toHaveLength(1);
  });

  it("does not defer once the freshly-created issue has a terminal run on record", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const sourceId = await seedIssue(companyId, {
      identifier: "WDOG-RAN",
      status: "blocked",
      assigneeAgentId: agentId,
      createdAt: new Date(),
    });
    await seedWatchdog(companyId, sourceId, agentId);
    // A run for this issue already reached a terminal status, so the stop is
    // genuine even though the issue was just created.
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "succeeded",
      invocationSource: "assignment",
      contextSnapshot: { issueId: sourceId },
    });
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 1 });
    expect(wakes).toHaveLength(1);
  });

  it("does not recursively trigger a watchdog configured on a task-watchdog issue", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const sourceId = await seedIssue(companyId, { identifier: "WDOG-4", status: "done" });
    const watchdogIssueId = await seedIssue(companyId, {
      parentId: sourceId,
      status: "done",
      originKind: "task_watchdog",
      originId: sourceId,
      originFingerprint: `task_watchdog:${companyId}:${sourceId}`,
    });
    await seedIssue(companyId, { parentId: watchdogIssueId, status: "done" });
    await seedWatchdog(companyId, watchdogIssueId, agentId);
    const { service, wakes } = createService();

    const result = await service.reconcileTaskWatchdogs({ companyId });

    expect(result).toMatchObject({ checked: 1, triggered: 0 });
    expect(wakes).toHaveLength(0);
    const watchdogIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogIssues).toHaveLength(1);
  });

  it("handles an armed cutoff when no watchdogs are active", async () => {
    const companyId = await seedCompany();
    const { service } = createService();

    const result = await service.reconcileTaskWatchdogs({
      companyId,
      issueCreatedAtGte: new Date(),
    });

    expect(result).toMatchObject({ checked: 0, triggered: 0 });
  });
});
