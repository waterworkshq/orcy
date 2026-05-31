import { getDb } from "../db/index.js";
import { codeEvidenceCompleteness } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import type {
  CodeEvidenceTargetType,
  CodeEvidenceCompletenessStatus,
  CodeEvidenceActorType,
} from "@orcy/shared";

export function getByTarget(targetType: CodeEvidenceTargetType, targetId: string) {
  const db = getDb();
  const rows = db
    .select()
    .from(codeEvidenceCompleteness)
    .where(eq(codeEvidenceCompleteness.targetType, targetType))
    .all();
  const match = rows.find((r) => r.targetId === targetId);
  return match ?? null;
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
      .where(eq(codeEvidenceCompleteness.targetType, input.targetType))
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
  db.delete(codeEvidenceCompleteness)
    .where(eq(codeEvidenceCompleteness.targetType, targetType))
    .run();
  return null;
}
