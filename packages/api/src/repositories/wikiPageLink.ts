import { getDb } from "../db/index.js";
import { wikiPageLinks } from "../db/schema/index.js";
import { eq, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { WikiPageLink, WikiLinkTargetType } from "@orcy/shared";
import { repositoryCreateError, repositoryDeleteError } from "../errors/repository.js";

export type { WikiPageLink, WikiLinkTargetType };

/** Input for inserting a new {@link WikiPageLink} citation. */
export interface CreateWikiPageLinkInput {
  id?: string;
  pageId: string;
  targetType: WikiLinkTargetType;
  targetId: string;
  linkNote?: string | null;
  createdBy: string;
  createdAt?: string;
}

/** Source-table name per polymorphic `targetType` (per ADR-0007 + ARCHITECTURE §2.1). */
const TARGET_TYPE_TO_TABLE: Record<WikiLinkTargetType, string> = {
  mission: "missions",
  task: "tasks",
  pulse: "pulses",
  insight: "project_insights",
  skill_signal: "habitat_skill_signals",
  commit: "code_commits",
  pull_request: "pull_requests",
  evidence_link: "code_evidence_links",
  external_issue: "external_issue_links",
};

function rowToLink(row: Record<string, unknown>): WikiPageLink {
  return {
    id: row.id as string,
    pageId: row.pageId as string,
    targetType: row.targetType as WikiLinkTargetType,
    targetId: row.targetId as string,
    linkNote: (row.linkNote as string | null) ?? null,
    createdBy: row.createdBy as string,
    createdAt: row.createdAt as string,
  };
}

/** Inserts a {@link WikiPageLink} citation and returns the materialized record; side effect: writes a row. */
export function create(input: CreateWikiPageLinkInput): WikiPageLink {
  const db = getDb();
  const id = input.id ?? uuid();
  const now = input.createdAt ?? new Date().toISOString();

  try {
    db.insert(wikiPageLinks)
      .values({
        id,
        pageId: input.pageId,
        targetType: input.targetType,
        targetId: input.targetId,
        linkNote: input.linkNote ?? null,
        createdBy: input.createdBy,
        createdAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("wikiPageLink", err as Error, id);
  }

  const fetched = db.select().from(wikiPageLinks).where(eq(wikiPageLinks.id, id)).get();
  if (!fetched) throw new Error(`wikiPageLink not found after insert: ${id}`);
  return rowToLink(fetched);
}

/** Deletes a {@link WikiPageLink} by id; returns `true` when a row was removed, `false` otherwise. */
export function remove(id: string): boolean {
  const db = getDb();
  const existing = db
    .select({ id: wikiPageLinks.id })
    .from(wikiPageLinks)
    .where(eq(wikiPageLinks.id, id))
    .get();
  if (!existing) return false;
  try {
    db.delete(wikiPageLinks).where(eq(wikiPageLinks.id, id)).run();
    return true;
  } catch (err) {
    throw repositoryDeleteError("wikiPageLink", err as Error, id);
  }
}

/** Returns all links for a page; no side effects. */
export function listByPage(pageId: string): WikiPageLink[] {
  const db = getDb();
  const rows = db.select().from(wikiPageLinks).where(eq(wikiPageLinks.pageId, pageId)).all();
  return rows.map(rowToLink);
}

/** A {@link WikiPageLink} with a `dangling` flag computed by {@link resolveDangling}. */
export type WikiPageLinkWithDangling = WikiPageLink & { dangling: boolean };

/**
 * Batch-resolves which link targets still exist **in the same habitat as the citing page** and
 * attaches a `dangling: boolean` flag to each link. Groups by `targetType` and issues one
 * habitat-aware `SELECT id ... WHERE habitat = ? AND id IN (...)` per type so:
 *
 * - a link to a target that was deleted → `dangling: true` (same as before)
 * - a link to a target that exists in a **different** habitat → `dangling: true` (NEW — closes
 *   the cross-habitat existence-leak where a page in habitat A could confirm a target exists in
 *   habitat B via `dangling: false`)
 *
 * Per-type habitat join paths (per ADR-0007 + ARCHITECTURE §2.1):
 * - `mission`, `pulse`, `insight`, `skill_signal`, `external_issue` → direct `habitat_id` column
 * - `task` → join `missions` on `tasks.mission_id`
 * - `commit`, `pull_request` → join `habitat_code_repositories` on `repository_id`
 * - `evidence_link` → join through `code_evidence_links.target_type`/`target_id` to the
 *   underlying task/mission's habitat
 *
 * Returns the input array shape (order preserved) with the boolean attached. Targets whose
 * `repository_id` is NULL (e.g. an orphan commit) are treated as not-in-habitat → `dangling: true`.
 */
export function resolveDangling(
  links: WikiPageLink[],
  habitatId: string,
): WikiPageLinkWithDangling[] {
  if (links.length === 0) return [];

  const db = getDb();
  const byType = new Map<WikiLinkTargetType, WikiPageLink[]>();
  for (const link of links) {
    const arr = byType.get(link.targetType) ?? [];
    arr.push(link);
    byType.set(link.targetType, arr);
  }

  const foundByTypeAndId = new Map<string, Set<string>>();
  for (const [type, group] of byType) {
    const ids = [...new Set(group.map((l) => l.targetId))];
    if (ids.length === 0) continue;
    const rows = db.all<{ id: string }>(habitatScopedQuery(type, habitatId, ids));
    foundByTypeAndId.set(type, new Set(rows.map((r) => r.id)));
  }

  return links.map((link) => {
    const set = foundByTypeAndId.get(link.targetType);
    return { ...link, dangling: !set || !set.has(link.targetId) };
  });
}

/**
 * Builds the habitat-scoped existence query for one `targetType`. Returns the ids of targets that
 * exist AND belong to `habitatId`. Uses drizzle's `sql` template so values are parameterised; the
 * table/column names are injected via `sql.raw` (they come from a static allowlist, not user input).
 */
function habitatScopedQuery(type: WikiLinkTargetType, habitatId: string, ids: string[]) {
  const idList = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  switch (type) {
    case "mission":
      return sql`SELECT id FROM ${sql.raw("missions")} WHERE habitat_id = ${habitatId} AND id IN (${idList})`;
    case "task":
      return sql`SELECT t.id AS id FROM ${sql.raw("tasks")} t JOIN ${sql.raw("missions")} m ON t.mission_id = m.id WHERE m.habitat_id = ${habitatId} AND t.id IN (${idList})`;
    case "pulse":
      return sql`SELECT id FROM ${sql.raw("pulses")} WHERE habitat_id = ${habitatId} AND id IN (${idList})`;
    case "insight":
      return sql`SELECT id FROM ${sql.raw("project_insights")} WHERE habitat_id = ${habitatId} AND id IN (${idList})`;
    case "skill_signal":
      return sql`SELECT id FROM ${sql.raw("habitat_skill_signals")} WHERE habitat_id = ${habitatId} AND id IN (${idList})`;
    case "external_issue":
      return sql`SELECT id FROM ${sql.raw("external_issue_links")} WHERE habitat_id = ${habitatId} AND id IN (${idList})`;
    case "commit":
      return sql`SELECT c.id AS id FROM ${sql.raw("code_commits")} c LEFT JOIN ${sql.raw("habitat_code_repositories")} r ON c.repository_id = r.id WHERE r.habitat_id = ${habitatId} AND c.id IN (${idList})`;
    case "pull_request":
      return sql`SELECT p.id AS id FROM ${sql.raw("pull_requests")} p LEFT JOIN ${sql.raw("habitat_code_repositories")} r ON p.repository_id = r.id WHERE r.habitat_id = ${habitatId} AND p.id IN (${idList})`;
    case "evidence_link":
      return sql`SELECT el.id AS id FROM ${sql.raw("code_evidence_links")} el WHERE el.id IN (${idList}) AND (
        (el.target_type = 'task' AND el.target_id IN (
          SELECT t.id FROM ${sql.raw("tasks")} t JOIN ${sql.raw("missions")} m ON t.mission_id = m.id WHERE m.habitat_id = ${habitatId}
        ))
        OR
        (el.target_type = 'mission' AND el.target_id IN (
          SELECT id FROM ${sql.raw("missions")} WHERE habitat_id = ${habitatId}
        ))
      )`;
  }
}

/** Re-export for callers that want to test the mapping table directly. */
export const _targetTypeToTable = TARGET_TYPE_TO_TABLE;
