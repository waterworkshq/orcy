import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";
import { wikiPages, wikiPageVersions, wikiCoverageMarkers } from "../db/schema/index.js";
import { and, eq } from "drizzle-orm";
import * as wikiPageRepo from "../repositories/wikiPage.js";
import * as wikiPageVersionRepo from "../repositories/wikiPageVersion.js";
import * as wikiPageLinkRepo from "../repositories/wikiPageLink.js";
import * as wikiCoverageRepo from "../repositories/wikiCoverage.js";
import { notFound, conflict, badRequest } from "../errors.js";
import { isSqliteError } from "../errors/sqlite.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { logger } from "../lib/logger.js";
import {
  WIKI_LINK_TARGET_TYPES,
  type WikiPage,
  type WikiPageLink,
  type WikiPageStatus,
  type WikiLinkTargetType,
} from "@orcy/shared";

export type { WikiPage, WikiPageLink, WikiPageStatus, WikiLinkTargetType };
export type { WikiPageLinkWithDangling } from "../repositories/wikiPageLink.js";
export type { WikiPageSearchResult, WikiPageSearchOptions } from "../repositories/wikiPage.js";

/** Slug collision retry cap — keep the page from spinning forever on a saturated namespace. */
const MAX_SLUG_ATTEMPTS = 200;

/** Lowercases, hyphenates, trims; truncates to 64 chars; returns `untitled` for empty input. */
export function slugifyTitle(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return base || "untitled";
}

/** Resolves a unique slug for `(habitatId, parentId?)` by appending `-2`, `-3`, ... on collision. */
function resolveUniqueSlug(habitatId: string, parentId: string | null, baseSlug: string): string {
  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
    const candidate = attempt === 1 ? baseSlug : `${baseSlug}-${attempt}`;
    const existing = wikiPageRepo.getByHabitatAndSlug(habitatId, candidate, parentId);
    if (!existing) return candidate;
  }
  throw badRequest(
    `Could not allocate a unique slug for "${baseSlug}" after ${MAX_SLUG_ATTEMPTS} attempts`,
  );
}

/** Input for {@link createPage}. */
export interface CreateWikiPageInput {
  title: string;
  content: string;
  parentId?: string | null;
  tags?: string[];
  status?: WikiPageStatus;
}

/** Input for {@link deletePage}. */
export interface DeleteWikiPageInput {
  stayGone?: boolean;
  reason?: string;
}

/** Input for {@link updatePageMetadata}. All fields optional except `editedBy`. */
export interface UpdateWikiPageMetadataInput {
  parentId?: string | null;
  tags?: string[];
  status?: WikiPageStatus;
}

/** Input for {@link saveVersion}. `title` and `content` are required; `editSummary` is an authored one-liner. */
export interface SaveWikiVersionInput {
  title: string;
  content: string;
  editSummary?: string;
}

/** Input for {@link addLink}. `targetType` is validated against `WIKI_LINK_TARGET_TYPES`; `note` is an authored one-liner. */
export interface AddWikiPageLinkInput {
  targetType: WikiLinkTargetType;
  targetId: string;
  note?: string;
}

/** Type guard that narrows an arbitrary string to {@link WikiLinkTargetType} using the runtime allowlist. */
function isValidTargetType(t: string): t is WikiLinkTargetType {
  return (WIKI_LINK_TARGET_TYPES as readonly string[]).includes(t);
}

/** Best-effort SSE broadcast — never throws to the caller. Mirrors `pulseService.broadcastPulse`. */
function publishWikiEvent(habitatId: string, type: string, data: Record<string, unknown>): void {
  try {
    sseBroadcaster.publish(habitatId, { type, data } as Parameters<
      typeof sseBroadcaster.publish
    >[1]);
  } catch (err) {
    logger.warn({ err, type, habitatId }, "SSE broadcast failed after wiki mutation");
  }
}

