import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  executionWorkspaces,
  goals,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issuePlanDecompositions,
  issueRelations,
  issueThreadInteractions,
  issueWatchdogs,
  issues,
  principalPermissionGrants,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import { buildAgentMentionHref } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { runningProcesses } from "../adapters/index.ts";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { taskWatchdogService } from "../services/task-watchdogs.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Issue watchdog route test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

// The window between the freshness guard and the route's own write is the thing
// under test, and it is not otherwise addressable from outside: both happen
// inside one request. This hook fires once, immediately after the guard has
// adjudicated, so a test can land a third party's write in exactly that window
// rather than approximating it with two ordinary sequential requests.
const raceAfterRevalidate = vi.hoisted(() => ({ current: null as null | (() => Promise<void>) }));

vi.mock("../services/index.js", async () => {
  const actual = await vi.importActual<typeof import("../services/index.js")>("../services/index.js");
  return {
    ...actual,
    taskWatchdogService: (...args: Parameters<typeof actual.taskWatchdogService>) => {
      const service = actual.taskWatchdogService(...args);
      return {
        ...service,
        // Forwards every argument. The second one carries the request's intent
        // and the issue it writes, and dropping it here would hand the real
        // service a state change it cannot attribute — the wrapper would be
        // testing itself rather than the route.
        revalidateMutationScope: async (
          scope: Parameters<typeof service.revalidateMutationScope>[0],
          opts?: Parameters<typeof service.revalidateMutationScope>[1],
        ) => {
          const result = await service.revalidateMutationScope(scope, opts);
          const race = raceAfterRevalidate.current;
          if (race) {
            raceAfterRevalidate.current = null;
            await race();
          }
          return result;
        },
      };
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue watchdog route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue watchdog routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-watchdogs-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issuePlanDecompositions);
    await db.delete(issueThreadInteractions);
    await db.delete(issueDocuments);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(issueRelations);
    await db.delete(issueWatchdogs);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(documents);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string, actor?: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor ?? {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, { taskWatchdogEnqueueWakeup: null }));
    app.use(errorHandler);
    return app;
  }

  function uniqueIssuePrefix() {
    return `W${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
  }

  // The wake an issue route fired, once it lands. Routes enqueue their wakes in
  // a detached tail that outlives the response, so a test reading the row
  // straight after `await request(...)` races it. Polling keeps the assertion
  // on the real row the route produced rather than a stand-in.
  async function waitForIssueWake(companyId: string, issueId: string, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await db
        .select()
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, companyId),
          sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
        ));
      if (row) return row;
      if (Date.now() >= deadline) {
        throw new Error(`No wake request landed for issue ${issueId} within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  // The wake a specific comment fired. Same detached tail as above; keyed by
  // the comment so a wake left over from an earlier step cannot be mistaken for
  // the one being waited on.
  async function waitForIssueCommentWake(companyId: string, commentId: string, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await db
        .select()
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, companyId),
          sql`${agentWakeupRequests.payload}->>'commentId' = ${commentId}`,
        ));
      if (row) return row;
      if (Date.now() >= deadline) {
        throw new Error(`No wake request landed for comment ${commentId} within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  // The wake a specific agent received. A comment can fire more than one wake —
  // the target's assignee and one per @-mention — and the route enqueues them
  // independently, so waiting on the comment's own wake says nothing about
  // whether the mention has landed yet.
  async function waitForAgentWake(companyId: string, agentId: string, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await db
        .select()
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, agentId),
        ));
      if (row) return row;
      if (Date.now() >= deadline) {
        throw new Error(`No wake request landed for agent ${agentId} within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function seedCloudTenantMember(companyId: string) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });
  }

  async function seedCompany(name = "Paperclip") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
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
      title: overrides.title ?? "Watched task",
      status: overrides.status ?? "todo",
      priority: overrides.priority ?? "medium",
      identifier: overrides.identifier,
      issueNumber: overrides.issueNumber,
      assigneeAgentId: overrides.assigneeAgentId,
      parentId: overrides.parentId,
      projectId: overrides.projectId,
      goalId: overrides.goalId,
      originKind: overrides.originKind,
      originId: overrides.originId,
      // Default to an "established" issue (created before the first-run grace
      // window) so attaching a watchdog evaluates immediately instead of being
      // deferred by the pending-first-run guard.
      createdAt: overrides.createdAt ?? new Date(Date.now() - 60 * 60 * 1000),
    });
    return id;
  }

  async function seedProject(companyId: string, name = "Watched project") {
    const id = randomUUID();
    await db.insert(projects).values({ id, companyId, name });
    return id;
  }

  // A company-level root goal, which is what `getDefaultCompanyGoal` resolves
  // to. It is the fallback `resolveNextIssueGoalId` writes onto an issue whose
  // own `goalId` is null, and therefore the only goal derivation an otherwise
  // empty update can perform.
  async function seedDefaultCompanyGoal(companyId: string) {
    const id = randomUUID();
    await db.insert(goals).values({ id, companyId, title: "Company goal", level: "company", status: "active" });
    return id;
  }

  // The archived isolated workspace a terminal issue is still linked to, in the
  // state the reaper leaves behind: `archived`, closed, and with its worktree
  // gone from disk. A rebuild of this row fails deterministically — the route's
  // reopen path resolves no base checkout and `ensurePersistedExecutionWorkspaceAvailable`
  // finds no directory at `cwd` — so a request that enters the reopen lifecycle
  // is refused with 503 rather than quietly rebuilding a worktree in the test's
  // environment.
  async function seedArchivedIsolatedWorkspace(input: {
    companyId: string;
    projectId: string;
    issueId: string;
  }) {
    const id = randomUUID();
    await db.insert(executionWorkspaces).values({
      id,
      companyId: input.companyId,
      projectId: input.projectId,
      sourceIssueId: input.issueId,
      mode: "isolated_workspace",
      strategyType: "project_primary",
      name: "archived-task-workspace",
      status: "archived",
      cwd: `/nonexistent/${id}`,
      closedAt: new Date(),
      cleanupEligibleAt: new Date(),
    });
    await db
      .update(issues)
      .set({ executionWorkspaceId: id })
      .where(eq(issues.id, input.issueId));
    return id;
  }

  // Stands up the live execution path a watchdog run's own recovery produced:
  // the run reassigns the stalled leaf, and the wake that lands is claimed by a
  // running heartbeat for the new owner. This is the state that takes the
  // subtree out of `stopped` and leaves the run with nothing but its audit
  // grant.
  async function restoreLivePath(input: {
    app: ReturnType<typeof createApp>;
    companyId: string;
    leafIssueId: string;
    workerAgentId: string;
  }) {
    const revived = await request(input.app)
      .patch(`/api/issues/${input.leafIssueId}`)
      .send({ assigneeAgentId: input.workerAgentId });
    expect(revived.status, JSON.stringify(revived.body)).toBe(200);
    const wake = await waitForIssueWake(input.companyId, input.leafIssueId);
    await db.update(agentWakeupRequests)
      .set({ status: "claimed", claimedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wake.id));
    await db.insert(heartbeatRuns).values({
      companyId: input.companyId,
      agentId: input.workerAgentId,
      status: "running",
      invocationSource: "assignment",
      wakeupRequestId: wake.id,
      contextSnapshot: { issueId: input.leafIssueId },
    });
  }

  async function readExecutionWorkspace(workspaceId: string) {
    const [row] = await db
      .select({
        status: executionWorkspaces.status,
        closedAt: executionWorkspaces.closedAt,
        cleanupReason: executionWorkspaces.cleanupReason,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, workspaceId));
    return row ?? null;
  }

  async function readAuditCommentSpentAt(runId: string) {
    const [row] = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    const context = (row?.contextSnapshot ?? {}) as Record<string, unknown>;
    const watchdog = context.taskWatchdog as Record<string, unknown> | undefined;
    return (watchdog?.auditCommentSpentAt ?? context.auditCommentSpentAt ?? null) as string | null;
  }

  async function seedWatchdogRun(input: {
    companyId: string;
    watchdogAgentId: string;
    watchedIssueId: string;
    watchdogIssueId: string;
  }) {
    await db.insert(issueWatchdogs).values({
      companyId: input.companyId,
      issueId: input.watchedIssueId,
      watchdogAgentId: input.watchdogAgentId,
      watchdogIssueId: input.watchdogIssueId,
      status: "active",
    });
    await taskWatchdogService(db).reconcileTaskWatchdogs({ companyId: input.companyId });
    const [watchdog] = await db
      .select({ lastObservedFingerprint: issueWatchdogs.lastObservedFingerprint })
      .from(issueWatchdogs)
      .where(and(eq(issueWatchdogs.companyId, input.companyId), eq(issueWatchdogs.issueId, input.watchedIssueId)));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.watchdogAgentId,
      status: "running",
      contextSnapshot: {
        issueId: input.watchdogIssueId,
        taskWatchdog: {
          watchedIssueId: input.watchedIssueId,
          watchedIssueIdentifier: "WDOG-ROOT",
          watchedIssueTitle: "Watched root",
          stopFingerprint: watchdog?.lastObservedFingerprint,
        },
      },
    });
    return runId;
  }

  // The plan document, its revision, and the acceptance that `decomposeAcceptedPlan`
  // requires before it will create anything.
  async function seedAcceptedPlan(companyId: string, sourceIssueId: string, authorAgentId: string) {
    const planDocumentId = randomUUID();
    const acceptedPlanRevisionId = randomUUID();
    await db.insert(documents).values({
      id: planDocumentId,
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "Plan body",
      latestRevisionId: acceptedPlanRevisionId,
      latestRevisionNumber: 1,
      createdByAgentId: authorAgentId,
      updatedByAgentId: authorAgentId,
    });
    await db.insert(documentRevisions).values({
      id: acceptedPlanRevisionId,
      companyId,
      documentId: planDocumentId,
      revisionNumber: 1,
      title: "Plan",
      format: "markdown",
      body: "Plan body",
      createdByAgentId: authorAgentId,
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId: sourceIssueId,
      documentId: planDocumentId,
      key: "plan",
    });
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId: sourceIssueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Approve this plan?",
        target: {
          type: "issue_document",
          issueId: sourceIssueId,
          documentId: planDocumentId,
          key: "plan",
          revisionId: acceptedPlanRevisionId,
          revisionNumber: 1,
        },
      },
      result: { version: 1, outcome: "accepted" },
      resolvedAt: new Date(),
      createdByUserId: "cloud-user-1",
      resolvedByUserId: "cloud-user-1",
    });
    return acceptedPlanRevisionId;
  }

  async function waitForAssignmentWakeup(companyId: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const rows = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, companyId))
        .limit(1);
      if (rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("creates, updates, reads, lists, and removes an issue watchdog with activity logs", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, { identifier: "WDOG-1", issueNumber: 1 });
    const firstAgentId = await seedAgent(companyId, { name: "First Watchdog" });
    const secondAgentId = await seedAgent(companyId, { name: "Second Watchdog" });
    const app = createApp(companyId);

    const created = await request(app)
      .put(`/api/issues/${issueId}/watchdog`)
      .send({ agentId: firstAgentId, instructions: "Check screenshots and tests." });

    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({
      issueId,
      watchdogAgentId: firstAgentId,
      instructions: "Check screenshots and tests.",
      status: "active",
    });

    const updated = await request(app)
      .put(`/api/issues/${issueId}/watchdog`)
      .send({ agentId: secondAgentId, instructions: "Be skeptical." });

    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.id).toBe(created.body.id);
    expect(updated.body).toMatchObject({
      issueId,
      watchdogAgentId: secondAgentId,
      instructions: "Be skeptical.",
      status: "active",
    });

    const read = await request(app).get(`/api/issues/${issueId}/watchdog`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({ id: created.body.id, watchdogAgentId: secondAgentId });

    const detail = await request(app).get(`/api/issues/${issueId}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.watchdog).toMatchObject({ id: created.body.id, watchdogAgentId: secondAgentId });

    const list = await request(app).get(`/api/companies/${companyId}/issues`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.find((issue: { id: string }) => issue.id === issueId)?.watchdog)
      .toMatchObject({ id: created.body.id, watchdogAgentId: secondAgentId });

    const removed = await request(app).delete(`/api/issues/${issueId}/watchdog`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toEqual({ ok: true });

    const afterDelete = await request(app).get(`/api/issues/${issueId}/watchdog`);
    expect(afterDelete.status, JSON.stringify(afterDelete.body)).toBe(200);
    expect(afterDelete.body).toBeNull();

    const stored = await db
      .select()
      .from(issueWatchdogs)
      .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, issueId)))
      .then((rows) => rows[0] ?? null);
    expect(stored).toMatchObject({
      id: created.body.id,
      status: "disabled",
      watchdogAgentId: secondAgentId,
    });

    const actions = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    const actionNames = actions.map((row) => row.action);
    expect(actionNames.filter((action) => action.startsWith("issue.watchdog_"))).toEqual([
      "issue.watchdog_created",
      "issue.watchdog_updated",
      "issue.watchdog_removed",
    ]);
    expect(actionNames).toContain("issue.task_watchdog_triggered");
  });

  it("handles concurrent first-time watchdog upserts without duplicate-key failures", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, { identifier: "WDOG-RACE", issueNumber: 99 });
    const agentId = await seedAgent(companyId, { name: "Race Watchdog" });
    const app = createApp(companyId);

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        request(app)
          .put(`/api/issues/${issueId}/watchdog`)
          .send({ agentId, instructions: `Concurrent instructions ${index}` }),
      ),
    );

    expect(responses.map((res) => res.status), JSON.stringify(responses.map((res) => res.body)))
      .toEqual(Array(12).fill(200));
    const stored = await db
      .select()
      .from(issueWatchdogs)
      .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, issueId)));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ status: "active", watchdogAgentId: agentId });
  });

  it("creates an issue and watchdog atomically from the create issue route", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const app = createApp(companyId);

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Create with watchdog",
        watchdog: {
          agentId,
          instructions: "Confirm the final state.",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.watchdog).toMatchObject({
      issueId: res.body.id,
      watchdogAgentId: agentId,
      instructions: "Confirm the final state.",
      status: "active",
    });

    const rows = await db
      .select()
      .from(issueWatchdogs)
      .where(eq(issueWatchdogs.issueId, res.body.id));
    expect(rows).toHaveLength(1);

    const activityRows = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, res.body.id));
    expect(activityRows.map((row) => row.action)).toContain("issue.watchdog_created");
  });

  it("does not create an immediate watchdog review for a newly assigned issue", async () => {
    const companyId = await seedCompany();
    const workerAgentId = await seedAgent(companyId, { name: "Worker" });
    const watchdogAgentId = await seedAgent(companyId, { name: "Watchdog" });
    const app = createApp(companyId);

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Assigned issue with watchdog",
        assigneeAgentId: workerAgentId,
        watchdog: {
          agentId: watchdogAgentId,
          instructions: "Confirm whether the worker got started.",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await waitForAssignmentWakeup(companyId);
    expect(res.body).toMatchObject({
      assigneeAgentId: workerAgentId,
      watchdog: {
        issueId: res.body.id,
        watchdogAgentId,
        status: "active",
      },
    });

    const watchdogReviewIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogReviewIssues).toHaveLength(0);

    const [watchdog] = await db
      .select()
      .from(issueWatchdogs)
      .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, res.body.id)));
    expect(watchdog?.triggerCount).toBe(0);

    const taskWatchdogActivity = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, res.body.id), eq(activityLog.action, "issue.task_watchdog_triggered")));
    expect(taskWatchdogActivity).toHaveLength(0);
  });

  it("enforces persisted watchdog scope for issue mutations and child creation", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Scoped Watchdog" });
    const watchedRootId = await seedIssue(companyId, { title: "Watched root", identifier: "WDOG-ROOT" });
    const watchedChildId = await seedIssue(companyId, { title: "Watched child", parentId: watchedRootId });
    const unrelatedRootId = await seedIssue(companyId, { title: "Unrelated root" });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const watchdogIssueChildId = await seedIssue(companyId, {
      title: "Watchdog issue child",
      parentId: watchdogIssueId,
    });
    const runId = await seedWatchdogRun({
      companyId,
      watchdogAgentId,
      watchedIssueId: watchedRootId,
      watchdogIssueId,
    });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const watchdogIssuePatch = await request(app)
      .patch(`/api/issues/${watchdogIssueId}`)
      .send({ title: "Reusable watchdog issue completed" });
    expect(watchdogIssuePatch.status, JSON.stringify(watchdogIssuePatch.body)).toBe(200);

    const deniedWatchdogDescendantPatch = await request(app)
      .patch(`/api/issues/${watchdogIssueChildId}`)
      .send({ title: "Denied watchdog descendant mutation" });
    expect(deniedWatchdogDescendantPatch.status, JSON.stringify(deniedWatchdogDescendantPatch.body)).toBe(403);
    expect(deniedWatchdogDescendantPatch.body.error).toBe(
      "Task-watchdog runs can only mutate the watched issue subtree.",
    );

    const deniedPatch = await request(app)
      .patch(`/api/issues/${unrelatedRootId}`)
      .send({ title: "Out-of-scope mutation" });
    expect(deniedPatch.status, JSON.stringify(deniedPatch.body)).toBe(403);
    expect(deniedPatch.body.error).toBe("Task-watchdog runs can only mutate the watched issue subtree.");

    const deniedChild = await request(app)
      .post(`/api/issues/${unrelatedRootId}/children`)
      .send({ title: "Denied unrelated child" });
    expect(deniedChild.status, JSON.stringify(deniedChild.body)).toBe(403);
    expect(deniedChild.body.error).toBe("Task-watchdog runs can only mutate the watched issue subtree.");

    const deniedWatchdogIssueChild = await request(app)
      .post(`/api/issues/${watchdogIssueId}/children`)
      .send({ title: "Denied watchdog issue child" });
    expect(deniedWatchdogIssueChild.status, JSON.stringify(deniedWatchdogIssueChild.body)).toBe(403);
    const deniedVisibleProbeIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.title, "Denied watchdog issue child")));
    expect(deniedVisibleProbeIssues).toHaveLength(0);

    const deniedParentCreate = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Denied parent create", parentId: unrelatedRootId });
    expect(deniedParentCreate.status, JSON.stringify(deniedParentCreate.body)).toBe(403);
    expect(deniedParentCreate.body.error).toBe("Task-watchdog runs can only mutate the watched issue subtree.");

    const deniedNestedWatchdog = await request(app)
      .put(`/api/issues/${watchedChildId}/watchdog`)
      .send({ agentId: watchdogAgentId, instructions: "Create a nested watchdog" });
    expect(deniedNestedWatchdog.status, JSON.stringify(deniedNestedWatchdog.body)).toBe(403);
    expect(deniedNestedWatchdog.body.error).toBe("Task-watchdog runs cannot change watchdog configuration.");

    const deniedWatchdogRemoval = await request(app).delete(`/api/issues/${watchedRootId}/watchdog`);
    expect(deniedWatchdogRemoval.status, JSON.stringify(deniedWatchdogRemoval.body)).toBe(403);
    expect(deniedWatchdogRemoval.body.error).toBe("Task-watchdog runs cannot change watchdog configuration.");

    const nestedWatchdogs = await db
      .select({ id: issueWatchdogs.id })
      .from(issueWatchdogs)
      .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, watchedChildId)));
    expect(nestedWatchdogs).toHaveLength(0);

    const allowedChild = await request(app)
      .post(`/api/issues/${watchedChildId}/children`)
      .send({ title: "Allowed watched child" });
    expect(allowedChild.status, JSON.stringify(allowedChild.body)).toBe(201);
    expect(allowedChild.body.parentId).toBe(watchedChildId);
  });

  it("routes watchdog-discovered product bugs outside the watched source tree with evidence links", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Product Bug Watchdog" });
    const watchedRootId = await seedIssue(companyId, {
      title: "Watched root",
      identifier: "PAP-100",
      issueNumber: 100,
    });
    const watchedChildId = await seedIssue(companyId, {
      title: "Watched child",
      identifier: "PAP-101",
      issueNumber: 101,
      parentId: watchedRootId,
    });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      identifier: "PAP-102",
      issueNumber: 102,
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const runId = await seedWatchdogRun({
      companyId,
      watchdogAgentId,
      watchedIssueId: watchedRootId,
      watchdogIssueId,
    });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Fix watchdog source-tree pollution",
        description: "Watchdog found a Paperclip follow-up routing bug.",
        parentId: watchedChildId,
        watchdogDiscovery: {
          kind: "product_bug",
          evidenceMarkdown: "The watchdog would otherwise create this under the watched child.",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      title: "Fix watchdog source-tree pollution",
      parentId: null,
      originKind: "task_watchdog_product_bug",
      originId: watchedRootId,
      originRunId: runId,
    });
    expect(res.body.description).toContain("## Watchdog Discovery");
    expect(res.body.description).toContain("Watched source issue: [PAP-100](/PAP/issues/PAP-100)");
    expect(res.body.description).toContain("Watchdog issue: [PAP-102](/PAP/issues/PAP-102)");
    expect(res.body.referencedIssueIdentifiers).toEqual(expect.arrayContaining(["PAP-100", "PAP-102"]));

    const watchedSourceChildren = await db
      .select({ id: issues.id, title: issues.title })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.parentId, watchedChildId)));
    expect(watchedSourceChildren).toHaveLength(0);

    const [createdActivity] = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, res.body.id)));
    expect(createdActivity?.details).toMatchObject({
      watchdogDiscovery: {
        kind: "product_bug",
        sourceIssueId: watchedRootId,
        watchdogIssueId,
      },
    });
  });

  // WDOG-010. Creating children through the accepted-plan decomposition route
  // passes the same freshness guard as the ordinary create routes and rotates
  // the fingerprint the same way — each new non-terminal child is a material
  // leaf. Undeclared, they lock the run out of its own next mutation, which is
  // this issue's whole defect reached through a route that never joined the
  // ledger.
  it("keeps a watchdog run mutating after it creates children through accepted-plan decomposition", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Decomposing Watchdog" });
    const watchedRootId = await seedIssue(companyId, { title: "Watched root" });
    const watchedChildId = await seedIssue(companyId, {
      title: "Watched child",
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
    });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const acceptedPlanRevisionId = await seedAcceptedPlan(companyId, watchedChildId, watchdogAgentId);
    const runId = await seedWatchdogRun({
      companyId,
      watchdogAgentId,
      watchedIssueId: watchedRootId,
      watchdogIssueId,
    });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const decomposed = await request(app)
      .post(`/api/issues/${watchedChildId}/accepted-plan-decompositions`)
      .send({
        acceptedPlanRevisionId,
        children: [{ title: "Plan step one" }],
      });
    expect(decomposed.status, JSON.stringify(decomposed.body)).toBe(200);
    expect(decomposed.body.newlyCreatedChildIssueIds).toHaveLength(1);

    // The run's own creation rotated the fingerprint. Its summary comment on the
    // watched subtree is the step this issue exists to keep working.
    const comment = await request(app)
      .post(`/api/issues/${watchedRootId}/comments`)
      .send({ body: "Recovery follow-ups created from the accepted plan." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
  });

  // The live variant of the step above. The mandate's headline recovery is
  // restoring a live execution path — reassigning a stalled leaf to an agent
  // that will pick it up — and that is precisely the action which takes the
  // subtree out of `stopped` altogether, so there is no fingerprint left to
  // re-pin to. Rejecting the mandated summary on `state` would lose the audit
  // trail on the one path the mandate cares about most.
  it("lets a watchdog run comment on the watched source issue after its own action restored a live path", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Reviving Watchdog" });
    const workerAgentId = await seedAgent(companyId, { name: "Revived Worker" });
    const watchedRootId = await seedIssue(companyId, { title: "Watched root" });
    // Stalled: a real leaf with nobody on it, which is why the watchdog woke.
    const watchedChildId = await seedIssue(companyId, {
      title: "Stalled leaf",
      parentId: watchedRootId,
      status: "todo",
    });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const runId = await seedWatchdogRun({ companyId, watchdogAgentId, watchedIssueId: watchedRootId, watchdogIssueId });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    // The sanctioned recovery: hand the stalled leaf to an agent that will run
    // it. `issueAssignmentWakeupFires` holds here (assignee set, status not
    // backlog), so the route declares `startsWork` next to the wake it enqueued.
    const revived = await request(app)
      .patch(`/api/issues/${watchedChildId}`)
      .send({ assigneeAgentId: workerAgentId });
    expect(revived.status, JSON.stringify(revived.body)).toBe(200);

    // The route fires that wake in a detached tail, so wait for the real row
    // rather than standing one in. It carries the watchdog run that caused it,
    // which is the provenance the guard reads back — proving the stamp survives
    // the round trip through the actual route, not just through the service.
    const wake = await waitForIssueWake(companyId, watchedChildId);
    expect((wake.payload as Record<string, unknown> | null)?._paperclipWatchdogOriginRunId).toBe(runId);

    // The runner claims that wake and starts a run from it. The run inherits
    // the provenance through `wakeup_request_id`, which is how a live path says
    // whose recovery it is.
    await db.update(agentWakeupRequests)
      .set({ status: "claimed", claimedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wake.id));
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: workerAgentId,
      status: "running",
      invocationSource: "assignment",
      wakeupRequestId: wake.id,
      contextSnapshot: { issueId: watchedChildId },
    });

    const comment = await request(app)
      .post(`/api/issues/${watchedRootId}/comments`)
      .send({ body: "Reassigned the stalled leaf to a live agent." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
  });

  // What the grant above is actually worth is decided here. A watched subtree
  // can be a single leaf, and then the issue the summary goes on is the issue
  // the recovery just restarted: the comment route would wake its owner, and
  // any agent the body mentions. Refusing the comment loses the audit trail on
  // the recovery the mandate cares about most, so the record is kept and the
  // steering is removed — the granted comment fires no wake at all.
  it("records the single-leaf recovery summary without waking the path it restarted", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Reviving Watchdog" });
    const workerAgentId = await seedAgent(companyId, { name: "Revived Worker" });
    const bystanderAgentId = await seedAgent(companyId, { name: "Mentioned Bystander" });
    // The whole watched subtree: one stalled leaf, which is also the watched
    // issue. Watchdog-origin children are not part of it.
    const watchedRootId = await seedIssue(companyId, { title: "Stalled leaf", status: "todo" });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const runId = await seedWatchdogRun({ companyId, watchdogAgentId, watchedIssueId: watchedRootId, watchdogIssueId });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const revived = await request(app)
      .patch(`/api/issues/${watchedRootId}`)
      .send({ assigneeAgentId: workerAgentId });
    expect(revived.status, JSON.stringify(revived.body)).toBe(200);

    const wake = await waitForIssueWake(companyId, watchedRootId);
    expect((wake.payload as Record<string, unknown> | null)?._paperclipWatchdogOriginRunId).toBe(runId);
    await db.update(agentWakeupRequests)
      .set({ status: "claimed", claimedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wake.id));
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: workerAgentId,
      status: "running",
      invocationSource: "assignment",
      wakeupRequestId: wake.id,
      contextSnapshot: { issueId: watchedRootId },
    });

    // The summary lands, mentions and all — the audit trail is the point.
    const summary = await request(app)
      .post(`/api/issues/${watchedRootId}/comments`)
      .send({
        body: `Restarted this leaf and handed it back. cc [@Mentioned Bystander](${buildAgentMentionHref(bystanderAgentId)})`,
      });
    expect(summary.status, JSON.stringify(summary.body)).toBe(201);

    // The run gets one record, not a channel: a second comment is refused, and
    // nothing of it reaches the thread. Which guard says no first is not fixed
    // here — a recovered subtree keeps moving under the run, so the staleness
    // check can reach this request before the spent grant does. That the grant
    // itself is what refuses a second summary is pinned in the service tests.
    const second = await request(app)
      .post(`/api/issues/${watchedRootId}/comments`)
      .send({ body: "And another thing." });
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    const watchdogComments = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(and(eq(issueComments.issueId, watchedRootId), eq(issueComments.createdByRunId, runId)));
    expect(watchdogComments).toHaveLength(1);

    // A board comment on the same issue does wake its assignee, which both
    // proves the wake path is live for this issue and gives the assertion below
    // a row to wait for instead of a timeout to trust.
    const control = await request(createApp(companyId))
      .post(`/api/issues/${watchedRootId}/comments`)
      .send({ body: "Board checking in." });
    expect(control.status, JSON.stringify(control.body)).toBe(201);
    await waitForIssueCommentWake(companyId, control.body.id);

    // Nothing was enqueued off the watchdog's summary: not to the owner it just
    // started, and not to the agent it mentioned.
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakes.filter((row) => (row.payload as Record<string, unknown> | null)?.commentId === summary.body.id))
      .toHaveLength(0);
    expect(wakes.filter((row) => row.agentId === bystanderAgentId)).toHaveLength(0);
  });

  // `POST /comments` is not the only way to write a comment. `PATCH
  // /issues/:id` carries a `comment` field and is a documented surface for
  // exactly this write, and it enters through the mutation gate — which
  // revalidates a plain summary as a state change and refuses it once the run's
  // own recovery has restored the subtree. Same mandate, same comment, so the
  // same grant has to reach it.
  it("records the recovery summary sent through the update route's comment field", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Reviving Watchdog" });
    const workerAgentId = await seedAgent(companyId, { name: "Revived Worker" });
    const bystanderAgentId = await seedAgent(companyId, { name: "Mentioned Bystander" });
    const watchedRootId = await seedIssue(companyId, { title: "Watched root" });
    const watchedChildId = await seedIssue(companyId, {
      title: "Stalled leaf",
      parentId: watchedRootId,
      status: "todo",
    });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const runId = await seedWatchdogRun({ companyId, watchdogAgentId, watchedIssueId: watchedRootId, watchdogIssueId });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const revived = await request(app)
      .patch(`/api/issues/${watchedChildId}`)
      .send({ assigneeAgentId: workerAgentId });
    expect(revived.status, JSON.stringify(revived.body)).toBe(200);

    const wake = await waitForIssueWake(companyId, watchedChildId);
    await db.update(agentWakeupRequests)
      .set({ status: "claimed", claimedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wake.id));
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: workerAgentId,
      status: "running",
      invocationSource: "assignment",
      wakeupRequestId: wake.id,
      contextSnapshot: { issueId: watchedChildId },
    });

    // The summary, through the update route. Before the grant reached this
    // surface the freshness guard saw `intent: "mutate"` and answered 409.
    const summary = await request(app)
      .patch(`/api/issues/${watchedRootId}`)
      .send({
        comment: `Reassigned the stalled leaf. cc [@Mentioned Bystander](${buildAgentMentionHref(bystanderAgentId)})`,
      });
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    const watchdogComments = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(and(eq(issueComments.issueId, watchedRootId), eq(issueComments.createdByRunId, runId)));
    expect(watchdogComments).toHaveLength(1);

    // And it is admitted on the same terms as on the comment route: a record,
    // not a message. The board's control comment on the revived leaf proves the
    // mention path is live for this company and gives the assertion a row to
    // wait for rather than a timeout to trust.
    const control = await request(createApp(companyId))
      .post(`/api/issues/${watchedChildId}/comments`)
      .send({ body: `Board checking in. cc [@Mentioned Bystander](${buildAgentMentionHref(bystanderAgentId)})` });
    expect(control.status, JSON.stringify(control.body)).toBe(201);
    // Wait on the *mention* the control fired, not just on the control's
    // comment wake. The route enqueues the two separately, so waiting for the
    // comment wake can observe the mention path mid-flight and read zero
    // bystander wakes for a reason that has nothing to do with the summary.
    await waitForAgentWake(companyId, bystanderAgentId);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakes.filter((row) => (row.payload as Record<string, unknown> | null)?.commentId === watchdogComments[0]!.id))
      .toHaveLength(0);
    // Nothing reached the agent the summary mentioned; the only wake it has is
    // the control's.
    const bystanderWakes = wakes.filter((row) => row.agentId === bystanderAgentId);
    expect(bystanderWakes).toHaveLength(1);
    expect((bystanderWakes[0]!.payload as Record<string, unknown> | null)?.commentId).toBe(control.body.id);

    // Still one record: the update route spends the same grant the comment
    // route does, not a second one of its own.
    const second = await request(app)
      .patch(`/api/issues/${watchedRootId}`)
      .send({ comment: "And another thing." });
    expect(second.status, JSON.stringify(second.body)).toBe(409);
  });

  // A generated client spells its optional fields out. `onBehalfOfUserId: null`
  // is discarded by the attribution-spoof check (which only fires on a non-null
  // value), and `reopen`/`resume`/`interrupt` gate on `=== true`, so a body
  // carrying them at those values does exactly what a lone `comment` does.
  // Counting keys called that a mutation and cost the run the summary the
  // mandate requires.
  it("records the recovery summary sent with no-op optional fields alongside the comment", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Reviving Watchdog" });
    const workerAgentId = await seedAgent(companyId, { name: "Revived Worker" });
    const watchedRootId = await seedIssue(companyId, { title: "Watched root" });
    const watchedChildId = await seedIssue(companyId, {
      title: "Stalled leaf",
      parentId: watchedRootId,
      status: "todo",
    });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const runId = await seedWatchdogRun({ companyId, watchdogAgentId, watchedIssueId: watchedRootId, watchdogIssueId });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const revived = await request(app)
      .patch(`/api/issues/${watchedChildId}`)
      .send({ assigneeAgentId: workerAgentId });
    expect(revived.status, JSON.stringify(revived.body)).toBe(200);

    const wake = await waitForIssueWake(companyId, watchedChildId);
    await db.update(agentWakeupRequests)
      .set({ status: "claimed", claimedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wake.id));
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: workerAgentId,
      status: "running",
      invocationSource: "assignment",
      wakeupRequestId: wake.id,
      contextSnapshot: { issueId: watchedChildId },
    });

    const summary = await request(app)
      .patch(`/api/issues/${watchedRootId}`)
      .send({
        comment: "Revived the stalled leaf.",
        onBehalfOfUserId: null,
        reopen: false,
        resume: false,
        interrupt: false,
      });
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    expect(await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(and(eq(issueComments.issueId, watchedRootId), eq(issueComments.createdByRunId, runId))))
      .toHaveLength(1);

    // Inert at those values only. `interrupt: true` cancels the live run this
    // recovery just started, so it stays a mutation and takes the strict check.
    const notInert = await request(app)
      .patch(`/api/issues/${watchedRootId}`)
      .send({ comment: "And cancel the run.", interrupt: true });
    expect(notInert.status, JSON.stringify(notInert.body)).toBe(409);
  });

  // The grant is a grant of one *inert* write, and on the update route the
  // request body does not settle whether the write is inert: this route derives
  // fields of its own from the issue's execution policy. A watched root left in
  // `in_review` with an execution state and no policy behind it is the reachable
  // shape — `applyIssueExecutionPolicyTransition` clears the state and moves the
  // issue to `in_progress` under its return assignee, off a body that asked for
  // none of it. Suppressing the wake does not make that inert: the root would
  // change owner while the child this run just revived already has a live one.
  it("refuses a summary whose update route would derive a state change from it", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Reviving Watchdog" });
    const workerAgentId = await seedAgent(companyId, { name: "Revived Worker" });
    const returnAssigneeId = await seedAgent(companyId, { name: "Return Assignee" });
    const watchedRootId = await seedIssue(companyId, { title: "Watched root", assigneeAgentId: workerAgentId });
    const watchedChildId = await seedIssue(companyId, {
      title: "Stalled leaf",
      parentId: watchedRootId,
      status: "todo",
    });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const runId = await seedWatchdogRun({ companyId, watchdogAgentId, watchedIssueId: watchedRootId, watchdogIssueId });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const revived = await request(app)
      .patch(`/api/issues/${watchedChildId}`)
      .send({ assigneeAgentId: workerAgentId });
    expect(revived.status, JSON.stringify(revived.body)).toBe(200);

    const wake = await waitForIssueWake(companyId, watchedChildId);
    await db.update(agentWakeupRequests)
      .set({ status: "claimed", claimedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wake.id));
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: workerAgentId,
      status: "running",
      invocationSource: "assignment",
      wakeupRequestId: wake.id,
      contextSnapshot: { issueId: watchedChildId },
    });

    // The root carries a review state whose policy is gone. Set after the
    // recovery so the fingerprint the run was woken at is the one it is still
    // being judged against.
    await db.update(issues)
      .set({
        status: "in_review",
        executionPolicy: null,
        executionState: {
          status: "pending",
          currentStageId: randomUUID(),
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: workerAgentId },
          returnAssignee: { type: "agent", agentId: returnAssigneeId },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      })
      .where(eq(issues.id, watchedRootId));

    const summary = await request(app)
      .patch(`/api/issues/${watchedRootId}`)
      .send({ comment: "Revived the stalled leaf." });
    expect(summary.status, JSON.stringify(summary.body)).toBe(409);
    expect(summary.body.details?.derivedFields)
      .toEqual(["assigneeAgentId", "assigneeUserId", "executionState", "status"]);

    // Refused whole. The root is where it was, and no comment was written.
    const [root] = await db
      .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId, executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, watchedRootId));
    expect(root?.status).toBe("in_review");
    expect(root?.assigneeAgentId).toBe(workerAgentId);
    expect(root?.executionState).not.toBeNull();
    expect(await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, watchedRootId))).toHaveLength(0);

    // And the refusal did not cost the run its mandate. The grant is spent in
    // the transaction that inserts the comment, and no comment was inserted, so
    // the run still holds the summary it is owed — to write on the comments
    // endpoint, which runs no transition and can derive nothing from it.
    const [runRow] = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    const watchdogContext = (runRow?.contextSnapshot as Record<string, unknown> | null)?.taskWatchdog as
      | Record<string, unknown>
      | undefined;
    expect(watchdogContext?.auditCommentSpentAt).toBeUndefined();
  });

  // The headline recovery lands on a subtree whose root is already terminal —
  // a finished parent with a stalled child under it — and such a parent is
  // usually assigned to the agent that finished it. The comment route runs a
  // second, closed-issue-specific authorization for that shape, and the
  // watchdog scope does not produce any of the access reasons its cross-issue
  // grant recognises. So the summary passed the guard that exists for it and
  // was then refused by a gate that asked whether a plain comment was a state
  // mutation — after the first check had already spent the one grant.
  it("records the recovery summary on a closed watched root assigned to another agent", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Reviving Watchdog" });
    const ownerAgentId = await seedAgent(companyId, { name: "Parent Owner" });
    const workerAgentId = await seedAgent(companyId, { name: "Revived Worker" });
    // Terminal parent, owned by somebody else, with a stalled child under it.
    const watchedRootId = await seedIssue(companyId, {
      title: "Finished parent",
      status: "done",
      assigneeAgentId: ownerAgentId,
    });
    const watchedChildId = await seedIssue(companyId, {
      title: "Stalled leaf",
      parentId: watchedRootId,
      status: "todo",
    });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const runId = await seedWatchdogRun({ companyId, watchdogAgentId, watchedIssueId: watchedRootId, watchdogIssueId });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const revived = await request(app)
      .patch(`/api/issues/${watchedChildId}`)
      .send({ assigneeAgentId: workerAgentId });
    expect(revived.status, JSON.stringify(revived.body)).toBe(200);

    const wake = await waitForIssueWake(companyId, watchedChildId);
    await db.update(agentWakeupRequests)
      .set({ status: "claimed", claimedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wake.id));
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: workerAgentId,
      status: "running",
      invocationSource: "assignment",
      wakeupRequestId: wake.id,
      contextSnapshot: { issueId: watchedChildId },
    });

    const summary = await request(app)
      .post(`/api/issues/${watchedRootId}/comments`)
      .send({ body: "Revived the stalled child of this finished parent." });
    expect(summary.status, JSON.stringify(summary.body)).toBe(201);

    // The terminal parent stays terminal: the summary is a record, so it
    // neither reopens the issue it lands on nor wakes the agent that owns it.
    const [rootAfter] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, watchedRootId));
    expect(rootAfter?.status).toBe("done");
    const control = await request(createApp(companyId))
      .post(`/api/issues/${watchedChildId}/comments`)
      .send({ body: "Board checking in." });
    expect(control.status, JSON.stringify(control.body)).toBe(201);
    await waitForIssueCommentWake(companyId, control.body.id);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakes.filter((row) => (row.payload as Record<string, unknown> | null)?.commentId === summary.body.id))
      .toHaveLength(0);
  });

  // Suppressing the wake is not the whole of inertness. A terminal issue keeps
  // its isolated workspace link, and both write surfaces rebuild and republish
  // that workspace as active before they insert anything — so the exact case
  // the grant exists for, a summary on a terminal watched root whose child the
  // run just revived, ran the workspace lifecycle on the way in. Two outcomes,
  // both wrong: the rebuild fails and the mandated summary is refused 503
  // having written nothing, or it succeeds and a comment-only grant has
  // published an active worktree and armed a cleanup fence.
  it("records the recovery summary without reopening the watched root's archived workspace", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    const watchdogAgentId = await seedAgent(companyId, { name: "Reviving Watchdog" });
    const ownerAgentId = await seedAgent(companyId, { name: "Parent Owner" });
    const workerAgentId = await seedAgent(companyId, { name: "Revived Worker" });
    const watchedRootId = await seedIssue(companyId, {
      title: "Finished parent",
      status: "done",
      projectId,
      assigneeAgentId: ownerAgentId,
    });
    const watchedChildId = await seedIssue(companyId, {
      title: "Stalled leaf",
      parentId: watchedRootId,
      projectId,
      status: "todo",
    });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const workspaceId = await seedArchivedIsolatedWorkspace({
      companyId,
      projectId,
      issueId: watchedRootId,
    });
    const runId = await seedWatchdogRun({ companyId, watchdogAgentId, watchedIssueId: watchedRootId, watchdogIssueId });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    await restoreLivePath({ app, companyId, leafIssueId: watchedChildId, workerAgentId });

    const summary = await request(app)
      .post(`/api/issues/${watchedRootId}/comments`)
      .send({ body: "Revived the stalled child of this finished parent." });
    expect(summary.status, JSON.stringify(summary.body)).toBe(201);
    const watchdogComments = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(and(eq(issueComments.issueId, watchedRootId), eq(issueComments.createdByRunId, runId)));
    expect(watchdogComments).toHaveLength(1);

    // The workspace row is exactly as the reaper left it. `cleanupReason` is the
    // tell for the failed-rebuild branch and `status`/`closedAt` for the
    // published one, so an untouched row rules out both: the reopen was never
    // attempted, not merely unsuccessful.
    const workspaceAfter = await readExecutionWorkspace(workspaceId);
    expect(workspaceAfter?.status).toBe("archived");
    expect(workspaceAfter?.closedAt).not.toBeNull();
    expect(workspaceAfter?.cleanupReason).toBeNull();
  });

  // The same lifecycle sits on the update route, after its own audit-exception
  // check has already decided the request writes no issue fields. "Writes no
  // fields" was never the same statement as "has no effects".
  it("records the update-route recovery summary without reopening the archived workspace", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    const watchdogAgentId = await seedAgent(companyId, { name: "Reviving Watchdog" });
    const ownerAgentId = await seedAgent(companyId, { name: "Parent Owner" });
    const workerAgentId = await seedAgent(companyId, { name: "Revived Worker" });
    const watchedRootId = await seedIssue(companyId, {
      title: "Finished parent",
      status: "done",
      projectId,
      assigneeAgentId: ownerAgentId,
    });
    const watchedChildId = await seedIssue(companyId, {
      title: "Stalled leaf",
      parentId: watchedRootId,
      projectId,
      status: "todo",
    });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const workspaceId = await seedArchivedIsolatedWorkspace({
      companyId,
      projectId,
      issueId: watchedRootId,
    });
    const runId = await seedWatchdogRun({ companyId, watchdogAgentId, watchedIssueId: watchedRootId, watchdogIssueId });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    await restoreLivePath({ app, companyId, leafIssueId: watchedChildId, workerAgentId });

    const summary = await request(app)
      .patch(`/api/issues/${watchedRootId}`)
      .send({ comment: "Revived the stalled child of this finished parent." });
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    const watchdogComments = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(and(eq(issueComments.issueId, watchedRootId), eq(issueComments.createdByRunId, runId)));
    expect(watchdogComments).toHaveLength(1);

    const workspaceAfter = await readExecutionWorkspace(workspaceId);
    expect(workspaceAfter?.status).toBe("archived");
    expect(workspaceAfter?.closedAt).not.toBeNull();
    expect(workspaceAfter?.cleanupReason).toBeNull();
  });

  // The comment insert dedupes on (run, author, body) so a retried request
  // cannot double-post. A watchdog run reaches that path legitimately: it
  // comments once while the subtree is still stopped, and the summary it owes
  // afterwards can repeat that wording. The shortcut returns the older row
  // before `afterInsert` runs, so the request reports success having written no
  // post-recovery record and left the grant unspent — free to be spent on some
  // other body instead.
  it("records the recovery summary even when the run already posted the same text pre-recovery", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Reviving Watchdog" });
    const workerAgentId = await seedAgent(companyId, { name: "Revived Worker" });
    const watchedRootId = await seedIssue(companyId, { title: "Stalled leaf", status: "todo" });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const runId = await seedWatchdogRun({ companyId, watchdogAgentId, watchedIssueId: watchedRootId, watchdogIssueId });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const summaryBody = "Restarted this leaf and handed it back.";
    // Posted while the subtree is still stopped, so it is admitted on the
    // original fingerprint fast path and spends no grant.
    const preRecovery = await request(app)
      .post(`/api/issues/${watchedRootId}/comments`)
      .send({ body: summaryBody });
    expect(preRecovery.status, JSON.stringify(preRecovery.body)).toBe(201);
    expect(await readAuditCommentSpentAt(runId)).toBeNull();

    await restoreLivePath({ app, companyId, leafIssueId: watchedRootId, workerAgentId });

    const summary = await request(app)
      .post(`/api/issues/${watchedRootId}/comments`)
      .send({ body: summaryBody });
    expect(summary.status, JSON.stringify(summary.body)).toBe(201);
    // A distinct row, not the pre-recovery one handed back.
    expect(summary.body.id).not.toBe(preRecovery.body.id);
    const posted = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(and(
        eq(issueComments.issueId, watchedRootId),
        eq(issueComments.createdByRunId, runId),
        eq(issueComments.body, summaryBody),
      ));
    expect(posted).toHaveLength(2);
    // And the grant it was given is now spent, so it cannot be redirected onto
    // a different body.
    expect(await readAuditCommentSpentAt(runId)).not.toBeNull();
    const second = await request(app)
      .post(`/api/issues/${watchedRootId}/comments`)
      .send({ body: "And another thing." });
    expect(second.status, JSON.stringify(second.body)).toBe(409);
  });

  // The update route's audit exception refuses the request whole if the body or
  // the execution-policy transition leaves anything in `updateFields`. The
  // service derives one more field below that check: an issue with no goal of
  // its own is backfilled with the company's fallback goal on *every* update,
  // including one whose patch is empty. So the inert record still moved issue
  // state.
  it("does not derive a fallback goal from the update route's audit summary", async () => {
    const companyId = await seedCompany();
    const defaultGoalId = await seedDefaultCompanyGoal(companyId);
    const watchdogAgentId = await seedAgent(companyId, { name: "Reviving Watchdog" });
    const workerAgentId = await seedAgent(companyId, { name: "Revived Worker" });
    const watchedRootId = await seedIssue(companyId, { title: "Watched root", goalId: null });
    const watchedChildId = await seedIssue(companyId, {
      title: "Stalled leaf",
      parentId: watchedRootId,
      status: "todo",
    });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const runId = await seedWatchdogRun({ companyId, watchdogAgentId, watchedIssueId: watchedRootId, watchdogIssueId });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    await restoreLivePath({ app, companyId, leafIssueId: watchedChildId, workerAgentId });

    const [rootBefore] = await db.select().from(issues).where(eq(issues.id, watchedRootId));
    const summary = await request(app)
      .patch(`/api/issues/${watchedRootId}`)
      .send({ comment: "Reassigned the stalled leaf." });
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    const [rootAfter] = await db.select().from(issues).where(eq(issues.id, watchedRootId));
    expect(rootAfter?.goalId).toBeNull();
    // Measured rather than read off the code: every other column is compared
    // too, so a derived field added to the update path lands here instead of in
    // the next review. `updatedAt` is excluded because the plain comment insert
    // bumps it on its own — recording comment activity is what it is for.
    const columnsChanged = Object.keys(rootBefore ?? {}).filter(
      (key) =>
        key !== "updatedAt" &&
        JSON.stringify((rootBefore as Record<string, unknown>)[key])
          !== JSON.stringify((rootAfter as Record<string, unknown>)[key]),
    );
    expect(columnsChanged).toEqual([]);

    // The derivation is live for this company on an ordinary update — without
    // this control the assertion above would also pass if no fallback goal
    // existed to derive.
    const boardUpdate = await request(createApp(companyId))
      .patch(`/api/issues/${watchedChildId}`)
      .send({ title: "Stalled leaf, renamed" });
    expect(boardUpdate.status, JSON.stringify(boardUpdate.body)).toBe(200);
    const [childAfter] = await db
      .select({ goalId: issues.goalId })
      .from(issues)
      .where(eq(issues.id, watchedChildId));
    expect(childAfter?.goalId).toBe(defaultGoalId);
  });

  // Admission is several validations and one insert short of the write the
  // grant exists for. A request refused in that window wrote no summary, so it
  // must not have spent the one the run is owed — and it cannot, because the
  // statement that spends the grant runs in the insert's own transaction rather
  // than at the door. `presentation` is the reachable instance: the request
  // schema accepts it, and the route rejects it for agents *after* the guard
  // has run.
  it("does not spend the audit grant on a summary the route then refuses", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Reviving Watchdog" });
    const workerAgentId = await seedAgent(companyId, { name: "Revived Worker" });
    const watchedRootId = await seedIssue(companyId, { title: "Stalled leaf", status: "todo" });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const runId = await seedWatchdogRun({ companyId, watchdogAgentId, watchedIssueId: watchedRootId, watchdogIssueId });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const revived = await request(app)
      .patch(`/api/issues/${watchedRootId}`)
      .send({ assigneeAgentId: workerAgentId });
    expect(revived.status, JSON.stringify(revived.body)).toBe(200);

    const wake = await waitForIssueWake(companyId, watchedRootId);
    await db.update(agentWakeupRequests)
      .set({ status: "claimed", claimedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wake.id));
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: workerAgentId,
      status: "running",
      invocationSource: "assignment",
      wakeupRequestId: wake.id,
      contextSnapshot: { issueId: watchedRootId },
    });

    // Admitted by the guard, then refused by the structured-field check that
    // runs after it. Nothing was written.
    const refused = await request(app)
      .post(`/api/issues/${watchedRootId}/comments`)
      .send({ body: "Restarted this leaf and handed it back.", presentation: null });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, watchedRootId))).toHaveLength(0);

    // So the run still has its summary to write.
    const summary = await request(app)
      .post(`/api/issues/${watchedRootId}/comments`)
      .send({ body: "Restarted this leaf and handed it back." });
    expect(summary.status, JSON.stringify(summary.body)).toBe(201);

    // And exactly one: a grant left unspent by the refusal is still one grant.
    const second = await request(app)
      .post(`/api/issues/${watchedRootId}/comments`)
      .send({ body: "And another thing." });
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    const watchdogComments = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(and(eq(issueComments.issueId, watchedRootId), eq(issueComments.createdByRunId, runId)));
    expect(watchdogComments).toHaveLength(1);
  });

  // The negative control for the one above, and the defect it closes: the
  // watchdog really did wake the leaf, but the path running on it now is not
  // the one it started. An issue-level "this run woke that issue" boolean
  // cannot tell the two apart and hands a third party's run to the watchdog as
  // its own doing; provenance carried on the path itself can.
  it("refuses a watchdog run's summary comment when the live path on the leaf it woke is somebody else's", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Reviving Watchdog" });
    const workerAgentId = await seedAgent(companyId, { name: "Revived Worker" });
    const strangerAgentId = await seedAgent(companyId, { name: "Unrelated Worker" });
    const watchedRootId = await seedIssue(companyId, { title: "Watched root" });
    const watchedChildId = await seedIssue(companyId, {
      title: "Stalled leaf",
      parentId: watchedRootId,
      status: "todo",
    });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const runId = await seedWatchdogRun({ companyId, watchdogAgentId, watchedIssueId: watchedRootId, watchdogIssueId });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const revived = await request(app)
      .patch(`/api/issues/${watchedChildId}`)
      .send({ assigneeAgentId: workerAgentId });
    expect(revived.status, JSON.stringify(revived.body)).toBe(200);

    // The watchdog's own wake is consumed without ever producing a run — it
    // failed, was coalesced away, or its run has already finished.
    const wake = await waitForIssueWake(companyId, watchedChildId);
    await db.update(agentWakeupRequests)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wake.id));

    // Somebody else then starts the same leaf while the watchdog run is still
    // going. Nothing the ledger records distinguishes this from the recovery
    // the watchdog performed; the path carries no stamp of this run's.
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: strangerAgentId,
      status: "running",
      invocationSource: "on_demand",
      contextSnapshot: { issueId: watchedChildId },
    });

    const comment = await request(app)
      .post(`/api/issues/${watchedRootId}/comments`)
      .send({ body: "Reassigned the stalled leaf to a live agent." });
    expect(comment.status).toBe(409);
    expect(comment.body?.details?.unattributedLivenessIssueIds).toEqual([watchedChildId]);
  });

  // The negative control for the grant above: liveness this run's ledger does
  // not account for is a competing actor, and the watchdog has no business
  // writing to a subtree somebody else just took over.
  it("still rejects the watchdog's comment when a different actor made the subtree live", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Outraced Watchdog" });
    const workerAgentId = await seedAgent(companyId, { name: "Assigned Worker" });
    const otherAgentId = await seedAgent(companyId, { name: "Third Party" });
    const watchedRootId = await seedIssue(companyId, { title: "Watched root" });
    const watchedChildId = await seedIssue(companyId, {
      title: "Stalled leaf",
      parentId: watchedRootId,
      status: "todo",
    });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const runId = await seedWatchdogRun({ companyId, watchdogAgentId, watchedIssueId: watchedRootId, watchdogIssueId });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const revived = await request(app)
      .patch(`/api/issues/${watchedChildId}`)
      .send({ assigneeAgentId: workerAgentId });
    expect(revived.status, JSON.stringify(revived.body)).toBe(200);

    // Somebody else starts work on the watched root itself. Nothing this run
    // declared explains a run there.
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: otherAgentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: watchedRootId },
    });

    const comment = await request(app)
      .post(`/api/issues/${watchedRootId}/comments`)
      .send({ body: "Reassigned the stalled leaf to a live agent." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(409);
  });

  // WDOG-005. The guard reads the subtree and the route writes it, and between
  // those two statements somebody else can write the same leaf. The mutation
  // ledger cannot see that: it diffs the final state against baseline+declared,
  // so a third party's write that this run's own write then lands back on the
  // expected value leaves a state that matches exactly — their change is erased
  // and no drift is ever recorded, on this revalidation or any later one. The
  // write has to carry the guard's reading with it.
  it("rejects a watched-leaf write whose read state changed underneath it", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Racing Watchdog" });
    const otherAgentId = await seedAgent(companyId, { name: "Third Party" });
    const watchedRootId = await seedIssue(companyId, { title: "Watched root" });
    const watchedChildId = await seedIssue(companyId, { title: "Watched child", parentId: watchedRootId });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const runId = await seedWatchdogRun({
      companyId,
      watchdogAgentId,
      watchedIssueId: watchedRootId,
      watchdogIssueId,
    });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    // The third party starts the leaf's work in the window the guard just
    // finished reading. The watchdog's own write names `todo` — the value the
    // leaf held when the guard read it — so without the read being carried into
    // the write, this lands, reverts them, and matches the ledger exactly.
    raceAfterRevalidate.current = async () => {
      await db.update(issues)
        .set({ status: "in_progress", assigneeAgentId: otherAgentId, updatedAt: new Date() })
        .where(eq(issues.id, watchedChildId));
    };

    const raced = await request(app)
      .patch(`/api/issues/${watchedChildId}`)
      .send({ status: "todo" });
    expect(raced.status, JSON.stringify(raced.body)).toBe(409);

    const [afterRace] = await db
      .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, watchedChildId));
    expect(afterRace?.status).toBe("in_progress");
    expect(afterRace?.assigneeAgentId).toBe(otherAgentId);
  });

  // WDOG-005-PARTIAL-CAS. Blockers are a material leaf field, and the one this
  // route does not merely overwrite but replaces wholesale — a
  // `blockedByIssueIds` patch deletes every relation not named in it. They also
  // live in `issue_relations` rather than on the issue row, so they cannot ride
  // in the update's `WHERE` clause with the columns; leaving them out left the
  // most destructive write on the leaf as the only one with nothing to compare
  // against, including the blockers-only patch, which names no column the
  // precondition covered at all.
  it("rejects a watched-leaf blocker write whose blockers changed underneath it", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Blocker Racing Watchdog" });
    const watchedRootId = await seedIssue(companyId, { title: "Watched root" });
    const watchedChildId = await seedIssue(companyId, { title: "Watched child", parentId: watchedRootId });
    const raceBlockerId = await seedIssue(companyId, { title: "Blocker the board added" });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const runId = await seedWatchdogRun({
      companyId,
      watchdogAgentId,
      watchedIssueId: watchedRootId,
      watchdogIssueId,
    });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    // A board user blocks the leaf in the window the guard just finished
    // reading. The watchdog's patch names the blocker list it saw — empty — so
    // without the read being carried into the write it lands and the blocker is
    // deleted, with a final state that matches the ledger exactly.
    raceAfterRevalidate.current = async () => {
      await db.insert(issueRelations).values({
        companyId,
        issueId: raceBlockerId,
        relatedIssueId: watchedChildId,
        type: "blocks",
      });
    };

    const raced = await request(app)
      .patch(`/api/issues/${watchedChildId}`)
      .send({ blockedByIssueIds: [] });
    expect(raced.status, JSON.stringify(raced.body)).toBe(409);

    const survivingBlockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(and(
        eq(issueRelations.relatedIssueId, watchedChildId),
        eq(issueRelations.type, "blocks"),
      ));
    expect(survivingBlockers.map((row) => row.blockerIssueId)).toEqual([raceBlockerId]);
  });

  // The control: the same blockers write with nobody racing is the run's own
  // sanctioned recovery and must land.
  it("lets a watched-leaf blocker write land when the blockers did not move", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Unraced Blocker Watchdog" });
    const watchedRootId = await seedIssue(companyId, { title: "Watched root" });
    const watchedChildId = await seedIssue(companyId, { title: "Watched child", parentId: watchedRootId });
    const blockerId = await seedIssue(companyId, { title: "Blocker the watchdog adds" });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const runId = await seedWatchdogRun({
      companyId,
      watchdogAgentId,
      watchedIssueId: watchedRootId,
      watchdogIssueId,
    });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const patched = await request(app)
      .patch(`/api/issues/${watchedChildId}`)
      .send({ blockedByIssueIds: [blockerId] });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);

    const blockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(and(
        eq(issueRelations.relatedIssueId, watchedChildId),
        eq(issueRelations.type, "blocks"),
      ));
    expect(blockers.map((row) => row.blockerIssueId)).toEqual([blockerId]);
  });

  // The control for the above: with nobody racing, the very same write is the
  // run's own sanctioned recovery and must land. A precondition that rejected
  // this would lock the watchdog out of the subtree it is there to restore.
  it("lets a watched-leaf write land when nothing moved underneath it", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Unraced Watchdog" });
    const watchedRootId = await seedIssue(companyId, { title: "Watched root" });
    const watchedChildId = await seedIssue(companyId, { title: "Watched child", parentId: watchedRootId });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const runId = await seedWatchdogRun({
      companyId,
      watchdogAgentId,
      watchedIssueId: watchedRootId,
      watchdogIssueId,
    });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const patched = await request(app)
      .patch(`/api/issues/${watchedChildId}`)
      .send({ title: "Watched child, restated" });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.title).toBe("Watched child, restated");
  });

  it("rejects watchdog interaction-resolution attempts outside the persisted watched subtree", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Interaction Watchdog" });
    const watchedRootId = await seedIssue(companyId, { title: "Watched root" });
    const unrelatedRootId = await seedIssue(companyId, { title: "Unrelated root" });
    const watchdogIssueId = await seedIssue(companyId, { title: "Reusable watchdog issue" });
    const runId = await seedWatchdogRun({
      companyId,
      watchdogAgentId,
      watchedIssueId: watchedRootId,
      watchdogIssueId,
    });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const res = await request(app)
      .post(`/api/issues/${unrelatedRootId}/interactions/${randomUUID()}/accept`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Task-watchdog runs can only mutate the watched issue subtree.");
  });

  it("rejects cross-company watched issues and watchdog agents", async () => {
    const companyId = await seedCompany("Allowed company");
    const otherCompanyId = await seedCompany("Other company");
    const issueId = await seedIssue(companyId);
    const otherIssueId = await seedIssue(otherCompanyId);
    const otherAgentId = await seedAgent(otherCompanyId);
    const app = createApp(companyId);

    const foreignIssue = await request(app)
      .put(`/api/issues/${otherIssueId}/watchdog`)
      .send({ agentId: otherAgentId });
    // Uniform 404 so cross-tenant ids are indistinguishable from missing ones.
    expect(foreignIssue.status, JSON.stringify(foreignIssue.body)).toBe(404);
    expect(foreignIssue.body.error).toBe("Issue not found");

    const foreignAgent = await request(app)
      .put(`/api/issues/${issueId}/watchdog`)
      .send({ agentId: otherAgentId });
    expect(foreignAgent.status, JSON.stringify(foreignAgent.body)).toBe(404);
  });

  it.each(["paused", "terminated", "pending_approval"])(
    "rejects %s watchdog agents",
    async (status) => {
      const companyId = await seedCompany();
      const issueId = await seedIssue(companyId);
      const agentId = await seedAgent(companyId, { status });
      const app = createApp(companyId);

      const res = await request(app)
        .put(`/api/issues/${issueId}/watchdog`)
        .send({ agentId });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toBe("Cannot assign watchdog to an agent that is not invokable");
    },
  );
});
