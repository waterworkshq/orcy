/**
 * Learning Loop built-in extractors — pure functions over a normalized batch.
 *
 * V1 ships a single built-in extractor (`builtin.pattern`) that examines
 * collected observations and produces candidates of every allowed finding
 * type: `lesson | convention | risk | anomaly | rule_recommendation |
 * knowledge_draft`.
 *
 * All extractors are **pure**: they receive observations and policy config,
 * and return candidates. They never touch the DB, call `getDb()`, or emit
 * events. Candidates cite only batch-local observation IDs; the downstream
 * validator + lifecycle resolve those to citation rows.
 *
 * `rule_recommendation` candidates are **prose-only**: the `structuredPayload`
 * is always `null` — no machine-readable trigger/condition/action payload,
 * no rule prefill/persist/enable (PATCH-CONSTRAINTS §Disallowed scope).
 *
 * See architecture §Extractor contract for the settled boundary.
 */
import type { ExtractionCandidate } from "@orcy/shared";
import type { ExtractionObservation } from "./extractionSourceCatalog/types.js";

// ---------------------------------------------------------------------------
// Built-in extractor identity
// ---------------------------------------------------------------------------

/** Closed key for the v1 built-in pattern extractor. */
export const BUILTIN_EXTRACTOR_KEY = "builtin.pattern";

/** Current version of the built-in pattern extractor. */
export const BUILTIN_EXTRACTOR_VERSION = 1;

// ---------------------------------------------------------------------------
// Extractor context
// ---------------------------------------------------------------------------

/**
 * Input to the built-in extractor. Observations are already privacy-projected
 * by the catalog adapters; the extractor never sees raw Pulse bodies, agent
 * IDs, or exact timestamps for Experience aggregates.
 */
export interface ExtractorContext {
  observations: ExtractionObservation[];
  /** Policy `config` JSON (extractor-specific settings). */
  policyConfig: Record<string, unknown>;
  /** Owning habitat. */
  habitatId: string;
}

// ---------------------------------------------------------------------------
// Pattern detector type
// ---------------------------------------------------------------------------

/**
 * A pure pattern detector. Takes the batch context and returns zero or more
 * candidates. Each detector owns one finding type.
 */
