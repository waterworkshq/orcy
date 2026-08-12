/**
 * Experience-signal privacy projection — k-anonymous cohort admission.
 *
 * Implements the non-configurable privacy floor mandated by authorization-review
 * §Experience-signal privacy and PATCH-CONSTRAINTS §13:
 *
 * - At least 5 signals from at least 3 distinct agents per cohort.
 * - Windows shorter than 7 days are ineligible.
 * - Coarse window buckets (≥7 days) replace exact timestamps.
 * - All isolating fields (Pulse IDs, agent IDs, raw bodies, exact timestamps,
 *   rare combinations) are suppressed BEFORE rows are discarded.
 * - A transient core-owned denylist scans candidate text before raw rows are
 *   discarded; the denylist is never retained or exposed.
 * - Only banded counts (not exact) and coarse windows (not exact timestamps)
 *   are emitted.
 *
 * This is stricter than hiding citations after extraction: de-anonymizing data
 * never enters the extractor batch (authorization-review §Experience-signal
 * privacy, final paragraph).
 */
import { createHash } from "node:crypto";
import { computeDigest, canonicalStringify } from "./digest.js";
import type { HabitatSkillSignal } from "../../repositories/habitatSkill.js";

// ---------------------------------------------------------------------------
// Policy version
// ---------------------------------------------------------------------------

/**
 * Bumped when the projection algorithm changes — invalidates prior source
 * identities so old citations fail closed on re-resolution.
 */
export const EXPERIENCE_PRIVACY_POLICY_VERSION = "experience-privacy-v1";

// ---------------------------------------------------------------------------
// Non-configurable floor
// ---------------------------------------------------------------------------

/** Absolute minimum signals per cohort. Habitat policy may raise, never lower. */
const MIN_SIGNALS_FLOOR = 5;

/** Absolute minimum distinct agents per cohort. Habitat policy may raise, never lower. */
const MIN_DISTINCT_AGENTS_FLOOR = 3;

/** Absolute minimum window duration in milliseconds (7 days). */
const MIN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Coarse bucket granularity in milliseconds (7 days). Never sub-7-day. */
const COARSE_BUCKET_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Experience skill categories
// ---------------------------------------------------------------------------

/** Experience-derived skill categories eligible for the projection. */
const EXPERIENCE_SKILL_CATEGORIES: ReadonlySet<string> = new Set([
  "pitfall",
  "domain_knowledge",
  "anti_patterns",
  "pattern",
]);

// ---------------------------------------------------------------------------
// Banding — the ONLY counts emitted (never exact values)
// ---------------------------------------------------------------------------

interface Band {
  max: number;
  label: string;
}

/** Signal-count bands: coarse enough to prevent fingerprinting. */
const SIGNAL_COUNT_BANDS: readonly Band[] = [
  { max: 9, label: "5-9" },
  { max: 19, label: "10-19" },
  { max: 49, label: "20-49" },
  { max: Number.MAX_SAFE_INTEGER, label: "50+" },
];

/** Distinct-agent-count bands. */
const AGENT_COUNT_BANDS: readonly Band[] = [
  { max: 4, label: "3-4" },
  { max: 9, label: "5-9" },
  { max: Number.MAX_SAFE_INTEGER, label: "10+" },
];

function bandFor(value: number, bands: readonly Band[]): string {
  for (const band of bands) {
    if (value <= band.max) return band.label;
  }
  return bands[bands.length - 1].label;
}

// ---------------------------------------------------------------------------
// Floor type
// ---------------------------------------------------------------------------

/** Privacy floor applied to each cohort. The non-configurable minimum. */
export interface ExperiencePrivacyFloor {
  minSignals: number;
  minDistinctAgents: number;
  minWindowMs: number;
}

/** The non-configurable default floor (≥5 signals, ≥3 agents, ≥7-day window). */
export function defaultFloor(): ExperiencePrivacyFloor {
  return {
    minSignals: MIN_SIGNALS_FLOOR,
    minDistinctAgents: MIN_DISTINCT_AGENTS_FLOOR,
    minWindowMs: MIN_WINDOW_MS,
  };
}

