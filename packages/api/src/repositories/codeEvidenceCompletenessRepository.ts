import { getDb } from "../db/index.js";
import { codeEvidenceCompleteness } from "../db/schema/index.js";
import { eq, and } from "drizzle-orm";
import type { CodeEvidenceTargetType, CodeEvidenceActorType } from "@orcy/shared";
import {
  repositoryCreateError,
  repositoryDeleteError,
  repositoryUpdateError,
} from "../errors/repository.js";

/** Client accepted by the supplied-client completeness primitives (top-level db or a transaction). */
export type CompletenessDbClient = ReturnType<typeof getDb>;

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

export function getByTargetWithClient(
  client: CompletenessDbClient,
  targetType: CodeEvidenceTargetType,
  targetId: string,
) {
  const row = client
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
    try {
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
    } catch (err) {
      throw repositoryUpdateError("codeEvidenceCompleteness", err as Error, input.targetId);
    }
  } else {
    try {
      db.insert(codeEvidenceCompleteness)
        .values({
          targetType: input.targetType,
          targetId: input.targetId,
          status: "not_applicable",
          reasonCode: input.reasonCode ?? null,
          reasonNote: input.reasonNote ?? null,
          markedByType: input.markedByType,
          markedById: input.markedById,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } catch (err) {
      throw repositoryCreateError("codeEvidenceCompleteness", err as Error, input.targetId);
    }
  }

  return getByTarget(input.targetType, input.targetId);
}

export function clearNotApplicable(targetType: CodeEvidenceTargetType, targetId: string) {
  const db = getDb();
  try {
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
  } catch (err) {
    throw repositoryDeleteError("codeEvidenceCompleteness", err as Error, targetId);
  }
}

// ---------------------------------------------------------------------------
// Supplied-client primitives for the transactional mark/clear compatibility
// adapters. The mark compatibility check + canonical upsert and the clear
// equivalent deletes each compose ONE immediate transaction in the service
// layer; these primitives run flat on that client.
// ---------------------------------------------------------------------------

/** Upserts the not-applicable override on the supplied client, inside the caller's transaction. */
export function upsertNotApplicableWithClient(
  client: CompletenessDbClient,
  input: {
    targetType: CodeEvidenceTargetType;
    targetId: string;
    reasonCode?: string;
    reasonNote?: string;
    markedByType: CodeEvidenceActorType;
    markedById: string;
  },
) {
  const now = new Date().toISOString();
  const existing = getByTargetWithClient(client, input.targetType, input.targetId);

  if (existing) {
    try {
      client
        .update(codeEvidenceCompleteness)
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
    } catch (err) {
      throw repositoryUpdateError("codeEvidenceCompleteness", err as Error, input.targetId);
    }
  } else {
    try {
      client
        .insert(codeEvidenceCompleteness)
        .values({
          targetType: input.targetType,
          targetId: input.targetId,
          status: "not_applicable",
          reasonCode: input.reasonCode ?? null,
          reasonNote: input.reasonNote ?? null,
          markedByType: input.markedByType,
          markedById: input.markedById,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } catch (err) {
      throw repositoryCreateError("codeEvidenceCompleteness", err as Error, input.targetId);
    }
  }

  return getByTargetWithClient(client, input.targetType, input.targetId);
}

/** Deletes the override for one exact stored target pair on the supplied client. */
export function deleteByTargetWithClient(
  client: CompletenessDbClient,
  targetType: CodeEvidenceTargetType,
  targetId: string,
): number {
  // Count-before-delete: `run()` does not report `changes` on the sql.js
  // driver, so existence is established with a select on the same client
  // inside the caller's transaction.
  const existing = getByTargetWithClient(client, targetType, targetId);
  if (!existing) return 0;
  try {
    client
      .delete(codeEvidenceCompleteness)
      .where(
        and(
          eq(codeEvidenceCompleteness.targetType, targetType),
          eq(codeEvidenceCompleteness.targetId, targetId),
        ),
      )
      .run();
  } catch (err) {
    throw repositoryDeleteError("codeEvidenceCompleteness", err as Error, targetId);
  }
  return 1;
}
