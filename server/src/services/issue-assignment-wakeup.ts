import { logger } from "../middleware/logger.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";

export interface IssueAssignmentWakeupDeps {
  wakeup: (
    agentId: string,
    opts: {
      source?: WakeupSource;
      triggerDetail?: WakeupTriggerDetail;
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

// Whether `queueIssueAssignmentWakeup` will actually wake anybody for this
// issue. A caller that has to record the *fact* of the wake rather than fire it
// — the task-watchdog ledger, which tells a run the request itself started from
// one it merely found running — needs the same answer, and must not restate the
// condition to get it.
export function issueAssignmentWakeupFires(issue: { assigneeAgentId: string | null; status: string }) {
  return Boolean(issue.assigneeAgentId) && issue.status !== "backlog";
}

export function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  taskKey?: string | null;
  rethrowOnError?: boolean;
}) {
  const assigneeAgentId = input.issue.assigneeAgentId;
  if (!assigneeAgentId || !issueAssignmentWakeupFires(input.issue)) return;

  return input.heartbeat
    .wakeup(assigneeAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: input.reason,
      payload: {
        issueId: input.issue.id,
        mutation: input.mutation,
        ...(input.taskKey ? { taskKey: input.taskKey } : {}),
      },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: {
        issueId: input.issue.id,
        source: input.contextSource,
        ...(input.taskKey ? { taskKey: input.taskKey } : {}),
      },
    })
    .catch((err) => {
      logger.warn({ err, issueId: input.issue.id }, "failed to wake assignee on issue assignment");
      if (input.rethrowOnError) throw err;
      return null;
    });
}
