/**
 * Extraction promotions repository — idempotent reservation and fenced
 * terminalization.
 *
 * One row per `(finding_id, destination_type, destination_key)`. Replay
 * returns the existing row. A stale owner cannot complete it. The CAS uses
 * `SELECT changes()` for portable affected-row classification.
 *
 * Every `*WithClient` primitive accepts the caller-supplied client and never
 * calls `getDb()`, opens a nested transaction, or emits hooks/SSE/audit.
 */
import { eq, and, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { extractedFindingPromotions } from "../../db/schema/index.js";
import { repositoryCreateError, repositoryUpdateError } from "../../errors/repository.js";
import type {
  ExtractedFindingPromotionRow,
  ExtractionPromotionDestination,
  ExtractionPromotionStatus,
} from "@orcy/shared";
import type { ExtractionDbClient } from "./types.js";
import { isUniqueConstraintViolation, getChanges } from "./types.js";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface ReservePromotionInput {
  findingId: string;
  destinationType: ExtractionPromotionDestination;
  destinationKey: string;
  idempotencyKey: string;
  leaseOwner: string;
  leaseGeneration: number;
  consumedFindingRevision: number;
}

export interface TerminalizePromotionInput {
  promotionId: string;
  leaseOwner: string;
  leaseGeneration: number;
  status: "succeeded" | "failed";
  targetType?: string | null;
  targetId?: string | null;
  targetVersion?: string | null;
  error?: string | null;
}

// ---------------------------------------------------------------------------
// Reservation
// ---------------------------------------------------------------------------

export type ReservePromotionResult =
  | { outcome: "created"; promotion: ExtractedFindingPromotionRow }
  | { outcome: "already_exists"; promotion: ExtractedFindingPromotionRow };

/**
 * Reserve one promotion row for `(finding_id, destination_type,
 * destination_key)`. Pre-check SELECT for the common replay case; the unique
 * index is the race defender. A concurrent insert surfaces as `already_exists`
 * (re-read), not an exception. This is the at-most-once contract: one row per
 * finding revision plus destination key.
 */
export function reservePromotionWithClient(
  db: ExtractionDbClient,
  input: ReservePromotionInput,
): ReservePromotionResult {
  // Fast path: pre-check SELECT
  const existing = db
    .select()
    .from(extractedFindingPromotions)
    .where(
      and(
        eq(extractedFindingPromotions.findingId, input.findingId),
        eq(extractedFindingPromotions.destinationType, input.destinationType),
        eq(extractedFindingPromotions.destinationKey, input.destinationKey),
      ),
    )
    .all()[0];
  if (existing) return { outcome: "already_exists", promotion: mapPromotionRow(existing) };

  const id = uuid();
  try {
    db.insert(extractedFindingPromotions)
      .values({
        id,
        findingId: input.findingId,
        destinationType: input.destinationType,
        destinationKey: input.destinationKey,
        status: "pending",
        idempotencyKey: input.idempotencyKey,
        leaseOwner: input.leaseOwner,
        leaseGeneration: input.leaseGeneration,
        targetType: null,
        targetId: null,
        targetVersion: null,
        consumedFindingRevision: input.consumedFindingRevision,
        error: null,
        completedAt: null,
      })
      .run();
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      const raced = db
        .select()
        .from(extractedFindingPromotions)
        .where(
          and(
            eq(extractedFindingPromotions.findingId, input.findingId),
            eq(extractedFindingPromotions.destinationType, input.destinationType),
            eq(extractedFindingPromotions.destinationKey, input.destinationKey),
          ),
        )
        .all()[0];
      if (raced) return { outcome: "already_exists", promotion: mapPromotionRow(raced) };
    }
    throw repositoryCreateError("extractedFindingPromotion", err as Error, id);
  }

  const created = db
    .select()
    .from(extractedFindingPromotions)
    .where(eq(extractedFindingPromotions.id, id))
    .all()[0];
  if (!created) throw repositoryCreateError("extractedFindingPromotion", undefined, id);
  return { outcome: "created", promotion: mapPromotionRow(created) };
}

