import type {
  AuditCompletenessSummary,
  AuditEvent,
  AuditQueryEntityType,
  AuditSource,
  AuditWarning,
} from "@orcy/shared/types";
import { badRequest } from "../errors.js";
import type { AuditEntityReferenceFilter } from "./auditProjection/types.js";
import { collectAuditProjection } from "./auditProjection/collectAuditProjection.js";

export { collectAuditProjection } from "./auditProjection/collectAuditProjection.js";

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

export function normalizeFilters(input: AuditQueryInput): AuditQueryInput {
  if (input.taskId && input.missionId) {
    throw badRequest("taskId and missionId cannot be combined; use bundle/query modes instead");
  }

  if (input.taskId) {
    if (
      (input.entityType && input.entityType !== "task") ||
      (input.entityId && input.entityId !== input.taskId)
    ) {
      throw badRequest("taskId conflicts with entityType/entityId filters");
    }
    return { ...input, entityType: "task", entityId: input.taskId };
  }

  if (input.missionId) {
    if (
      (input.entityType && input.entityType !== "mission") ||
      (input.entityId && input.entityId !== input.missionId)
    ) {
      throw badRequest("missionId conflicts with entityType/entityId filters");
    }
    return { ...input, entityType: "mission", entityId: input.missionId };
  }

  return input;
}

export function matchesFilters(event: AuditEvent, query: AuditQueryInput): boolean {
  if (event.habitatId !== query.habitatId) return false;
  if (query.since && event.occurredAt < query.since) return false;
  if (query.until && event.occurredAt > query.until) return false;
  if (query.entityType && event.entity.type !== query.entityType) return false;
  if (
    query.entityTypes &&
    query.entityTypes.length > 0 &&
    !query.entityTypes.includes(event.entity.type as AuditQueryEntityType)
  ) {
    return false;
  }
  if (query.entityId && event.entity.id !== query.entityId) return false;
  if (query.actorType && event.actor.type !== query.actorType) return false;
  if (query.actorId && event.actor.id !== query.actorId) return false;
  if (query.source && event.source !== query.source) return false;
  return true;
}

export function sortEvents(events: AuditEvent[], order: "asc" | "desc"): AuditEvent[] {
  return events.toSorted((a, b) => {
    const time = a.occurredAt.localeCompare(b.occurredAt);
    const direction = order === "asc" ? time : -time;
    if (direction !== 0) return direction;
    return a.id.localeCompare(b.id);
  });
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
  const query = normalizeFilters(input);
  const projection = collectAuditProjection(query);
  const effectiveLimit = Math.min(query.limit ?? DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT);
  const effectiveOffset = query.offset ?? 0;

  const paginatedEvents = projection.events.slice(effectiveOffset, effectiveOffset + effectiveLimit);
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