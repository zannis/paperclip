import { and, isNull, ne, type SQL } from "drizzle-orm";
import { issues } from "@paperclipai/db";
import { INTERNAL_OPERATION_ORIGIN_KIND } from "@paperclipai/shared";

export function visibleIssueCondition(): SQL {
  return and(isNull(issues.hiddenAt), isNull(issues.harnessKind))!;
}

export function visibleIssueSql(alias = "issues") {
  return `"${alias}"."hidden_at" IS NULL AND "${alias}"."harness_kind" IS NULL`;
}

/** Human-facing discovery only. Execution, recovery, timers, leases, direct-id
 * reads and comments deliberately continue to use visibleIssueCondition. */
export function surfaceIssueCondition(): SQL {
  return and(visibleIssueCondition(), ne(issues.originKind, INTERNAL_OPERATION_ORIGIN_KIND))!;
}
