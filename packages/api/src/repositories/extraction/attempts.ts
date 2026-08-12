/**
 * Extraction attempt repository — creation/acquisition with monotonic attempt
 * number, lease generation fencing, and guarded terminalization.
 *
 * Only the attempt holding the current lease generation may persist candidates
 * or terminalize. A stale fence returns a closed losing outcome and changes
 * nothing.
 *
 * Every `*WithClient` primitive accepts the caller-supplied client and never
 * calls `getDb()`, opens a nested transaction, or emits hooks/SSE/audit.
 */
import { eq, and, max, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { extractionAttempts } from "../../db/schema/index.js";
import {
  repositoryCreateError,
  repositoryUpdateError,
} from "../../errors/repository.js";
import type {
  ExtractionAttemptRow,
  ExtractionDeliveryMode,
  ExtractionAttemptStatus,
} from "@orcy/shared";
import type { ExtractionDbClient } from "./types.js";
import { isUniqueConstraintViolation, getChanges } from "./types.js";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateAttemptInput {
  workItemId: string;
  parentAttemptId?: string | null;
  deliveryMode: ExtractionDeliveryMode;
  leaseOwner: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
}

export interface TerminalizeAttemptInput {
  attemptId: string;
  workItemId: string;
  leaseOwner: string;
  leaseGeneration: number;
  status: ExtractionAttemptStatus;
  candidateCount?: number;
  persistedCount?: number;
  deduplicatedCount?: number;
  error?: string | null;
  /** Per-source diagnostics to persist on the attempt (B8 fix). */
  sourceSnapshot?: Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Create attempt with monotonic attempt number
// ---------------------------------------------------------------------------

export type CreateAttemptResult =
  | { outcome: "created"; attempt: ExtractionAttemptRow }
  | { outcome: "already_exists"; attempt: ExtractionAttemptRow };

/**
 * Create a new physical attempt with a monotonic attempt number derived from
 * `MAX(attempt_no) + 1` for the given work item. The unique index on
 * `(work_item_id, attempt_no)` is the race defender for concurrent creates.
 */
export function createAttemptWithClient(
  db: ExtractionDbClient,
  input: CreateAttemptInput,
): CreateAttemptResult {
  // Derive next attempt_no from the current max
  const maxResult = db
    .select({ maxNo: max(extractionAttempts.attemptNo) })
    .from(extractionAttempts)
    .where(eq(extractionAttempts.workItemId, input.workItemId))
    .all()[0];
  const attemptNo = (maxResult?.maxNo ?? 0) + 1;

  const id = uuid();
  const now = new Date().toISOString();
  try {
    db.insert(extractionAttempts)
      .values({
        id,
        workItemId: input.workItemId,
        attemptNo,
        parentAttemptId: input.parentAttemptId ?? null,
        deliveryMode: input.deliveryMode,
        leaseOwner: input.leaseOwner,
        leaseGeneration: input.leaseGeneration,
        leaseExpiresAt: input.leaseExpiresAt,
        sourceSnapshot: [],
        status: "running",
        candidateCount: 0,
        persistedCount: 0,
        deduplicatedCount: 0,
        error: null,
        startedAt: now,
        completedAt: null,
      })
      .run();
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      // A concurrent create raced for the same attempt_no — re-read by
      // (work_item_id, attempt_no) to return the winner.
      const raced = db
        .select()
        .from(extractionAttempts)
        .where(
          and(
            eq(extractionAttempts.workItemId, input.workItemId),
            eq(extractionAttempts.attemptNo, attemptNo),
          ),
        )
        .all()[0];
      if (raced) return { outcome: "already_exists", attempt: mapAttemptRow(raced) };
    }
    throw repositoryCreateError("extractionAttempt", err as Error, id);
  }

  const created = db
    .select()
    .from(extractionAttempts)
    .where(eq(extractionAttempts.id, id))
    .all()[0];
  if (!created) throw repositoryCreateError("extractionAttempt", undefined, id);
  return { outcome: "created", attempt: mapAttemptRow(created) };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function getAttemptByIdWithClient(
  db: ExtractionDbClient,
  attemptId: string,
): ExtractionAttemptRow | null {
  const row = db
    .select()
    .from(extractionAttempts)
    .where(eq(extractionAttempts.id, attemptId))
    .all()[0];
  return row ? mapAttemptRow(row) : null;
}

export function getAttemptsByWorkItemWithClient(
  db: ExtractionDbClient,
  workItemId: string,
): ExtractionAttemptRow[] {
  return db
    .select()
    .from(extractionAttempts)
    .where(eq(extractionAttempts.workItemId, workItemId))
    .all()
    .map(mapAttemptRow);
}

/** Get the latest attempt for a work item (highest attempt_no). */
export function getLatestAttemptWithClient(
  db: ExtractionDbClient,
  workItemId: string,
): ExtractionAttemptRow | null {
  const rows = db
    .select()
    .from(extractionAttempts)
    .where(eq(extractionAttempts.workItemId, workItemId))
    .orderBy(sql`${extractionAttempts.attemptNo} DESC`)
    .all();
  return rows.length > 0 ? mapAttemptRow(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Fenced terminalization
// ---------------------------------------------------------------------------

export type TerminalizeAttemptResult =
  | { outcome: "terminalized"; attempt: ExtractionAttemptRow }
  | { outcome: "not_found" }
  | { outcome: "illegal_source_state"; attempt: ExtractionAttemptRow; fromState: string }
  | { outcome: "fence_mismatch"; attempt: ExtractionAttemptRow };

/**
 * Terminalize a running attempt guarded by lease owner and lease generation.
 *
 * CAS predicate: `id = attemptId AND work_item_id = workItemId AND
 * status = 'running' AND lease_owner = leaseOwner AND
 * lease_generation = leaseGeneration`. A stale owner or generation fails the
 * CAS and returns `fence_mismatch`. A non-running attempt returns
 * `illegal_source_state`. Only the owned `running → terminal` transition
 * succeeds.
 */
export function terminalizeAttemptWithClient(
  db: ExtractionDbClient,
  input: TerminalizeAttemptInput,
): TerminalizeAttemptResult {
  const now = new Date().toISOString();
  const updates: Record<string, unknown> = {
    status: input.status,
    completedAt: now,
    updatedAt: now,
  };
  if (input.candidateCount !== undefined) updates.candidateCount = input.candidateCount;
  if (input.persistedCount !== undefined) updates.persistedCount = input.persistedCount;
  if (input.deduplicatedCount !== undefined) updates.deduplicatedCount = input.deduplicatedCount;
  if (input.error !== undefined) updates.error = input.error;
  if (input.sourceSnapshot !== undefined) updates.sourceSnapshot = input.sourceSnapshot;

  try {
    db.update(extractionAttempts)
      .set(updates)
      .where(
        and(
          eq(extractionAttempts.id, input.attemptId),
          eq(extractionAttempts.workItemId, input.workItemId),
          eq(extractionAttempts.status, "running"),
          eq(extractionAttempts.leaseOwner, input.leaseOwner),
          eq(extractionAttempts.leaseGeneration, input.leaseGeneration),
        ),
      )
      .run();
  } catch (err) {
    throw repositoryUpdateError("extractionAttempt", err as Error, input.attemptId);
  }

  const affected = getChanges(db);
  const row = db
    .select()
    .from(extractionAttempts)
    .where(eq(extractionAttempts.id, input.attemptId))
    .all()[0];
  if (!row) return { outcome: "not_found" };

  if (affected === 1) return { outcome: "terminalized", attempt: mapAttemptRow(row) };

  const fromState = row.status;
  if (fromState !== "running") {
    return { outcome: "illegal_source_state", attempt: mapAttemptRow(row), fromState };
  }
  // Status is 'running' but the CAS failed: lease owner or generation mismatch.
  return { outcome: "fence_mismatch", attempt: mapAttemptRow(row) };
}

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

type AttemptDbRow = typeof extractionAttempts.$inferSelect;

function mapAttemptRow(row: AttemptDbRow): ExtractionAttemptRow {
  return {
    id: row.id,
    workItemId: row.workItemId,
    attemptNo: row.attemptNo,
    parentAttemptId: row.parentAttemptId,
    deliveryMode: row.deliveryMode as ExtractionDeliveryMode,
    leaseOwner: row.leaseOwner,
    leaseGeneration: row.leaseGeneration,
    leaseExpiresAt: row.leaseExpiresAt,
    sourceSnapshot: row.sourceSnapshot,
    status: row.status as ExtractionAttemptStatus,
    candidateCount: row.candidateCount,
    persistedCount: row.persistedCount,
    deduplicatedCount: row.deduplicatedCount,
    error: row.error,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
