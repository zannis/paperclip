import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  workAssessments,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { commitNativeStatusDecision } from "./status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "./status-arbiter.js";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("native completion of a grouped child", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const workerId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-grouped-native-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Native", issuePrefix: "GNC" });
    await db.insert(agents).values({ id: workerId, companyId, name: "Lane worker", adapterType: "codex_local", status: "running" });
  }, 30_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  async function completeNativeChild(
    groupedChild: boolean,
    { blocksParent = false, reason = "issue_children_completed" }: { blocksParent?: boolean; reason?: string } = {},
  ) {
    const engineerId = randomUUID();
    await db.insert(agents).values({ id: engineerId, companyId, name: "Engineer", adapterType: "codex_local", status: "idle" });
    const ticketId = randomUUID();
    const childId = randomUUID();
    const contractId = randomUUID();
    const runId = randomUUID();
    const resultId = randomUUID();
    const assessmentId = randomUUID();
    await db.insert(issues).values([
      { id: ticketId, companyId, title: "ticket", status: blocksParent ? "blocked" : "in_progress", assigneeAgentId: engineerId, workMode: "standard" },
      {
        id: childId, companyId, parentId: ticketId, groupedChild, title: "child", status: "in_progress",
        assigneeAgentId: workerId, workMode: "standard",
      },
      { companyId, parentId: ticketId, title: "sibling", status: blocksParent ? "todo" : "done", workMode: "standard" },
    ]);
    if (blocksParent) {
      await db.insert(issueRelations).values({ companyId, issueId: childId, relatedIssueId: ticketId, type: "blocks" });
    }
    await db.insert(completionContracts).values({
      id: contractId, companyId, issueId: childId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "grouped-v1", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "grouped-v1", criteria: [{ id: "objective", requirement: "finish" }] },
      canonicalSha256: `contract-${contractId}`, createdByActorType: "system", createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId: workerId, status: "running", runtimeMode: "native",
      nativeIssueId: childId, completionContractId: contractId, completionContractSha256: `contract-${contractId}`,
      contextSnapshot: { issueId: childId },
    });
    await db.insert(nativeRunResults).values({
      id: resultId, companyId, issueId: childId, runId, completionContractId: contractId,
      serverFingerprint: `fp-${resultId}`, schemaStatus: "accepted", resultJson: {}, canonicalSha256: `sha-${resultId}`,
    });
    await db.insert(workAssessments).values({
      id: assessmentId, companyId, issueId: childId, runId, contractId, resultId,
      triggerKind: "native_result", triggerActorCompanyId: companyId, priorIssueStatus: "in_progress",
      priorStatusVersion: 0, policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, assessmentJson: {},
      inputDigest: `digest-${assessmentId}`,
    });
    await db.insert(nativeRunFinalizations).values({
      runId, companyId, issueId: childId, phase: "arbitrating", attempt: 0, resultId,
    });
    await commitNativeStatusDecision({
      db, companyId, issueId: childId, runId, assessmentId,
      priorStatus: "in_progress", priorStatusVersion: 0, priorDecisionId: null,
      decision: {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "done", toStatus: "done", reasonCode: "completion_contract_satisfied",
        unblockDescriptor: null, effects: [],
      },
    });
    const [child] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, childId));
    expect(child?.status).toBe("done");
    return db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.agentId, engineerId),
      eq(agentWakeupRequests.reason, reason),
    ));
  }

  it("does not enqueue issue_children_completed for the parent's assignee", async () => {
    expect(await completeNativeChild(true)).toEqual([]);
  });

  it("still enqueues it for an ordinary child", async () => {
    expect(await completeNativeChild(false)).toHaveLength(1);
  });

  it("does not enqueue issue_blockers_resolved for a parent the grouped child explicitly blocks", async () => {
    expect(await completeNativeChild(true, { blocksParent: true, reason: "issue_blockers_resolved" })).toEqual([]);
  });

  it("still enqueues issue_blockers_resolved when an ordinary child blocks its parent", async () => {
    expect(await completeNativeChild(false, { blocksParent: true, reason: "issue_blockers_resolved" })).toHaveLength(1);
  });
});
