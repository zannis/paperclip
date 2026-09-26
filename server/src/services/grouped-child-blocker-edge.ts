import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { issueRelations, issues } from "@paperclipai/db";

// A grouped child never reaches its parent, so its explicit "blocks" edge to that parent is inert.

/** Predicate over a `blocker` issue row: false when it is a grouped child of `dependentId`. */
export function blockerCountsFor(
  blocker: { groupedChild: AnyColumn; parentId: AnyColumn },
  dependentId: AnyColumn | string,
): SQL {
  return sql`not (${blocker.groupedChild} and ${blocker.parentId} is not distinct from ${dependentId})`;
}

/** Predicate over an `issue_relations` row: false for a grouped child's edge to its own parent. */
export function relationBlockerCounts(): SQL {
  return sql`not exists (
    select 1 from ${issues} grouped_blocker
    where grouped_blocker.id = ${issueRelations.issueId}
      and grouped_blocker.grouped_child
      and grouped_blocker.parent_id = ${issueRelations.relatedIssueId}
  )`;
}
