import type {
  AuditCompletenessSummary,
  AuditEvent,
  AuditQueryEntityType,
  AuditSource,
  AuditWarning,
} from "@orcy/shared/types";
import { collectAuditProjection } from "./auditProjection/collectAuditProjection.js";
import type { AuditEntityReferenceFilter } from "./auditProjection/types.js";

export { collectAuditProjection } from "./auditProjection/collectAuditProjection.js";
export { matchesFilters, normalizeFilters, sortEvents } from "./auditProjection/helpers.js";

export interface AuditQueryInput {
  habitatId: string;
  since?: string;
  until?: string;
  entityType?: AuditQueryEntityType;
  entityTypes?: readonly AuditQueryEntityType[];
  entityId?: string;
  taskId?: string;
  missionId?: string;
  actorType?: "human" | "agent" | "system" | "remote_human" | "remote_orcy" | "remote_pod";
  actorId?: string;
  source?: AuditSource;
  order?: "asc" | "desc";
  includeHealthSnapshots?: boolean;
  limit?: number;
  offset?: number;
  referencedEntities?: readonly AuditEntityReferenceFilter[];
}

/** Result envelope for an audit query containing projected {@link AuditEvent} records, data-quality warnings, and a completeness summary. */
export interface AuditQueryResult {
  events: AuditEvent[];
  warnings: AuditWarning[];
  completenessSummary: AuditCompletenessSummary;
}

/** Aggregates per-event completeness statuses into counts by status and a deduplicated list of caveats. */
export function summarizeAuditCompleteness(
  events: AuditEvent[],
  additionalCaveats: Iterable<string> = [],
): AuditCompletenessSummary {
  const caveats = new Set<string>();
  for (const caveat of additionalCaveats) caveats.add(caveat);
  const byStatus: AuditCompletenessSummary["byStatus"] = {
    complete: 0,
    legacy_partial: 0,
    source_unavailable: 0,
  };

  for (const event of events) {
    byStatus[event.completeness.status] += 1;
    for (const caveat of event.completeness.caveats) caveats.add(caveat);
  }

  return {
    totalEvents: events.length,
    byStatus,
    caveats: Array.from(caveats).toSorted(),
  };
}

const DEFAULT_AUDIT_LIMIT = 1000;
const MAX_AUDIT_LIMIT = 10000;

/** Projects source tables (task events, mission events, effort entries, code evidence, integrations, webhooks, health snapshots) into a unified, filtered, and paginated {@link AuditEvent} stream for a habitat. Emits data-quality warnings when rows lack provenance or cannot be tied to a habitat. */
export function queryAuditEvents(input: AuditQueryInput): AuditQueryResult {
  const projection = collectAuditProjection(input);
  const effectiveLimit = Math.min(input.limit ?? DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT);
  const effectiveOffset = input.offset ?? 0;

  const paginatedEvents = projection.events.slice(
    effectiveOffset,
    effectiveOffset + effectiveLimit,
  );
  const warnings: AuditWarning[] = [...projection.warnings];

  if (projection.events.length > effectiveLimit) {
    warnings.push({
      code: "result_truncated",
      message: `Result set truncated to ${effectiveLimit} of ${projection.events.length} matching events. Use limit/offset parameters for pagination.`,
    });
  }

  return {
    events: paginatedEvents,
    warnings,
    completenessSummary: summarizeAuditCompleteness(projection.events, projection.caveats),
  };
}
