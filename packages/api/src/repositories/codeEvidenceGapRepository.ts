import { getDb } from "../db/index.js";
import { codeEvidenceGaps } from "../db/schema/index.js";
import { eq, and, sql, inArray } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type {
  CodeEvidenceTargetType,
  CodeEvidenceGapStatus,
  CodeEvidenceActorType,
} from "@orcy/shared";
import { repositoryCreateError, repositoryUpdateError } from "../errors/repository.js";

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

export function resolveGap(
  id: string,
  resolvedByType: CodeEvidenceActorType,
  resolvedById: string,
  resolutionReason: string,
) {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    db.update(codeEvidenceGaps)
      .set({
        status: "resolved",
        resolvedByType,
        resolvedById,
        resolvedAt: now,
        resolutionReason,
      })
      .where(eq(codeEvidenceGaps.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("codeEvidenceGap", err as Error, id);
  }

  return getById(id);
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
