/**
 * Extraction work-item repository — logical-work reservation and fenced
 * terminalization.
 *
 * Logical-work identity excludes delivery mode: scheduled and manual
 * deliveries for the same envelope converge on one work item. An explicit
 * fresh rerun creates a new generation and a new logical key.
 *
 * Every `*WithClient` primitive accepts the caller-supplied client and never
 * calls `getDb()`, opens a nested transaction, or emits hooks/SSE/audit.
 */
import { eq, and, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  extractionWorkItems,
} from "../../db/schema/index.js";
import {
  repositoryCreateError,
  repositoryUpdateError,
} from "../../errors/repository.js";
import type { ExtractionWorkItemRow, ExtractionDeliveryMode, ExtractionWorkStatus } from "@orcy/shared";
import type { ExtractionDbClient } from "./types.js";
import { isUniqueConstraintViolation, getChanges } from "./types.js";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface ReserveWorkItemInput {
  habitatId: string;
  policyId: string | null;
  extractorKey: string;
  extractorVersion: number;
  policyVersion: number;
  windowFrom: string;
  windowTo: string;
  sourceBoundaryTokens: Record<string, unknown>;
  logicalWorkKey: string;
  deliveryMode: ExtractionDeliveryMode;
  rerunGeneration?: number;
  supersedesWorkId?: string | null;
  freshReason?: string | null;
  policySnapshot?: Record<string, unknown>;
}

export interface TerminalizeWorkItemInput {
  workItemId: string;
  attemptId: string;
  status: ExtractionWorkStatus;
}

// ---------------------------------------------------------------------------
// Reservation
// ---------------------------------------------------------------------------

/**
 * Reserve one logical work item by `logical_work_key`. Pre-check SELECT for
 * the common replay case; the unique index is the race defender. A concurrent
 * insert surfaces as `already_exists` (re-read), not an exception. Delivery
 * mode is stored for diagnostics but excluded from the unique key identity.
 */
export function reserveWorkItemWithClient(
  db: ExtractionDbClient,
  input: ReserveWorkItemInput,
):
  | { outcome: "created"; workItem: ExtractionWorkItemRow }
  | { outcome: "already_exists"; workItem: ExtractionWorkItemRow }
{
  // Fast path: pre-check SELECT
  const existing = db
    .select()
    .from(extractionWorkItems)
    .where(eq(extractionWorkItems.logicalWorkKey, input.logicalWorkKey))
    .all()[0];
  if (existing) return { outcome: "already_exists", workItem: mapWorkItemRow(existing) };

  const id = uuid();
  try {
    db.insert(extractionWorkItems)
      .values({
        id,
        habitatId: input.habitatId,
        policyId: input.policyId,
        extractorKey: input.extractorKey,
        extractorVersion: input.extractorVersion,
        policyVersion: input.policyVersion,
        windowFrom: input.windowFrom,
        windowTo: input.windowTo,
        sourceBoundaryTokens: input.sourceBoundaryTokens,
        logicalWorkKey: input.logicalWorkKey,
        deliveryMode: input.deliveryMode,
        rerunGeneration: input.rerunGeneration ?? 0,
        supersedesWorkId: input.supersedesWorkId ?? null,
        freshReason: input.freshReason ?? null,
        status: "pending",
        completedByAttemptId: null,
        policySnapshot: input.policySnapshot ?? {},
      })
      .run();
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      const raced = db
        .select()
        .from(extractionWorkItems)
        .where(eq(extractionWorkItems.logicalWorkKey, input.logicalWorkKey))
        .all()[0];
      if (raced) return { outcome: "already_exists", workItem: mapWorkItemRow(raced) };
    }
    throw repositoryCreateError("extractionWorkItem", err as Error, id);
  }

  const created = db
    .select()
    .from(extractionWorkItems)
    .where(eq(extractionWorkItems.id, id))
    .all()[0];
  if (!created) throw repositoryCreateError("extractionWorkItem", undefined, id);
  return { outcome: "created", workItem: mapWorkItemRow(created) };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function getWorkItemByIdWithClient(
  db: ExtractionDbClient,
  workItemId: string,
): ExtractionWorkItemRow | null {
  const row = db
    .select()
    .from(extractionWorkItems)
    .where(eq(extractionWorkItems.id, workItemId))
    .all()[0];
  return row ? mapWorkItemRow(row) : null;
}

