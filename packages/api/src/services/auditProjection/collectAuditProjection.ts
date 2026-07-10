import {
  DEFAULT_AUDIT_QUERY_ENTITY_TYPES,
  type AuditEvent,
  type AuditQueryEntityType,
  type AuditWarning,
} from "@orcy/shared/types";
import {
  enrichAuditActorNames,
  matchesFilters,
  normalizeFilters,
  sortEvents,
  summarizeAuditCompleteness,
  type AuditQueryInput,
} from "../auditQueryService.js";
import { selectCollectors } from "./catalog.js";
import type {
  AuditCollectorResult,
  AuditProjectionCollector,
  AuditProjectionSet,
} from "./types.js";

function dispatchCollector(
  collector: AuditProjectionCollector,
  habitatId: string,
  selectedEntityTypes: ReadonlySet<AuditQueryEntityType>,
): AuditCollectorResult {
  if (collector.failurePolicy === "fatal") {
    return collector.collect({ habitatId, selectedEntityTypes });
  }
  try {
    return collector.collect({ habitatId, selectedEntityTypes });
  } catch {
    return {
      events: [],
      warnings: [
        {
          code: "collector_unavailable",
          source: collector.warningSource,
          message: `Audit projection source '${collector.key}' is unavailable; results are partial.`,
        },
      ],
      caveats: [`Audit projection source '${collector.key}' was unavailable.`],
    };
  }
}

export function collectAuditProjection(input: AuditQueryInput): AuditProjectionSet {
  const query = normalizeFilters(input);
  const selectedEntityTypes = new Set<AuditQueryEntityType>(DEFAULT_AUDIT_QUERY_ENTITY_TYPES);

  const collectors = selectCollectors(selectedEntityTypes);

  const allEvents: AuditEvent[] = [];
  const allWarnings: AuditWarning[] = [];
  const allCaveats: string[] = [];

  for (const collector of collectors) {
    const result = dispatchCollector(collector, query.habitatId, selectedEntityTypes);
    allEvents.push(...result.events);
    allWarnings.push(...result.warnings);
    allCaveats.push(...result.caveats);
  }

  const filteredEvents = allEvents.filter((event) => matchesFilters(event, query));
  enrichAuditActorNames(filteredEvents);
  const sortedEvents = sortEvents(filteredEvents, query.order ?? "desc");

  return {
    events: sortedEvents,
    warnings: allWarnings,
    caveats: allCaveats,
  };
}

export { summarizeAuditCompleteness };