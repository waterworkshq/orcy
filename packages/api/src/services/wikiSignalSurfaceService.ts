import * as habitatSkillRepo from "../repositories/habitatSkill.js";
import type {
  ExperienceAggregate,
  ExperienceAggregateFilters,
} from "../repositories/habitatSkill.js";
import * as pulseRepo from "../repositories/pulse.js";
import type { Pulse, FindingFilters } from "../repositories/pulse.js";
import type { SkillCategory } from "@orcy/shared";

/**
 * Aggregated experience-surface result — reader-facing only (ARCHITECTURE.md §11.7). Never
 * includes individual pulse IDs, task IDs, comment IDs, or agent IDs — those stay inside
 * `habitat_skill_signals` rows and are only reachable via the `HabitatSkillSignal` repo.
 */
export interface ExperienceSurfaceResult {
  habitatId: string;
  /** Echoed filter for transparency. */
  category: SkillCategory | null;
  /** Echoed filter; `null` means no time-window filter applied. */
  timeWindow: string | null;
  /** Echoed filter; `null` means no domain filter applied (the v0.21 domain join is deferred). */
  domain: string | null;
  aggregates: ExperienceAggregate[];
}

/**
 * Findings-surface result — splits structured (`findingKind IS NOT NULL`) from free-form
 * (`findingKind IS NULL`) findings. Findings have NO privacy gate; individual rows are
 * returned with attribution so readers can see who observed what (ARCHITECTURE.md §11.7).
 */
export interface FindingsSurfaceResult {
  habitatId: string;
  structured: FindingFilters["structured"] | null;
  findingKind: string | null;
  severity: string | null;
  timeWindow: string | null;
  /** Findings with structured metadata — opt-in to wiki surfacing + v0.23 triage routing. */
  structuredFindings: Pulse[];
  /** Free-form findings (no `findingKind` in metadata). Backward-compatible catch-all. */
  unstructuredFindings: Pulse[];
}

/**
 * Combined query result for the `get_signal_surface` MCP action and the wiki signal-surface
 * tabs. Returns PARALLEL arrays — experience and findings are not correlated (cross-correlation
 * is explicitly deferred to v0.23 per the locked decision).
 *
 * Each top-level key is `undefined` (not `null`) when its `signalClass` was not requested, so
 * consumers can distinguish "not requested" from "empty array".
 */
export interface SignalSurfaceForAgent {
  experiencePatterns?: ExperienceAggregate[];
  findings?: Pulse[];
  unstructuredFindings?: Pulse[];
}

/** Class selector for {@link getSignalSurfaceForAgent}. */
export type SignalClass = "experience" | "finding" | "both";

/** Inputs for {@link getExperienceSurface}. */
export interface ExperienceSurfaceInput {
  domain?: string;
  timeWindow?: string;
  category?: SkillCategory;
}

/** Inputs for {@link getFindingsSurface}. */
export interface FindingsSurfaceInput {
  structured?: boolean;
  findingKind?: string;
  severity?: string;
  timeWindow?: string;
}

/** Inputs for {@link getSignalSurfaceForAgent}. */
export interface SignalSurfaceForAgentInput {
  domain?: string;
  timeWindow?: string;
  signalClass: SignalClass;
}

/**
 * Returns aggregated experience clusters for a habitat. Filters `habitat_skill_signals` to the
 * four experience-derived skill categories via {@link habitatSkillRepo.listExperienceAggregates}
 * (privacy projection — individual pulse / task / comment / agent IDs are stripped at the repo
 * layer). Optional `category` narrows within the experience subset; `timeWindow` accepts a
 * duration string (`'7 days'`); `domain` is accepted for API stability but is a no-op (the
 * JSON-array join through `source_task_ids` → tasks → domain is deferred — see MEMORY.md).
 */
export function getExperienceSurface(
  habitatId: string,
  input: ExperienceSurfaceInput = {},
): ExperienceSurfaceResult {
  const filters: ExperienceAggregateFilters = {};
  if (input.category !== undefined) filters.category = input.category;
  if (input.timeWindow !== undefined) filters.timeWindow = input.timeWindow;
  if (input.domain !== undefined) filters.domain = input.domain;

  const aggregates = habitatSkillRepo.listExperienceAggregates(habitatId, filters);

  return {
    habitatId,
    category: input.category ?? null,
    timeWindow: input.timeWindow ?? null,
    domain: input.domain ?? null,
    aggregates,
  };
}

/**
 * Returns finding pulses for a habitat, split into structured (`findingKind IS NOT NULL`)
 * and unstructured (`findingKind IS NULL`). Both sub-arrays always present (possibly empty).
 *
 * Attribution (`fromType` + `fromId`) is preserved on every row — findings are intentional
 * observations, not candid self-assessment, so the privacy gate from {@link getExperienceSurface}
 * does NOT apply here (ARCHITECTURE.md §11.7).
 */
export function getFindingsSurface(
  habitatId: string,
  input: FindingsSurfaceInput = {},
): FindingsSurfaceResult {
  const structuredFilters: FindingFilters = { structured: true };
  if (input.findingKind !== undefined) structuredFilters.findingKind = input.findingKind;
  if (input.severity !== undefined) structuredFilters.severity = input.severity;
  if (input.timeWindow !== undefined) structuredFilters.timeWindow = input.timeWindow;

  const unstructuredFilters: FindingFilters = { structured: false };
  if (input.timeWindow !== undefined) unstructuredFilters.timeWindow = input.timeWindow;

  const structuredFindings = pulseRepo.listFindings(habitatId, structuredFilters);
  const unstructuredFindings = pulseRepo.listFindings(habitatId, unstructuredFilters);

  return {
    habitatId,
    structured: input.structured ?? null,
    findingKind: input.findingKind ?? null,
    severity: input.severity ?? null,
    timeWindow: input.timeWindow ?? null,
    structuredFindings,
    unstructuredFindings,
  };
}

/**
 * Combined reader-facing query for the `get_signal_surface` MCP action. Selects which sub-surface
 * to populate based on `signalClass`. Cross-correlation between experience and findings is
 * explicitly NOT performed — parallel arrays only (locked v0.21 decision; deferred to v0.23).
 *
 * - `'experience'`: populates only `experiencePatterns`.
 * - `'finding'`: populates only `findings` + `unstructuredFindings`.
 * - `'both'` (default): populates all three.
 */
export function getSignalSurfaceForAgent(
  habitatId: string,
  input: SignalSurfaceForAgentInput,
): SignalSurfaceForAgent {
  const signalClass: SignalClass = input.signalClass;
  const result: SignalSurfaceForAgent = {};

  if (signalClass === "experience" || signalClass === "both") {
    const filters: ExperienceAggregateFilters = {};
    if (input.timeWindow !== undefined) filters.timeWindow = input.timeWindow;
    if (input.domain !== undefined) filters.domain = input.domain;
    result.experiencePatterns = habitatSkillRepo.listExperienceAggregates(habitatId, filters);
  }

  if (signalClass === "finding" || signalClass === "both") {
    const structuredFilters: FindingFilters = { structured: true };
    if (input.timeWindow !== undefined) structuredFilters.timeWindow = input.timeWindow;
    result.findings = pulseRepo.listFindings(habitatId, structuredFilters);

    const unstructuredFilters: FindingFilters = { structured: false };
    if (input.timeWindow !== undefined) unstructuredFilters.timeWindow = input.timeWindow;
    result.unstructuredFindings = pulseRepo.listFindings(habitatId, unstructuredFilters);
  }

  return result;
}
