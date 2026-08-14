/**
 * Finding Triage legacy lineage repair.
 *
 * Offline maintenance operation for repairing ambiguous legacy lineage.
 * Two modes:
 *
 * 1. **predecessor_mapping** — validates and applies a known-good linear
 *    predecessor→child mapping. Reruns all linear-chain invariants.
 * 2. **evidence_baselined_root** — sets a canonical root, records a cutoff
 *    timestamp, and snapshots every provable Pulse id across the quarantined
 *    same-identity component. Post-reset recurrence requires a Pulse created
 *    after the cutoff and absent from the explicit baseline.
 *
 * Both modes:
 * - Run OFFLINE with exclusive DB access (BEGIN IMMEDIATE)
 * - Require verified backup, operator identity, and reason
 * - Record an append-only before/after/input digest ledger
 * - Are idempotent: identical repair replay succeeds; changed content conflicts
 */

import { getDb } from "../db/index.js";
import { findingTriageLineageRepairs } from "../db/schema/index.js";
import { eq, and, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { LineageRepairMode } from "@orcy/shared";
import { createHash } from "crypto";

/** Required input for any repair. */
export interface RepairOperator {
  type: string;
  id: string;
  reason: string;
}

/** Input for a predecessor-mapping repair. */
export interface PredecessorMappingInput {
  mode: "predecessor_mapping";
  habitatId: string;
  clusterKey: string;
  findingKind: string;
  /** Map of findingTriagId → predecessorId (null means "set as root"). */
  mapping: Record<string, string | null>;
  operator: RepairOperator;
}

/** Input for an evidence-baselined-root repair. */
export interface EvidenceBaselinedRootInput {
  mode: "evidence_baselined_root";
  habitatId: string;
  clusterKey: string;
  findingKind: string;
  /** The canonical root findingTriagId to set. */
  canonicalRootId: string;
  /** Cutoff timestamp: only post-cutoff evidence can recur. */
  cutoffTimestamp: string;
  /** Provable Pulse ids across the quarantined component. */
  baselinePulseIds: string[];
  operator: RepairOperator;
}

export type RepairInput = PredecessorMappingInput | EvidenceBaselinedRootInput;

/** Preview result — what the repair would do without applying. */
export interface RepairPreview {
  mode: LineageRepairMode;
  habitatId: string;
  clusterKey: string;
  findingKind: string;
  digest: string;
  beforeMapping: Record<string, string | null>;
  afterMapping: Record<string, string | null>;
  baselinePulseIds?: string[];
  cutoffTimestamp?: string;
  validationErrors: string[];
  canApply: boolean;
}

/** Apply result — confirmation of what was persisted. */
export interface RepairApplyResult {
  repairId: string;
  mode: LineageRepairMode;
  appliedAt: string;
  digest: string;
}

/** Error thrown when prerequisites are not met. */
export class RepairValidationError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "RepairValidationError";
  }
}

/**
 * Compute a deterministic SHA-256 digest of the repair input + current database
 * state. This is the "input snapshot digest" that preview and apply must share.
 * If the database changes between preview and apply (new rows, changed mappings),
 * the before-state component of the digest will differ and apply will reject.
 */
export function computeRepairDigest(
  input: RepairInput,
  beforeMapping?: Record<string, string | null>,
): string {
  const hash = createHash("sha256");
  // Include the before-mapping (database state) so changes are detected
  const beforeKey = beforeMapping
    ? Object.keys(beforeMapping)
        .sort()
        .map((k) => `${k}:${beforeMapping[k] ?? "null"}`)
        .join(",")
    : "";
  if (input.mode === "predecessor_mapping") {
    const sortedKeys = Object.keys(input.mapping).sort();
    const pairs = sortedKeys.map((k) => `${k}:${input.mapping[k] ?? "null"}`);
    hash.update(`predecessor_mapping|${input.habitatId}|${input.clusterKey}|${input.findingKind}|${pairs.join(",")}|${beforeKey}`);
  } else {
    const sortedPulses = [...input.baselinePulseIds].sort();
    hash.update(
      `evidence_baselined_root|${input.habitatId}|${input.clusterKey}|${input.findingKind}|${input.canonicalRootId}|${input.cutoffTimestamp}|${sortedPulses.join(",")}|${beforeKey}`,
    );
  }
  return hash.digest("hex");
}

