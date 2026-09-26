import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  companies,
  createDb,
  issueTreeHoldMembers,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
const actor = { actorType: "user" as const, actorId: "board-user", userId: "board-user" };

d("tree control and grouped children", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-grouped-tree-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterEach(async () => {
    await db.delete(activityLog); await db.delete(issueTreeHoldMembers); await db.delete(issueTreeHolds);
    await db.delete(agentWakeupRequests);
    await db.update(issues).set({ parentId: null });
    await db.delete(issues); await db.delete(companies);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  const seed = async () => {
    const companyId = randomUUID();
    const ticketId = randomUUID();
    const laneId = randomUUID();
    const plainId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Co", issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      { id: ticketId, companyId, title: "ticket", status: "in_progress", priority: "medium" },
      { id: laneId, companyId, parentId: ticketId, groupedChild: true, title: "lane", status: "todo", priority: "high" },
      { id: plainId, companyId, parentId: ticketId, title: "plain", status: "todo", priority: "medium" },
    ]);
    return { companyId, ticketId, laneId, plainId };
  };

  it("a subtree cancel on the parent skips the grouped child entirely", async () => {
    const s = await seed();
    const svc = issueTreeControlService(db);
    const cancel = await svc.createHold(s.companyId, s.ticketId, { mode: "cancel", reason: "reversal", actor });
    expect(cancel.preview.issues.map((i) => i.id).sort()).toEqual([s.ticketId, s.plainId].sort());
    await svc.cancelIssueStatusesForHold(s.companyId, s.ticketId, cancel.hold.id);
    const rows = await db.select({ id: issues.id, status: issues.status }).from(issues)
      .where(inArray(issues.id, [s.laneId, s.plainId]));
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      [s.laneId]: "todo",
      [s.plainId]: "cancelled",
    });
  });

  it("a pause hold on the parent gates the ordinary child but not the grouped one", async () => {
    const s = await seed();
    const svc = issueTreeControlService(db);
    await svc.createHold(s.companyId, s.ticketId, { mode: "pause", reason: "operator pause", actor });
    expect(await svc.getActivePauseHoldGate(s.companyId, s.plainId)).not.toBeNull();
    expect(await svc.getActivePauseHoldGate(s.companyId, s.laneId)).toBeNull();
  });

  it("a pause hold rooted at the grouped child itself still gates it", async () => {
    const s = await seed();
    const svc = issueTreeControlService(db);
    await svc.createHold(s.companyId, s.laneId, { mode: "pause", reason: "lane pause", actor });
    expect((await svc.getActivePauseHoldGate(s.companyId, s.laneId))?.rootIssueId).toBe(s.laneId);
  });

  it("an ordinary issue under the grouped child sits outside a ticket-rooted hold, unlike an ordinary grandchild", async () => {
    const s = await seed();
    const laneGrandchildId = randomUUID();
    const plainGrandchildId = randomUUID();
    await db.insert(issues).values([
      { id: laneGrandchildId, companyId: s.companyId, parentId: s.laneId, title: "lane grandchild", status: "todo", priority: "medium" },
      { id: plainGrandchildId, companyId: s.companyId, parentId: s.plainId, title: "plain grandchild", status: "todo", priority: "medium" },
    ]);
    const svc = issueTreeControlService(db);
    const pause = await svc.createHold(s.companyId, s.ticketId, { mode: "pause", reason: "operator pause", actor });
    const previewIds = pause.preview.issues.map((i) => i.id);
    expect(previewIds).not.toContain(laneGrandchildId);
    expect(previewIds).toContain(plainGrandchildId);
    expect(await svc.getActivePauseHoldGate(s.companyId, laneGrandchildId)).toBeNull();
    expect(await svc.getActivePauseHoldGate(s.companyId, plainGrandchildId)).not.toBeNull();
  });
});
