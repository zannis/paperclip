import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueCreateIdempotencyKeys,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";

const wakeupSpy = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
      ...actual.heartbeatService(...args),
      wakeup: wakeupSpy,
    }),
  };
});

type Wake = { reason?: string; payload?: Record<string, unknown> };
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("grouped child issues", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-grouped-child-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterEach(async () => {
    // Route side effects (activity, wakes) are fire-and-forget after the response.
    await new Promise((resolve) => setTimeout(resolve, 300));
    wakeupSpy.mockClear();
    await db.delete(activityLog); await db.delete(issueComments); await db.delete(issueCreateIdempotencyKeys);
    await db.delete(heartbeatRuns);
    await db.update(issues).set({ parentId: null });
    await db.delete(issues); await db.delete(agents); await db.delete(companies);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  const mount = (a: express.Express) => {
    a.use("/api", issueRoutes(db, {} as any)); a.use(errorHandler); return a;
  };
  const app = () => {
    const a = express(); a.use(express.json());
    a.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    return mount(a);
  };
  const agentApp = (agentId: string, companyId: string, runId?: string) => {
    const a = express(); a.use(express.json());
    a.use((req, _res, next) => {
      req.actor = { type: "agent", agentId, companyId, source: "agent_jwt", ...(runId ? { runId } : {}) } as Express.Request["actor"];
      next();
    });
    return mount(a);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
  const wakes = () => wakeupSpy.mock.calls.map((c) => {
    const [agentId, wake] = c as unknown as [string, Wake];
    return { agentId, reason: wake.reason, payload: wake.payload };
  });

  const seedTicket = async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Co", issuePrefix: `G${companyId.slice(0, 5).toUpperCase()}` });
    const [engineer, conductor] = await db.insert(agents).values([
      { companyId, name: "Engineer", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
      { companyId, name: "Conductor", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
    ]).returning();
    const ticket = await request(app()).post(`/api/companies/${companyId}/issues`)
      .send({ title: "ticket", status: "todo", allowDuplicate: true }).expect(201);
    await db.update(issues).set({ status: "in_progress", assigneeAgentId: engineer!.id }).where(eq(issues.id, ticket.body.id));
    return { companyId, engineerId: engineer!.id, conductorId: conductor!.id, ticketId: ticket.body.id as string };
  };
  const createChild = async (
    t: Awaited<ReturnType<typeof seedTicket>>,
    extra: Record<string, unknown> = {},
  ) => {
    const res = await request(app()).post(`/api/companies/${t.companyId}/issues`).send({
      title: `child ${randomUUID().slice(0, 6)}`, status: "todo", allowDuplicate: true,
      parentId: t.ticketId, assigneeAgentId: t.conductorId, ...extra,
    }).expect(201);
    return res.body as { id: string; title: string; groupedChild: boolean; parentId: string };
  };
  const quiet = async () => { await settle(); wakeupSpy.mockClear(); };

  describe("the flag", () => {
    it("is persisted at create and read back; omitted means false", async () => {
      const t = await seedTicket();
      const lane = await createChild(t, { groupedChild: true });
      const plain = await createChild(t);
      expect(lane.groupedChild).toBe(true);
      expect(plain.groupedChild).toBe(false);
      expect((await request(app()).get(`/api/issues/${lane.id}`).expect(200)).body.groupedChild).toBe(true);
      const listed = await request(app()).get(`/api/companies/${t.companyId}/issues?parentId=${t.ticketId}`).expect(200);
      expect(Object.fromEntries(listed.body.map((i: any) => [i.id, i.groupedChild])))
        .toEqual({ [lane.id]: true, [plain.id]: false });
    });

    it.each([true, false])("is refused for an agent actor whatever its value (groupedChild: %s)", async (value) => {
      const t = await seedTicket();
      const res = await request(agentApp(t.engineerId, t.companyId)).post(`/api/companies/${t.companyId}/issues`)
        .send({ title: "sneaky", status: "todo", parentId: t.ticketId, groupedChild: value });
      expect(res.status).toBe(403);
      const children = await db.select().from(issues).where(eq(issues.parentId, t.ticketId));
      expect(children).toEqual([]);
    });

    it("an agent create that omits the flag still succeeds", async () => {
      const t = await seedTicket();
      const res = await request(agentApp(t.engineerId, t.companyId)).post(`/api/companies/${t.companyId}/issues`)
        .send({ title: "plain", status: "todo", parentId: t.ticketId });
      expect(res.status).toBe(201);
      expect(res.body.groupedChild).toBe(false);
    });

    it.each([true, false])("cannot be changed by PATCH (groupedChild: %s is a 400)", async (value) => {
      const t = await seedTicket();
      const lane = await createChild(t, { groupedChild: true });
      const plain = await createChild(t);
      await request(app()).patch(`/api/issues/${lane.id}`).send({ groupedChild: value }).expect(400);
      await request(app()).patch(`/api/issues/${plain.id}`).send({ groupedChild: value }).expect(400);
      expect((await request(app()).get(`/api/issues/${lane.id}`).expect(200)).body.groupedChild).toBe(true);
      expect((await request(app()).get(`/api/issues/${plain.id}`).expect(200)).body.groupedChild).toBe(false);
    });

    it("cannot be written through the issue service at all, changed or not", async () => {
      const t = await seedTicket();
      const lane = await createChild(t, { groupedChild: true });
      const plain = await createChild(t);
      const svc = issueService(db);
      await expect(svc.update(lane.id, { groupedChild: false })).rejects.toThrow("groupedChild is fixed at creation");
      await expect(svc.update(plain.id, { groupedChild: true })).rejects.toThrow("groupedChild is fixed at creation");
      await expect(svc.update(lane.id, { groupedChild: true, title: "same flag" }))
        .rejects.toThrow("groupedChild is fixed at creation");
      await expect(svc.update(plain.id, { groupedChild: false, title: "same flag" }))
        .rejects.toThrow("groupedChild is fixed at creation");
      const rows = Object.fromEntries((await db.select().from(issues).where(eq(issues.companyId, t.companyId)))
        .map((row) => [row.id, row]));
      expect(rows[lane.id]).toMatchObject({ groupedChild: true, title: lane.title });
      expect(rows[plain.id]).toMatchObject({ groupedChild: false, title: plain.title });
    });

    it("is refused on the child-create helper route", async () => {
      const t = await seedTicket();
      await request(app()).post(`/api/issues/${t.ticketId}/children`)
        .send({ title: "helper", status: "todo", groupedChild: true }).expect(400);
    });

    it("survives an idempotent replay, which returns the original parent and flag", async () => {
      const t = await seedTicket();
      const key = `lane:${randomUUID()}`;
      const first = await createChild(t, { groupedChild: true, idempotencyKey: key, idempotencyRetain: true });
      const replay = await request(app()).post(`/api/companies/${t.companyId}/issues`).send({
        title: "replayed", status: "todo", allowDuplicate: true, parentId: t.ticketId,
        assigneeAgentId: t.conductorId, groupedChild: true, idempotencyKey: key, idempotencyRetain: true,
      }).expect(200);
      expect(replay.body.id).toBe(first.id);
      expect(replay.body.parentId).toBe(t.ticketId);
      expect(replay.body.groupedChild).toBe(true);
    });
  });

  describe("child to parent", () => {
    it.each(["done", "cancelled"] as const)(
      "a grouped child moving to %s does not wake the parent's assignee, even with every sibling finished",
      async (status) => {
        const t = await seedTicket();
        const finished = await createChild(t);
        await request(app()).patch(`/api/issues/${finished.id}`).send({ status: "done" }).expect(200);
        const lane = await createChild(t, { groupedChild: true });
        await quiet();
        await request(app()).patch(`/api/issues/${lane.id}`).send({ status }).expect(200);
        await settle();
        expect(wakes().filter((w) => w.agentId === t.engineerId)).toEqual([]);
        expect(wakes().filter((w) => w.reason === "issue_children_completed")).toEqual([]);
      },
    );

    it.each(["done", "cancelled"] as const)(
      "an ordinary child moving to %s still wakes the parent's assignee with issue_children_completed",
      async (status) => {
        const t = await seedTicket();
        const plain = await createChild(t);
        await quiet();
        await request(app()).patch(`/api/issues/${plain.id}`).send({ status }).expect(200);
        await vi.waitFor(() => expect(wakes().filter((w) => w.reason === "issue_children_completed")).toHaveLength(1));
        const [wake] = wakes().filter((w) => w.reason === "issue_children_completed");
        expect(wake!.agentId).toBe(t.engineerId);
        expect(wake!.payload?.completedChildIssueId).toBe(plain.id);
      },
    );

    it("an open grouped sibling neither holds back nor joins the parent's children-completed wake", async () => {
      const t = await seedTicket();
      const lane = await createChild(t, { groupedChild: true });
      const plain = await createChild(t);
      await quiet();
      await request(app()).patch(`/api/issues/${plain.id}`).send({ status: "done" }).expect(200);
      await vi.waitFor(() => expect(wakes().filter((w) => w.reason === "issue_children_completed")).toHaveLength(1));
      const [wake] = wakes().filter((w) => w.reason === "issue_children_completed");
      expect(wake!.payload?.childIssueIds).toEqual([plain.id]);
      expect(JSON.stringify(wake!.payload)).not.toContain(lane.id);
    });

    it.each(["blocked", "cancelled"] as const)(
      "a grouped child moving to %s posts no stop relay on a low-trust parent; an ordinary one does",
      async (status) => {
        const t = await seedTicket();
        const lane = await createChild(t, { groupedChild: true });
        const plain = await createChild(t);
        await db.update(issues).set({ executionPolicy: { trustPreset: "low_trust_review" } })
          .where(eq(issues.parentId, t.ticketId));
        await quiet();
        const body = (s: string) => ({
          status: s,
          ...(s === "blocked" ? { unblockDescriptor: { owner: "board", action: "lane parked" } } : {}),
        });
        await request(app()).patch(`/api/issues/${lane.id}`).send(body(status)).expect(200);
        await settle();
        const relaysAfterLane = await db.select().from(issueComments)
          .where(and(eq(issueComments.issueId, t.ticketId), eq(issueComments.authorType, "system")));
        expect(relaysAfterLane).toEqual([]);
        expect(wakes().filter((w) => w.agentId === t.engineerId)).toEqual([]);

        await request(app()).patch(`/api/issues/${plain.id}`).send(body(status)).expect(200);
        const relaysAfterPlain = await db.select().from(issueComments)
          .where(and(eq(issueComments.issueId, t.ticketId), eq(issueComments.authorType, "system")));
        expect(relaysAfterPlain).toHaveLength(1);
        expect(relaysAfterPlain[0]!.body).toContain(`transitioned to \`${status}\``);
      },
    );
  });

  describe("explicit blocker edges", () => {
    const blockBy = (issueId: string, blockerId: string) =>
      request(app()).patch(`/api/issues/${issueId}`).send({
        status: "blocked", blockedByIssueIds: [blockerId], unblockDescriptor: { owner: "board", action: "wait on the blocker" },
      }).expect(200);
    const blockersResolved = () => wakes().filter((w) => w.reason === "issue_blockers_resolved");
    const reviewBy = async (issueId: string, reviewerId: string) => {
      const stageId = randomUUID();
      await db.update(issues).set({
        status: "in_review",
        assigneeAgentId: reviewerId,
        executionPolicy: {
          mode: "normal", commentRequired: true,
          stages: [{ id: stageId, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "agent", agentId: reviewerId }] }],
        },
        executionState: {
          status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerId }, returnAssignee: { type: "agent", agentId: reviewerId },
          completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
        },
      }).where(eq(issues.id, issueId));
    };

    it.each([
      [true, 0],
      [false, 1],
    ] as const)("a child (grouped: %s) blocking its own parent: PATCH to done wakes the parent %i time(s)", async (grouped, count) => {
      const t = await seedTicket();
      const child = await createChild(t, grouped ? { groupedChild: true } : {});
      await createChild(t); // an open sibling keeps issue_children_completed out of the picture
      await blockBy(t.ticketId, child.id);
      await quiet();
      await request(app()).patch(`/api/issues/${child.id}`).send({ status: "done" }).expect(200);
      if (count > 0) await vi.waitFor(() => expect(blockersResolved()).toHaveLength(count));
      await settle();
      expect(blockersResolved().filter((w) => w.agentId === t.engineerId)).toHaveLength(count);
    });

    it.each([
      [true, 0],
      [false, 1],
    ] as const)("a child (grouped: %s) blocking its own parent: a review-approval comment wakes the parent %i time(s)", async (grouped, count) => {
      const t = await seedTicket();
      const child = await createChild(t, grouped ? { groupedChild: true } : {});
      await createChild(t); // an open sibling keeps issue_children_completed out of the picture
      await blockBy(t.ticketId, child.id);
      await reviewBy(child.id, t.conductorId);
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId, companyId: t.companyId, agentId: t.conductorId, invocationSource: "assignment",
        triggerDetail: "system", status: "running", contextSnapshot: { issueId: child.id, wakeReason: "issue_assigned" },
      });
      await quiet();
      await request(agentApp(t.conductorId, t.companyId, runId)).post(`/api/issues/${child.id}/comments`)
        .send({ body: "## Review: APPROVED\n\nLooks good." }).expect((r) => expect(r.status, JSON.stringify(r.body)).toBe(201));
      expect((await request(app()).get(`/api/issues/${child.id}`).expect(200)).body.status).toBe("done");
      if (count > 0) await vi.waitFor(() => expect(blockersResolved()).toHaveLength(count));
      await settle();
      expect(blockersResolved().filter((w) => w.agentId === t.engineerId)).toHaveLength(count);
    });

    it("a grouped child blocking an unrelated issue still wakes that issue", async () => {
      const t = await seedTicket();
      const lane = await createChild(t, { groupedChild: true });
      const other = await request(app()).post(`/api/companies/${t.companyId}/issues`)
        .send({ title: "unrelated", status: "todo", allowDuplicate: true, assigneeAgentId: t.engineerId }).expect(201);
      await blockBy(other.body.id, lane.id);
      await quiet();
      await request(app()).patch(`/api/issues/${lane.id}`).send({ status: "done" }).expect(200);
      await vi.waitFor(() => expect(blockersResolved()).toHaveLength(1));
      expect(blockersResolved()[0]!.payload?.issueId).toBe(other.body.id);
    });

    it("an open grouped child does not hold its parent; an open ordinary child does", async () => {
      const t = await seedTicket();
      const lane = await createChild(t, { groupedChild: true });
      const plain = await createChild(t);
      const svc = issueService(db);
      await blockBy(t.ticketId, lane.id);
      expect((await svc.listDependencyReadiness(t.companyId, [t.ticketId])).get(t.ticketId))
        .toMatchObject({ isDependencyReady: true, blockerIssueIds: [], unresolvedBlockerIssueIds: [] });
      await request(app()).patch(`/api/issues/${t.ticketId}`).send({ status: "in_progress" }).expect(200);
      await request(app()).patch(`/api/issues/${t.ticketId}`)
        .send({ status: "in_progress", blockedByIssueIds: [lane.id] }).expect(200);

      await blockBy(t.ticketId, plain.id);
      expect((await svc.listDependencyReadiness(t.companyId, [t.ticketId])).get(t.ticketId))
        .toMatchObject({ isDependencyReady: false, unresolvedBlockerIssueIds: [plain.id] });
      await request(app()).patch(`/api/issues/${t.ticketId}`).send({ status: "in_progress" }).expect(422);
    });
  });

  describe("parent to child", () => {
    it.each(["done", "cancelled", "in_review", "blocked"] as const)(
      "the parent moving to %s leaves a grouped child's status, assignee and revision alone",
      async (status) => {
        const t = await seedTicket();
        const lane = await createChild(t, { groupedChild: true });
        const before = (await request(app()).get(`/api/issues/${lane.id}`).expect(200)).body;
        await quiet();
        await request(app()).patch(`/api/issues/${t.ticketId}`).send({
          status,
          ...(status === "blocked" ? { unblockDescriptor: { owner: "board", action: "ticket parked" } } : {}),
        }).expect(200);
        await settle();
        const after = (await request(app()).get(`/api/issues/${lane.id}`).expect(200)).body;
        expect(after.status).toBe("todo");
        expect(after.assigneeAgentId).toBe(t.conductorId);
        expect(after.revision).toBe(before.revision);
        expect(wakes().filter((w) => w.agentId === t.conductorId)).toEqual([]);
      },
    );

    it("a grouped child reopens by conditional PATCH after its parent is done (the lane wake)", async () => {
      const t = await seedTicket();
      const lane = await createChild(t, { groupedChild: true });
      await request(app()).patch(`/api/issues/${lane.id}`).send({ status: "done" }).expect(200);
      await request(app()).patch(`/api/issues/${t.ticketId}`).send({ status: "done" }).expect(200);
      const done = (await request(app()).get(`/api/issues/${lane.id}`).expect(200)).body;
      await quiet();
      await request(app()).patch(`/api/issues/${lane.id}`).send({
        status: "todo", description: "brief 2", comment: "<!-- delivery:v1 {\"token\":\"w2\"} -->",
        expected: { revision: done.revision, status: "done" },
      }).expect(200);
      await vi.waitFor(() => expect(wakes().filter((w) => w.agentId === t.conductorId)).toHaveLength(1));
      await settle();
      expect(wakes().filter((w) => w.agentId === t.conductorId)).toHaveLength(1);
      expect(wakes().filter((w) => w.agentId === t.engineerId)).toEqual([]);
    });

    it("the parent cannot be deleted while a grouped child references it; the child is untouched", async () => {
      const t = await seedTicket();
      const lane = await createChild(t, { groupedChild: true });
      await request(app()).delete(`/api/issues/${t.ticketId}`).expect(409);
      const after = (await request(app()).get(`/api/issues/${lane.id}`).expect(200)).body;
      expect(after.parentId).toBe(t.ticketId);
      expect(after.status).toBe("todo");
    });
  });

  describe("pins flow depends on", () => {
    it("parentId is mutable by PATCH, and a grouped child keeps its flag when re-parented", async () => {
      const t = await seedTicket();
      const other = await request(app()).post(`/api/companies/${t.companyId}/issues`)
        .send({ title: "other ticket", status: "todo", allowDuplicate: true }).expect(201);
      const lane = await createChild(t, { groupedChild: true });
      const orphan = await request(app()).post(`/api/companies/${t.companyId}/issues`)
        .send({ title: "seeded lane", status: "todo", allowDuplicate: true, assigneeAgentId: t.conductorId }).expect(201);
      const moved = await request(app()).patch(`/api/issues/${lane.id}`).send({ parentId: other.body.id }).expect(200);
      expect(moved.body.parentId).toBe(other.body.id);
      expect(moved.body.groupedChild).toBe(true);
      const adopted = await request(app()).patch(`/api/issues/${orphan.body.id}`).send({ parentId: t.ticketId }).expect(200);
      expect(adopted.body.parentId).toBe(t.ticketId);
      expect(adopted.body.groupedChild).toBe(false);
    });

    it.each(["done", "blocked"] as const)(
      "comment + todo in one conditional PATCH from %s wakes the assignee exactly once",
      async (from) => {
        const t = await seedTicket();
        const lane = await createChild(t, { groupedChild: true });
        await request(app()).patch(`/api/issues/${lane.id}`).send({
          status: from,
          ...(from === "blocked" ? { unblockDescriptor: { owner: "board", action: "lane parked" } } : {}),
        }).expect(200);
        const parked = (await request(app()).get(`/api/issues/${lane.id}`).expect(200)).body;
        await quiet();
        await request(app()).patch(`/api/issues/${lane.id}`).send({
          status: "todo", description: "brief 2", comment: "<!-- delivery:v1 {\"token\":\"w\"} -->",
          expected: { revision: parked.revision, status: from },
        }).expect(200);
        await vi.waitFor(() => expect(wakes().filter((w) => w.agentId === t.conductorId)).toHaveLength(1));
        await settle();
        expect(wakes()).toHaveLength(1);
        expect(wakes()[0]!.payload?.issueId).toBe(lane.id);
      },
    );
  });

  describe("parent-side operations skip grouped children", () => {
    const post = (t: Awaited<ReturnType<typeof seedTicket>>, body: Record<string, unknown>) =>
      request(app()).post(`/api/companies/${t.companyId}/issues`)
        .send({ status: "todo", parentId: t.ticketId, ...body }).expect((res) => {
          if (res.status !== 200 && res.status !== 201) throw new Error(`unexpected ${res.status}`);
        });

    it("recent-title deduplication never crosses the grouped flag", async () => {
      const t = await seedTicket();
      const lane = (await post(t, { title: "Review", groupedChild: true })).body;
      const plain = (await post(t, { title: "Review" })).body;
      expect(plain.id).not.toBe(lane.id);
      expect(plain.groupedChild).toBe(false);
      expect((await post(t, { title: "review " })).body.id).toBe(plain.id);
      expect((await post(t, { title: "Review", groupedChild: true })).body.id).toBe(lane.id);
      const otherLane = (await post(t, { title: "Build", groupedChild: false })).body;
      const buildLane = (await post(t, { title: "Build", groupedChild: true })).body;
      expect(buildLane.id).not.toBe(otherLane.id);
      expect(buildLane.groupedChild).toBe(true);
    });

    it("grouped children do not count toward the child-create helper's cap", async () => {
      const t = await seedTicket();
      const svc = issueService(db);
      await db.insert(issues).values(Array.from({ length: 25 }, (_, index) => ({
        companyId: t.companyId, parentId: t.ticketId, groupedChild: true, title: `lane ${index}`, status: "todo" as const,
      })));
      const { issue } = await svc.createChild(t.ticketId, { title: "ordinary", status: "todo", allowDuplicate: true } as never);
      expect(issue.parentId).toBe(t.ticketId);
      await db.insert(issues).values(Array.from({ length: 24 }, (_, index) => ({
        companyId: t.companyId, parentId: t.ticketId, title: `plain ${index}`, status: "todo" as const,
      })));
      await expect(svc.createChild(t.ticketId, { title: "one too many", status: "todo", allowDuplicate: true } as never))
        .rejects.toThrow("maximum 25 child issues");
    });

    it("subtree diagnostics stop at a grouped child unless it is the root", async () => {
      const t = await seedTicket();
      const lane = await createChild(t, { groupedChild: true });
      const plain = await createChild(t);
      const laneChild = (await request(app()).post(`/api/companies/${t.companyId}/issues`).send({
        title: "lane child", status: "todo", allowDuplicate: true, parentId: lane.id,
      }).expect(201)).body;
      const svc = issueService(db);
      const fromTicket = await svc.getSubtreeDiagnostics(t.ticketId);
      expect(fromTicket.nodes.map((node) => node.id).sort()).toEqual([t.ticketId, plain.id].sort());
      const fromLane = await svc.getSubtreeDiagnostics(lane.id);
      expect(fromLane.nodes.map((node) => node.id).sort()).toEqual([lane.id, laneChild.id].sort());
    });

    it("watchdog follow-up serialization never blocks on a grouped child", async () => {
      const t = await seedTicket();
      const seedWatchdogParent = async () => {
        const [row] = await db.insert(issues).values({
          companyId: t.companyId, title: `watchdog ${randomUUID().slice(0, 6)}`, status: "in_progress",
          originKind: "task_watchdog", originId: randomUUID(),
        }).returning();
        return row!.id;
      };
      const blockersOf = async (issueId: string) =>
        (await issueService(db).getRelationSummaries(issueId)).blockedBy.map((relation) => relation.id);

      const groupedParent = await seedWatchdogParent();
      await request(app()).post(`/api/companies/${t.companyId}/issues`).send({
        title: "lane", status: "todo", allowDuplicate: true, parentId: groupedParent, groupedChild: true,
      }).expect(201);
      const followUp = (await request(app()).post(`/api/issues/${groupedParent}/children`)
        .send({ title: "follow-up", status: "todo" }).expect(201)).body;
      expect(await blockersOf(groupedParent)).toEqual([followUp.id]);

      const ordinaryParent = await seedWatchdogParent();
      const existing = (await request(app()).post(`/api/companies/${t.companyId}/issues`).send({
        title: "existing", status: "todo", allowDuplicate: true, parentId: ordinaryParent,
      }).expect(201)).body;
      await request(app()).post(`/api/issues/${ordinaryParent}/children`)
        .send({ title: "follow-up", status: "todo" }).expect(201);
      expect(await blockersOf(ordinaryParent)).toEqual([existing.id]);
    });
  });
});
