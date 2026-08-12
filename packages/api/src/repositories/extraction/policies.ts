/**
 * Learning Loop policy repository — transaction-aware CRUD with version CAS.
 *
 * No route or auth policy is wired here. These primitives accept the
 * caller-supplied client and never call `getDb()`, nest transactions, or emit
 * hooks/SSE/audit.
 */
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { learningLoopPolicies } from "../../db/schema/index.js";
import { repositoryCreateError, repositoryUpdateError, repositoryNotFoundError } from "../../errors/repository.js";
import type { LearningLoopPolicyRow } from "@orcy/shared";
import type { ExtractionDbClient } from "./types.js";
import { isUniqueConstraintViolation, mapPolicyRow, getChanges } from "./types.js";
import type { ExtractionSourceType } from "@orcy/shared";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreatePolicyInput {
  habitatId: string;
  extractorKey: string;
  sourceTypes: ExtractionSourceType[];
  schedule: string;
  windowSeconds: number;
  lookbackSeconds: number;
  minConfidence?: number | null;
  minSampleSize?: number | null;
  config?: Record<string, unknown>;
  createdByType?: "human" | "agent" | "system";
  createdById?: string | null;
}

export interface UpdatePolicyInput {
  policyId: string;
  expectedVersion: number;
  sourceTypes?: ExtractionSourceType[];
  schedule?: string;
  windowSeconds?: number;
  lookbackSeconds?: number;
  minConfidence?: number | null;
  minSampleSize?: number | null;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export type UpdatePolicyResult =
  | { outcome: "updated"; policy: LearningLoopPolicyRow }
  | { outcome: "version_conflict"; policy: LearningLoopPolicyRow };

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export type CreatePolicyResult =
  | { outcome: "created"; policy: LearningLoopPolicyRow }
  | { outcome: "already_exists"; policy: LearningLoopPolicyRow };

/**
 * Insert a new policy. The unique index on `(habitat_id, extractor_key)` is
 * the race defender: a concurrent insert for the same pair surfaces as
 * `already_exists` (re-read), not an exception.
 */
export function createPolicyWithClient(
  db: ExtractionDbClient,
  input: CreatePolicyInput,
): CreatePolicyResult {
  const id = uuid();
  try {
    db.insert(learningLoopPolicies)
      .values({
        id,
        habitatId: input.habitatId,
        extractorKey: input.extractorKey,
        enabled: 0,
        sourceTypes: input.sourceTypes,
        schedule: input.schedule,
        windowSeconds: input.windowSeconds,
        lookbackSeconds: input.lookbackSeconds,
        minConfidence: input.minConfidence ?? null,
        minSampleSize: input.minSampleSize ?? null,
        config: input.config ?? {},
        version: 1,
        createdByType: input.createdByType ?? "human",
        createdById: input.createdById ?? null,
      })
      .run();
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      const existing = db
        .select()
        .from(learningLoopPolicies)
        .where(
          and(
            eq(learningLoopPolicies.habitatId, input.habitatId),
            eq(learningLoopPolicies.extractorKey, input.extractorKey),
          ),
        )
        .all()[0];
      if (existing) return { outcome: "already_exists", policy: mapPolicyRow(existing) };
    }
    throw repositoryCreateError("learningLoopPolicy", err as Error, id);
  }

  const created = db
    .select()
    .from(learningLoopPolicies)
    .where(eq(learningLoopPolicies.id, id))
    .all()[0];
  if (!created) throw repositoryCreateError("learningLoopPolicy", undefined, id);
  return { outcome: "created", policy: mapPolicyRow(created) };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function getPolicyByIdWithClient(
  db: ExtractionDbClient,
  policyId: string,
): LearningLoopPolicyRow | null {
  const row = db
    .select()
    .from(learningLoopPolicies)
    .where(eq(learningLoopPolicies.id, policyId))
    .all()[0];
  return row ? mapPolicyRow(row) : null;
}

export function getPoliciesByHabitatWithClient(
  db: ExtractionDbClient,
  habitatId: string,
): LearningLoopPolicyRow[] {
  return db
    .select()
    .from(learningLoopPolicies)
    .where(eq(learningLoopPolicies.habitatId, habitatId))
    .all()
    .map(mapPolicyRow);
}

// ---------------------------------------------------------------------------
// Update with version CAS
// ---------------------------------------------------------------------------

/**
 * Update a policy guarded by `expectedVersion`. Uses `SELECT changes()` for
 * portable affected-row classification: `affected === 1` means the CAS
 * succeeded; `affected === 0` means a concurrent update bumped the version
 * (version_conflict). Only fields present in the input are written.
 */
export function updatePolicyWithClient(
  db: ExtractionDbClient,
  input: UpdatePolicyInput,
): UpdatePolicyResult {
  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (input.sourceTypes !== undefined) updates.sourceTypes = input.sourceTypes;
  if (input.schedule !== undefined) updates.schedule = input.schedule;
  if (input.windowSeconds !== undefined) updates.windowSeconds = input.windowSeconds;
  if (input.lookbackSeconds !== undefined) updates.lookbackSeconds = input.lookbackSeconds;
  if (input.minConfidence !== undefined) updates.minConfidence = input.minConfidence;
  if (input.minSampleSize !== undefined) updates.minSampleSize = input.minSampleSize;
  if (input.config !== undefined) updates.config = input.config;
  if (input.enabled !== undefined) updates.enabled = input.enabled ? 1 : 0;

  // Bump version atomically inside the same UPDATE
  try {
    db.update(learningLoopPolicies)
      .set({ ...updates, version: input.expectedVersion + 1 })
      .where(
        and(
          eq(learningLoopPolicies.id, input.policyId),
          eq(learningLoopPolicies.version, input.expectedVersion),
        ),
      )
      .run();
  } catch (err) {
    throw repositoryUpdateError("learningLoopPolicy", err as Error, input.policyId);
  }

  const affected = getChanges(db);
  const row = db
    .select()
    .from(learningLoopPolicies)
    .where(eq(learningLoopPolicies.id, input.policyId))
    .all()[0];
  if (!row) throw repositoryNotFoundError("learningLoopPolicy", input.policyId);

  if (affected === 1) return { outcome: "updated", policy: mapPolicyRow(row) };
  return { outcome: "version_conflict", policy: mapPolicyRow(row) };
}
