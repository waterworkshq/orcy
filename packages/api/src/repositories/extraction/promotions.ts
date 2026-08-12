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
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  extractedFindingPromotions,
} from "../../db/schema/index.js";
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
