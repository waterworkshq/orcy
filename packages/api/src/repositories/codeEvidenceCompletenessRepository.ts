import { getDb } from "../db/index.js";
import { codeEvidenceCompleteness } from "../db/schema/index.js";
import { eq, and } from "drizzle-orm";
import type {
  CodeEvidenceTargetType,
  CodeEvidenceCompletenessStatus,
  CodeEvidenceActorType,
} from "@orcy/shared";

export function getByTarget(targetType: CodeEvidenceTargetType, targetId: string) {
  const db = getDb();
  const row = db
    .select()
    .from(codeEvidenceCompleteness)
    .where(
      and(
        eq(codeEvidenceCompleteness.targetType, targetType),
        eq(codeEvidenceCompleteness.targetId, targetId),
      ),
    )
    .get();
  return row ?? null;
}

export function upsertNotApplicable(input: {
  targetType: CodeEvidenceTargetType;
  targetId: string;
  reasonCode?: string;
  reasonNote?: string;
  markedByType: CodeEvidenceActorType;
  markedById: string;
}) {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = getByTarget(input.targetType, input.targetId);

  if (existing) {
    db.update(codeEvidenceCompleteness)
      .set({
        status: "not_applicable",
        reasonCode: input.reasonCode ?? null,
        reasonNote: input.reasonNote ?? null,
        markedByType: input.markedByType,
        markedById: input.markedById,
        updatedAt: now,
      })
      .where(
        and(
          eq(codeEvidenceCompleteness.targetType, input.targetType),
          eq(codeEvidenceCompleteness.targetId, input.targetId),
        ),
      )
      .run();
  } else {
    db.insert(codeEvidenceCompleteness)
      .values({
        targetType: input.targetType,
        targetId: input.targetId,
        status: "not_applicable",
        reasonCode: input.reasonCode ?? null,
        reasonNote: input.reasonNote ?? null,
        markedByType: input.markedByType,
        markedById: input.markedById,
        updatedAt: now,
      })
      .run();
  }

  return getByTarget(input.targetType, input.targetId);
}

export function clearNotApplicable(targetType: CodeEvidenceTargetType, targetId: string) {
  const db = getDb();
  const result = db
    .delete(codeEvidenceCompleteness)
    .where(
      and(
        eq(codeEvidenceCompleteness.targetType, targetType),
        eq(codeEvidenceCompleteness.targetId, targetId),
      ),
    )
    .run();
  return result.changes > 0;
}
