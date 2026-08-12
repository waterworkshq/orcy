/**
 * Learning Loop execution lifecycle — the ONE fenced work/attempt mutation
 * seam shared by every caller.
 *
 * Mirrors `automationAttemptLifecycle.attemptRuleRun`'s disciplined step
 * ordering and discriminated disposition. Every production path — scheduled
 * scan, manual `ensure`, human-only reason-required `fresh_rerun`, `dry_run`,
 * and boot recovery — flows through `runExtraction`. No extraction ever
 * routes through Automation Rules.
 *
 * The 9-step canonical run flow (architecture §Canonical run flow):
 *   1.  Resolve enabled policy; validate bounded window. Feature-off → `skipped`.
 *   2.  Capture each configured adapter's upper-bound token (before reservation).
 *   3.  Reserve logical work by `logical_work_key`. Duplicate → `deduplicated`.
 *   4.  Acquire a fenced attempt lease (monotonic attempt_no, lease generation).
 *   5.  Collect each source up to its captured boundary; record warnings + completeness.
 *   6.  Apply source-specific privacy projection (catalog adapters already do this).
 *   7.  Invoke the pure built-in extractor over the normalized batch.
 *   8.  Validate every candidate (X4 validator); reject invalid ones.
 *   9.  Persist each valid candidate atomically (guarded by attempt fence);
 *       owned terminalization + exactly-once completion emission.
 *
 * Completion emission belongs only to the owned `running → terminal`
 * transition, mirroring `terminalized` discipline: `terminalizeAttempt`
 * reports a closed losing outcome on a lost race, and we emit only on the
 * owned win.
 *
 * See architecture §Canonical run flow + §Failure and recovery for the
 * binding semantics, and PATCH-CONSTRAINTS §6–11, §21–23 for constraints.
 */
import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";
import { logger } from "../lib/logger.js";
import {
  reserveWorkItemWithClient,
  createAttemptWithClient,
  terminalizeAttemptWithClient,
  terminalizeWorkItemWithClient,
  persistCandidateWithClient,
  getLatestAttemptWithClient,
  type CitationInput,
  type ScopeRefInput,
  type PersistCandidateInput,
} from "../repositories/extraction/index.js";
import {
  selectAdapters,
  getAdapter,
  canonicalStringify,
  computeDigest,
  projectScopeRefs,
  type ExtractionObservation,
  type SourceBatch,
  type SourceBoundaryToken,
  type SourceWindowRequest,
} from "./extractionSourceCatalog/index.js";
import {
  shouldRunExtraction,
  validatePolicyWindow,
  validateSourceTypes,
} from "./extractionPolicyService.js";
import {
  runBuiltinExtractor,
  BUILTIN_EXTRACTOR_VERSION,
} from "./extractionExtractors.js";
import { validateCandidate } from "./extractionValidator.js";
import type {
  ExtractionCandidate,
  ExtractionDeliveryMode,
  ExtractionFindingCompleteness,
  ExtractionSourceType,
  ExtractionVisibilityClass,
  ExtractionWorkItemRow,
  ExtractionAttemptRow,
  LearningLoopPolicyRow,
} from "@orcy/shared";

// ---------------------------------------------------------------------------
// Disposition (4-kind discriminated result)
// ---------------------------------------------------------------------------

/** Per-source diagnostics recorded on the attempt's source snapshot. */
export interface SourceSnapshotEntry {
  sourceType: ExtractionSourceType;
  completeness: "complete" | "partial";
  observationCount: number;
  warnings: string[];
  /** Whether this source's watermark advanced (only on successful collection). */
  watermarkAdvanced: boolean;
}

/**
 * The 4-kind discriminated result. The disposition is the only authoritative
 * source for the run's outcome.
 *
 *  - `executed`     — extraction ran; `outcome` is the composite run status.
 *  - `skipped`      — terminal skip; `reason` explains why (feature-off,
 *                     no enabled policy, invalid window).
 *  - `deduplicated` — duplicate delivery for an existing work item; the
 *                     returned work item/attempt are the EXISTING rows,
 *                     not mutated by this call.
 *  - `failed`       — extraction attempted but failed at a named stage.
 */
