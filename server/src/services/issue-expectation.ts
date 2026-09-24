import { createHash } from "node:crypto";
import type { issues } from "@paperclipai/db";
import type { IssueUpdateExpectation } from "@paperclipai/shared";
import { conflict } from "../errors.js";

export function issueDescriptionSha256(description: string | null | undefined): string {
  return createHash("sha256").update(description ?? "", "utf8").digest("hex");
}

// Client-facing PATCH `expected` check; reports `details.current` on mismatch.
export function assertIssueExpectation(
  row: typeof issues.$inferSelect,
  expected: IssueUpdateExpectation | undefined,
): void {
  if (!expected) return;
  const current = {
    revision: row.revision,
    status: row.status,
    assigneeAgentId: row.assigneeAgentId ?? null,
    descriptionSha256: issueDescriptionSha256(row.description),
  };
  const mismatch =
    (expected.revision !== undefined && expected.revision !== current.revision)
    || (expected.status !== undefined && expected.status !== current.status)
    || (expected.assigneeAgentId !== undefined && expected.assigneeAgentId !== current.assigneeAgentId)
    || (expected.descriptionSha256 !== undefined && expected.descriptionSha256 !== current.descriptionSha256);
  if (mismatch) {
    throw conflict("Issue precondition failed", { code: "issue_precondition_failed", current });
  }
}
