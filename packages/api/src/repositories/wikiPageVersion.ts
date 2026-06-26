import { getDb } from "../db/index.js";
import { wikiPageVersions, wikiPages } from "../db/schema/index.js";
import { and, desc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { WikiPageVersion } from "@orcy/shared";
import { repositoryCreateError } from "../errors/repository.js";

export type { WikiPageVersion };

/** Input for inserting a new {@link WikiPageVersion} snapshot. */
export interface CreateWikiPageVersionInput {
  id?: string;
  pageId: string;
  versionNumber: number;
  title: string;
  content: string;
  editSummary?: string | null;
  editedBy: string;
  createdAt?: string;
}

function rowToVersion(row: Record<string, unknown>): WikiPageVersion {
  return {
    id: row.id as string,
    pageId: row.pageId as string,
    versionNumber: row.versionNumber as number,
    title: row.title as string,
    content: row.content as string,
    editSummary: (row.editSummary as string | null) ?? null,
    editedBy: row.editedBy as string,
    createdAt: row.createdAt as string,
  };
}

/** Inserts a {@link WikiPageVersion} snapshot and returns the materialized record; side effect: writes a row. */
export function create(input: CreateWikiPageVersionInput): WikiPageVersion {
  const db = getDb();
  const id = input.id ?? uuid();
  const now = input.createdAt ?? new Date().toISOString();

  try {
    db.insert(wikiPageVersions)
      .values({
        id,
        pageId: input.pageId,
        versionNumber: input.versionNumber,
        title: input.title,
        content: input.content,
        editSummary: input.editSummary ?? null,
        editedBy: input.editedBy,
        createdAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("wikiPageVersion", err as Error, id);
  }

  const version = getByPageAndNumber(input.pageId, input.versionNumber);
  if (!version) throw new Error(`wikiPageVersion not found after insert: ${id}`);
  return version;
}

/** Returns all versions for a page ordered by `versionNumber` descending (newest first); no side effects. */
export function listByPage(pageId: string): WikiPageVersion[] {
  const db = getDb();
  const rows = db
    .select()
    .from(wikiPageVersions)
    .where(eq(wikiPageVersions.pageId, pageId))
    .orderBy(desc(wikiPageVersions.versionNumber))
    .all();
  return rows.map(rowToVersion);
}

/** Returns the specific version matching `pageId` + `versionNumber`, or `null` when not found; no side effects. */
export function getByPageAndNumber(pageId: string, versionNumber: number): WikiPageVersion | null {
  const db = getDb();
  const row = db
    .select()
    .from(wikiPageVersions)
    .where(
      and(eq(wikiPageVersions.pageId, pageId), eq(wikiPageVersions.versionNumber, versionNumber)),
    )
    .get();
  return row ? rowToVersion(row) : null;
}

/** Returns the version matching the page's `currentVersionNumber` (joins `wiki_pages.currentVersionNumber`), or `null` when the page is missing; no side effects. */
export function getLatest(pageId: string): WikiPageVersion | null {
  const db = getDb();
  const page = db.select().from(wikiPages).where(eq(wikiPages.id, pageId)).get();
  if (!page) return null;
  return getByPageAndNumber(pageId, page.currentVersionNumber);
}