/**
 * Validate a habitat-supplied floor override. Habitat policy may **raise** but
 * never **lower** either threshold or the window minimum. Throws on violation.
 */
export function validateFloorOverride(
  override?: Partial<Pick<ExperiencePrivacyFloor, "minSignals" | "minDistinctAgents" | "minWindowMs">>,
): ExperiencePrivacyFloor {
  const floor = defaultFloor();
  if (!override) return floor;

  if (override.minSignals !== undefined) {
    if (override.minSignals < MIN_SIGNALS_FLOOR) {
      throw new Error(
        `Privacy floor override minSignals (${override.minSignals}) cannot be below the non-configurable floor (${MIN_SIGNALS_FLOOR})`,
      );
    }
    floor.minSignals = override.minSignals;
  }

  if (override.minDistinctAgents !== undefined) {
    if (override.minDistinctAgents < MIN_DISTINCT_AGENTS_FLOOR) {
      throw new Error(
        `Privacy floor override minDistinctAgents (${override.minDistinctAgents}) cannot be below the non-configurable floor (${MIN_DISTINCT_AGENTS_FLOOR})`,
      );
    }
    floor.minDistinctAgents = override.minDistinctAgents;
  }

  if (override.minWindowMs !== undefined) {
    if (override.minWindowMs < MIN_WINDOW_MS) {
      throw new Error(
        `Privacy floor override minWindowMs (${override.minWindowMs}) cannot be below the non-configurable floor (${MIN_WINDOW_MS}ms / 7 days)`,
      );
    }
    floor.minWindowMs = override.minWindowMs;
  }

  return floor;
}

// ---------------------------------------------------------------------------
// Window eligibility + coarse bucketing
// ---------------------------------------------------------------------------

/**
 * Whether the extraction window meets the minimum duration. Windows shorter
 * than 7 days are ineligible for Experience extraction.
 */
export function isWindowEligible(windowFrom: string, windowTo: string | undefined): boolean {
  const fromMs = Date.parse(windowFrom);
  if (Number.isNaN(fromMs)) return false;
  const toMs = windowTo ? Date.parse(windowTo) : Date.now();
  if (Number.isNaN(toMs)) return false;
  return toMs - fromMs >= MIN_WINDOW_MS;
}

/**
 * Derive the coarse window bucket from a window boundary. The bucket is
 * aligned to a fixed epoch and is at least 7 days wide. This is the ONLY
 * time information emitted — never exact timestamps.
 */
export function deriveCoarseWindow(windowFrom: string): string {
  const ms = Date.parse(windowFrom);
  const bucket = Math.floor(ms / COARSE_BUCKET_MS) * COARSE_BUCKET_MS;
  return new Date(bucket).toISOString();
}

/**
 * Compute the exclusive end boundary of a coarse window bucket. Used during
 * re-resolution to bound the historical window correctly (coarseWindow →
 * coarseWindow + bucket) instead of coarseWindow → now.
 */
export function coarseWindowEnd(coarseWindow: string): string {
  const ms = Date.parse(coarseWindow);
  return new Date(ms + COARSE_BUCKET_MS).toISOString();
}

// ---------------------------------------------------------------------------
// Transient denylist
// ---------------------------------------------------------------------------

/**
 * Build a transient core-owned identifier denylist from raw signal rows.
 * Scanned against candidate text (subject, summary) BEFORE raw rows are
 * discarded. Never retained or exposed to extractors.
 *
 * Collects every individual-level identifier stored on the signal rows:
 * agent IDs, pulse IDs, task IDs, comment IDs.
 */
export function buildTransientDenylist(signals: readonly HabitatSkillSignal[]): Set<string> {
  const denylist = new Set<string>();
  for (const signal of signals) {
    collectJsonIds(signal.corroboratingAgentIds, denylist);
    collectJsonIds(signal.sourcePulseIds, denylist);
    collectJsonIds(signal.sourceTaskIds, denylist);
    collectJsonIds(signal.sourceCommentIds, denylist);
  }
  return denylist;
}

