/**
 * Server-derived scope-ref projection (ADR-0044 §Server-derived scope refs;
 * authorization-review §Agent read predicate).
 *
 * Scope refs (`task | mission | domain`) are derived from successfully resolved
 * cited-source `entity_refs` and source-owned domain projections — never from
 * free text, labels, subject text, or extractor payloads. This module owns the
 * pure deterministic derivation; ticket 4's runner wires the output into
 * `ScopeRefInput[]` with `derivedFromSourceId` pointing at the establishing
 * citation.
 *
 * Derivation rules (implemented exactly):
 *  - A **Task** ref also derives its owning **Mission** ref.
 *  - A **domain** ref is created only when a source adapter explicitly projects
 *    that domain AND at least one cited Task/Mission belongs to the same
 *    Habitat.
 *  - Free text, labels, subject text, extractor payloads, and search terms
 *    NEVER grant scope.
 *  - Habitat-wide findings are represented by **no scope refs** (human-only).
 *  - Cross-Habitat entity refs are dropped (same-Habitat guard).
 */
import type { ExtractionScopeType } from "@orcy/shared";

/** Input observation shape consumed by the projection. */
export interface ScopeProjectionObservation {
  /** The citation-local observation ID that establishes any derived scope. */
  observationId: string;
  /** Entity refs on the resolved cited source. */
  entityRefs: Array<{ type: string; id: string }>;
  /**
   * Source-owned explicit domain projections (e.g. a task's `requiredDomain`).
   * NEVER populated from free text, labels, or extractor payloads.
   */
  domains?: string[];
  /** Habitat that owns this observation's entity refs (same-Habitat guard). */
  habitatId: string;
}

/**
 * Caller-resolved Task → Mission linkage. The runner builds this from the cited
 * Task rows it has already resolved (no DB access inside the projection).
 */
export interface TaskMissionLink {
  taskId: string;
  missionId: string;
  /** Habitat that owns the task (same-Habitat guard for derived Mission ref). */
  habitatId: string;
}

/** A derived scope ref to be persisted (`derivedFromSourceId` filled by caller). */
export interface DerivedScopeRef {
  scopeType: ExtractionScopeType;
  scopeId: string;
  /** Observation (citation) ID that established this scope ref. */
  derivedFromSourceId: string;
}

const TASK_REF_TYPE = "task";
const MISSION_REF_TYPE = "mission";

/**
 * Project the deterministic `task | mission | domain` scope set from resolved
 * cited observations.
 *
 * @param observations Resolved cited-source observations (already filtered to
 *   successfully resolved / `available` citations by the caller).
 * @param owningHabitatId The Habitat whose scope is being derived.
 * @param taskMission Caller-resolved Task → Mission links (taskId → missionId +
 *   habitatId). Required so a Task ref can derive its owning Mission ref without
 *   a DB lookup inside this pure function.
 */
export function projectScopeRefs(
  observations: ScopeProjectionObservation[],
  owningHabitatId: string,
  taskMission: TaskMissionLink[],
): DerivedScopeRef[] {
  const linksByTask = new Map<string, TaskMissionLink>();
  for (const link of taskMission) linksByTask.set(link.taskId, link);

  const seen = new Set<string>();
  const derived: DerivedScopeRef[] = [];

  const emit = (
    scopeType: ExtractionScopeType,
    scopeId: string,
    derivedFromSourceId: string,
  ): void => {
    const key = `${scopeType}:${scopeId}`;
    if (seen.has(key)) return;
    seen.add(key);
    derived.push({ scopeType, scopeId, derivedFromSourceId });
  };

  for (const obs of observations) {
    // Cross-Habitat entity refs are dropped: only same-Habitat observations
    // establish scope.
    if (obs.habitatId !== owningHabitatId) continue;

    const hasSameHabitatTaskOrMission = obs.entityRefs.some(
      (ref) => ref.type === TASK_REF_TYPE || ref.type === MISSION_REF_TYPE,
    );

    for (const ref of obs.entityRefs) {
      if (ref.type === TASK_REF_TYPE) {
        emit("task", ref.id, obs.observationId);
        // A Task ref also derives its owning Mission ref (when the link is
        // same-Habitat and known).
        const link = linksByTask.get(ref.id);
        if (link && link.habitatId === owningHabitatId) {
          emit("mission", link.missionId, obs.observationId);
        }
      } else if (ref.type === MISSION_REF_TYPE) {
        emit("mission", ref.id, obs.observationId);
      }
      // No other entity type grants scope. Free text / labels never appear in
      // `entityRefs`; they are structurally excluded from this path.
    }

    // A domain ref is created only when the source adapter explicitly projects
    // that domain AND at least one cited Task/Mission belongs to the same
    // Habitat. Domains are normalized (trimmed, lowercased) for stability.
    if (hasSameHabitatTaskOrMission && obs.domains) {
      for (const rawDomain of obs.domains) {
        const domain = normalizeDomain(rawDomain);
        if (domain) emit("domain", domain, obs.observationId);
      }
    }
  }

  return derived;
}

/** Normalize a domain string to a stable identifier. Empty/whitespace → null. */
export function normalizeDomain(domain: string): string | null {
  const trimmed = domain.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}