// ---------------------------------------------------------------------------
// Fenced terminalization
// ---------------------------------------------------------------------------

export type TerminalizePromotionResult =
  | { outcome: "terminalized"; promotion: ExtractedFindingPromotionRow }
  | { outcome: "not_found" }
  | { outcome: "illegal_source_state"; promotion: ExtractedFindingPromotionRow; fromState: string }
  | { outcome: "fence_mismatch"; promotion: ExtractedFindingPromotionRow };

/**
 * Terminalize a promotion guarded by lease owner and lease generation.
 *
 * CAS predicate: `id = promotionId AND status = 'pending' AND
 * lease_owner = leaseOwner AND lease_generation = leaseGeneration`. A stale
 * owner or generation fails the CAS and returns `fence_mismatch`. A non-pending
 * promotion returns `illegal_source_state`. Only the owned `pending → terminal`
 * transition succeeds.
 */
export function terminalizePromotionWithClient(
  db: ExtractionDbClient,
  input: TerminalizePromotionInput,
): TerminalizePromotionResult {
  const now = new Date().toISOString();
  const updates: Record<string, unknown> = {
    status: input.status,
    completedAt: now,
    updatedAt: now,
  };
  if (input.targetType !== undefined) updates.targetType = input.targetType;
  if (input.targetId !== undefined) updates.targetId = input.targetId;
  if (input.targetVersion !== undefined) updates.targetVersion = input.targetVersion;
  if (input.error !== undefined) updates.error = input.error;

  try {
    db.update(extractedFindingPromotions)
      .set(updates)
      .where(
        and(
          eq(extractedFindingPromotions.id, input.promotionId),
          eq(extractedFindingPromotions.status, "pending"),
          eq(extractedFindingPromotions.leaseOwner, input.leaseOwner),
          eq(extractedFindingPromotions.leaseGeneration, input.leaseGeneration),
        ),
      )
      .run();
  } catch (err) {
    throw repositoryUpdateError("extractedFindingPromotion", err as Error, input.promotionId);
  }

  const affected = getChanges(db);
  const row = db
    .select()
    .from(extractedFindingPromotions)
    .where(eq(extractedFindingPromotions.id, input.promotionId))
    .all()[0];
  if (!row) return { outcome: "not_found" };

  if (affected === 1) return { outcome: "terminalized", promotion: mapPromotionRow(row) };

  const fromState = row.status;
  if (fromState !== "pending") {
    return { outcome: "illegal_source_state", promotion: mapPromotionRow(row), fromState };
  }
  // Status is 'pending' but the CAS failed: lease owner or generation mismatch.
  return { outcome: "fence_mismatch", promotion: mapPromotionRow(row) };
}

// ---------------------------------------------------------------------------
// Target recording (stays pending, fenced by lease)
// ---------------------------------------------------------------------------

export interface RecordPromotionTargetInput {
  promotionId: string;
  leaseOwner: string;
  leaseGeneration: number;
  targetType: string;
  targetId: string;
  targetVersion: string;
}

export type RecordPromotionTargetResult =
  | { outcome: "recorded"; promotion: ExtractedFindingPromotionRow }
  | { outcome: "not_found" }
  | { outcome: "illegal_source_state"; promotion: ExtractedFindingPromotionRow; fromState: string }
  | { outcome: "fence_mismatch"; promotion: ExtractedFindingPromotionRow };

/**
 * Record the created destination target on a pending promotion row without
 * terminalizing. This lets a retry detect a page created in a prior attempt
 * (targetId is set) and skip page creation, preventing duplicates.
 *
 * CAS predicate: `id = promotionId AND status = 'pending' AND
 * lease_owner = leaseOwner AND lease_generation = leaseGeneration`.
 */