export type ExtractionRunDisposition =
  | {
      kind: "executed";
      workItem: ExtractionWorkItemRow;
      attempt: ExtractionAttemptRow;
      outcome: "succeeded" | "partial";
      sources: SourceSnapshotEntry[];
      candidates: { validated: number; persisted: number; deduplicated: number; rejected: number };
    }
  | {
      kind: "skipped";
      reason: "disabled" | "no_enabled_policy" | "window_invalid";
      policyId: string | null;
    }
  | {
      kind: "deduplicated";
      workItem: ExtractionWorkItemRow;
      attempt: ExtractionAttemptRow | null;
    }
  | {
      kind: "failed";
      workItem: ExtractionWorkItemRow | null;
      attempt: ExtractionAttemptRow | null;
      stage: string;
      error: string;
    };

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Input to `runExtraction`. All callers — scheduled, manual ensure,
 * fresh_rerun, dry_run, and boot recovery — build this shape.
 */
export interface RunExtractionInput {
  /** Owning Habitat. */
  habitatId: string;
  /** Policy to run under. Must belong to `habitatId`. */
  policy: LearningLoopPolicyRow;
  /** Channel through which this attempt was delivered. Diagnostic only. */
  deliveryMode: ExtractionDeliveryMode;
  /** Actor initiating this run. */
  actorType: "human" | "agent" | "system";
  actorId: string;

  // --- fresh_rerun gating ---

  /**
   * If `true`, create a new `rerun_generation` with a linked logical key.
   * Requires `actorType === "human"` and a non-empty `freshReason`.
   */
  isFreshRerun?: boolean;
  /** Required for fresh_rerun. Must be non-empty. */
  freshReason?: string;
  /** Prior work item to supersede (for fresh_rerun linkage). */
  supersedesWorkId?: string | null;

  // --- dry_run ---

  /**
   * If `true`, exercise collection/extraction/validation and write work/attempt
   * diagnostics, but persist NO findings.
   */
  dryRun?: boolean;

  // --- boot_recovery ---

  /**
   * If `true`, this is a boot-recovery child attempt. The caller has already
   * reserved the work item and is creating a new fenced attempt on an
   * existing work item.
   */
  isBootRecovery?: boolean;
  /** Existing work item for boot recovery. */
  existingWorkItem?: ExtractionWorkItemRow;

  /** Override for "now" (tests). */
  now?: string;
}

// ---------------------------------------------------------------------------
// Completion emission (exactly-once, owned transition only)
// ---------------------------------------------------------------------------

/** Hook invoked once per owned `running → terminal` transition. */
type ExtractionRunCompletedHook = (opts: {
  habitatId: string;
  workItem: ExtractionWorkItemRow;
  attempt: ExtractionAttemptRow;
  outcome: "succeeded" | "partial" | "failed";
}) => void;

const extractionRunCompletedHooks: ExtractionRunCompletedHook[] = [];

/**
 * Register a completion hook. Returns an unsubscribe function.
 * Mirrors `onAutomationRunCompleted`.
 */
export function onExtractionRunCompleted(hook: ExtractionRunCompletedHook): () => void {
  extractionRunCompletedHooks.push(hook);
  return () => {
    const idx = extractionRunCompletedHooks.indexOf(hook);
    if (idx >= 0) extractionRunCompletedHooks.splice(idx, 1);
  };
}

/**
 * Emit one in-process completion callback. Per-hook errors are swallowed
 * so one bad subscriber cannot block the others (mirrors automation pattern).
 */
function notifyExtractionRunCompleted(opts: Parameters<ExtractionRunCompletedHook>[0]): void {
  for (const hook of extractionRunCompletedHooks) {
    try {
      hook(opts);
    } catch (err) {
      logger.warn({ err }, "Extraction run completed hook failed");
    }
  }
}

// ---------------------------------------------------------------------------
// Lease configuration
// ---------------------------------------------------------------------------

/** Default lease duration: 5 minutes. */
const DEFAULT_LEASE_SECONDS = 300;

/** Process-level lease owner identifier. */
function makeLeaseOwner(actorType: string, actorId: string): string {
  return `extraction:${actorType}:${actorId}:${process.pid ?? "unknown"}`;
}

