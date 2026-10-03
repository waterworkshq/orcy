import { getDb } from "../db/index.js";
import { codeEvidenceGaps } from "../db/schema/index.js";
import { eq, and, sql, inArray, desc, asc } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { CodeEvidenceTargetType, CodeEvidenceActorType } from "@orcy/shared";
import { repositoryCreateError, repositoryUpdateError } from "../errors/repository.js";

/** Client accepted by the supplied-client gap primitives (top-level db or a transaction). */
export type GapDbClient = ReturnType<typeof getDb>;

const DEFAULT_TARGET_LIST_LIMIT = 100;

export function getById(id: string) {
  const db = getDb();
  const rows = db.select().from(codeEvidenceGaps).where(eq(codeEvidenceGaps.id, id)).all();
  return rows.length > 0 ? rows[0] : null;
}

export function getActiveByTarget(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  options?: { limit?: number },
) {
  const db = getDb();
  const limit = options?.limit ?? DEFAULT_TARGET_LIST_LIMIT;
  return db
    .select()
    .from(codeEvidenceGaps)
    .where(
      and(
        eq(codeEvidenceGaps.targetType, targetType),
        eq(codeEvidenceGaps.targetId, targetId),
        eq(codeEvidenceGaps.status, "active"),
      ),
    )
    // Deterministic capped order: newest reportedAt first, ascending row id on ties.
    .orderBy(desc(codeEvidenceGaps.reportedAt), asc(codeEvidenceGaps.id))
    .limit(limit)
    .all();
}

export function getResolvedByTarget(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  options?: { limit?: number },
) {
  const db = getDb();
  const limit = options?.limit ?? DEFAULT_TARGET_LIST_LIMIT;
  return db
    .select()
    .from(codeEvidenceGaps)
    .where(
      and(
        eq(codeEvidenceGaps.targetType, targetType),
        eq(codeEvidenceGaps.targetId, targetId),
        eq(codeEvidenceGaps.status, "resolved"),
      ),
    )
    // Deterministic capped order: newest resolvedAt first, ascending row id on ties.
    .orderBy(desc(codeEvidenceGaps.resolvedAt), asc(codeEvidenceGaps.id))
    .limit(limit)
    .all();
}

export function create(input: {
  targetType: CodeEvidenceTargetType;
  targetId: string;
  reasonCode: string;
  reasonNote?: string;
  reportedByType: CodeEvidenceActorType;
  reportedById: string;
  metadata?: Record<string, unknown>;
}) {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(codeEvidenceGaps)
      .values({
        id,
        targetType: input.targetType,
        targetId: input.targetId,
        reasonCode: input.reasonCode,
        reasonNote: input.reasonNote ?? null,
        status: "active",
        reportedByType: input.reportedByType,
        reportedById: input.reportedById,
        reportedAt: now,
        resolvedByType: null,
        resolvedById: null,
        resolvedAt: null,
        resolutionReason: null,
        metadata: input.metadata ?? {},
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("codeEvidenceGap", err as Error, id);
  }

  return getById(id);
}

/**
 * Marks a source gap resolved. Like {@link import("./codeEvidenceLinkRepository.js").correctLink},
 * the update is fenced on the gap's polymorphic target pair as well as its id,
 * and the returned row is the one the UPDATE actually changed (or null).
 */
export function resolveGap(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  id: string,
  resolvedByType: CodeEvidenceActorType,
  resolvedById: string,
  resolutionReason: string,
) {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    const matched = db
      .update(codeEvidenceGaps)
      .set({
        status: "resolved",
        resolvedByType,
        resolvedById,
        resolvedAt: now,
        resolutionReason,
      })
      .where(
        and(
          eq(codeEvidenceGaps.id, id),
          eq(codeEvidenceGaps.targetType, targetType),
          eq(codeEvidenceGaps.targetId, targetId),
        ),
      )
      .returning()
      .all();
    return matched.length > 0 ? matched[0] : null;
  } catch (err) {
    throw repositoryUpdateError("codeEvidenceGap", err as Error, id);
  }
}

export function countActiveByTarget(targetType: CodeEvidenceTargetType, targetId: string) {
  const db = getDb();
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(codeEvidenceGaps)
    .where(
      and(
        eq(codeEvidenceGaps.targetType, targetType),
        eq(codeEvidenceGaps.targetId, targetId),
        eq(codeEvidenceGaps.status, "active"),
      ),
    )
    .get();
  return result?.count ?? 0;
}

export function autoResolveByReasonCodes(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  reasonCodes: string[],
) {
  if (reasonCodes.length === 0) return;

  const db = getDb();
  const now = new Date().toISOString();

  try {
    db.update(codeEvidenceGaps)
      .set({
        status: "resolved",
        resolvedByType: "system",
        resolvedById: "auto",
        resolvedAt: now,
        resolutionReason: "Auto-resolved: evidence linked",
      })
      .where(
        and(
          eq(codeEvidenceGaps.targetType, targetType),
          eq(codeEvidenceGaps.targetId, targetId),
          inArray(codeEvidenceGaps.reasonCode, reasonCodes),
          eq(codeEvidenceGaps.status, "active"),
        ),
      )
      .run();
  } catch (err) {
    throw repositoryUpdateError("codeEvidenceGap", err as Error, targetId);
  }
}

// ---------------------------------------------------------------------------
// Supplied-client primitive for the opted-in local report write bundle.
// ---------------------------------------------------------------------------

/**
 * Auto-resolves matching active gaps on the supplied client inside the
 * caller's transaction. Canonical URL-pair only: legacy alias gap rows are
 * resolved explicitly by resource id, never silently by canonical linking.
 */
export function autoResolveByReasonCodesWithClient(
  client: GapDbClient,
  targetType: CodeEvidenceTargetType,
  targetId: string,
  reasonCodes: string[],
) {
  if (reasonCodes.length === 0) return;

  const now = new Date().toISOString();
  try {
    client
      .update(codeEvidenceGaps)
      .set({
        status: "resolved",
        resolvedByType: "system",
        resolvedById: "auto",
        resolvedAt: now,
        resolutionReason: "Auto-resolved: evidence linked",
      })
      .where(
        and(
          eq(codeEvidenceGaps.targetType, targetType),
          eq(codeEvidenceGaps.targetId, targetId),
          inArray(codeEvidenceGaps.reasonCode, reasonCodes),
          eq(codeEvidenceGaps.status, "active"),
        ),
      )
      .run();
  } catch (err) {
    throw repositoryUpdateError("codeEvidenceGap", err as Error, targetId);
  }
}

/** Exact resolved-gap population count for a stored target pair (independent of list caps). */
export function countResolvedByTarget(targetType: CodeEvidenceTargetType, targetId: string) {
  const db = getDb();
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(codeEvidenceGaps)
    .where(
      and(
        eq(codeEvidenceGaps.targetType, targetType),
        eq(codeEvidenceGaps.targetId, targetId),
        eq(codeEvidenceGaps.status, "resolved"),
      ),
    )
    .get();
  return result?.count ?? 0;
}