function collectJsonIds(jsonStr: string | null, set: Set<string>): void {
  if (!jsonStr) return;
  try {
    const arr = JSON.parse(jsonStr);
    if (Array.isArray(arr)) {
      for (const id of arr) {
        if (typeof id === "string" && id.length > 0) set.add(id);
      }
    }
  } catch {
    // Malformed JSON — ignore; the raw field is suppressed regardless.
  }
}

/**
 * Scan text against the transient denylist. Matching substrings are replaced
 * with `[redacted]`. Returns the sanitized text and whether any match occurred.
 */
export function scanAgainstDenylist(
  text: string,
  denylist: ReadonlySet<string>,
): { sanitized: string; hadMatch: boolean } {
  let sanitized = text;
  let hadMatch = false;
  for (const id of denylist) {
    if (sanitized.includes(id)) {
      // Escape regex special characters in the ID for literal replacement.
      sanitized = sanitized.split(id).join("[redacted]");
      hadMatch = true;
    }
  }
  return { sanitized, hadMatch };
}

// ---------------------------------------------------------------------------
// Suppressed aggregate — the ONLY shape that crosses the projection boundary
// ---------------------------------------------------------------------------

/**
 * A privacy-projected experience aggregate. This is the sole output of the
 * projection — it contains NO individual IDs, raw bodies, exact timestamps, or
 * identifying combinations. Every field here is safe for extractor consumption.
 *
 * Free text (subject, summary) does NOT cross the privacy boundary in the type.
 * The adapter drops sanitized subject text before building an extraction
 * observation, and the type does not expose it to future callers.
 */
export interface SuppressedExperienceAggregate {
  /** Non-disclosing stable source identity (`exp_agg:<hash>`). */
  sourceId: string;
  /** Skill category (one of the 4 experience categories — not identifying). */
  skillCategory: string;
  /** Coarse window bucket start (ISO), NOT exact timestamps. */
  coarseWindow: string;
  /** Banded signal count (e.g. "5-9"), never the exact count. */
  signalCountBand: string;
  /** Banded distinct-agent count (e.g. "3-4"), never the exact count. */
  agentCountBand: string;
  /** Completeness caveats (e.g. denylist match, rare combination warning). */
  caveats: string[];
  /** Stable digest of the suppressed aggregate (drives `changed` detection). */
  digest: string;
  /** Privacy policy version stamped on this aggregate. */
  policyVersion: string;
}

// ---------------------------------------------------------------------------
// Stable identity + digest
// ---------------------------------------------------------------------------

/**
 * Non-disclosing stable source identity: hash of habitat, normalized subject
 * (clusterKey), skill category, coarse window, and privacy-policy version.
 * Deterministic for the same cohort; changes when policy version changes.
 */
export function computeExperienceSourceId(
  habitatId: string,
  clusterKey: string,
  skillCategory: string,
  coarseWindow: string,
): string {
  const identity = canonicalStringify({
    habitatId,
    clusterKey,
    skillCategory,
    coarseWindow,
    policyVersion: EXPERIENCE_PRIVACY_POLICY_VERSION,
  });
  const hash = createHash("sha256").update(identity).digest("hex");
  return `exp_agg:${hash}`;
}

/**
 * Digest of the already-suppressed aggregate. Drives `changed` detection:
 * a resolver recomputes this and compares with the stored `sourceDigest`.
 * Changes when banded counts shift, the coarse window changes, or the policy
 * version changes — but NOT when individual signals fluctuate within a band.
 */
export function computeExperienceDigest(aggregate: {
  skillCategory: string;
  coarseWindow: string;
  signalCountBand: string;
  agentCountBand: string;
  caveats: string[];
}): string {
  return computeDigest({
    skillCategory: aggregate.skillCategory,
    coarseWindow: aggregate.coarseWindow,
    signalCountBand: aggregate.signalCountBand,
    agentCountBand: aggregate.agentCountBand,
    caveats: aggregate.caveats,
    policyVersion: EXPERIENCE_PRIVACY_POLICY_VERSION,
  });
}

