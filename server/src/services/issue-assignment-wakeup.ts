import { logger } from "../middleware/logger.js";
import type { DurableChatWakeupRequest } from "./durable-chat-wakeup.js";
import { TASK_WATCHDOG_WAKE_ORIGIN_RUN_ID_KEY } from "./task-watchdog-scope.js";

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
      idempotencyKey?: string | null;
      allowRunCoalescing?: boolean;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
      durableChatRequest?: DurableChatWakeupRequest;
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
  /** Latest issue comment that caused this wakeup. Included in both payload
   * and context so the heartbeat can build the exact turn that was requested. */
  wakeCommentId?: string | null;
  /** Closed, server-derived omission counts for provider attachments on the
   * exact wake comment. These are prompt diagnostics, never authorization. */
  attachmentOmissionReasons?: Record<string, number> | null;
  rethrowOnError?: boolean;
  durableChatRequest?: DurableChatWakeupRequest;
  // Set when the request firing this wake is acting under a task-watchdog
  // mutation scope. Stamped into the payload so the live path this wake starts
  // carries the watchdog run that caused it; see
  // `TASK_WATCHDOG_WAKE_ORIGIN_RUN_ID_KEY`.
  watchdogOriginRunId?: string | null;
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
        ...(input.wakeCommentId ? { wakeCommentId: input.wakeCommentId } : {}),
        ...(input.watchdogOriginRunId
          ? { [TASK_WATCHDOG_WAKE_ORIGIN_RUN_ID_KEY]: input.watchdogOriginRunId }
          : {}),
      },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      ...(input.durableChatRequest
        ? { durableChatRequest: input.durableChatRequest }
        : {}),
      contextSnapshot: {
        issueId: input.issue.id,
        source: input.contextSource,
        ...(input.taskKey ? { taskKey: input.taskKey } : {}),
        ...(input.wakeCommentId ? { wakeCommentId: input.wakeCommentId } : {}),
        ...(input.wakeCommentId && input.attachmentOmissionReasons
          ? {
              externalAttachmentOmissions: [
                {
                  commentId: input.wakeCommentId,
                  reasons: input.attachmentOmissionReasons,
                },
              ],
            }
          : {}),
      },
    })
    .catch((err) => {
      logger.warn(
        { err, issueId: input.issue.id },
        "failed to wake assignee on issue assignment",
      );
      if (input.rethrowOnError) throw err;
      return null;
    });
}
