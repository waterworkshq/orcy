/**
 * Extraction repository shared types.
 *
 * Defines the caller-owned DB client type, closed result-union shapes, and
 * the cross-backend unique-constraint detector used by every extraction
 * repository module.
 *
 * Conventions (mirrors `taskPublication.ts` / `scheduledOccurrences.ts`):
 * - `*WithClient` primitives accept the caller-supplied client and never call
 *   `getDb()`, open nested transactions, or emit hooks/SSE/audit.
 * - Expected domain outcomes are discriminated unions, never thrown exceptions.
 * - `SELECT changes()` is used for portable affected-row classification.
 * - The unique-constraint detector recognises both SQLite error shapes.
 */
import { getDb } from "../../db/index.js";
import { isSqliteError } from "../../errors/sqlite.js";
import type {
  LearningLoopPolicyRow,
  ExtractionWorkItemRow,
  ExtractionAttemptRow,
  ExtractedFindingRow,
  ExtractedFindingSourceRow,
  ExtractedFindingScopeRefRow,
  ExtractedFindingReviewRow,
  ExtractedFindingPromotionRow,
} from "@orcy/shared";

/**
 * Drizzle client accepted by every `*WithClient` primitive in this module set.
 * The default `getDb()` client and a transactional `tx` from
 * `db.transaction(cb)` both satisfy this shape.
 */
export type ExtractionDbClient = ReturnType<typeof getDb>;

// ---------------------------------------------------------------------------
// Row re-exports for repository consumers
// ---------------------------------------------------------------------------

export type {
  LearningLoopPolicyRow,
  ExtractionWorkItemRow,
  ExtractionAttemptRow,
  ExtractedFindingRow,
  ExtractedFindingSourceRow,
  ExtractedFindingScopeRefRow,
  ExtractedFindingReviewRow,
  ExtractedFindingPromotionRow,
};

// ---------------------------------------------------------------------------
// Closed result unions
// ---------------------------------------------------------------------------

/** Outcome of reserving a logical work item by `logical_work_key`. */
export type ReserveWorkItemResult =
  | { outcome: "created"; workItem: ExtractionWorkItemRow }
  | { outcome: "already_exists"; workItem: ExtractionWorkItemRow };

/** Outcome of fenced attempt terminalization. */
export type TerminalizeAttemptResult =
  | { outcome: "terminalized"; attempt: ExtractionAttemptRow; workItem: ExtractionWorkItemRow }
  | { outcome: "not_found" }
  | { outcome: "illegal_source_state"; attempt: ExtractionAttemptRow; fromState: string }
  | { outcome: "fence_mismatch"; attempt: ExtractionAttemptRow };

/** Outcome of fenced work-item terminalization. */
export type TerminalizeWorkItemResult =
  | { outcome: "terminalized"; workItem: ExtractionWorkItemRow }
  | { outcome: "not_found" }
  | { outcome: "illegal_source_state"; workItem: ExtractionWorkItemRow; fromState: string }
  | { outcome: "fence_mismatch"; workItem: ExtractionWorkItemRow };

/** Outcome of persisting one candidate finding transactionally. */
export type PersistCandidateResult =
  | { outcome: "created"; finding: ExtractedFindingRow }
  | { outcome: "recurrence"; finding: ExtractedFindingRow }
  | { outcome: "fence_mismatch"; attempt: ExtractionAttemptRow };

/** Outcome of a review compare-and-set. */
export type ReviewCasResult =
  | { outcome: "decided"; review: ExtractedFindingReviewRow; finding: ExtractedFindingRow }
  | { outcome: "version_conflict"; finding: ExtractedFindingRow };

/** Outcome of promotion reservation by `(finding_id, destination_type, destination_key)`. */
export type ReservePromotionResult =
  | { outcome: "created"; promotion: ExtractedFindingPromotionRow }
  | { outcome: "already_exists"; promotion: ExtractedFindingPromotionRow };

/** Outcome of fenced promotion terminalization. */
export type TerminalizePromotionResult =
  | { outcome: "terminalized"; promotion: ExtractedFindingPromotionRow }
  | { outcome: "not_found" }
  | { outcome: "illegal_source_state"; promotion: ExtractedFindingPromotionRow; fromState: string }
  | { outcome: "fence_mismatch"; promotion: ExtractedFindingPromotionRow };

// ---------------------------------------------------------------------------
// Cross-backend unique-constraint detector
// ---------------------------------------------------------------------------

const UNIQUE_CONSTRAINT_RE = /UNIQUE constraint failed/i;

/**
 * Cross-backend UNIQUE-constraint detector (mirrors the pattern in
 * `taskCreationAttempts.ts` / `scheduledOccurrences.ts`). better-sqlite3
 * (production) throws a `SqliteError` with `code: "SQLITE_CONSTRAINT_UNIQUE"`;
 * sql.js (test) throws a plain `Error` whose `.message` matches the regex;
 * drizzle-orm wraps better-sqlite3 errors and puts the real error on `.cause`.
 */
export function isUniqueConstraintViolation(err: unknown): boolean {
  if (isSqliteError(err) && err.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  if (err instanceof Error && UNIQUE_CONSTRAINT_RE.test(err.message)) return true;
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error) {
    if (isSqliteError(cause) && cause.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
    if (UNIQUE_CONSTRAINT_RE.test(cause.message)) return true;
  }
  return false;
}

/**
 * Portable affected-row count from `SELECT changes()`. Drizzle `run().changes`
 * is `undefined` on sql.js; `SELECT changes()` works on both backends.
 */
export function getChanges(db: ExtractionDbClient): number {
  return db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
}

// ---------------------------------------------------------------------------
// DB row mappers (raw row → typed projection)
// ---------------------------------------------------------------------------

/** Type for the raw Drizzle row from `learning_loop_policies`. */
export type LearningLoopPolicyDbRow = typeof import("../../db/schema/extraction.js").learningLoopPolicies.$inferSelect;

/** Map a raw DB row to a typed policy projection. */
export function mapPolicyRow(row: LearningLoopPolicyDbRow): LearningLoopPolicyRow {
  return {
    id: row.id,
    habitatId: row.habitatId,
    extractorKey: row.extractorKey,
    enabled: row.enabled === 1,
    sourceTypes: row.sourceTypes,
    schedule: row.schedule,
    windowSeconds: row.windowSeconds,
    lookbackSeconds: row.lookbackSeconds,
    minConfidence: row.minConfidence,
    minSampleSize: row.minSampleSize,
    config: row.config,
    version: row.version,
    createdByType: row.createdByType as "human" | "agent" | "system",
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Input: import sql lazily to avoid circular dependencies at module init
// ---------------------------------------------------------------------------

import { sql } from "drizzle-orm";