/**
 * Validates a `parentId` for a page in `habitatId`. Throws:
 * - `badRequest` when `parentId` equals `pageId` (self-parent would create a trivial cycle),
 * - `notFound` when the parent page does not exist,
 * - `badRequest` when the parent belongs to a different habitat (cross-habitat tree coupling),
 * - `conflict` when the parent is a descendant of `pageId` (move would create a cycle).
 *
 * `pageId` is the id of the page being created/moved (pass `null` for create-self-check skip —
 * a brand-new id can't be its own ancestor, but a caller could still pass `parentId === pageId`
 * if they fabricated the id, so the self-check runs regardless).
 */
function validateParent(habitatId: string, parentId: string, pageId: string | null): void {
  if (pageId !== null && parentId === pageId) {
    throw badRequest("A wiki page cannot be its own parent.", { parentId });
  }
  const parent = wikiPageRepo.getById(parentId);
  if (!parent) throw notFound(`Parent wiki page not found: ${parentId}`);
  if (parent.habitatId !== habitatId) {
    throw badRequest("Parent wiki page belongs to a different habitat.", {
      parentHabitatId: parent.habitatId,
      pageHabitatId: habitatId,
    });
  }
  if (pageId !== null && isAncestorOf(pageId, parentId)) {
    throw conflict("Cannot move a wiki page under one of its own descendants (cycle).", {
      pageId,
      parentId,
    });
  }
}

/**
 * Walks up the parent chain from `startId` and returns `true` if `ancestorId` is encountered.
 * Used to detect cycles before reparenting: if the proposed new parent is a descendant of the
 * page being moved, walking up from that parent will hit the page's id. Bounded by the depth of
 * the tree; a malformed/self-referential chain bails out after a sane cap to avoid infinite loops.
 */
function isAncestorOf(ancestorId: string, startId: string): boolean {
  let current: string | null = startId;
  const seen = new Set<string>();
  for (let depth = 0; depth < 10_000 && current; depth++) {
    if (current === ancestorId) return true;
    if (seen.has(current)) return false; // pre-existing cycle guard
    seen.add(current);
    const row = wikiPageRepo.getById(current);
    current = row?.parentId ?? null;
  }
  return false;
}

/** A page with its links attached (each link carries a `dangling` flag). */
export type WikiPageWithLinks = WikiPage & { links: (WikiPageLink & { dangling: boolean })[] };

/**
 * Creates a draft (or published) wiki page plus its initial version-1 snapshot atomically.
 * Slug is derived from the title; on collision within the same sibling set, `-2`, `-3`, ... are appended.
 * `createdBy` is always an orcy id (ADR-0006 authored-only boundary). Side effect: writes 2 rows.
 * SSE event `wiki_page_created` is wired in Phase 8 (E8a) — see the TODO marker below.
 */
