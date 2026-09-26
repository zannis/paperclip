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
  const agentApp = (agentId: string, companyId: string) => {
    const a = express(); a.use(express.json());
    a.use((req, _res, next) => {
      req.actor = { type: "agent", agentId, companyId, source: "agent_jwt" } as Express.Request["actor"];
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
    return res.body as { id: string; groupedChild: boolean; parentId: string };
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

    it("is refused for an agent actor", async () => {
      const t = await seedTicket();
      const res = await request(agentApp(t.engineerId, t.companyId)).post(`/api/companies/${t.companyId}/issues`)
        .send({ title: "sneaky", status: "todo", parentId: t.ticketId, groupedChild: true });
      expect(res.status).toBe(403);
      const children = await db.select().from(issues).where(eq(issues.parentId, t.ticketId));
      expect(children).toEqual([]);
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
});