// ---------------------------------------------------------------------------
// Rare-combination suppression
// ---------------------------------------------------------------------------

/**
 * Pattern that matches common Orcy identifiers (UUIDs, task/mission IDs) that
 * may appear in subject text despite not being in the structured ID fields.
 */
const ID_PATTERNS: readonly RegExp[] = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, // UUIDs
  /\btask-[0-9a-f]+/gi, // task IDs
  /\bmission-[0-9a-f]+/gi, // mission IDs
];

/**
 * Check whether the subject text contains patterns that could re-identify even
 * after denylist scanning (embedded UUIDs, task IDs, etc.).
 */
function containsIdentifierPatterns(text: string): boolean {
  return ID_PATTERNS.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Main projection
// ---------------------------------------------------------------------------

/**
 * Window-scoped counts for a signal, replacing all-time aggregates.
 * When provided, the privacy floor and banded counts use these values
 * instead of the signal row's all-time `frequency`/`corroboratingAgents`.
 */
export interface WindowScopedCounts {
  frequency: number;
  distinctAgents: number;
}

/**
 * Project raw experience signals through the k-anonymity privacy boundary.
 *
 * Steps:
 *  1. Filter to experience-derived skill categories.
 *  2. Reject if the window is shorter than the floor minimum.
 *  3. Build the transient denylist from ALL raw signal identifiers.
 *  4. Derive the coarse window bucket from the window start.
 *  5. For each signal row (cohort), check the k-anonymity floor using
 *     window-scoped counts (not all-time aggregates):
 *     ≥minSignals window frequency AND ≥minDistinctAgents window agents.
 *  6. Apply denylist scan and identifier-pattern check to subject/summary text.
 *  7. Suppress rare combinations — denylist-matched or identifier-embedded
 *     subjects are redacted with a caveat.
 *  8. Emit only banded counts and coarse window — never exact values.
 *
 * Below-floor cohorts are dropped entirely — not partially emitted.
 *
 * @param windowCounts Optional map from signal.id → window-scoped counts.
 *   When provided, the floor check and banded counts use window-scoped values.
 *   When absent, falls back to all-time counts (for legacy test compatibility).
 *   Production callers MUST provide window-scoped counts.
 */
export function projectExperienceSignals(
  rawSignals: readonly HabitatSkillSignal[],
  habitatId: string,
  floor: ExperiencePrivacyFloor,
  windowFrom: string,
  windowTo: string | undefined,
  windowCounts?: Map<string, WindowScopedCounts>,
): SuppressedExperienceAggregate[] {
  // Step 1: filter to experience categories.
  const experienceSignals = rawSignals.filter((s) =>
    EXPERIENCE_SKILL_CATEGORIES.has(s.skillCategory),
  );

  if (experienceSignals.length === 0) return [];

  // Step 2: window eligibility.
  if (!isWindowEligible(windowFrom, windowTo)) return [];

  // Step 3: build transient denylist from ALL raw identifiers.
  const denylist = buildTransientDenylist(experienceSignals);

  // Step 4: derive coarse window.
  const coarseWindow = deriveCoarseWindow(windowFrom);

  // Step 5-8: project each eligible cohort.
  const results: SuppressedExperienceAggregate[] = [];

  for (const signal of experienceSignals) {
    // Floor check: use window-scoped counts when available, all-time fallback otherwise.
    const wsc = windowCounts?.get(signal.id);
    const effectiveFreq = wsc?.frequency ?? signal.frequency;
    const effectiveAgents = wsc?.distinctAgents ?? signal.corroboratingAgents;

    // Drop below-floor cohorts entirely.
    if (effectiveFreq < floor.minSignals) continue;
    if (effectiveAgents < floor.minDistinctAgents) continue;

    // Denylist scan on subject and summary.
    const caveats: string[] = [];
    const rawSubject = signal.subject;
    const { sanitized: denylistedSubject, hadMatch: subjectDenyMatch } =
      scanAgainstDenylist(rawSubject, denylist);

    // Identifier-pattern check (embedded UUIDs, task IDs, etc.).
    const hasIdPattern = containsIdentifierPatterns(denylistedSubject);

    if (subjectDenyMatch || hasIdPattern) {
      caveats.push("subject_redacted_identifier_match");
    }

    // Denylist scan on summary (if present).
    if (signal.summary) {
      const { hadMatch: summaryMatch } = scanAgainstDenylist(signal.summary, denylist);
      if (summaryMatch || containsIdentifierPatterns(signal.summary)) {
        caveats.push("summary_redacted_identifier_match");
      }
    }

    // Compute banded counts from window-scoped values — never exact values.
    const signalCountBand = bandFor(effectiveFreq, SIGNAL_COUNT_BANDS);
    const agentCountBand = bandFor(effectiveAgents, AGENT_COUNT_BANDS);

    // Stable non-disclosing source identity.
    const sourceId = computeExperienceSourceId(
      habitatId,
      signal.clusterKey,
      signal.skillCategory,
      coarseWindow,
    );

    const digestInput = {
      skillCategory: signal.skillCategory as string,
      coarseWindow,
      signalCountBand,
      agentCountBand,
      caveats,
    };

    results.push({
      sourceId,
      skillCategory: signal.skillCategory as string,
      coarseWindow,
      signalCountBand,
      agentCountBand,
      caveats,
      digest: computeExperienceDigest(digestInput),
      policyVersion: EXPERIENCE_PRIVACY_POLICY_VERSION,
    });
  }

  // Rare-combination suppression: if only one cohort survives in the entire
  // batch, its combination of (category, band, window) uniquely identifies a
  // cohort within this habitat-window. Suppress it — a singleton batch is an
  // isolating combination even when the cohort itself meets the floor.
  if (results.length === 1) {
    return [];
  }

  return results;
}

// ---------------------------------------------------------------------------
// Re-resolution helper
// ---------------------------------------------------------------------------

/**
 * Resolve a cited experience-aggregate source ref against the CURRENT eligible
 * cohorts. The adapter pre-fetches signals and calls this pure function — the
 * privacy module has no DB coupling.
 *
 * Returns the resolution state and, when available, the current digest and
 * coarse window. Denial states (`unauthorized`, `dangling`) carry no content.
 *
 * Fail-closed: a previously eligible cohort that recomputes below the floor
 * resolves `unauthorized` — the HMAC won't match any current cohort. This
 * withdraws the finding from agent reads without revealing why.
 *
 * @param sourceId The cited `sourceId` (e.g. `exp_agg:<hash>`).
 * @param coarseWindow The coarse window extracted from `sourceVersion`.
 * @param sourceDigest The digest captured at extraction time (optional).
 * @param currentCohorts The pre-computed eligible cohorts for this habitat+window.
 */
export function resolveExperienceCohort(
  sourceId: string,
  coarseWindow: string | null,
  sourceDigest: string | null | undefined,
  currentCohorts: readonly SuppressedExperienceAggregate[],
): {
  state: "available" | "dangling" | "unauthorized" | "changed";
  digest?: string;
  occurredAt?: string;
} {
  // Source ID format check.
  if (!sourceId.startsWith("exp_agg:")) {
    return { state: "dangling" };
  }
  if (!coarseWindow) {
    return { state: "dangling" };
  }

  // Find the cited cohort among the current eligible set.
  const cohort = currentCohorts.find((c) => c.sourceId === sourceId);

  if (!cohort) {
    // Cohort either dropped below the floor, moved to a different window,
    // or belongs to a different habitat (HMAC won't match). Fail closed:
    // unauthorized without revealing why.
    return { state: "unauthorized" };
  }

  // Compare digests for `changed` detection.
  if (sourceDigest && sourceDigest !== cohort.digest) {
    return { state: "changed", digest: cohort.digest };
  }

  return {
    state: "available",
    digest: cohort.digest,
    occurredAt: cohort.coarseWindow,
  };
}
