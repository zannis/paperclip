import { describe, expect, it } from "vitest";
import {
  unattributedSubtreeChanges,
  type TaskWatchdogMaterialLeaf,
  type TaskWatchdogMutationLedger,
} from "../services/task-watchdogs.js";

const LEAF = "11111111-1111-4111-8111-111111111111";

function leaf(overrides: Partial<TaskWatchdogMaterialLeaf> = {}): TaskWatchdogMaterialLeaf {
  return {
    issueId: LEAF,
    status: "todo",
    assigneeAgentId: null,
    assigneeUserId: null,
    blockerIssueIds: [],
    pendingInteractionIds: [],
    pendingApprovalIds: [],
    ...overrides,
  };
}

function ledgerWith(declared: Partial<TaskWatchdogMaterialLeaf>): TaskWatchdogMutationLedger {
  const baseline = leaf();
  return {
    version: 1,
    baseline: { version: 2, fingerprint: "task_watchdog_stop:baseline", materialLeaves: [baseline], waitsByIssueId: {} },
    baselineMaterialByIssueId: { [LEAF]: baseline },
    mutations: [{ issueId: LEAF, declared, startsWork: true }],
  };
}

function changesAfter(
  ledger: TaskWatchdogMutationLedger,
  current: TaskWatchdogMaterialLeaf,
  ownedLiveIssueIds: Iterable<string>,
) {
  return unattributedSubtreeChanges({
    ledger,
    next: { version: 2, fingerprint: "task_watchdog_stop:next", materialLeaves: [current], waitsByIssueId: {} },
    nextMaterialByIssueId: { [LEAF]: current },
    parentByIssueId: new Map([[LEAF, null]]),
    ownedLiveIssueIds: new Set(ownedLiveIssueIds),
  });
}

// A watchdog run reassigns a stalled leaf; the assignment wake starts the new
// owner's run, which checks the leaf out to in_progress before the watchdog
// writes its summary. That checkout is the run's own recovery landing.
describe("unattributedSubtreeChanges with a live path the run started", () => {
  const worker = "22222222-2222-4222-8222-222222222222";
  const ledger = ledgerWith({ assigneeAgentId: worker });

  it("attributes the checkout of a path this run started", () => {
    expect(changesAfter(ledger, leaf({ assigneeAgentId: worker, status: "in_progress" }), [LEAF])).toEqual([]);
  });

  it("still attributes the declared write alone", () => {
    expect(changesAfter(ledger, leaf({ assigneeAgentId: worker }), [LEAF])).toEqual([]);
  });

  it("does not attribute a checkout of a path this run did not start", () => {
    expect(changesAfter(ledger, leaf({ assigneeAgentId: worker, status: "in_progress" }), [])).toEqual([LEAF]);
  });

  it("does not attribute any other change on a path this run started", () => {
    const other = "33333333-3333-4333-8333-333333333333";
    expect(changesAfter(ledger, leaf({ assigneeAgentId: other, status: "in_progress" }), [LEAF])).toEqual([LEAF]);
    expect(changesAfter(ledger, leaf({ assigneeAgentId: worker, status: "done" }), [LEAF])).toEqual([LEAF]);
    expect(changesAfter(ledger, leaf({ assigneeAgentId: worker, status: "in_progress", blockerIssueIds: [other] }), [LEAF])).toEqual([LEAF]);
  });
});