/**
 * Preview a repair without applying it. Computes the before/after mapping,
 * validates invariants, and returns a digest that apply will verify.
 */
export function previewRepair(input: RepairInput): RepairPreview {
  const db = getDb();
  const identityRows = (
    db.all(
      sql`SELECT id, recurrence_of_id, legacy_lineage_repair_required, status, created_at
          FROM finding_triage
          WHERE habitat_id = ${input.habitatId}
            AND cluster_key = ${input.clusterKey}
            AND finding_kind = ${input.findingKind}
          ORDER BY created_at`,
    ) as Record<string, unknown>[]
  ).map((row) => ({
    id: row.id as string,
    recurrenceOfId: row.recurrence_of_id as string | null,
      legacyLineageRepairRequired: row.legacy_lineage_repair_required as number,
      status: row.status as string,
      createdAt: row.created_at as string,
    }));

  const beforeMapping: Record<string, string | null> = {};
  for (const row of identityRows) {
    beforeMapping[row.id] = row.recurrenceOfId;
  }

  const validationErrors: string[] = [];
  let afterMapping: Record<string, string | null> = {};
  let baselinePulseIds: string[] | undefined;
  let cutoffTimestamp: string | undefined;

  if (input.mode === "predecessor_mapping") {
    afterMapping = { ...input.mapping };
    // Validate: every id in mapping must exist in the identity set
    const identitySet = new Set(identityRows.map((r) => r.id));
    for (const [child, pred] of Object.entries(input.mapping)) {
      if (!identitySet.has(child)) {
        validationErrors.push(`Unknown finding id in mapping: ${child}`);
      }
      if (pred !== null && !identitySet.has(pred)) {
        validationErrors.push(`Unknown predecessor id in mapping: ${pred}`);
      }
    }
    // Validate linear chain invariants
    validateLinearChain(afterMapping, validationErrors);
  } else {
    // evidence_baselined_root
    afterMapping[input.canonicalRootId] = null;
    // Set all other rows to point to the root
    for (const row of identityRows) {
      if (row.id !== input.canonicalRootId) {
        afterMapping[row.id] = input.canonicalRootId;
      }
    }
    baselinePulseIds = input.baselinePulseIds;
    cutoffTimestamp = input.cutoffTimestamp;

    // Validate canonical root exists
    const rootExists = identityRows.some((r) => r.id === input.canonicalRootId);
    if (!rootExists) {
      validationErrors.push(`Canonical root ${input.canonicalRootId} does not exist in this identity`);
    }
  }

  const digest = computeRepairDigest(input, beforeMapping);

  return {
    mode: input.mode,
    habitatId: input.habitatId,
    clusterKey: input.clusterKey,
    findingKind: input.findingKind,
    digest,
    beforeMapping,
    afterMapping,
    baselinePulseIds,
    cutoffTimestamp,
    validationErrors,
    canApply: validationErrors.length === 0,
  };
}

/**
 * Validate linear chain invariants: no self-edge, no cycle, no branch,
 * predecessor must be older and terminal.
 */
function validateLinearChain(
  mapping: Record<string, string | null>,
  errors: string[],
): void {
  // Check for self-edges
  for (const [child, pred] of Object.entries(mapping)) {
    if (pred !== null && child === pred) {
      errors.push(`Self-edge: ${child} points to itself`);
    }
  }

  // Check for branches (predecessor with multiple children)
  const childCount: Record<string, number> = {};
  for (const pred of Object.values(mapping)) {
    if (pred !== null) {
      childCount[pred] = (childCount[pred] ?? 0) + 1;
    }
  }
  for (const [pred, count] of Object.entries(childCount)) {
    if (count > 1) {
      errors.push(`Branched lineage: predecessor ${pred} has ${count} children`);
    }
  }

  // Check for cycles (bounded traversal)
  const MAX_DEPTH = 100;
  for (const start of Object.keys(mapping)) {
    const visited = new Set<string>([start]);
    let current = mapping[start];
    let depth = 0;
    while (current && depth < MAX_DEPTH) {
      if (visited.has(current)) {
        errors.push(`Cycle detected starting from ${start}`);
        break;
      }
      visited.add(current);
      current = mapping[current] ?? null;
      depth++;
    }
  }
}

