import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
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
  it("commits status and comment together, and an explicit status suppresses the comment reopen", async () => {
    const issue = await seed();
    await request(app()).patch(`/api/issues/${issue.id}`).send({ status: "done" }).expect(200);
    const done = await request(app()).get(`/api/issues/${issue.id}`).expect(200);

    const res = await request(app()).patch(`/api/issues/${issue.id}`).send({
      status: "blocked",
      unblockDescriptor: { owner: "board", action: "retired lane" },
      description: "retired: t1",
      comment: "<!-- quiesce:v1 {\"token\":\"t1\"} -->",
      expected: { revision: done.body.revision, status: "done" },
    }).expect(200);
    expect(res.body.status).toBe("blocked");            // not reopened to todo by the user comment
    const comments = await request(app()).get(`/api/issues/${issue.id}/comments?order=asc`).expect(200);
    expect(comments.body.map((c: any) => c.body)).toEqual(["<!-- quiesce:v1 {\"token\":\"t1\"} -->"]);
    const commentActivity = await db.select().from(activityLog).where(eq(activityLog.action, "issue.comment_added"));
    expect(commentActivity.filter((row) => row.entityId === issue.id)).toHaveLength(1);
  });

  it("bumps revision for a comment-only conditional update", async () => {
    const issue = await seed();
    const res = await request(app()).patch(`/api/issues/${issue.id}`)
      .send({ comment: "only a comment", expected: { revision: issue.revision } }).expect(200);
    expect(res.body.revision).toBeGreaterThan(issue.revision);
  });

  it("a stale second conditional update after the first applied is refused (version fence)", async () => {
    const issue = await seed();
    await request(app()).patch(`/api/issues/${issue.id}`)
      .send({ status: "blocked", unblockDescriptor: { owner: "board", action: "fenced" }, comment: "fence", expected: { revision: issue.revision } }).expect(200);
    await request(app()).patch(`/api/issues/${issue.id}`)
      .send({ status: "todo", description: "late wake", comment: "late", expected: { revision: issue.revision } })
      .expect(409);
    const after = await request(app()).get(`/api/issues/${issue.id}`).expect(200);
    expect(after.body.status).toBe("blocked");
    expect(after.body.description).toBe("brief A");
    const comments = await request(app()).get(`/api/issues/${issue.id}/comments`).expect(200);
    expect(comments.body.map((c: any) => c.body)).not.toContain("late");
  });
  it("returns the committed revision, so the response can fence the next conditional update", async () => {
    const issue = await seed();
    const res = await request(app()).patch(`/api/issues/${issue.id}`)
      .send({ title: "fenced", comment: "with a comment", expected: { revision: issue.revision } }).expect(200);
    const after = await request(app()).get(`/api/issues/${issue.id}`).expect(200);
    expect(res.body.revision).toBe(after.body.revision);
    await request(app()).patch(`/api/issues/${issue.id}`)
      .send({ title: "next", expected: { revision: res.body.revision } }).expect(200);
  });

  it("rolls the issue update back when the conditional comment cannot be inserted", async () => {
    const issue = await seed();
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION paperclip_test_reject_comment()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        IF NEW.body = 'reject me' THEN RAISE EXCEPTION 'comment rejected by test'; END IF;
        RETURN NEW;
      END
      $function$;
      CREATE TRIGGER paperclip_test_reject_comment
      BEFORE INSERT ON issue_comments
      FOR EACH ROW EXECUTE FUNCTION paperclip_test_reject_comment();
    `));
    try {
      await request(app()).patch(`/api/issues/${issue.id}`)
        .send({ title: "must roll back", comment: "reject me", expected: { revision: issue.revision } })
        .expect(500);
    } finally {
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS paperclip_test_reject_comment ON issue_comments;
        DROP FUNCTION IF EXISTS paperclip_test_reject_comment();
      `));
    }
    const after = await request(app()).get(`/api/issues/${issue.id}`).expect(200);
    expect(after.body.title).toBe("cond");
    expect(after.body.revision).toBe(issue.revision);
  });
});
