import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("conditional issue update", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-conditional-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterEach(async () => {
    await db.delete(activityLog); await db.delete(issueComments); await db.delete(heartbeatRuns);
    await db.delete(issues); await db.delete(agents); await db.delete(companies);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  const app = () => {
    const a = express(); a.use(express.json());
    a.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    a.use("/api", issueRoutes(db, {} as any)); a.use(errorHandler); return a;
  };
  const seed = async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Co", issuePrefix: `C${companyId.slice(0, 5).toUpperCase()}` });
    const created = await request(app()).post(`/api/companies/${companyId}/issues`)
      .send({ title: "cond", description: "brief A", status: "todo", allowDuplicate: true }).expect(201);
    return created.body as { id: string; revision: number; status: string };
  };

  it("applies when every stated precondition holds", async () => {
    const issue = await seed();
    const res = await request(app()).patch(`/api/issues/${issue.id}`).send({
      title: "cond 2",
      expected: { revision: issue.revision, status: "todo", assigneeAgentId: null, descriptionSha256: sha("brief A") },
    }).expect(200);
    expect(res.body.title).toBe("cond 2");
  });

  it.each([
    ["revision", { revision: 999 }],
    ["status", { status: "done" }],
    ["assigneeAgentId", { assigneeAgentId: randomUUID() }],
    ["descriptionSha256", { descriptionSha256: sha("brief B") }],
  ])("refuses with 409 and changes nothing when %s differs", async (_name, expected) => {
    const issue = await seed();
    const res = await request(app()).patch(`/api/issues/${issue.id}`)
      .send({ title: "must not apply", comment: "must not post", expected }).expect(409);
    expect(res.body.details?.code).toBe("issue_precondition_failed");
    expect(res.body.details?.current?.revision).toBe(issue.revision);
    const after = await request(app()).get(`/api/issues/${issue.id}`).expect(200);
    expect(after.body.title).toBe("cond");
    expect(after.body.revision).toBe(issue.revision);
    const comments = await request(app()).get(`/api/issues/${issue.id}/comments`).expect(200);
    expect(comments.body).toEqual([]);
  });

  it("treats an omitted field as unchecked and null assignee as 'must be unassigned'", async () => {
    const issue = await seed();
    await request(app()).patch(`/api/issues/${issue.id}`)
      .send({ title: "x", expected: { assigneeAgentId: null } }).expect(200);
    await request(app()).patch(`/api/issues/${issue.id}`)
      .send({ title: "y", expected: {} }).expect(200);
  });

  it("hashes a null description as the empty string", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Co", issuePrefix: `N${companyId.slice(0, 5).toUpperCase()}` });
    const created = await request(app()).post(`/api/companies/${companyId}/issues`)
      .send({ title: "nodesc", allowDuplicate: true }).expect(201);
    await request(app()).patch(`/api/issues/${created.body.id}`)
      .send({ title: "z", expected: { descriptionSha256: sha("") } }).expect(200);
  });

  it("refuses a stale-precondition terminalization before any side effect, leaving an assigned issue untouched", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Co", issuePrefix: `T${companyId.slice(0, 5).toUpperCase()}` });
    const [agent] = await db.insert(agents).values({
      companyId, name: "Agent", role: "engineer", status: "active",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {},
    }).returning();
    const created = await request(app()).post(`/api/companies/${companyId}/issues`)
      .send({ title: "term", allowDuplicate: true }).expect(201);
    await db.update(issues)
      .set({ status: "in_progress", assigneeAgentId: agent!.id })
      .where(eq(issues.id, created.body.id));
    const before = await request(app()).get(`/api/issues/${created.body.id}`).expect(200);
    const activityBefore = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));

    const res = await request(app()).patch(`/api/issues/${created.body.id}`)
      .send({ status: "done", expected: { revision: before.body.revision + 1000 } }).expect(409);
    expect(res.body.details?.code).toBe("issue_precondition_failed");

    const after = await request(app()).get(`/api/issues/${created.body.id}`).expect(200);
    expect(after.body.status).toBe("in_progress");
    expect(after.body.revision).toBe(before.body.revision);
    const comments = await request(app()).get(`/api/issues/${created.body.id}/comments`).expect(200);
    expect(comments.body).toEqual([]);
    const activityAfter = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(activityAfter.length).toBe(activityBefore.length);
  });

  it("refuses a stale-precondition interrupt-with-comment before any side effect, leaving the active run and comments untouched", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Co", issuePrefix: `I${companyId.slice(0, 5).toUpperCase()}` });
    const [agent] = await db.insert(agents).values({
      companyId, name: "Agent", role: "engineer", status: "active",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {},
    }).returning();
    const created = await request(app()).post(`/api/companies/${companyId}/issues`)
      .send({ title: "interrupt", allowDuplicate: true }).expect(201);
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent!.id, status: "running",
    }).returning();
    await db.update(issues)
      .set({ status: "in_progress", assigneeAgentId: agent!.id, executionRunId: run!.id })
      .where(eq(issues.id, created.body.id));
    const before = await request(app()).get(`/api/issues/${created.body.id}`).expect(200);

    const res = await request(app()).patch(`/api/issues/${created.body.id}`)
      .send({ comment: "must not post", interrupt: true, expected: { revision: before.body.revision + 1000 } })
      .expect(409);
    expect(res.body.details?.code).toBe("issue_precondition_failed");

    const comments = await request(app()).get(`/api/issues/${created.body.id}/comments`).expect(200);
    expect(comments.body).toEqual([]);
    const [runAfter] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    expect(runAfter?.status).toBe("running");
    const cancelledActivity = await db.select().from(activityLog)
      .where(eq(activityLog.action, "heartbeat.cancelled"));
    expect(cancelledActivity.filter((row) => row.entityId === run!.id)).toEqual([]);
  });
});