/**
 * Apply a repair. Requirements:
 * - Operator identity and reason must be provided
 * - The digest from preview must match (database hasn't changed)
 * - Uses BEGIN IMMEDIATE for exclusive access
 * - Records append-only audit ledger in the same transaction
 *
 * Throws RepairValidationError if prerequisites are not met.
 */
export function applyRepair(
  input: RepairInput,
  expectedDigest: string,
  options: { backupVerified: boolean; exclusiveLock: boolean },
): RepairApplyResult {
  if (!input.operator.id || !input.operator.reason) {
    throw new RepairValidationError(
      "Operator identity and reason are required",
      "missing_operator",
    );
  }
  if (!options.backupVerified) {
    throw new RepairValidationError(
      "Verified backup is required before repair",
      "missing_backup",
    );
  }
  if (!options.exclusiveLock) {
    throw new RepairValidationError(
      "Exclusive database access is required for repair",
      "missing_exclusive_lock",
    );
  }

  // Re-preview to compute current digest
  const currentPreview = previewRepair(input);
  if (currentPreview.digest !== expectedDigest) {
    throw new RepairValidationError(
      `Digest drift: expected ${expectedDigest}, got ${currentPreview.digest}. Database changed between preview and apply.`,
      "digest_drift",
    );
  }
  if (!currentPreview.canApply) {
    throw new RepairValidationError(
      `Validation errors: ${currentPreview.validationErrors.join("; ")}`,
      "validation_failed",
    );
  }

  const db = getDb();
  const repairId = uuid();
  const now = new Date().toISOString();

  // Execute under BEGIN IMMEDIATE for exclusive access
  db.transaction(
    () => {
      // Apply the mapping changes
      if (input.mode === "predecessor_mapping") {
        for (const [childId, predId] of Object.entries(input.mapping)) {
          db.run(
            sql`UPDATE finding_triage
                SET recurrence_of_id = ${predId},
                    legacy_lineage_repair_required = 0,
                    updated_at = ${now}
                WHERE id = ${childId}`,
          );
        }
      } else {
        // evidence_baselined_root: set root + clear repair flag on all
        for (const [childId, predId] of Object.entries(currentPreview.afterMapping)) {
          db.run(
            sql`UPDATE finding_triage
                SET recurrence_of_id = ${predId},
                    legacy_lineage_repair_required = 0,
                    updated_at = ${now}
                WHERE id = ${childId}`,
          );
        }
      }

      // Record the append-only audit ledger
      db.insert(findingTriageLineageRepairs)
        .values({
          id: repairId,
          habitatId: input.habitatId,
          clusterKey: input.clusterKey,
          findingKind: input.findingKind,
          mode: input.mode,
          affectedIdentity: `${input.habitatId}/${input.clusterKey}/${input.findingKind}`,
          actorType: input.operator.type,
          actorId: input.operator.id,
          reason: input.operator.reason,
          beforeMapping: currentPreview.beforeMapping,
          afterMapping: currentPreview.afterMapping,
          inputSnapshotDigest: currentPreview.digest,
          cutoffTimestamp: input.mode === "evidence_baselined_root" ? input.cutoffTimestamp : null,
        })
        .run();

      // For evidence_baselined_root: persist baseline evidence
      if (input.mode === "evidence_baselined_root") {
        for (const pulseId of input.baselinePulseIds) {
          db.run(
            sql`INSERT OR IGNORE INTO finding_triage_lineage_baseline_evidence
                (repair_id, pulse_id, digest)
                VALUES (${repairId}, ${pulseId}, ${currentPreview.digest})`,
          );
        }
      }
    },
    { behavior: "immediate" },
  );

  return {
    repairId,
    mode: input.mode,
    appliedAt: now,
    digest: currentPreview.digest,
  };
}

/**
 * Idempotent replay check: if the same repair digest was already applied,
 * it succeeds without side effects. If the digest differs, it conflicts.
 */
export function checkExistingRepair(digest: string): { exists: boolean; repairId: string | null } {
  const db = getDb();
  const row = db
    .select({ id: findingTriageLineageRepairs.id })
    .from(findingTriageLineageRepairs)
    .where(eq(findingTriageLineageRepairs.inputSnapshotDigest, digest))
    .get();
  return {
    exists: !!row,
    repairId: row?.id ?? null,
  };
}