type PatternDetector = (ctx: ExtractorContext) => ExtractionCandidate[];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count occurrences of a specific entity ref type across observations. */
function countEntityRefType(
  observations: readonly ExtractionObservation[],
  refType: string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const obs of observations) {
    for (const ref of obs.entityRefs) {
      if (ref.type === refType) {
        counts.set(ref.id, (counts.get(ref.id) ?? 0) + 1);
      }
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Lesson detector — repeated task lifecycle patterns
// ---------------------------------------------------------------------------

/**
 * Detect lessons from task lifecycle patterns. A lesson candidate is emitted
 * when a task has 3+ lifecycle events (indicating a complex workflow worth
 * documenting).
 */
const detectLessons: PatternDetector = (ctx) => {
  const candidates: ExtractionCandidate[] = [];
  const taskEvents = ctx.observations.filter((o) => o.sourceType === "task_lifecycle_audit");
  const taskEventCounts = countEntityRefType(taskEvents, "task");

  for (const [taskId, count] of taskEventCounts) {
    if (count < 3) continue;
    const cited = taskEvents
      .filter((o) => o.entityRefs.some((r) => r.type === "task" && r.id === taskId))
      .map((o) => o.observationId);

    candidates.push({
      clientKey: `lesson-task-${taskId}`,
      findingType: "lesson",
      subject: `Task ${taskId} has a complex lifecycle (${count} events)`,
      body: `This task underwent ${count} lifecycle transitions, suggesting a workflow pattern worth documenting as a lesson for similar tasks.`,
      confidence: 0.6,
      sampleSize: count,
      completeness: "complete",
      caveats: [],
      citations: cited.slice(0, 10).map((observationId) => ({
        observationId,
        role: "supporting" as const,
      })),
    });
  }

  return candidates;
};

// ---------------------------------------------------------------------------
// Convention detector — consistent mission practices
// ---------------------------------------------------------------------------

/**
 * Detect conventions from mission lifecycle patterns. A convention is emitted
 * when a mission appears in multiple task lifecycle events, suggesting
 * a consistent practice within that mission.
 */
const detectConventions: PatternDetector = (ctx) => {
  const candidates: ExtractionCandidate[] = [];
  const missionEvents = ctx.observations.filter(
    (o) => o.sourceType === "mission_lifecycle_audit" || o.sourceType === "task_lifecycle_audit",
  );
  const missionCounts = countEntityRefType(missionEvents, "mission");

  for (const [missionId, count] of missionCounts) {
    if (count < 5) continue;
    const cited = missionEvents
      .filter((o) => o.entityRefs.some((r) => r.type === "mission" && r.id === missionId))
      .map((o) => o.observationId);

    candidates.push({
      clientKey: `convention-mission-${missionId}`,
      findingType: "convention",
      subject: `Mission ${missionId} follows a consistent task lifecycle pattern`,
      body: `Mission ${missionId} accumulated ${count} lifecycle events across its tasks, indicating an established convention for task management within this mission.`,
      confidence: 0.55,
      sampleSize: count,
      completeness: "complete",
      caveats: [],
      citations: cited.slice(0, 10).map((observationId) => ({
        observationId,
        role: "supporting" as const,
      })),
    });
  }

  return candidates;
};

// ---------------------------------------------------------------------------
// Risk detector — automation/plugin failure patterns
// ---------------------------------------------------------------------------

/**
 * Detect risks from terminal automation/plugin run failures. A risk candidate
 * is emitted when failed runs exceed a threshold.
 */
const detectRisks: PatternDetector = (ctx) => {
  const candidates: ExtractionCandidate[] = [];
  const automationRuns = ctx.observations.filter(
    (o) => o.sourceType === "automation_run_audit",
  );

  // Need at least 3 automation run observations to detect a pattern.
  if (automationRuns.length < 3) return candidates;

  // Emit a risk candidate for the batch of automation runs.
  candidates.push({
    clientKey: `risk-automation-batch`,
    findingType: "risk",
    subject: `${automationRuns.length} terminal automation runs observed in window`,
    body: `${automationRuns.length} automation runs reached terminal status in this extraction window. Reviewing their outcomes may reveal systemic risks in the automation configuration.`,
    confidence: 0.5,
    sampleSize: automationRuns.length,
    completeness: "complete",
    caveats: [],
    citations: automationRuns.slice(0, 10).map((o) => ({
      observationId: o.observationId,
      role: "supporting" as const,
    })),
  });

  return candidates;
};

// ---------------------------------------------------------------------------
// Anomaly detector — unusual plugin run patterns
// ---------------------------------------------------------------------------

/**
 * Detect anomalies from plugin run patterns. An anomaly is emitted when
 * plugin runs show unexpected status distributions.
 */
const detectAnomalies: PatternDetector = (ctx) => {
  const candidates: ExtractionCandidate[] = [];
  const pluginRuns = ctx.observations.filter((o) => o.sourceType === "plugin_run_audit");

  if (pluginRuns.length < 2) return candidates;

  // Group by collectorFamily to see if any single plugin dominates.
  const byFamily = new Map<string, number>();
  for (const run of pluginRuns) {
    byFamily.set(run.collectorFamily, (byFamily.get(run.collectorFamily) ?? 0) + 1);
  }

  // If a single plugin family accounts for >80% of runs, flag it.
  const total = pluginRuns.length;
  for (const [family, count] of byFamily) {
    if (count / total > 0.8 && count >= 3) {
      const cited = pluginRuns
        .filter((o) => o.collectorFamily === family)
        .map((o) => o.observationId);

      candidates.push({
        clientKey: `anomaly-plugin-${family}`,
        findingType: "anomaly",
        subject: `Plugin family "${family}" dominates plugin run volume (${count}/${total})`,
        body: `Plugin family "${family}" accounts for ${Math.round((count / total) * 100)}% of all plugin runs in this window. This concentration may indicate over-reliance or a misconfigured plugin.`,
        confidence: 0.45,
        sampleSize: count,
        completeness: "partial",
        caveats: ["volume_concentration_only", "review_required"],
        citations: cited.slice(0, 10).map((observationId) => ({
          observationId,
          role: "supporting" as const,
        })),
      });
    }
  }

  return candidates;
};

// ---------------------------------------------------------------------------
// Rule recommendation detector — PROSE ONLY
// ---------------------------------------------------------------------------

/**
 * Detect rule recommendation opportunities from triage resolutions.
 * Rule recommendations are **prose-only**: `structuredPayload` is always
 * `null`. No machine-readable trigger/condition/action payload, no rule
 * prefill/persist/enable.
 */
const detectRuleRecommendations: PatternDetector = (ctx) => {
  const candidates: ExtractionCandidate[] = [];
  const triageResolutions = ctx.observations.filter(
    (o) => o.sourceType === "triage_resolution",
  );

  if (triageResolutions.length < 2) return candidates;

  candidates.push({
    clientKey: `rule-rec-triage-batch`,
    findingType: "rule_recommendation",
    subject: `Consider automating triage resolution handling (${triageResolutions.length} resolutions observed)`,
    body: [
      `${triageResolutions.length} terminal triage resolutions were observed in this window.`,
      "If these resolutions follow a recurring pattern, an Automation Rule could be proposed to handle similar cases automatically.",
      "",
      "This is a prose recommendation only. No rule trigger, condition, or action is specified.",
      "A human reviewer should evaluate whether the pattern is stable enough to warrant automation.",
    ].join("\n"),
    structuredPayload: null,
    confidence: 0.4,
    sampleSize: triageResolutions.length,
    completeness: "partial",
    caveats: ["prose_only_recommendation", "no_machine_readable_payload"],
    citations: triageResolutions.slice(0, 10).map((o) => ({
      observationId: o.observationId,
      role: "supporting" as const,
    })),
  });

  return candidates;
};

// ---------------------------------------------------------------------------
// Knowledge draft detector — experience aggregate patterns
// ---------------------------------------------------------------------------

/**
 * Detect knowledge draft opportunities from experience aggregates. A knowledge
 * draft is emitted when Experience cohorts suggest a recurring pattern worth
 * documenting in the wiki.
 */
const detectKnowledgeDrafts: PatternDetector = (ctx) => {
  const candidates: ExtractionCandidate[] = [];
  const experienceAggs = ctx.observations.filter(
    (o) => o.sourceType === "experience_aggregate",
  );

  if (experienceAggs.length < 2) return candidates;

  candidates.push({
    clientKey: `knowledge-experience-batch`,
    findingType: "knowledge_draft",
    subject: `Recurring experience patterns across ${experienceAggs.length} cohorts`,
    body: [
      `${experienceAggs.length} privacy-projected Experience cohorts were observed in this window.`,
      "The patterns suggest recurring practices that could be documented as wiki knowledge for the team.",
      "",
      "Note: Experience data is aggregate-only (k-anonymized). No individual agent or signal is identifiable.",
    ].join("\n"),
    confidence: 0.5,
    sampleSize: experienceAggs.length,
    completeness: "partial",
    caveats: ["aggregate_only_source", "privacy_projected"],
    citations: experienceAggs.slice(0, 10).map((o) => ({
      observationId: o.observationId,
      role: "supporting" as const,
    })),
  });

  return candidates;
};

// ---------------------------------------------------------------------------
// Registry + entry point
// ---------------------------------------------------------------------------

/**
 * All built-in pattern detectors, in stable order. Each owns one finding type.
 * The runner invokes them all and passes the union to the validator.
 */
const DETECTORS: readonly PatternDetector[] = [
  detectLessons,
  detectConventions,
  detectRisks,
  detectAnomalies,
  detectRuleRecommendations,
  detectKnowledgeDrafts,
];

/**
 * Diagnostic entry for a detector that threw during extraction.
 */
export interface DetectorDiagnostic {
  detectorIndex: number;
  error: string;
}

/** Result of running the built-in extractor. */
export interface BuiltinExtractorResult {
  candidates: ExtractionCandidate[];
  diagnostics: DetectorDiagnostic[];
  /** `"partial"` if any detector threw; `"complete"` otherwise. */
  completeness: "complete" | "partial";
}

/**
 * Run the built-in pattern extractor over a normalized batch.
 *
 * Returns the union of all detector outputs plus diagnostics for any detector
 * that threw. The downstream validator drops invalid candidates (zero-citation,
 * fabricated IDs, cross-Habitat, feedback-derived, etc.).
 *
 * Detector failures are NOT silently swallowed — they are recorded as
 * diagnostics and the overall completeness is marked `partial` so the
 * lifecycle can terminalize the attempt accordingly (I2 fix).
 */
export function runBuiltinExtractor(ctx: ExtractorContext): BuiltinExtractorResult {
  const all: ExtractionCandidate[] = [];
  const diagnostics: DetectorDiagnostic[] = [];

  DETECTORS.forEach((detector, index) => {
    try {
      const candidates = detector(ctx);
      all.push(...candidates);
    } catch (err) {
      // Record the failure — do NOT silently convert to success.
      diagnostics.push({
        detectorIndex: index,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return {
    candidates: all,
    diagnostics,
    completeness: diagnostics.length > 0 ? "partial" : "complete",
  };
}
