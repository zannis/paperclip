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

  it("a void key refuses creation", async () => {
    const companyId = await seedCompany();
    await db.insert(issueCreateIdempotencyKeys).values({ companyId, idempotencyKey: "lane:d", issueId: null, state: "void", retain: true });
    const res = await create(companyId, "lane:d", true).expect(409);
    expect(res.body.details?.code).toBe("idempotency_key_void");
  });
});
