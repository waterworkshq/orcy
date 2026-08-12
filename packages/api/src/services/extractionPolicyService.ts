/**
 * Learning Loop policy service — feature defaults, two-layer kill switch,
 * and human-only policy CRUD with version CAS.
 *
 * Composes the ticket-1 policy repository primitives. The feature defaults
 * **off** globally (`ORCY_LEARNING_LOOP_ENABLED=false`) and per-Habitat
 * (`enabled` column defaults 0/false). Both must be on to run. A kill switch
 * stops new runs/promotions but accepted reads remain; privacy withdrawal
 * still fails closed (PATCH-CONSTRAINTS §21).
 *
 * `source_types` must be a subset of the catalog's closed vocabulary
 * (`EXTRACTION_SOURCE_TYPES`); the validator rejects broadening by runtime
 * input.
 */
import { getDb } from "../db/index.js";
import {
  createPolicyWithClient,
  updatePolicyWithClient,
  getPolicyByIdWithClient,
  getPoliciesByHabitatWithClient,
  type CreatePolicyResult,
  type UpdatePolicyInput,
  type UpdatePolicyResult,
} from "../repositories/extraction/index.js";
import type { LearningLoopPolicyRow, ExtractionSourceType } from "@orcy/shared";
import { EXTRACTION_SOURCE_TYPES } from "@orcy/shared";

// ---------------------------------------------------------------------------
// Feature defaults
// ---------------------------------------------------------------------------

/**
 * Whether the Learning Loop feature is globally enabled via env.
 * Defaults **off** — the env var must be explicitly `"true"`.
 */
export function isLearningLoopGloballyEnabled(): boolean {
  return process.env.ORCY_LEARNING_LOOP_ENABLED === "true";
}

/**
 * Two-layer kill switch mirroring `shouldExecuteActions`. Both the global
 * env flag and the per-policy `enabled` field must be on. Returns `false`
 * (honest skipped, no extraction) when either layer is off.
 */
export function shouldRunExtraction(policy: LearningLoopPolicyRow): boolean {
  if (!isLearningLoopGloballyEnabled()) return false;
  return policy.enabled;
}

// ---------------------------------------------------------------------------
// Source-type validation (closed vocabulary subset check)
// ---------------------------------------------------------------------------

const VALID_SOURCE_TYPES: ReadonlySet<string> = new Set(EXTRACTION_SOURCE_TYPES);

/**
 * Validate that `sourceTypes` is a non-empty subset of the catalog's closed
 * vocabulary. Rejects broadening by runtime input.
 */
export function validateSourceTypes(sourceTypes: readonly string[]): ExtractionSourceType[] {
  if (!Array.isArray(sourceTypes) || sourceTypes.length === 0) {
    throw new Error("Policy source_types must be a non-empty array.");
  }
  for (const st of sourceTypes) {
    if (!VALID_SOURCE_TYPES.has(st)) {
      throw new Error(
        `Policy source_types contains unknown source type "${st}". Allowed: ${EXTRACTION_SOURCE_TYPES.join(", ")}.`,
      );
    }
  }
  return sourceTypes as ExtractionSourceType[];
}

// ---------------------------------------------------------------------------
// Bounded window validation
// ---------------------------------------------------------------------------

/** Minimum schedule interval in seconds (5 minutes). */
export const MIN_SCHEDULE_SECONDS = 300;

/** Maximum lookback window in seconds (90 days). */
export const MAX_LOOKBACK_SECONDS = 90 * 24 * 60 * 60;

/** Maximum extraction window in seconds (7 days). */
export const MAX_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/**
 * Validate a policy's bounded execution contract.
 * Throws on invalid input.
 */
export function validatePolicyWindow(input: {
  schedule: string;
  windowSeconds: number;
  lookbackSeconds: number;
}): void {
  if (!input.schedule || typeof input.schedule !== "string") {
    throw new Error("Policy schedule must be a non-empty string.");
  }
  if (
    !Number.isFinite(input.windowSeconds) ||
    input.windowSeconds <= 0 ||
    input.windowSeconds > MAX_WINDOW_SECONDS
  ) {
    throw new Error(
      `Policy window_seconds must be a positive number ≤ ${MAX_WINDOW_SECONDS} (7 days). Got: ${input.windowSeconds}`,
    );
  }
  if (
    !Number.isFinite(input.lookbackSeconds) ||
    input.lookbackSeconds <= 0 ||
    input.lookbackSeconds > MAX_LOOKBACK_SECONDS
  ) {
    throw new Error(
      `Policy lookback_seconds must be a positive number ≤ ${MAX_LOOKBACK_SECONDS} (90 days). Got: ${input.lookbackSeconds}`,
    );
  }
  if (input.lookbackSeconds < input.windowSeconds) {
    throw new Error(
      `Policy lookback_seconds (${input.lookbackSeconds}) must be ≥ window_seconds (${input.windowSeconds}).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Policy CRUD (human-only in production; auth gate is ticket 5)
// ---------------------------------------------------------------------------

export interface CreatePolicyServiceInput {
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

/**
 * Create a policy. Validates source types and bounded window before
 * delegating to the repository. The policy is created **disabled** —
 * a separate human action is required to enable it.
 */
export function createPolicy(input: CreatePolicyServiceInput): CreatePolicyResult {
  validateSourceTypes(input.sourceTypes);
  validatePolicyWindow(input);

  const db = getDb();
  return createPolicyWithClient(db, {
    habitatId: input.habitatId,
    extractorKey: input.extractorKey,
    sourceTypes: input.sourceTypes,
    schedule: input.schedule,
    windowSeconds: input.windowSeconds,
    lookbackSeconds: input.lookbackSeconds,
    minConfidence: input.minConfidence ?? null,
    minSampleSize: input.minSampleSize ?? null,
    config: input.config ?? {},
    createdByType: input.createdByType ?? "human",
    createdById: input.createdById ?? null,
  });
}

/**
 * Update a policy with version CAS. Validates any updated source types
 * and bounded window before delegating.
 */
export function updatePolicy(input: UpdatePolicyInput): UpdatePolicyResult {
  if (input.sourceTypes !== undefined) {
    validateSourceTypes(input.sourceTypes);
  }
  if (
    input.schedule !== undefined ||
    input.windowSeconds !== undefined ||
    input.lookbackSeconds !== undefined
  ) {
    const current = getPolicyByIdWithClient(getDb(), input.policyId);
    if (!current) throw new Error(`Policy ${input.policyId} not found.`);
    validatePolicyWindow({
      schedule: input.schedule ?? current.schedule,
      windowSeconds: input.windowSeconds ?? current.windowSeconds,
      lookbackSeconds: input.lookbackSeconds ?? current.lookbackSeconds,
    });
  }

  const db = getDb();
  return updatePolicyWithClient(db, input);
}

/** Get a policy by ID. */
export function getPolicy(policyId: string): LearningLoopPolicyRow | null {
  return getPolicyByIdWithClient(getDb(), policyId);
}

/** Get all policies for a habitat. */
export function getPoliciesByHabitat(habitatId: string): LearningLoopPolicyRow[] {
  return getPoliciesByHabitatWithClient(getDb(), habitatId);
}