export function recordPromotionTargetWithClient(
  db: ExtractionDbClient,
  input: RecordPromotionTargetInput,
): RecordPromotionTargetResult {
  const now = new Date().toISOString();
  try {
    db.update(extractedFindingPromotions)
      .set({
        targetType: input.targetType,
        targetId: input.targetId,
        targetVersion: input.targetVersion,
        updatedAt: now,
      })
      .where(
        and(
          eq(extractedFindingPromotions.id, input.promotionId),
          eq(extractedFindingPromotions.status, "pending"),
          eq(extractedFindingPromotions.leaseOwner, input.leaseOwner),
          eq(extractedFindingPromotions.leaseGeneration, input.leaseGeneration),
        ),
      )
      .run();
  } catch (err) {
    throw repositoryUpdateError("extractedFindingPromotion", err as Error, input.promotionId);
  }

  const affected = getChanges(db);
  const row = db
    .select()
    .from(extractedFindingPromotions)
    .where(eq(extractedFindingPromotions.id, input.promotionId))
    .all()[0];
  if (!row) return { outcome: "not_found" };

  if (affected === 1) return { outcome: "recorded", promotion: mapPromotionRow(row) };

  const fromState = row.status;
  if (fromState !== "pending") {
    return { outcome: "illegal_source_state", promotion: mapPromotionRow(row), fromState };
  }
  return { outcome: "fence_mismatch", promotion: mapPromotionRow(row) };
}

// ---------------------------------------------------------------------------
// Re-arm a failed promotion for retry
// ---------------------------------------------------------------------------

export interface ReArmPromotionInput {
  promotionId: string;
  leaseOwner: string;
  leaseGeneration: number;
}

export interface ReArmPendingPromotionLeaseInput extends ReArmPromotionInput {
  expectedLeaseOwner: string;
  expectedLeaseGeneration: number;
}

export type ReArmPromotionResult =
  | { outcome: "re_armed"; promotion: ExtractedFindingPromotionRow }
  | { outcome: "not_found" }
  | { outcome: "illegal_source_state"; promotion: ExtractedFindingPromotionRow; fromState: string };

/**
 * Re-arm a `failed` promotion back to `pending` with a new lease, allowing an
 * honest retry. CAS predicate: `id = promotionId AND status = 'failed'`.
 * Only one concurrent retry can win the CAS; the loser sees `illegal_source_state`.
 */
export function reArmPromotionWithClient(
  db: ExtractionDbClient,
  input: ReArmPromotionInput,
): ReArmPromotionResult {
  const now = new Date().toISOString();
  try {
    db.update(extractedFindingPromotions)
      .set({
        status: "pending",
        leaseOwner: input.leaseOwner,
        leaseGeneration: input.leaseGeneration,
        error: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(extractedFindingPromotions.id, input.promotionId),
          eq(extractedFindingPromotions.status, "failed"),
        ),
      )
      .run();
  } catch (err) {
    throw repositoryUpdateError("extractedFindingPromotion", err as Error, input.promotionId);
  }

  const affected = getChanges(db);
  const row = db
    .select()
    .from(extractedFindingPromotions)
    .where(eq(extractedFindingPromotions.id, input.promotionId))
    .all()[0];
  if (!row) return { outcome: "not_found" };

  if (affected === 1) return { outcome: "re_armed", promotion: mapPromotionRow(row) };

  const fromState = row.status;
  return { outcome: "illegal_source_state", promotion: mapPromotionRow(row), fromState };
}

// ---------------------------------------------------------------------------
// Re-arm a pending promotion's lease (crash recovery — B5)
// ---------------------------------------------------------------------------

/**
 * Result of re-arming a pending promotion's lease (B5 crash recovery).
 */
export type ReArmPendingPromotionResult =
  | { outcome: "re_armed"; promotion: ExtractedFindingPromotionRow }
  | { outcome: "not_found" }
  | { outcome: "illegal_source_state"; promotion: ExtractedFindingPromotionRow; fromState: string }
  | { outcome: "fence_mismatch"; promotion: ExtractedFindingPromotionRow };

