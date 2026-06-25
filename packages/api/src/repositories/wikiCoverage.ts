import { getDb } from "../db/index.js";
import { wikiCoverageMarkers } from "../db/schema/index.js";
import { and, eq, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { WikiCoverageMarker, WikiCoverageMarkerType } from "@orcy/shared";
import { repositoryCreateError } from "../errors/repository.js";

export type { WikiCoverageMarker, WikiCoverageMarkerType };

/** Input for inserting a new {@link WikiCoverageMarker}. */
export interface CreateWikiCoverageMarkerInput {
  id?: string;
  habitatId: string;
  coverageFrom: string;
  coverageTo: string;
  markerType: WikiCoverageMarkerType;
  pageId?: string | null;
  reason?: string | null;
  createdBy: string;
  createdAt?: string;
}

/** Input for {@link replacePageMarkersWithNoUpdate}. */
export interface ReplacePageMarkersInput {
  reason?: string;
  createdBy: string;
}

function rowToMarker(row: Record<string, unknown>): WikiCoverageMarker {
  return {
    id: row.id as string,
    habitatId: row.habitatId as string,
    coverageFrom: row.coverageFrom as string,
    coverageTo: row.coverageTo as string,
    markerType: row.markerType as WikiCoverageMarkerType,
    pageId: (row.pageId as string | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    createdBy: row.createdBy as string,
    createdAt: row.createdAt as string,
  };
}

/** Inserts a {@link WikiCoverageMarker} and returns the materialized record; side effect: writes a row. */
export function create(input: CreateWikiCoverageMarkerInput): WikiCoverageMarker {
  const db = getDb();
  const id = input.id ?? uuid();
  const now = input.createdAt ?? new Date().toISOString();

  try {
    db.insert(wikiCoverageMarkers)
      .values({
        id,
        habitatId: input.habitatId,
        coverageFrom: input.coverageFrom,
        coverageTo: input.coverageTo,
        markerType: input.markerType,
        pageId: input.pageId ?? null,
        reason: input.reason ?? null,
        createdBy: input.createdBy,
        createdAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("wikiCoverageMarker", err as Error, id);
  }

  const fetched = db.select().from(wikiCoverageMarkers).where(eq(wikiCoverageMarkers.id, id)).get();
  if (!fetched) throw new Error(`wikiCoverageMarker not found after insert: ${id}`);
  return rowToMarker(fetched);
}

/** Returns the per-habitat cadence watermark (`MAX(coverage_to)`) or `null` when no markers exist; no side effects. */
export function getWatermark(habitatId: string): string | null {
  const db = getDb();
  const row = db.get<{ max: string | null }>(
    sql`SELECT MAX(coverage_to) AS max FROM wiki_coverage_markers WHERE habitat_id = ${habitatId}`,
  );
  return row?.max ?? null;
}

/** Returns all page-type coverage markers attached to a page; no side effects. */
export function getByPage(pageId: string): WikiCoverageMarker[] {
  const db = getDb();
  const rows = db
    .select()
    .from(wikiCoverageMarkers)
    .where(and(eq(wikiCoverageMarkers.pageId, pageId), eq(wikiCoverageMarkers.markerType, "page")))
    .all();
  return rows.map(rowToMarker);
}

/**
 * Two-mode deletion helper (ADR-0009). Reads the page's existing page-type coverage markers and inserts
 * equivalent `no_update_needed` markers covering the same windows. The caller then deletes the page;
 * the `ON DELETE CASCADE` on `wiki_coverage_markers.page_id` removes the old page-type markers while the
 * new no-update markers (which have `page_id = null`) survive to hold the watermark. Returns the inserted
 * no-update markers. Caller is responsible for wrapping this + the page delete in a transaction so a
 * failed delete rolls back the no-update inserts.
 */
export function replacePageMarkersWithNoUpdate(
  pageId: string,
  input: ReplacePageMarkersInput,
): WikiCoverageMarker[] {
  const db = getDb();
  const existing = getByPage(pageId);
  if (existing.length === 0) return [];

  const now = new Date().toISOString();
  const created: WikiCoverageMarker[] = [];
  for (const marker of existing) {
    const row = create({
      habitatId: marker.habitatId,
      coverageFrom: marker.coverageFrom,
      coverageTo: marker.coverageTo,
      markerType: "no_update_needed",
      pageId: null,
      reason: input.reason ?? null,
      createdBy: input.createdBy,
      createdAt: now,
    });
    created.push(row);
  }
  return created;
}
