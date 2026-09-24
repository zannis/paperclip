import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("issue revision", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-revision-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterEach(async () => {
    await db.delete(activityLog); await db.delete(issueComments); await db.delete(issues); await db.delete(companies);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  const app = () => {
    const a = express(); a.use(express.json());
    a.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    a.use("/api", issueRoutes(db, {} as any)); a.use(errorHandler); return a;
  };
  const seedCompany = async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Co", issuePrefix: `R${companyId.slice(0, 5).toUpperCase()}` });
    return companyId;
  };

  it("starts at 0 and increases on every PATCH and every comment", async () => {
    const companyId = await seedCompany();
    const created = await request(app()).post(`/api/companies/${companyId}/issues`)
      .send({ title: "rev", allowDuplicate: true }).expect(201);
    expect(created.body.revision).toBe(0);

    const p1 = await request(app()).patch(`/api/issues/${created.body.id}`).send({ title: "rev 2" }).expect(200);
    expect(p1.body.revision).toBeGreaterThan(0);

    await request(app()).post(`/api/issues/${created.body.id}/comments`).send({ body: "hello" }).expect(201);
    const after = await request(app()).get(`/api/issues/${created.body.id}`).expect(200);
    expect(after.body.revision).toBeGreaterThan(p1.body.revision);
  });
});