/**
 * Re-arm a `pending` promotion's lease when the caller's lease doesn't match
 * the stored one (B5 fix). This handles the crash window: a prior attempt
 * crashed after `createPage` but before `recordTarget`, leaving a `pending`
 * row with null `target_id`. A retry must update the lease to reach the
 * tag-recovery path and find the already-created page.
 *
 * CAS predicate: `id = promotionId AND status = 'pending' AND target_id IS NULL
 * AND lease_owner = expectedLeaseOwner
 * AND lease_generation = expectedLeaseGeneration`.
 * This is safe because:
 * - A succeeded/failed promotion fails the CAS (no mutation).
 * - A pending promotion with a target_id (already recorded) fails — the caller
 *   should use the existing target via the succeeded/already_promoted path.
 *
 * Only one concurrent retry can win the CAS; the loser sees `fence_mismatch`.
 */
export function reArmPendingPromotionLeaseWithClient(
  db: ExtractionDbClient,
  input: ReArmPendingPromotionLeaseInput,
): ReArmPendingPromotionResult {
  const now = new Date().toISOString();
  try {
    db.update(extractedFindingPromotions)
      .set({
        leaseOwner: input.leaseOwner,
        leaseGeneration: input.leaseGeneration,
        updatedAt: now,
      })
      .where(
        and(
          eq(extractedFindingPromotions.id, input.promotionId),
          eq(extractedFindingPromotions.status, "pending"),
          sql`${extractedFindingPromotions.targetId} IS NULL`,
          eq(extractedFindingPromotions.leaseOwner, input.expectedLeaseOwner),
          eq(extractedFindingPromotions.leaseGeneration, input.expectedLeaseGeneration),
        ),
      )
      .run();
  } catch (err) {
    throw repositoryUpdateError("extractedFindingPromotion", err as Error, input.promotionId);
  }

  const affected = getChanges(db);
  const row = db
    .select()
    .from(extractedFindingPromotions)
    .where(eq(extractedFindingPromotions.id, input.promotionId))
    .all()[0];
  if (!row) return { outcome: "not_found" };

  if (affected === 1) return { outcome: "re_armed", promotion: mapPromotionRow(row) };

  const fromState = row.status;
  if (fromState !== "pending") {
    return { outcome: "illegal_source_state", promotion: mapPromotionRow(row), fromState };
  }
  // Status is pending but CAS failed: target_id was set or the observed fence
  // is stale because another retry already re-armed the row.
  return { outcome: "fence_mismatch", promotion: mapPromotionRow(row) };
}
// ---------------------------------------------------------------------------

/**
 * Check whether a wiki page ID appears as a successful promotion target.
 * Any page that was promoted from a finding is permanently excluded from
 * future Wiki source batches, even after link removal, edit, or publish.
 * This is the feedback-loop prevention probe (not a real Wiki source adapter).
 */
export function isWikiPageExcludedFromSources(db: ExtractionDbClient, pageId: string): boolean {
  const row = db
    .select({ id: extractedFindingPromotions.id })
    .from(extractedFindingPromotions)
    .where(
      and(
        eq(extractedFindingPromotions.targetId, pageId),
        eq(extractedFindingPromotions.status, "succeeded"),
      ),
    )
    .all()[0];
  return !!row;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function getPromotionsByFindingWithClient(
  db: ExtractionDbClient,
  findingId: string,
): ExtractedFindingPromotionRow[] {
  return db
    .select()
    .from(extractedFindingPromotions)
    .where(eq(extractedFindingPromotions.findingId, findingId))
    .all()
    .map(mapPromotionRow);
}

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

type PromotionDbRow = typeof extractedFindingPromotions.$inferSelect;

function mapPromotionRow(row: PromotionDbRow): ExtractedFindingPromotionRow {
  return {
    id: row.id,
    findingId: row.findingId,
    destinationType: row.destinationType as ExtractionPromotionDestination,
    destinationKey: row.destinationKey,
    status: row.status as ExtractionPromotionStatus,
    idempotencyKey: row.idempotencyKey,
    leaseOwner: row.leaseOwner,
    leaseGeneration: row.leaseGeneration,
    targetType: row.targetType,
    targetId: row.targetId,
    targetVersion: row.targetVersion,
    consumedFindingRevision: row.consumedFindingRevision,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}
