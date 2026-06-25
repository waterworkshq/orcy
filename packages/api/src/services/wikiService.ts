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
import type { WikiPage, WikiPageLink, WikiPageStatus } from "@orcy/shared";

export type { WikiPage, WikiPageLink, WikiPageStatus };

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

  // TODO: SSE wiki_page_created
  const page = wikiPageRepo.getById(pageId);
  if (!page) throw notFound(`wikiPage not found after insert: ${pageId}`);
  return page;
}

/**
 * Fetches a page with its links resolved (each link tagged `dangling: boolean` per ADR-0007).
 * Throws 404 when the page is missing.
 */
export function getPage(pageId: string): WikiPageWithLinks {
  const page = wikiPageRepo.getById(pageId);
  if (!page) throw notFound(`Wiki page not found: ${pageId}`);

  const links = wikiPageLinkRepo.resolveDangling(wikiPageLinkRepo.listByPage(pageId));
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

  if (patch.parentId !== undefined && patch.parentId !== page.parentId) {
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

    const nextStatus: WikiPageStatus | undefined = patch.status;
    const isPublishing = nextStatus === "published" && page.status !== "published";
    const isUnpublishing = nextStatus === "draft" && page.status === "published";

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

  // TODO: SSE wiki_page_updated (on status change)

  const updated = wikiPageRepo.getById(pageId);
  if (!updated) throw notFound(`wikiPage not found after update: ${pageId}`);
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

  // TODO: SSE wiki_page_deleted
}
