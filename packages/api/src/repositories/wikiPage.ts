import { getDb } from "../db/index.js";
import { wikiPages } from "../db/schema/index.js";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { WikiPage, WikiPageStatus } from "@orcy/shared";
import {
  repositoryCreateError,
  repositoryDeleteError,
  repositoryUpdateError,
} from "../errors/repository.js";

export type { WikiPage, WikiPageStatus };

/** Input for inserting a new {@link WikiPage} row. */
export interface CreateWikiPageInput {
  id?: string;
  habitatId: string;
  parentId?: string | null;
  slug: string;
  title: string;
  content?: string;
  status?: WikiPageStatus;
  tags?: string[];
  currentVersionNumber?: number;
  createdBy: string;
  lastUpdatedBy: string;
  lastUpdatedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Filters for {@link listByHabitat} — `parentId` accepts a string (parent match) or `null` (root pages). */
export interface ListWikiPagesFilters {
  parentId?: string | null;
  tag?: string;
  status?: WikiPageStatus;
}

/** Search params for {@link search}. */
export interface WikiPageSearchOptions {
  limit?: number;
  offset?: number;
}

/** Result row for {@link search} — BM25-ranked excerpt over published pages. */
export interface WikiPageSearchResult {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  rank: number;
}

function rowToPage(row: Record<string, unknown>): WikiPage {
  return {
    id: row.id as string,
    habitatId: row.habitatId as string,
    parentId: (row.parentId as string | null) ?? null,
    slug: row.slug as string,
    title: row.title as string,
    content: row.content as string,
    status: row.status as WikiPageStatus,
    tags: (row.tags as string[]) ?? [],
    currentVersionNumber: row.currentVersionNumber as number,
    createdBy: row.createdBy as string,
    lastUpdatedBy: row.lastUpdatedBy as string,
    lastUpdatedAt: row.lastUpdatedAt as string,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

/** Returns true when the FTS5 virtual table for wiki pages exists in the current connection; no side effects. */
export function ftsTableExists(): boolean {
  const db = getDb();
  const row = db.get<{ name: string | null }>(
    sql`SELECT name FROM sqlite_master WHERE type='table' AND name='wiki_pages_fts'`,
  );
  return row?.name === "wiki_pages_fts";
}

/** Inserts a {@link WikiPage} row and returns the materialized record; side effect: writes a row. */
export function create(input: CreateWikiPageInput): WikiPage {
  const db = getDb();
  const id = input.id ?? uuid();
  const now = new Date().toISOString();
  const lastUpdatedAt = input.lastUpdatedAt ?? now;
  const createdAt = input.createdAt ?? now;
  const updatedAt = input.updatedAt ?? now;

  try {
    db.insert(wikiPages)
      .values({
        id,
        habitatId: input.habitatId,
        parentId: input.parentId ?? null,
        slug: input.slug,
        title: input.title,
        content: input.content ?? "",
        status: input.status ?? "draft",
        tags: input.tags ?? [],
        currentVersionNumber: input.currentVersionNumber ?? 1,
        createdBy: input.createdBy,
        lastUpdatedBy: input.lastUpdatedBy,
        lastUpdatedAt,
        createdAt,
        updatedAt,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("wikiPage", err as Error, id);
  }

  const page = getById(id);
  if (!page) throw new Error(`wikiPage not found after insert: ${id}`);
  return page;
}

/** Returns a single {@link WikiPage} by id, or `null` when no row matches; no side effects. */
export function getById(id: string): WikiPage | null {
  const db = getDb();
  const row = db.select().from(wikiPages).where(eq(wikiPages.id, id)).get();
  return row ? rowToPage(row) : null;
}

/** Returns the page in a habitat with the given slug under the given parent (or `null` for root pages); no side effects. */
export function getByHabitatAndSlug(
  habitatId: string,
  slug: string,
  parentId: string | null = null,
): WikiPage | null {
  const db = getDb();
  const parentClause =
    parentId === null ? isNull(wikiPages.parentId) : eq(wikiPages.parentId, parentId);
  const row = db
    .select()
    .from(wikiPages)
    .where(and(eq(wikiPages.habitatId, habitatId), eq(wikiPages.slug, slug), parentClause))
    .get();
  return row ? rowToPage(row) : null;
}

/** Lists pages for a habitat, optionally filtered by parent, tag, and status; no side effects. */
export function listByHabitat(habitatId: string, filters: ListWikiPagesFilters = {}): WikiPage[] {
  const db = getDb();
  const conditions = [eq(wikiPages.habitatId, habitatId)];

  if (filters.parentId === null) {
    conditions.push(isNull(wikiPages.parentId));
  } else if (filters.parentId !== undefined) {
    conditions.push(eq(wikiPages.parentId, filters.parentId));
  }

  if (filters.status) {
    conditions.push(eq(wikiPages.status, filters.status));
  }

  if (filters.tag) {
    const tagPattern = `%"${filters.tag}"%`;
    conditions.push(like(wikiPages.tags, tagPattern));
  }

  const rows = db
    .select()
    .from(wikiPages)
    .where(and(...conditions))
    .orderBy(wikiPages.title)
    .all();
  return rows.map(rowToPage);
}

/** Input for {@link updateMetadata} — all fields optional, `lastUpdatedBy` is always rewritten. */
export interface UpdateWikiPageMetadataInput {
  parentId?: string | null;
  tags?: string[];
  status?: WikiPageStatus;
  lastUpdatedBy: string;
}

/** Applies a metadata-only patch to a {@link WikiPage} (does not touch `title` or `content`); side effect: writes the row. */
export function updateMetadata(id: string, patch: UpdateWikiPageMetadataInput): void {
  const db = getDb();
  const now = new Date().toISOString();

  const set: Partial<typeof wikiPages.$inferInsert> = {
    lastUpdatedBy: patch.lastUpdatedBy,
    lastUpdatedAt: now,
    updatedAt: now,
  };
  if (patch.parentId !== undefined) set.parentId = patch.parentId;
  if (patch.tags !== undefined) set.tags = patch.tags;
  if (patch.status !== undefined) set.status = patch.status;

  try {
    db.update(wikiPages).set(set).where(eq(wikiPages.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("wikiPage", err as Error, id);
  }
}

/** Deletes a {@link WikiPage} by id; returns `true` when a row was removed, `false` otherwise. */
export function deletePage(id: string): boolean {
  const db = getDb();
  const existing = db
    .select({ id: wikiPages.id })
    .from(wikiPages)
    .where(eq(wikiPages.id, id))
    .get();
  if (!existing) return false;
  try {
    db.delete(wikiPages).where(eq(wikiPages.id, id)).run();
    return true;
  } catch (err) {
    throw repositoryDeleteError("wikiPage", err as Error, id);
  }
}

/**
 * Searches published pages in a habitat for a free-text query.
 * Uses FTS5 + BM25 + snippet when the `wiki_pages_fts` virtual table exists in the current connection;
 * otherwise falls back to a deterministic `LIKE` scan over `title`/`content` so the test environment
 * (sql.js without FTS5) still produces a correct result. Full BM25 ranking is a Phase 3 (S3a) refinement;
 * this stub establishes the capability-aware branch.
 */
export function search(
  habitatId: string,
  query: string,
  options: WikiPageSearchOptions = {},
): WikiPageSearchResult[] {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  const db = getDb();

  if (ftsTableExists()) {
    const rows = db.all<{
      id: string;
      slug: string;
      title: string;
      excerpt: string;
      rank: number;
    }>(sql`
        SELECT w.id, w.slug, w.title,
          snippet(wiki_pages_fts, 1, '<mark>', '</mark>', '…', 12) AS excerpt,
          bm25(wiki_pages_fts) AS rank
        FROM wiki_pages_fts f
        JOIN wiki_pages w ON w.rowid = f.rowid
        WHERE wiki_pages_fts MATCH ${query}
          AND w.habitat_id = ${habitatId}
          AND w.status = 'published'
        ORDER BY rank
        LIMIT ${limit} OFFSET ${offset}
      `);
    return rows;
  }

  const likePattern = `%${query}%`;
  const rows = db.all<{
    id: string;
    slug: string;
    title: string;
    excerpt: string;
    rank: number;
  }>(sql`
      SELECT id, slug, title,
        substr(content, 1, 160) AS excerpt,
        0 AS rank
      FROM wiki_pages
      WHERE (title LIKE ${likePattern} OR content LIKE ${likePattern})
        AND habitat_id = ${habitatId}
        AND status = 'published'
      ORDER BY last_updated_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
  return rows;
}
