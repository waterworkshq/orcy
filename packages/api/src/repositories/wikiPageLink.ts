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
 * Batch-resolves which link targets still exist in their source tables and attaches a `dangling: boolean`
 * flag to each link. Groups by `targetType` and issues one `SELECT id FROM <table> WHERE id IN (...)` per
 * type so the per-link cost stays low regardless of fan-out. Returns the input array shape (order preserved)
 * with the boolean attached.
 */
export function resolveDangling(links: WikiPageLink[]): WikiPageLinkWithDangling[] {
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
    const table = TARGET_TYPE_TO_TABLE[type];
    const ids = [...new Set(group.map((l) => l.targetId))];
    if (ids.length === 0) continue;
    const rows = db.all<{ id: string }>(
      sql`SELECT id FROM ${sql.raw(table)} WHERE id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
    const set = new Set(rows.map((r) => r.id));
    foundByTypeAndId.set(type, set);
  }

  return links.map((link) => {
    const set = foundByTypeAndId.get(link.targetType);
    return { ...link, dangling: !set || !set.has(link.targetId) };
  });
}

/** Re-export for callers that want to test the mapping table directly. */
export const _targetTypeToTable = TARGET_TYPE_TO_TABLE;