export function getWorkItemsByHabitatWithClient(
  db: ExtractionDbClient,
  habitatId: string,
): ExtractionWorkItemRow[] {
  return db
    .select()
    .from(extractionWorkItems)
    .where(eq(extractionWorkItems.habitatId, habitatId))
    .all()
    .map(mapWorkItemRow);
}

// ---------------------------------------------------------------------------
// Fenced terminalization
// ---------------------------------------------------------------------------

/**
 * Terminalize a work item, guarded by the completing attempt's identity.
 *
 * CAS predicate: `id = workItemId AND status IN ('pending','running')
 * AND completed_by_attempt_id IS NULL`. Sets `status`, `completed_by_attempt_id`,
 * and `updated_at` atomically. Only the owned `running → terminal` transition
 * succeeds. A stale or duplicate caller gets `fence_mismatch` or
 * `illegal_source_state` with no mutation.
 */
export function terminalizeWorkItemWithClient(
  db: ExtractionDbClient,
  input: TerminalizeWorkItemInput,
):
  | { outcome: "terminalized"; workItem: ExtractionWorkItemRow }
  | { outcome: "not_found" }
  | { outcome: "illegal_source_state"; workItem: ExtractionWorkItemRow; fromState: string }
  | { outcome: "fence_mismatch"; workItem: ExtractionWorkItemRow }
{
  const now = new Date().toISOString();
  try {
    db.update(extractionWorkItems)
      .set({
        status: input.status,
        completedByAttemptId: input.attemptId,
        updatedAt: now,
      })
      .where(
        and(
          eq(extractionWorkItems.id, input.workItemId),
          sql`${extractionWorkItems.status} IN ('pending', 'running')`,
          sql`${extractionWorkItems.completedByAttemptId} IS NULL`,
        ),
      )
      .run();
  } catch (err) {
    throw repositoryUpdateError("extractionWorkItem", err as Error, input.workItemId);
  }

  const affected = getChanges(db);
  const row = db
    .select()
    .from(extractionWorkItems)
    .where(eq(extractionWorkItems.id, input.workItemId))
    .all()[0];
  if (!row) return { outcome: "not_found" };

  if (affected === 1) return { outcome: "terminalized", workItem: mapWorkItemRow(row) };

  const fromState = row.status;
  if (fromState !== "pending" && fromState !== "running") {
    return { outcome: "illegal_source_state", workItem: mapWorkItemRow(row), fromState };
  }
  // Status is pending/running but the CAS failed: completed_by_attempt_id was
  // already set by another attempt → fence mismatch.
  return { outcome: "fence_mismatch", workItem: mapWorkItemRow(row) };
}

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

type WorkItemDbRow = typeof extractionWorkItems.$inferSelect;

function mapWorkItemRow(row: WorkItemDbRow): ExtractionWorkItemRow {
  return {
    id: row.id,
    habitatId: row.habitatId,
    policyId: row.policyId,
    extractorKey: row.extractorKey,
    extractorVersion: row.extractorVersion,
    policyVersion: row.policyVersion,
    windowFrom: row.windowFrom,
    windowTo: row.windowTo,
    sourceBoundaryTokens: row.sourceBoundaryTokens,
    logicalWorkKey: row.logicalWorkKey,
    rerunGeneration: row.rerunGeneration,
    supersedesWorkId: row.supersedesWorkId,
    freshReason: row.freshReason,
    status: row.status as ExtractionWorkStatus,
    completedByAttemptId: row.completedByAttemptId,
    policySnapshot: row.policySnapshot,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
