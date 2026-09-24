import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, issueComments, issueCreateIdempotencyKeys, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("idempotency key registry", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-idem-registry-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterEach(async () => {
    await db.delete(activityLog); await db.delete(issueComments);
    await db.delete(issueCreateIdempotencyKeys); await db.delete(issues); await db.delete(companies);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  const app = () => {
    const a = express(); a.use(express.json());
    a.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    a.use("/api", issueRoutes(db, {} as any)); a.use(errorHandler); return a;
  };
  const seedCompany = async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Co", issuePrefix: `I${companyId.slice(0, 5).toUpperCase()}` });
    return companyId;
  };
  const create = (companyId: string, key: string, retain: boolean, title = "lane") =>
    request(app()).post(`/api/companies/${companyId}/issues`)
      .send({ title, idempotencyKey: key, idempotencyRetain: retain, allowDuplicate: true });

  it("a retained key survives the 7-day TTL and still replays its issue", async () => {
    const companyId = await seedCompany();
    const first = await create(companyId, "lane:a", true).expect(201);
    await db.update(issueCreateIdempotencyKeys)
      .set({ createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) })
      .where(eq(issueCreateIdempotencyKeys.idempotencyKey, "lane:a"));
    await create(companyId, "unrelated:trigger-cleanup", false).expect(201);   // runs the lazy TTL delete
    const replay = await create(companyId, "lane:a", true, "different title").expect(200);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.deduplicated).toBe(true);
  });

  it("re-using a non-retained key with retain:true marks it retained without a second row", async () => {
    const companyId = await seedCompany();
    await create(companyId, "lane:b", false).expect(201);
    await create(companyId, "lane:b", true).expect(200);
    const rows = await db.select().from(issueCreateIdempotencyKeys).where(eq(issueCreateIdempotencyKeys.idempotencyKey, "lane:b"));
    expect(rows).toHaveLength(1);
    expect(rows[0].retain).toBe(true);
  });

  it("deleting the issue leaves a tombstone; a later create under the key is 409, never a new issue", async () => {
    const companyId = await seedCompany();
    const first = await create(companyId, "lane:c", true).expect(201);
    await db.delete(issues).where(eq(issues.id, first.body.id));
    const again = await create(companyId, "lane:c", true).expect(409);
    expect(again.body.details?.code).toBe("idempotency_key_deleted");
    const count = await db.execute(sql`select count(*)::int as n from issues where company_id = ${companyId}`);
    expect((count as any).rows?.[0]?.n ?? (count as any)[0]?.n).toBe(0);
  });

  it("deleting the issue under a non-retained key allows a fresh issue on the next create, not a 409", async () => {
    const companyId = await seedCompany();
    const first = await create(companyId, "lane:e", false).expect(201);
    await db.delete(issues).where(eq(issues.id, first.body.id));
    const again = await create(companyId, "lane:e", false).expect(201);
    expect(again.body.id).not.toBe(first.body.id);
    expect(again.body.deduplicated).toBeUndefined();
    const rows = await db.select().from(issueCreateIdempotencyKeys).where(eq(issueCreateIdempotencyKeys.idempotencyKey, "lane:e"));
    expect(rows).toHaveLength(1);
    expect(rows[0].issueId).toBe(again.body.id);
  });

  it("a void key refuses creation", async () => {
    const companyId = await seedCompany();
    await db.insert(issueCreateIdempotencyKeys).values({ companyId, idempotencyKey: "lane:d", issueId: null, state: "void", retain: true });
    const res = await create(companyId, "lane:d", true).expect(409);
    expect(res.body.details?.code).toBe("idempotency_key_void");
  });

  const keyUrl = (companyId: string, key: string) =>
    `/api/companies/${companyId}/issue-idempotency-keys/${encodeURIComponent(key)}`;

  it("lookup reports absent, created, deleted and void without creating anything", async () => {
    const companyId = await seedCompany();
    expect((await request(app()).get(keyUrl(companyId, "lane:e")).expect(200)).body).toEqual({ state: "absent" });
    const made = await create(companyId, "lane:e", true).expect(201);
    const found = await request(app()).get(keyUrl(companyId, "lane:e")).expect(200);
    expect(found.body.state).toBe("created");
    expect(found.body.issue.id).toBe(made.body.id);
    await db.delete(issues).where(eq(issues.id, made.body.id));
    expect((await request(app()).get(keyUrl(companyId, "lane:e")).expect(200)).body).toEqual({ state: "deleted" });
  });

  it("lookup reports absent for a non-retained tombstone, matching what a create under it would do", async () => {
    const companyId = await seedCompany();
    const made = await create(companyId, "lane:i", false).expect(201);
    await db.delete(issues).where(eq(issues.id, made.body.id));
    expect((await request(app()).get(keyUrl(companyId, "lane:i")).expect(200)).body).toEqual({ state: "absent" });
    const again = await create(companyId, "lane:i", false).expect(201);
    expect(again.body.id).not.toBe(made.body.id);
  });

  it("void returns the issue when the key already created one", async () => {
    const companyId = await seedCompany();
    const made = await create(companyId, "lane:f", true).expect(201);
    const res = await request(app()).post(`${keyUrl(companyId, "lane:f")}/void`).expect(200);
    expect(res.body.state).toBe("created");
    expect(res.body.issue.id).toBe(made.body.id);
  });

  it("void on an absent key records void; a later create under it is refused", async () => {
    const companyId = await seedCompany();
    expect((await request(app()).post(`${keyUrl(companyId, "lane:g")}/void`).expect(200)).body).toEqual({ state: "void" });
    await create(companyId, "lane:g", true).expect(409);
    expect((await request(app()).get(keyUrl(companyId, "lane:g")).expect(200)).body).toEqual({ state: "void" });
  });

  it("void and create racing on one key: exactly one wins", async () => {
    const companyId = await seedCompany();
    const [v, c] = await Promise.all([
      request(app()).post(`${keyUrl(companyId, "lane:h")}/void`),
      create(companyId, "lane:h", true),
    ]);
    const created = c.status === 201;
    if (created) {
      expect(v.body.state).toBe("created");
      expect(v.body.issue.id).toBe(c.body.id);
    } else {
      expect(c.status).toBe(409);
      expect(v.body).toEqual({ state: "void" });
    }
  });
});