export function createPage(
  habitatId: string,
  input: CreateWikiPageInput,
  createdBy: string,
): WikiPage {
  const db = getDb();
  const pageId = uuid();
  const versionId = uuid();
  const now = new Date().toISOString();
  const slug = resolveUniqueSlug(habitatId, input.parentId ?? null, slugifyTitle(input.title));
  const status = input.status ?? "draft";

  if (input.parentId) {
    validateParent(habitatId, input.parentId, pageId);
  }

  db.transaction((tx) => {
    tx.insert(wikiPages)
      .values({
        id: pageId,
        habitatId,
        parentId: input.parentId ?? null,
        slug,
        title: input.title,
        content: input.content,
        status,
        tags: input.tags ?? [],
        currentVersionNumber: 1,
        createdBy,
        lastUpdatedBy: createdBy,
        lastUpdatedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(wikiPageVersions)
      .values({
        id: versionId,
        pageId,
        versionNumber: 1,
        title: input.title,
        content: input.content,
        editSummary: "initial",
        editedBy: createdBy,
        createdAt: now,
      })
      .run();
    if (status === "published") {
      tx.insert(wikiCoverageMarkers)
        .values({
          id: uuid(),
          habitatId,
          coverageFrom: now,
          coverageTo: now,
          markerType: "page",
          pageId,
          createdBy,
          createdAt: now,
        })
        .run();
    }
  });

  const page = wikiPageRepo.getById(pageId);
  if (!page) throw notFound(`wikiPage not found after insert: ${pageId}`);

  publishWikiEvent(page.habitatId, "wiki_page_created", {
    pageId: page.id,
    habitatId: page.habitatId,
    title: page.title,
    status: page.status,
    parentId: page.parentId,
  });

  if (status === "published") {
    publishWikiEvent(habitatId, "wiki_coverage_changed", {
      habitatId,
      watermark: wikiCoverageRepo.getWatermark(habitatId),
      markerType: "page",
    });
  }

  return page;
}

/**
 * Fetches a page with its links resolved (each link tagged `dangling: boolean` per ADR-0007).
 * Throws 404 when the page is missing.
 */
export function getPage(pageId: string): WikiPageWithLinks {
  const page = wikiPageRepo.getById(pageId);
  if (!page) throw notFound(`Wiki page not found: ${pageId}`);

  const links = wikiPageLinkRepo.resolveDangling(
    wikiPageLinkRepo.listByPage(pageId),
    page.habitatId,
  );
  return { ...page, links };
}

/** Lists pages in a habitat, optionally filtered by parent, tag, and status; no link resolution (too expensive for list view). */
export function listPages(
  habitatId: string,
  filters: {
    parentId?: string | null;
    tag?: string;
    status?: WikiPageStatus;
  } = {},
): WikiPage[] {
  return wikiPageRepo.listByHabitat(habitatId, filters);
}

/**
 * Applies a metadata-only patch to a wiki page — no version bump, no `title`/`content` change.
 * Status transitions drive coverage marker lifecycle (ADR-0009):
 * - `draft → published`: inserts a page-type coverage marker covering `[createdAt, now]` (the
 *   cited-primitive window is a later refinement; ARCHITECTURE.md §10 open note).
 * - `published → draft`: deletes the page-type coverage marker(s) for this page. Watermark may revert.
 * Throws 404 when the page is missing, 409 when moving under a new parent whose sibling set
 * already contains a page with the same slug. SSE event `wiki_page_updated` is wired in Phase 8.
 */
export function updatePageMetadata(
  pageId: string,
  patch: UpdateWikiPageMetadataInput,
  editedBy: string,
): WikiPage {
  const page = wikiPageRepo.getById(pageId);
  if (!page) throw notFound(`Wiki page not found: ${pageId}`);

  const db = getDb();
  const now = new Date().toISOString();
  const nextStatus: WikiPageStatus | undefined = patch.status;
  const isPublishing = nextStatus === "published" && page.status !== "published";
  const isUnpublishing = nextStatus === "draft" && page.status === "published";

  if (patch.parentId !== undefined && patch.parentId !== page.parentId) {
    if (patch.parentId) {
      validateParent(page.habitatId, patch.parentId, pageId);
    }
    const collision = wikiPageRepo.getByHabitatAndSlug(page.habitatId, page.slug, patch.parentId);
    if (collision && collision.id !== pageId) {
      throw conflict("A sibling page with this slug already exists in the target parent.", {
        pageId,
        parentId: patch.parentId,
        slug: page.slug,
        existingPageId: collision.id,
      });
    }
  }

  db.transaction((tx) => {
    tx.update(wikiPages)
      .set({
        ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        lastUpdatedBy: editedBy,
        lastUpdatedAt: now,
        updatedAt: now,
      })
      .where(eq(wikiPages.id, pageId))
      .run();

    if (isPublishing) {
      tx.insert(wikiCoverageMarkers)
        .values({
          id: uuid(),
          habitatId: page.habitatId,
          coverageFrom: page.createdAt,
          coverageTo: now,
          markerType: "page",
          pageId: pageId,
          createdBy: editedBy,
          createdAt: now,
        })
        .run();
    } else if (isUnpublishing) {
      tx.delete(wikiCoverageMarkers)
        .where(
          and(eq(wikiCoverageMarkers.pageId, pageId), eq(wikiCoverageMarkers.markerType, "page")),
        )
        .run();
    }
  });

  const updated = wikiPageRepo.getById(pageId);
  if (!updated) throw notFound(`wikiPage not found after update: ${pageId}`);

  if (isPublishing || isUnpublishing) {
    publishWikiEvent(updated.habitatId, "wiki_page_updated", {
      pageId: updated.id,
      habitatId: updated.habitatId,
      title: updated.title,
      versionNumber: updated.currentVersionNumber,
      status: updated.status,
    });
    publishWikiEvent(updated.habitatId, "wiki_coverage_changed", {
      habitatId: updated.habitatId,
      watermark: wikiCoverageRepo.getWatermark(updated.habitatId),
      markerType: isPublishing ? "page" : "no_update_needed",
    });
  }

  return updated;
}

/**
 * Deletes a wiki page (ADR-0009 two-mode deletion):
 * - `stayGone: true` — first inserts `no_update_needed` markers covering the same window as the page's
 *   page-type coverage markers, then deletes the page (cascade removes the page-type markers; the
 *   no-update markers hold the watermark so the cadence does not re-author the window).
 * - `stayGone: false`/absent — plain delete; cascade removes page-type markers; watermark may revert;
 *   cadence will re-author on its next run.
 * Throws 404 when the page is missing, 409 when the page has children (`ON DELETE NO ACTION` on `parent_id`).
 * SSE event `wiki_page_deleted` is wired in Phase 8 (E8a) — see TODO marker.
 */
export function deletePage(pageId: string, options: DeleteWikiPageInput, deletedBy: string): void {
  const page = wikiPageRepo.getById(pageId);
  if (!page) throw notFound(`Wiki page not found: ${pageId}`);

  const db = getDb();
  const now = new Date().toISOString();
  const { stayGone, reason } = options;

  try {
    if (stayGone) {
      db.transaction((tx) => {
        const existing = tx
          .select()
          .from(wikiCoverageMarkers)
          .where(
            and(eq(wikiCoverageMarkers.pageId, pageId), eq(wikiCoverageMarkers.markerType, "page")),
          )
          .all();
        for (const m of existing) {
          tx.insert(wikiCoverageMarkers)
            .values({
              id: uuid(),
              habitatId: m.habitatId,
              coverageFrom: m.coverageFrom,
              coverageTo: m.coverageTo,
              markerType: "no_update_needed",
              pageId: null,
              reason: reason ?? null,
              createdBy: deletedBy,
              createdAt: now,
            })
            .run();
        }
        tx.delete(wikiPages).where(eq(wikiPages.id, pageId)).run();
      });
    } else {
      db.transaction((tx) => {
        tx.delete(wikiPages).where(eq(wikiPages.id, pageId)).run();
      });
    }
  } catch (err) {
    const isFkError =
      (isSqliteError(err) && err.code === "SQLITE_CONSTRAINT_FOREIGNKEY") ||
      (err instanceof Error && /FOREIGN KEY constraint failed/i.test(err.message));
    if (isFkError) {
      throw conflict("Cannot delete page with children. Delete or move children first.", {
        pageId,
      });
    }
    throw err;
  }

  publishWikiEvent(page.habitatId, "wiki_page_deleted", {
    pageId: page.id,
    habitatId: page.habitatId,
    parentId: page.parentId,
  });

  if (stayGone) {
    publishWikiEvent(page.habitatId, "wiki_coverage_changed", {
      habitatId: page.habitatId,
      watermark: wikiCoverageRepo.getWatermark(page.habitatId),
      markerType: "no_update_needed",
    });
  }
}

/**
 * Appends a new version snapshot for a wiki page and atomically rewrites the denormalized current-version
 * fields on the page row (`title`, `content`, `currentVersionNumber`, `lastUpdatedBy`, `lastUpdatedAt`).
 * Restore is implemented as a {@link saveVersion} that copies old content (the old version row is never
 * rewritten — versions are append-only).
 *
 * When the page is `published`, the existing page-type coverage marker(s) for the page are extended
 * (`coverage_to` is advanced to `now`) so the cadence watermark reflects the new content. The
 * `coverage_from` is preserved — the window is widened, not replaced. If the page is `draft`, no
 * coverage marker mutation occurs (a draft has no watermark contribution).
 *
 * Side effect: writes 1 version row + updates 1 page row (+ updates 0..N coverage markers). Throws 404
 * when the page is missing. SSE event `wiki_page_updated` is wired in Phase 8 (E8a) — see TODO marker.
 */
export function saveVersion(
  pageId: string,
  input: SaveWikiVersionInput,
  editedBy: string,
): WikiPage {
  const page = wikiPageRepo.getById(pageId);
  if (!page) throw notFound(`Wiki page not found: ${pageId}`);

  const db = getDb();
  const now = new Date().toISOString();
  const newVersionNumber = page.currentVersionNumber + 1;

  db.transaction((tx) => {
    tx.insert(wikiPageVersions)
      .values({
        id: uuid(),
        pageId,
        versionNumber: newVersionNumber,
        title: input.title,
        content: input.content,
        editSummary: input.editSummary ?? null,
        editedBy,
        createdAt: now,
      })
      .run();

    tx.update(wikiPages)
      .set({
        title: input.title,
        content: input.content,
        currentVersionNumber: newVersionNumber,
        lastUpdatedBy: editedBy,
        lastUpdatedAt: now,
        updatedAt: now,
      })
      .where(eq(wikiPages.id, pageId))
      .run();

    if (page.status === "published") {
      tx.update(wikiCoverageMarkers)
        .set({ coverageTo: now })
        .where(
          and(eq(wikiCoverageMarkers.pageId, pageId), eq(wikiCoverageMarkers.markerType, "page")),
        )
        .run();
    }
  });

  const updated = wikiPageRepo.getById(pageId);
  if (!updated) throw notFound(`wikiPage not found after saveVersion: ${pageId}`);

  publishWikiEvent(updated.habitatId, "wiki_page_updated", {
    pageId: updated.id,
    habitatId: updated.habitatId,
    title: updated.title,
    versionNumber: updated.currentVersionNumber,
    status: updated.status,
  });

  return updated;
}

/**
 * Restores an older version of a wiki page as a NEW version (append-only history). The old version row
 * is untouched; the new version copies its `title` and `content` and tags `editSummary` with the
 * source version number. Returns the updated page.
 *
 * Throws 404 when the page or the requested version is missing.
 */
export function restoreVersion(pageId: string, versionNumber: number, editedBy: string): WikiPage {
  const oldVersion = wikiPageVersionRepo.getByPageAndNumber(pageId, versionNumber);
  if (!oldVersion) {
    throw notFound(`Wiki page version not found: pageId=${pageId} versionNumber=${versionNumber}`);
  }
  return saveVersion(
    pageId,
    {
      title: oldVersion.title,
      content: oldVersion.content,
      editSummary: `Restored from version ${versionNumber}`,
    },
    editedBy,
  );
}

/**
 * Adds a polymorphic citation from a wiki page to a source primitive (ADR-0007). `targetType` is
 * validated against `WIKI_LINK_TARGET_TYPES`; the `UNIQUE (page_id, target_type, target_id)` index
 * catches duplicate citations and is translated to a 409. The target row is NOT verified to exist at
 * insert time (no FK on `(target_type, target_id)`); dangling detection runs at read time via
 * {@link listLinks}.
 *
 * Throws 400 when `targetType` is not in the allowlist, 404 when the page is missing, 409 when a
 * citation for the same `(pageId, targetType, targetId)` already exists.
 */
export function addLink(
  pageId: string,
  input: AddWikiPageLinkInput,
  createdBy: string,
): WikiPageLink {
  if (!isValidTargetType(input.targetType)) {
    throw badRequest(
      `Invalid targetType: ${input.targetType}. Must be one of: ${WIKI_LINK_TARGET_TYPES.join(", ")}`,
      { targetType: input.targetType, allowed: WIKI_LINK_TARGET_TYPES },
    );
  }

  if (!wikiPageRepo.getById(pageId)) {
    throw notFound(`Wiki page not found: ${pageId}`);
  }

  try {
    return wikiPageLinkRepo.create({
      pageId,
      targetType: input.targetType,
      targetId: input.targetId,
      linkNote: input.note ?? null,
      createdBy,
    });
  } catch (err) {
    const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
    const isUniqueError =
      (isSqliteError(cause) && cause.code === "SQLITE_CONSTRAINT_UNIQUE") ||
      (cause instanceof Error && /UNIQUE constraint failed/i.test(cause.message));
    if (isUniqueError) {
      throw conflict("Link already exists.", {
        pageId,
        targetType: input.targetType,
        targetId: input.targetId,
      });
    }
    throw err;
  }
}

/**
 * Removes a citation from a wiki page. The link must exist AND belong to the named page; otherwise
 * throws 404. A second 404 check after the repo delete guards against a concurrent-delete race.
 *
 * Throws 404 when the page is missing or the link is missing / owned by a different page.
 */
export function removeLink(pageId: string, linkId: string): void {
  if (!wikiPageRepo.getById(pageId)) {
    throw notFound(`Wiki page not found: ${pageId}`);
  }

  const pageLinks = wikiPageLinkRepo.listByPage(pageId);
  if (!pageLinks.some((l) => l.id === linkId)) {
    throw notFound(`Wiki page link not found: ${linkId} on page ${pageId}`);
  }

  const removed = wikiPageLinkRepo.remove(linkId);
  if (!removed) {
    throw notFound(`Wiki page link not found: ${linkId} on page ${pageId}`);
  }
}

/**
 * Returns all citations from a wiki page, each tagged `dangling: boolean` per ADR-0007
 * (read-time dangling detection — no FK, no background reconciliation). `dangling: true` means the
 * target row in its source table no longer exists.
 *
 * Throws 404 when the page is missing.
 */
export function listLinks(pageId: string): wikiPageLinkRepo.WikiPageLinkWithDangling[] {
  const page = wikiPageRepo.getById(pageId);
  if (!page) throw notFound(`Wiki page not found: ${pageId}`);
  return wikiPageLinkRepo.resolveDangling(wikiPageLinkRepo.listByPage(pageId), page.habitatId);
}

/** Input for {@link postNoUpdateNeeded}. `from` must be ≤ `to`; both are ISO-8601 strings. */
export interface PostNoUpdateNeededInput {
  from: string;
  to: string;
  reason?: string;
}

/**
 * Inserts a `no_update_needed` coverage marker for a habitat (ADR-0009). Holds the cadence watermark
 * across an explicit "no content needs to be authored for this window" decision — used by both the
 * REST route and the `mark_no_update_needed` MCP action. Broadcasts `wiki_coverage_changed` so the UI
 * cadence status panel refreshes.
 *
 * No habitat existence check at the service layer (matches `createPage` and the marker-management
 * paths in `updatePageMetadata` / `deletePage`); FK on `wiki_coverage_markers.habitat_id` enforces
 * referential integrity at the DB level.
 */
export function postNoUpdateNeeded(
  habitatId: string,
  input: PostNoUpdateNeededInput,
  createdBy: string,
): wikiCoverageRepo.WikiCoverageMarker {
  const marker = wikiCoverageRepo.create({
    habitatId,
    coverageFrom: input.from,
    coverageTo: input.to,
    markerType: "no_update_needed",
    pageId: null,
    reason: input.reason ?? null,
    createdBy,
  });

  publishWikiEvent(habitatId, "wiki_coverage_changed", {
    habitatId,
    watermark: wikiCoverageRepo.getWatermark(habitatId),
    markerType: "no_update_needed",
  });

  return marker;
}

/**
 * Free-text search over published pages in a habitat. Thin wrapper around
 * {@link wikiPageRepo.search} (FTS5 + BM25 with LIKE fallback — see the S3a note in
 * `docs/plans/MEMORY.md`). Drafts are never returned.
 */
export function searchPages(
  habitatId: string,
  query: string,
  options: wikiPageRepo.WikiPageSearchOptions = {},
): wikiPageRepo.WikiPageSearchResult[] {
  return wikiPageRepo.search(habitatId, query, options);
}