// ---------------------------------------------------------------------------
// Logical-work-key computation
// ---------------------------------------------------------------------------

/**
 * Compute the deterministic `logical_work_key`. Hashes Habitat, extractor/
 * version, policy/version, normalized window, source types, source boundary
 * tokens, and `rerun_generation`. **Delivery mode is deliberately excluded**
 * so scheduled and manual `ensure` converge (architecture §extraction_work_items).
 */
export function computeLogicalWorkKey(input: {
  habitatId: string;
  extractorKey: string;
  extractorVersion: number;
  policyVersion: number;
  windowFrom: string;
  windowTo: string;
  sourceTypes: readonly ExtractionSourceType[];
  sourceBoundaryTokens: Record<string, unknown>;
  rerunGeneration: number;
}): string {
  const canonical = canonicalStringify({
    habitatId: input.habitatId,
    extractorKey: input.extractorKey,
    extractorVersion: input.extractorVersion,
    policyVersion: input.policyVersion,
    windowFrom: input.windowFrom,
    windowTo: input.windowTo,
    sourceTypes: input.sourceTypes.toSorted(),
    sourceBoundaryTokens: input.sourceBoundaryTokens,
    rerunGeneration: input.rerunGeneration,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// Fingerprint + evidence digest
// ---------------------------------------------------------------------------

/** Claim identity: hash of finding type + subject + body. */
function computeFingerprint(candidate: ExtractionCandidate): string {
  return computeDigest({
    findingType: candidate.findingType,
    subject: candidate.subject,
    body: candidate.body,
  });
}

/** Exact cited-evidence identity: hash of sorted observation digests. */
function computeEvidenceDigest(
  citedObservations: readonly ExtractionObservation[],
): string {
  const digests = citedObservations.map((o) => o.digest).toSorted();
  return computeDigest(digests);
}

// ---------------------------------------------------------------------------
// Source window helpers
// ---------------------------------------------------------------------------

/**
 * Compute the window boundaries from the policy's lookback/window settings.
 */
function computeWindow(
  policy: LearningLoopPolicyRow,
  nowIso: string,
): { windowFrom: string; windowTo: string } {
  const nowMs = Date.parse(nowIso);
  const fromMs = nowMs - policy.lookbackSeconds * 1000;
  return {
    windowFrom: new Date(fromMs).toISOString(),
    windowTo: new Date(nowMs).toISOString(),
  };
}

/**
 * Build a serializable boundary-token map for the logical-work-key.
 * Only the `highWaterMark` is included — it determines data identity (which
 * rows are in scope). The `capturedAt` timestamp is metadata and MUST NOT
 * be part of the logical key, or duplicate deliveries would never converge.
 */
function serializeBoundaryTokens(
  tokens: readonly SourceBoundaryToken[],
): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const t of tokens) {
    map[t.sourceType] = t.highWaterMark;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Candidate → citation/scope-ref mapping
// ---------------------------------------------------------------------------

/**
 * Resolve a candidate's observation-ID citations to catalog-issued citation
 * inputs. Uses `adapter.canonicalIdentity(obs)` for the stable source
 * reference.
 */
function buildCitationInputs(
  candidate: ExtractionCandidate,
  batchById: Map<string, ExtractionObservation>,
): { citations: CitationInput[]; observations: ExtractionObservation[] } {
  const citations: CitationInput[] = [];
  const observations: ExtractionObservation[] = [];

  for (const cite of candidate.citations) {
    const obs = batchById.get(cite.observationId);
    if (!obs) continue;

    const adapter = getAdapter(obs.sourceType);
    const ref = adapter.canonicalIdentity(obs);

    citations.push({
      id: uuid(),
      sourceType: ref.sourceType,
      sourceId: ref.sourceId,
      sourceVersion: ref.sourceVersion,
      role: cite.role,
      sourceDigest: ref.digest,
      occurredAt: obs.occurredAt,
      entityRefs: obs.entityRefs,
      completeness: "complete",
      visibilityClass: obs.visibilityClass,
    });
    observations.push(obs);
  }

  return { citations, observations };
}

/**
 * Build scope-ref inputs from cited observations using `projectScopeRefs`.
 * Maps `DerivedScopeRef` → `ScopeRefInput` by resolving `derivedFromSourceId`
 * to the citation row ID.
 */
function buildScopeRefInputs(
  citedObservations: ExtractionObservation[],
  citations: CitationInput[],
  owningHabitatId: string,
): ScopeRefInput[] {
  // Build observation → citation ID mapping for scope derivation linkage.
  const obsToCitationId = new Map<string, string>();
  for (let i = 0; i < citedObservations.length; i++) {
    const obs = citedObservations[i];
    const citation = citations[i];
    if (obs && citation) {
      obsToCitationId.set(obs.observationId, citation.id);
    }
  }

  // Build task-mission links from cited observations' entity refs.
  // The runner has no DB access inside the projection; we extract links
  // from the already-collected observations.
  const taskMissionLinks = extractTaskMissionLinks(citedObservations, owningHabitatId);

  const scopeProjectionObs = citedObservations.map((obs) => ({
    observationId: obs.observationId,
    entityRefs: obs.entityRefs,
    domains: obs.domains,
    habitatId: obs.habitatId,
  }));

  const derived = projectScopeRefs(scopeProjectionObs, owningHabitatId, taskMissionLinks);

  return derived.map((d) => ({
    scopeType: d.scopeType,
    scopeId: d.scopeId,
    derivedFromSourceId: obsToCitationId.get(d.derivedFromSourceId) ?? d.derivedFromSourceId,
  }));
}

/**
 * Extract Task → Mission links from cited observations' entity refs.
 * When an observation has both a task and mission entity ref, the link
 * is extracted. This avoids a DB lookup inside the scope projection.
 */
function extractTaskMissionLinks(
  observations: readonly ExtractionObservation[],
  owningHabitatId: string,
): Array<{ taskId: string; missionId: string; habitatId: string }> {
  const links: Array<{ taskId: string; missionId: string; habitatId: string }> = [];
  const seen = new Set<string>();

  for (const obs of observations) {
    if (obs.habitatId !== owningHabitatId) continue;
    const taskRef = obs.entityRefs.find((r) => r.type === "task");
    const missionRef = obs.entityRefs.find((r) => r.type === "mission");
    if (taskRef && missionRef) {
      const key = `${taskRef.id}:${missionRef.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        links.push({
          taskId: taskRef.id,
          missionId: missionRef.id,
          habitatId: owningHabitatId,
        });
      }
    }
  }

  return links;
}

// ---------------------------------------------------------------------------
// Canonical seam — runExtraction
// ---------------------------------------------------------------------------

/**
 * Run the canonical extraction lifecycle for one input.
 *
 * The returned disposition is the only authoritative source for the run's
 * outcome. Dedupe losers never emit completion and never mutate the existing
 * work item/attempt.
 */
export function runExtraction(input: RunExtractionInput): ExtractionRunDisposition {
  const nowIso = input.now ?? new Date().toISOString();
  const db = getDb();
  const { policy, habitatId } = input;

  // -------------------------------------------------------------------------
  // Step 0 — fresh_rerun gating.
  // -------------------------------------------------------------------------

  if (input.isFreshRerun) {
    if (input.actorType !== "human") {
      return {
        kind: "failed",
        workItem: null,
        attempt: null,
        stage: "fresh_rerun_gate",
        error: "fresh_rerun requires a human actor",
      };
    }
    if (!input.freshReason || input.freshReason.trim().length === 0) {
      return {
        kind: "failed",
        workItem: null,
        attempt: null,
        stage: "fresh_rerun_gate",
        error: "fresh_rerun requires a non-empty reason",
      };
    }
  }

  // -------------------------------------------------------------------------
  // Step 1 — resolve enabled policy; validate bounded window. Feature-off → skipped.
  // -------------------------------------------------------------------------

  if (!shouldRunExtraction(policy)) {
    return {
      kind: "skipped",
      reason: "disabled",
      policyId: policy.id,
    };
  }

  try {
    validatePolicyWindow({
      schedule: policy.schedule,
      windowSeconds: policy.windowSeconds,
      lookbackSeconds: policy.lookbackSeconds,
    });
  } catch {
    return {
      kind: "skipped",
      reason: "window_invalid",
      policyId: policy.id,
    };
  }

  // Source-type validation (defensive — should already be valid from CRUD).
  try {
    validateSourceTypes(policy.sourceTypes);
  } catch {
    return {
      kind: "skipped",
      reason: "window_invalid",
      policyId: policy.id,
    };
  }

  // -------------------------------------------------------------------------
  // Step 2 — capture each configured adapter's upper-bound token (before reservation).
  // -------------------------------------------------------------------------

  const window = computeWindow(policy, nowIso);
  const selectedSourceTypes = new Set(policy.sourceTypes);
  const adapters = selectAdapters(selectedSourceTypes);

  const boundaryTokens: SourceBoundaryToken[] = [];
  for (const adapter of adapters) {
    try {
      const token = adapter.captureBoundary({
        habitatId,
        windowFrom: window.windowFrom,
        windowTo: window.windowTo,
      });
      boundaryTokens.push(token);
    } catch (err) {
      // Boundary capture failure → empty token; collection will report the error.
      logger.warn(
        { err, sourceType: adapter.type, habitatId },
        "Extraction boundary capture failed",
      );
    }
  }

  const serializedTokens = serializeBoundaryTokens(boundaryTokens);

  // -------------------------------------------------------------------------
  // Step 3 — reserve logical work by `logical_work_key`.
  // -------------------------------------------------------------------------

  const rerunGeneration = input.isFreshRerun ? Date.now() : 0; // Unique per fresh rerun
  const extractorVersion = BUILTIN_EXTRACTOR_VERSION;
  const policyVersion = policy.version;

  const logicalWorkKey = computeLogicalWorkKey({
    habitatId,
    extractorKey: policy.extractorKey,
    extractorVersion,
    policyVersion,
    windowFrom: window.windowFrom,
    windowTo: window.windowTo,
    sourceTypes: policy.sourceTypes,
    sourceBoundaryTokens: serializedTokens,
    rerunGeneration,
  });

  let workItem: ExtractionWorkItemRow;

  if (input.isBootRecovery && input.existingWorkItem) {
    // Boot recovery uses the existing work item.
    workItem = input.existingWorkItem;
  } else {
    const reservation = reserveWorkItemWithClient(db, {
      habitatId,
      policyId: policy.id,
      extractorKey: policy.extractorKey,
      extractorVersion,
      policyVersion,
      windowFrom: window.windowFrom,
      windowTo: window.windowTo,
      sourceBoundaryTokens: serializedTokens,
      logicalWorkKey,
      deliveryMode: input.deliveryMode,
      rerunGeneration,
      supersedesWorkId: input.supersedesWorkId ?? null,
      freshReason: input.isFreshRerun ? input.freshReason ?? null : null,
      policySnapshot: {
        schedule: policy.schedule,
        windowSeconds: policy.windowSeconds,
        lookbackSeconds: policy.lookbackSeconds,
        sourceTypes: policy.sourceTypes,
        minConfidence: policy.minConfidence,
        minSampleSize: policy.minSampleSize,
      },
    });

    if (reservation.outcome === "already_exists") {
      // Duplicate scheduled/manual ensure → deduplicated.
      // Return the existing work item and its latest attempt, if any.
      const latestAttempt = getLatestAttemptForWorkItem(db, reservation.workItem.id);
      return {
        kind: "deduplicated",
        workItem: reservation.workItem,
        attempt: latestAttempt,
      };
    }

    workItem = reservation.workItem;
  }

  // -------------------------------------------------------------------------
  // Step 4 — acquire a fenced attempt lease.
  // -------------------------------------------------------------------------

  const leaseOwner = makeLeaseOwner(input.actorType, input.actorId);
  const leaseExpiresAt = new Date(
    Date.parse(nowIso) + DEFAULT_LEASE_SECONDS * 1000,
  ).toISOString();

  // Derive lease generation from the latest existing attempt (if any).
  const existingLatest = getLatestAttemptForWorkItem(db, workItem.id);
  const leaseGeneration = existingLatest ? existingLatest.leaseGeneration + 1 : 1;

  const attemptResult = createAttemptWithClient(db, {
    workItemId: workItem.id,
    parentAttemptId: existingLatest?.id ?? null,
    deliveryMode: input.deliveryMode,
    leaseOwner,
    leaseGeneration,
    leaseExpiresAt,
  });

  const attempt = attemptResult.outcome === "created"
    ? attemptResult.attempt
    : attemptResult.attempt; // `already_exists` returns the raced winner.

  // -------------------------------------------------------------------------
  // Step 5 — collect each source up to its captured boundary.
  // -------------------------------------------------------------------------

  const sourceSnapshots: SourceSnapshotEntry[] = [];
  const allObservations: ExtractionObservation[] = [];

  for (let i = 0; i < adapters.length; i++) {
    const adapter = adapters[i]!;
    const token = boundaryTokens[i];

    let batch: SourceBatch;
    try {
      const request: SourceWindowRequest = {
        habitatId,
        windowFrom: window.windowFrom,
        windowTo: window.windowTo,
        boundaryToken: token,
      };
      batch = adapter.collect(request);
    } catch (err) {
      // Source collection failure → partial snapshot + warning, NEVER empty success.
      // The source's watermark does NOT advance.
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err: message, sourceType: adapter.type, habitatId },
        "Extraction source collection failed",
      );
      sourceSnapshots.push({
        sourceType: adapter.type,
        completeness: "partial",
        observationCount: 0,
        warnings: ["source_unavailable"],
        watermarkAdvanced: false,
      });
      continue;
    }

    // A failed source → partial snapshot + warning, watermark NOT advanced.
    const hasWarnings = batch.warnings.length > 0;
    const completeness = hasWarnings || batch.completeness === "partial"
      ? "partial"
      : "complete";

    sourceSnapshots.push({
      sourceType: adapter.type,
      completeness: completeness as "complete" | "partial",
      observationCount: batch.observations.length,
      warnings: batch.warnings,
      watermarkAdvanced: true, // Watermark advances only on successful collection.
    });

    allObservations.push(...batch.observations);
  }

  // Build batch-by-ID map for validator + citation resolution.
  const batchById = new Map<string, ExtractionObservation>();
  for (const obs of allObservations) {
    batchById.set(obs.observationId, obs);
  }

  // -------------------------------------------------------------------------
  // Step 6 — privacy projection is already applied by catalog adapters.
  // (Experience observations are aggregate-only; lifecycle observations carry
  // full entity refs. No additional projection needed here.)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Step 7 — invoke the pure built-in extractor.
  // -------------------------------------------------------------------------

  let candidates: ExtractionCandidate[];
  try {
    candidates = runBuiltinExtractor({
      observations: allObservations,
      policyConfig: policy.config,
      habitatId,
    });
  } catch (err) {
    // Extractor throw → no findings persisted; terminalize failed.
    const message = err instanceof Error ? err.message : String(err);
    return terminalizeFailed(db, workItem, attempt, "extractor_throw", message, sourceSnapshots, 0, 0, 0);
  }

  // -------------------------------------------------------------------------
  // Step 8 — validate every candidate; reject invalid ones.
  // -------------------------------------------------------------------------

  let validated = 0;
  let rejected = 0;
  const validCandidates: ExtractionCandidate[] = [];

  for (const candidate of candidates) {
    const result = validateCandidate(candidate, batchById, policy, habitatId);
    if (result.valid) {
      validated++;
      validCandidates.push(candidate);
    } else {
      rejected++;
      logger.debug(
        { errors: result.errors, clientKey: candidate.clientKey },
        "Extraction candidate rejected by validator",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 9 — persist valid candidates; terminalize; emit completion.
  // -------------------------------------------------------------------------

  // dry_run: persist NO findings, but terminalize the attempt with diagnostics.
  if (input.dryRun) {
    const outcome = sourceSnapshots.some((s) => s.completeness === "partial")
      ? "partial"
      : "succeeded";

    return terminalizeWithDiagnostics(
      db,
      workItem,
      attempt,
      outcome,
      sourceSnapshots,
      { validated, persisted: 0, deduplicated: 0, rejected },
      true,
    );
  }

  let persisted = 0;
  let deduplicated = 0;

  for (const candidate of validCandidates) {
    // Resolve citations to citation inputs.
    const { citations, observations: citedObs } = buildCitationInputs(candidate, batchById);

    if (citations.length === 0) {
      rejected++;
      continue;
    }

    // Compute identity hashes.
    const fingerprint = computeFingerprint(candidate);
    const evidenceDigest = computeEvidenceDigest(citedObs);

    // Derive scope refs.
    const scopeRefs = buildScopeRefInputs(citedObs, citations, habitatId);

    // Determine visibility ceiling.
    const obsVisibilities = citedObs.map((o) => o.visibilityClass);
    const visibilityCeiling = obsVisibilities.length > 0
      ? mostRestrictiveVisibility(obsVisibilities)
      : "human_reviewer" as ExtractionVisibilityClass;

    // Determine completeness.
    const hasPartialSources = sourceSnapshots.some((s) => s.completeness === "partial");
    const completeness: ExtractionFindingCompleteness =
      candidate.completeness === "partial" || hasPartialSources ? "partial" : "complete";

    const persistInput: PersistCandidateInput = {
      attemptId: attempt.id,
      workItemId: workItem.id,
      leaseOwner,
      leaseGeneration,
      habitatId,
      firstAttemptId: attempt.id,
      fingerprint,
      evidenceDigest,
      extractorKey: policy.extractorKey,
      extractorVersion,
      findingType: candidate.findingType,
      subject: candidate.subject,
      body: candidate.body,
      structuredPayload: candidate.structuredPayload ?? null,
      confidence: candidate.confidence,
      sampleSize: candidate.sampleSize,
      completeness,
      visibilityCeiling,
      caveats: candidate.caveats,
      lineageRootId: uuid(), // Revision 1 → root is self
      revision: 1,
      citations,
      scopeRefs,
    };

    try {
      const result = db.transaction((tx) =>
        persistCandidateWithClient(tx, persistInput),
      );

      if (result.outcome === "fence_mismatch") {
        // Stale fence — cannot persist. This attempt lost ownership.
        return terminalizeFailed(
          db, workItem, attempt, "fence_mismatch_during_persist",
          "Attempt fence mismatch during candidate persistence",
          sourceSnapshots, validated, persisted, rejected,
        );
      }

      if (result.outcome === "recurrence") {
        deduplicated++;
      } else {
        persisted++;
      }
    } catch (err) {
      // Per-finding persistence failure: roll back that finding and continue.
      // The transaction rollback ensures no partial rows.
      logger.warn(
        { err, clientKey: candidate.clientKey },
        "Extraction candidate persistence failed",
      );
      rejected++;
    }
  }

  // Determine composite outcome. Partial if any source failed (watermark
  // not advanced). Otherwise succeeded — even with zero findings (an honest
  // empty result, not an error).
  const finalOutcome: "succeeded" | "partial" = sourceSnapshots.some(
    (s) => !s.watermarkAdvanced,
  )
    ? "partial"
    : "succeeded";

  return terminalizeWithDiagnostics(
    db,
    workItem,
    attempt,
    finalOutcome,
    sourceSnapshots,
    { validated, persisted, deduplicated, rejected },
  );
}

// ---------------------------------------------------------------------------
// Terminalization helpers
// ---------------------------------------------------------------------------

/**
 * Terminalize the attempt and work item with diagnostics. Emits completion
 * exactly once — only if the owned `running → terminal` transition succeeds.
 */
function terminalizeWithDiagnostics(
  db: ReturnType<typeof getDb>,
  workItem: ExtractionWorkItemRow,
  attempt: ExtractionAttemptRow,
  outcome: "succeeded" | "partial",
  sources: SourceSnapshotEntry[],
  candidates: { validated: number; persisted: number; deduplicated: number; rejected: number },
  dryRun = false,
): ExtractionRunDisposition {
  const candidateCount = candidates.validated + candidates.rejected;
  const attemptStatus = outcome === "succeeded" ? "succeeded" as const : "partial" as const;
  const workStatus = outcome === "succeeded" ? "succeeded" as const : "partial" as const;

  // Terminalize the attempt (owned transition only).
  const attemptResult = terminalizeAttemptWithClient(db, {
    attemptId: attempt.id,
    workItemId: workItem.id,
    leaseOwner: attempt.leaseOwner,
    leaseGeneration: attempt.leaseGeneration,
    status: attemptStatus,
    candidateCount,
    persistedCount: candidates.persisted,
    deduplicatedCount: candidates.deduplicated,
  });

  if (attemptResult.outcome !== "terminalized") {
    // Lost the race — another finalizer won. Do not emit completion.
    logger.warn(
      { attemptId: attempt.id, outcome: attemptResult.outcome },
      "Extraction attempt terminalization lost the race",
    );
    return {
      kind: "failed",
      workItem,
      attempt: attemptResult.outcome === "not_found" ? null : (attemptResult as { attempt: ExtractionAttemptRow }).attempt,
      stage: "terminalization_race",
      error: `Attempt terminalization outcome: ${attemptResult.outcome}`,
    };
  }

  const terminalAttempt = attemptResult.attempt;

  // Terminalize the work item (only if not dry-run).
  if (!dryRun) {
    const workResult = terminalizeWorkItemWithClient(db, {
      workItemId: workItem.id,
      attemptId: attempt.id,
      status: workStatus,
    });

    if (workResult.outcome !== "terminalized") {
      // Work item terminalization failed — this is the crash-after-commit-
      // before-finalization window. Findings are already committed. Recovery
      // will reconcile.
      logger.warn(
        { workItemId: workItem.id, outcome: workResult.outcome },
        "Extraction work item terminalization failed — recovery will reconcile",
      );
    }
  }

  // Emit exactly-once completion (owned transition).
  notifyExtractionRunCompleted({
    habitatId: workItem.habitatId,
    workItem,
    attempt: terminalAttempt,
    outcome,
  });

  return {
    kind: "executed",
    workItem,
    attempt: terminalAttempt,
    outcome,
    sources,
    candidates,
  };
}

/**
 * Terminalize a failed attempt. Emits completion with `failed` outcome
 * only on the owned transition.
 */
function terminalizeFailed(
  db: ReturnType<typeof getDb>,
  workItem: ExtractionWorkItemRow,
  attempt: ExtractionAttemptRow,
  stage: string,
  error: string,
  sources: SourceSnapshotEntry[],
  validated: number,
  persisted: number,
  rejected: number,
): ExtractionRunDisposition {
  const candidateCount = validated + rejected;

  const attemptResult = terminalizeAttemptWithClient(db, {
    attemptId: attempt.id,
    workItemId: workItem.id,
    leaseOwner: attempt.leaseOwner,
    leaseGeneration: attempt.leaseGeneration,
    status: "failed",
    candidateCount,
    persistedCount: persisted,
    error,
  });

  // Attempt to terminalize the work item as failed.
  terminalizeWorkItemWithClient(db, {
    workItemId: workItem.id,
    attemptId: attempt.id,
    status: "failed",
  });

  if (attemptResult.outcome === "terminalized") {
    notifyExtractionRunCompleted({
      habitatId: workItem.habitatId,
      workItem,
      attempt: attemptResult.attempt,
      outcome: "failed",
    });
  }

  return {
    kind: "failed",
    workItem,
    attempt: attemptResult.outcome === "terminalized" ? attemptResult.attempt : attempt,
    stage,
    error,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the latest attempt for a work item, or null. */
function getLatestAttemptForWorkItem(
  db: ReturnType<typeof getDb>,
  workItemId: string,
): ExtractionAttemptRow | null {
  return getLatestAttemptWithClient(db, workItemId);
}

/**
 * Compute the most-restrictive visibility from a list.
 */
function mostRestrictiveVisibility(
  classes: ExtractionVisibilityClass[],
): ExtractionVisibilityClass {
  const rank: Record<ExtractionVisibilityClass, number> = {
    aggregate_only: 0,
    human_reviewer: 1,
    habitat_member: 2,
  };
  if (classes.length === 0) return "human_reviewer";
  let result = classes[0]!;
  for (const cls of classes) {
    if (rank[cls] < rank[result]) result = cls;
  }
  return result;
}
