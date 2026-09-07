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
    options: { establishedChildren?: string[] } = {},
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

    // The snapshot the freshness guard admitted the run's mutation against —
    // the state of the subtree immediately *before* the run changes anything.
    // Re-pinning diffs against exactly this to tell the run's own change apart
    // from anybody else's.
    const admitMutation = async (scope: Awaited<ReturnType<typeof resolveScope>>) => {
      const revalidated = await service.revalidateMutationScope(scope);
      expect(revalidated.allowed).toBe(true);
      const classification = revalidated.classification;
      if (!classification || !("stopSnapshot" in classification)) {
        throw new Error("Expected an admitted mutation to carry a stop snapshot");
      }
      return classification.stopSnapshot;
    };

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
    };
  }

  it("lets a watchdog run keep mutating the subtree after its own sanctioned action rotated the fingerprint", async () => {
    const { agentId, childIds, service, pinnedFingerprint, resolveScope, admitMutation } =
      await seedWokenWatchdogRun("WDOG-REPIN", { establishedChildren: ["WDOG-REPIN-LEAF"] });
    const leafId = childIds[0]!;

    const scope = await resolveScope();
    expect(scope.stopFingerprint).toBe(pinnedFingerprint);
    const previousStopSnapshot = await admitMutation(scope);

    // The run's first sanctioned recovery action: reassign a stopped leaf. The
    // assignee is an input to `materialLeaf`, so this allowed operation rotates
    // the very fingerprint the run is pinned to while the subtree stays
    // stopped. This is the interleaving that was actually reported.
    await db.update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, leafId));

    const stale = await service.revalidateMutationScope(scope);
    expect(stale.allowed).toBe(false);
    expect(stale.reason).toContain("stop fingerprint changed");
    // The subtree did not become live — only the hash moved. This is the
    // self-inflicted staleness being fixed.
    expect(stale.classification?.state).toBe("stopped");

    const repin = await service.repinMutationScope(scope, {
      authorizedIssueIds: [leafId],
      previousStopSnapshot,
    });
    expect(repin.repinned).toBe(true);

    // The next request in the same run re-reads its scope from the run context,
    // so it must now see the re-pinned fingerprint and be allowed to proceed
    // (this is the summary comment the run previously could not post).
    const nextScope = await resolveScope();
    expect(nextScope.stopFingerprint).not.toBe(pinnedFingerprint);
    const after = await service.revalidateMutationScope(nextScope);
    expect(after.allowed).toBe(true);
  });

  it("still rejects a concurrent third-party change after the run re-pinned itself", async () => {
    const { agentId, childIds, service, resolveScope, admitMutation } = await seedWokenWatchdogRun(
      "WDOG-REPIN-CONTROL",
      { establishedChildren: ["WDOG-REPIN-CONTROL-A", "WDOG-REPIN-CONTROL-B"] },
    );
    const [ownLeafId, otherLeafId] = childIds as [string, string];

    const scope = await resolveScope();
    const previousStopSnapshot = await admitMutation(scope);
    await db.update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, ownLeafId));
    expect((await service.repinMutationScope(scope, {
      authorizedIssueIds: [ownLeafId],
      previousStopSnapshot,
    })).repinned).toBe(true);

    const repinnedScope = await resolveScope();
    expect((await service.revalidateMutationScope(repinnedScope)).allowed).toBe(true);

    // Somebody other than this run now moves the watched subtree. This is the
    // property the freshness guard exists for and it must survive re-pinning.
    await db.update(issues)
      .set({ status: "in_progress", updatedAt: new Date() })
      .where(eq(issues.id, otherLeafId));

    const afterExternalChange = await service.revalidateMutationScope(repinnedScope);
    expect(afterExternalChange.allowed).toBe(false);
    expect(afterExternalChange.reason).toContain("stop fingerprint changed");
  });

  it("refuses to re-pin when an unrelated change landed in the same window as the run's own mutation", async () => {
    const { agentId, childIds, service, pinnedFingerprint, resolveScope, admitMutation } =
      await seedWokenWatchdogRun("WDOG-REPIN-RACE", {
        establishedChildren: ["WDOG-REPIN-RACE-A", "WDOG-REPIN-RACE-B"],
      });
    const [ownLeafId, otherLeafId] = childIds as [string, string];

    const scope = await resolveScope();
    const previousStopSnapshot = await admitMutation(scope);

    // The run's own authorized mutation, and — in the window before the re-pin
    // re-reads the subtree — a board user moving a *different* stopped leaf.
    // Re-pinning must not launder that second change into the run's pin.
    await db.update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, ownLeafId));
    await db.update(issues)
      .set({ status: "in_progress", updatedAt: new Date() })
      .where(eq(issues.id, otherLeafId));

    const repin = await service.repinMutationScope(scope, {
      authorizedIssueIds: [ownLeafId],
      previousStopSnapshot,
    });
    expect(repin.repinned).toBe(false);
    expect(repin.reason).toBe("unrelated_subtree_change");
    expect(repin.unattributedIssueIds).toEqual([otherLeafId]);

    // The run stays pinned to what its wake observed, so the guard keeps
    // rejecting — the same fail-closed behaviour as before re-pinning existed.
    const unchangedScope = await resolveScope();
    expect(unchangedScope.stopFingerprint).toBe(pinnedFingerprint);
    expect((await service.revalidateMutationScope(unchangedScope)).allowed).toBe(false);
  });

  it("attributes a leaf the run created under an issue it was authorized to mutate", async () => {
    const { companyId, sourceId, service, resolveScope, admitMutation } = await seedWokenWatchdogRun(
      "WDOG-REPIN-CREATE",
    );
    const scope = await resolveScope();
    const previousStopSnapshot = await admitMutation(scope);

    // A follow-up child under the watched root. `seedIssue` backdates
    // `createdAt`, which stands in for a child that has aged past the first-run
    // grace window — the immediate-aftermath case is asserted separately below.
    const childId = await seedIssue(companyId, {
      identifier: "WDOG-REPIN-CREATE-CHILD",
      status: "todo",
      parentId: sourceId,
    });

    const repin = await service.repinMutationScope(scope, {
      authorizedIssueIds: [sourceId],
      previousStopSnapshot,
    });
    expect(repin.repinned).toBe(true);
    expect((await resolveScope()).stopFingerprint).toBe(repin.stopFingerprint);
    expect(childId).toBeTruthy();
  });

  it("refuses a leaf created under an issue the run was not authorized to mutate", async () => {
    const { companyId, sourceId, childIds, service, pinnedFingerprint, resolveScope, admitMutation } =
      await seedWokenWatchdogRun("WDOG-REPIN-CREATE-FOREIGN", {
        establishedChildren: ["WDOG-REPIN-CREATE-FOREIGN-A"],
      });
    const otherLeafId = childIds[0]!;
    const scope = await resolveScope();
    const previousStopSnapshot = await admitMutation(scope);

    // A third party creates a child somewhere else in the watched subtree.
    const foreignChildId = await seedIssue(companyId, {
      identifier: "WDOG-REPIN-CREATE-FOREIGN-CHILD",
      status: "todo",
      parentId: otherLeafId,
    });

    const repin = await service.repinMutationScope(scope, {
      authorizedIssueIds: [sourceId],
      previousStopSnapshot,
    });
    expect(repin.repinned).toBe(false);
    expect(repin.reason).toBe("unrelated_subtree_change");
    expect(repin.unattributedIssueIds).toContain(foreignChildId);
    expect((await resolveScope()).stopFingerprint).toBe(pinnedFingerprint);
  });

  it("does not re-pin without the snapshot the mutation was admitted against", async () => {
    const { agentId, childIds, service, pinnedFingerprint, resolveScope, admitMutation } =
      await seedWokenWatchdogRun("WDOG-REPIN-NO-SNAPSHOT", {
        establishedChildren: ["WDOG-REPIN-NO-SNAPSHOT-LEAF"],
      });
    const leafId = childIds[0]!;
    const scope = await resolveScope();
    await admitMutation(scope);
    await db.update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, leafId));

    // With nothing to diff against there is no way to tell the run's own change
    // from anybody else's, so re-pinning must fail closed rather than guess.
    const repin = await service.repinMutationScope(scope, {
      authorizedIssueIds: [leafId],
      previousStopSnapshot: null,
    });
    expect(repin.repinned).toBe(false);
    expect(repin.reason).toBe("missing_previous_snapshot");
    expect((await resolveScope()).stopFingerprint).toBe(pinnedFingerprint);
  });

  it("does not re-pin a follow-up child created inside the first-run grace window", async () => {
    const { companyId, sourceId, service, pinnedFingerprint, resolveScope, admitMutation } =
      await seedWokenWatchdogRun("WDOG-REPIN-GRACE");
    const scope = await resolveScope();
    const previousStopSnapshot = await admitMutation(scope);

    // A follow-up child created *now* is inside TASK_WATCHDOG_FIRST_RUN_GRACE_MS
    // and has not completed a run, so the classifier reports
    // `pending_first_run` — a state that carries no stop fingerprint at all.
    // Re-pinning therefore cannot cover child creation in its immediate
    // aftermath; the run stays pinned and the guard keeps failing closed.
    const childId = await seedIssue(companyId, {
      identifier: "WDOG-REPIN-GRACE-CHILD",
      status: "todo",
      parentId: sourceId,
      createdAt: new Date(),
    });

    const repin = await service.repinMutationScope(scope, {
      authorizedIssueIds: [sourceId, childId],
      previousStopSnapshot,
    });
    expect(repin.repinned).toBe(false);
    expect(repin.reason).toBe("subtree_not_stopped");
    expect(repin.classificationState).toBe("pending_first_run");
    expect((await resolveScope()).stopFingerprint).toBe(pinnedFingerprint);
  });

  it("does not clobber a run context that another writer changed after the scope was read", async () => {
    const { agentId, childIds, runId, service, resolveScope, admitMutation } = await seedWokenWatchdogRun(
      "WDOG-REPIN-CAS",
      { establishedChildren: ["WDOG-REPIN-CAS-LEAF"] },
    );
    const leafId = childIds[0]!;
    const scope = await resolveScope();
    const previousStopSnapshot = await admitMutation(scope);
    await db.update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, leafId));

    // Another writer has already moved this run's pin. A read-modify-write off
    // the value this request read would silently discard that update.
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

    const repin = await service.repinMutationScope(scope, {
      authorizedIssueIds: [leafId],
      previousStopSnapshot,
    });
    expect(repin.repinned).toBe(false);
    expect(repin.reason).toBe("run_context_changed");

    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const afterContext = after!.contextSnapshot as { taskWatchdog: { stopFingerprint: string } };
    expect(afterContext.taskWatchdog.stopFingerprint).toBe("task_watchdog_stop:sibling");
  });

  it("writes only the pinned fingerprint, leaving the rest of the run context intact", async () => {
    const { agentId, childIds, runId, service, resolveScope, admitMutation } = await seedWokenWatchdogRun(
      "WDOG-REPIN-MERGE",
      { establishedChildren: ["WDOG-REPIN-MERGE-LEAF"] },
    );
    const leafId = childIds[0]!;
    const scope = await resolveScope();
    const previousStopSnapshot = await admitMutation(scope);
    await db.update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, leafId));

    // A key another subsystem writes on the same column (the native-question
    // cancellation marker is a real example) must survive the re-pin.
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

    const repin = await service.repinMutationScope(scope, {
      authorizedIssueIds: [leafId],
      previousStopSnapshot,
    });
    expect(repin.repinned).toBe(true);

    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const afterContext = after!.contextSnapshot as {
      taskWatchdog: { watchedIssueId: string; stopFingerprint: string };
      nativeQuestionCancellation?: { version: number };
    };
    expect(afterContext.nativeQuestionCancellation).toEqual({ version: 1 });
    expect(afterContext.taskWatchdog.stopFingerprint).toBe(repin.stopFingerprint);
    expect(afterContext.taskWatchdog.watchedIssueId).toBeTruthy();
  });

  it("does not re-pin a run whose action left the watched subtree live", async () => {
    const { companyId, sourceId, service, pinnedFingerprint, resolveScope, admitMutation } =
      await seedWokenWatchdogRun("WDOG-REPIN-LIVE");
    const scope = await resolveScope();
    const previousStopSnapshot = await admitMutation(scope);

    // A recovery action that restores a live path takes the subtree out of the
    // `stopped` state entirely, so there is no stop fingerprint to re-pin to.
    // The run stays pinned to what its wake observed; it is granted comment-only
    // scope instead, which is asserted separately below.
    const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId));
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent!.id,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: sourceId },
    });

    const repin = await service.repinMutationScope(scope, {
      authorizedIssueIds: [sourceId],
      previousStopSnapshot,
    });
    expect(repin.repinned).toBe(false);
    expect(repin.classificationState).toBe("live");
    expect((await resolveScope()).stopFingerprint).toBe(pinnedFingerprint);
  });

  // Restoring a live execution path is the recovery action the watchdog
  // mandate cares about most, and it takes the subtree out of `stopped`
  // entirely — so there is no fingerprint left to re-pin to. Without a grant
  // the run that just succeeded at its job is locked out of the watched issue
  // for the rest of the run, and its summary comment lands on the watchdog
  // issue instead of where a human reads it.
  //
  // A comment is the only write this grant covers, and it is provably inert:
  // `materialLeaf` strips `latestCommentAt`, so a comment cannot rotate the
  // stop fingerprint and cannot change the classification.
  async function queueWakeForIssue(companyId: string, agentId: string, issueId: string) {
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      status: "queued",
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
    });
  }

  it("lets a watchdog run comment on the watched subtree after its own action restored a live path", async () => {
    const { companyId, agentId, childIds, service, pinnedFingerprint, resolveScope, admitMutation } =
      await seedWokenWatchdogRun("WDOG-LIVE-GRANT", { establishedChildren: ["WDOG-LIVE-GRANT-LEAF"] });
    const leafId = childIds[0]!;

    const scope = await resolveScope();
    const previousStopSnapshot = await admitMutation(scope);

    // The sanctioned recovery action: hand the stopped leaf back to a live
    // agent. The assignment enqueues that agent's wake, which is exactly what
    // takes the subtree live.
    await db.update(issues)
      .set({ status: "todo", assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, leafId));
    await queueWakeForIssue(companyId, agentId, leafId);

    // Before the grant: rejected on *state*, not on fingerprint. Re-pinning
    // cannot help here — a live subtree has no stop fingerprint to pin to.
    const staleComment = await service.revalidateMutationScope(scope, { intent: "comment" });
    expect(staleComment.allowed).toBe(false);
    expect(staleComment.classification?.state).toBe("live");

    const outcome = await service.repinMutationScope(scope, {
      authorizedIssueIds: [leafId],
      previousStopSnapshot,
    });
    // The pin itself deliberately does not move: there is nothing to move it
    // to. The run is granted comment-only scope instead.
    expect(outcome.repinned).toBe(false);
    expect(outcome.reason).toBe("live_comment_scope_granted");
    expect((await resolveScope()).stopFingerprint).toBe(pinnedFingerprint);

    const rescoped = await resolveScope();
    const allowedComment = await service.revalidateMutationScope(rescoped, { intent: "comment" });
    expect(allowedComment.allowed).toBe(true);
    expect(allowedComment.classification?.state).toBe("live");
  });

  it("does not grant comment scope when a different actor made the watched subtree live", async () => {
    const { companyId, agentId, childIds, service, resolveScope, admitMutation } = await seedWokenWatchdogRun(
      "WDOG-LIVE-FOREIGN",
      { establishedChildren: ["WDOG-LIVE-FOREIGN-MINE", "WDOG-LIVE-FOREIGN-THEIRS"] },
    );
    const [mineId, theirsId] = [childIds[0]!, childIds[1]!];

    const scope = await resolveScope();
    const previousStopSnapshot = await admitMutation(scope);

    // The run was authorized to move `mineId`. Somebody else started work on a
    // different leaf in the same window — a competing actor by definition.
    await db.update(issues)
      .set({ status: "todo", assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, mineId));
    await queueWakeForIssue(companyId, agentId, theirsId);

    const outcome = await service.repinMutationScope(scope, {
      authorizedIssueIds: [mineId],
      previousStopSnapshot,
    });
    expect(outcome.repinned).toBe(false);
    expect(outcome.reason).toBe("unattributed_live_path");
    expect(outcome.unattributedIssueIds).toEqual([theirsId]);

    const stillStale = await service.revalidateMutationScope(await resolveScope(), { intent: "comment" });
    expect(stillStale.allowed).toBe(false);
  });

  it("attributes a live path on a follow-up child created under an authorized issue", async () => {
    const { companyId, sourceId, agentId, service, resolveScope, admitMutation } = await seedWokenWatchdogRun(
      "WDOG-LIVE-CHILD",
    );
    const scope = await resolveScope();
    const previousStopSnapshot = await admitMutation(scope);

    // The other sanctioned recovery action: create a follow-up task under the
    // watched issue and let it start. Its first run is a live path on an issue
    // that did not exist when the mutation was admitted — attributable only
    // because its parent is the issue the run was authorized to mutate.
    const childId = await seedIssue(companyId, {
      identifier: "WDOG-LIVE-CHILD-FOLLOWUP",
      status: "todo",
      parentId: sourceId,
      createdAt: new Date(),
    });
    await queueWakeForIssue(companyId, agentId, childId);

    const outcome = await service.repinMutationScope(scope, {
      authorizedIssueIds: [sourceId],
      previousStopSnapshot,
    });
    expect(outcome.classificationState).toBe("live");
    expect(outcome.reason).toBe("live_comment_scope_granted");

    const allowed = await service.revalidateMutationScope(await resolveScope(), { intent: "comment" });
    expect(allowed.allowed).toBe(true);
  });

  it("does not let a granted run make a state-changing write to the live subtree", async () => {
    const { companyId, agentId, childIds, service, resolveScope, admitMutation } = await seedWokenWatchdogRun(
      "WDOG-LIVE-COMMENT-ONLY",
      { establishedChildren: ["WDOG-LIVE-COMMENT-ONLY-LEAF"] },
    );
    const leafId = childIds[0]!;

    const scope = await resolveScope();
    const previousStopSnapshot = await admitMutation(scope);
    await db.update(issues)
      .set({ status: "todo", assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, leafId));
    await queueWakeForIssue(companyId, agentId, leafId);

    const outcome = await service.repinMutationScope(scope, {
      authorizedIssueIds: [leafId],
      previousStopSnapshot,
    });
    expect(outcome.reason).toBe("live_comment_scope_granted");

    // The grant restores the audit trail; it grants no new authority over
    // state. A subtree that is live now has a live owner, and the watchdog is
    // not it.
    const rescoped = await resolveScope();
    const mutate = await service.revalidateMutationScope(rescoped, { intent: "mutate" });
    expect(mutate.allowed).toBe(false);
    expect(mutate.reason).toContain("live");
    // Default intent is the conservative one.
    expect((await service.revalidateMutationScope(rescoped)).allowed).toBe(false);
  });

  // The grant lives on the run's context row, and that row outlives the run.
  // Only the run's own status makes the grant die with it — without that check
  // a finished run's context keeps admitting writes to a subtree that has had
  // a live owner ever since.
  it("stops honouring the comment grant once the run itself is terminal", async () => {
    const { companyId, agentId, childIds, runId, service, resolveScope, admitMutation } =
      await seedWokenWatchdogRun("WDOG-LIVE-RUN-ENDED", { establishedChildren: ["WDOG-LIVE-RUN-ENDED-LEAF"] });
    const leafId = childIds[0]!;

    const scope = await resolveScope();
    const previousStopSnapshot = await admitMutation(scope);
    await db.update(issues)
      .set({ status: "todo", assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, leafId));
    await queueWakeForIssue(companyId, agentId, leafId);

    const outcome = await service.repinMutationScope(scope, {
      authorizedIssueIds: [leafId],
      previousStopSnapshot,
    });
    expect(outcome.reason).toBe("live_comment_scope_granted");

    const granted = await resolveScope();
    expect((await service.revalidateMutationScope(granted, { intent: "comment" })).allowed).toBe(true);

    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));

    const afterRunEnded = await service.revalidateMutationScope(granted, { intent: "comment" });
    expect(afterRunEnded.allowed).toBe(false);
    expect(afterRunEnded.classification?.state).toBe("live");
  });

  it("does not issue a comment grant to a run that has already finished", async () => {
    const { companyId, agentId, childIds, runId, service, resolveScope, admitMutation } =
      await seedWokenWatchdogRun("WDOG-LIVE-RUN-GONE", { establishedChildren: ["WDOG-LIVE-RUN-GONE-LEAF"] });
    const leafId = childIds[0]!;

    const scope = await resolveScope();
    const previousStopSnapshot = await admitMutation(scope);
    await db.update(issues)
      .set({ status: "todo", assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, leafId));
    await queueWakeForIssue(companyId, agentId, leafId);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, runId));

    const outcome = await service.repinMutationScope(scope, {
      authorizedIssueIds: [leafId],
      previousStopSnapshot,
    });
    expect(outcome.repinned).toBe(false);
    expect(outcome.reason).toBe("run_not_live");
    expect((await service.revalidateMutationScope(scope, { intent: "comment" })).allowed).toBe(false);
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
