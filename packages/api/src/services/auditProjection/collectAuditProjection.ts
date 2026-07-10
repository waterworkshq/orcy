import {
  AUDIT_QUERY_ENTITY_TYPES,
  DEFAULT_AUDIT_QUERY_ENTITY_TYPES,
  type AuditEvent,
  type AuditQueryEntityType,
  type AuditWarning,
} from "@orcy/shared/types";
import { getDb } from "../../db/index.js";
import { remoteParticipants, users } from "../../db/schema/index.js";
import { inArray } from "drizzle-orm";
import { selectCollectors } from "./catalog.js";
import type {
  AuditCollectorResult,
  AuditEntityReferenceFilter,
  AuditProjectionCollector,
  AuditProjectionSet,
} from "./types.js";
import { normalizeFilters, type AuditQueryInput } from "../auditQueryService.js";

function resolveSelectedEntityTypes(
  entityType: AuditQueryEntityType | undefined,
  entityTypes: readonly AuditQueryEntityType[] | undefined,
  includeHealthSnapshots: boolean | undefined,
): Set<AuditQueryEntityType> {
  const validSet = new Set<AuditQueryEntityType>(AUDIT_QUERY_ENTITY_TYPES);
  if (entityType) {
    return new Set<AuditQueryEntityType>([entityType]);
  }
  if (entityTypes && entityTypes.length > 0) {
    const set = new Set<AuditQueryEntityType>();
    for (const t of entityTypes) {
      if (validSet.has(t)) set.add(t);
    }
    return set;
  }
  const set = new Set<AuditQueryEntityType>(DEFAULT_AUDIT_QUERY_ENTITY_TYPES);
  if (includeHealthSnapshots) set.add("health_snapshot");
  return set;
}

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

function matchesEvent(event: AuditEvent, query: AuditQueryInput): boolean {
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

function matchesReferencedEntities(
  event: AuditEvent,
  referencedEntities: readonly AuditEntityReferenceFilter[],
): boolean {
  if (referencedEntities.length === 0) return true;
  for (const ref of referencedEntities) {
    if (event.entity.type === ref.type && event.entity.id === ref.id) return true;
    for (const linked of event.linkedEntities) {
      if (linked.type === ref.type && linked.id === ref.id) return true;
    }
  }
  return false;
}

function enrichAuditActorNames(events: AuditEvent[]): void {
  if (events.length === 0) return;
  const db = getDb();
  const humanActorIds = [
    ...new Set(
      events
        .filter((e) => e.actor.type === "human" && e.actor.id && !e.actor.name)
        .map((e) => e.actor.id!),
    ),
  ];
  if (humanActorIds.length > 0) {
    const userRows = db
      .select({ id: users.id, username: users.username, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, humanActorIds))
      .all();
    const nameMap = new Map(userRows.map((u) => [u.id, u.displayName || u.username]));
    for (const event of events) {
      if (event.actor.type === "human" && event.actor.id && !event.actor.name) {
        event.actor.name = nameMap.get(event.actor.id) ?? null;
      }
    }
  }

  const remoteActorIds = [
    ...new Set(
      events
        .filter(
          (e) =>
            (e.actor.type === "remote_human" || e.actor.type === "remote_orcy") &&
            e.actor.id &&
            !e.actor.name,
        )
        .map((e) => e.actor.id!),
    ),
  ];
  if (remoteActorIds.length > 0) {
    const remoteRows = db
      .select({
        id: remoteParticipants.id,
        displayName: remoteParticipants.displayName,
        remotePodId: remoteParticipants.remotePodId,
      })
      .from(remoteParticipants)
      .where(inArray(remoteParticipants.id, remoteActorIds))
      .all();
    const remoteNameMap = new Map(remoteRows.map((r) => [r.id, r.displayName]));
    for (const event of events) {
      if (
        (event.actor.type === "remote_human" || event.actor.type === "remote_orcy") &&
        event.actor.id &&
        !event.actor.name
      ) {
        event.actor.name = remoteNameMap.get(event.actor.id) ?? null;
      }
    }
  }
}

function sortEvents(events: AuditEvent[], order: "asc" | "desc"): AuditEvent[] {
  return events.toSorted((a, b) => {
    const time = a.occurredAt.localeCompare(b.occurredAt);
    const direction = order === "asc" ? time : -time;
    if (direction !== 0) return direction;
    return a.id.localeCompare(b.id);
  });
}

export interface CollectAuditProjectionInput {
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
  source?: string;
  order?: "asc" | "desc";
  includeHealthSnapshots?: boolean;
  referencedEntities?: readonly AuditEntityReferenceFilter[];
}

export function collectAuditProjection(input: CollectAuditProjectionInput): AuditProjectionSet {
  const query = normalizeFilters(input as AuditQueryInput);
  const selectedEntityTypes = resolveSelectedEntityTypes(
    query.entityType,
    query.entityTypes,
    query.includeHealthSnapshots,
  );
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

  let filteredEvents = allEvents.filter((event) => matchesEvent(event, query));

  if (query.referencedEntities && query.referencedEntities.length > 0) {
    filteredEvents = filteredEvents.filter((event) =>
      matchesReferencedEntities(event, query.referencedEntities!),
    );
  }

  enrichAuditActorNames(filteredEvents);

  if (filteredEvents.some((event) => event.completeness.status === "legacy_partial")) {
    allWarnings.push({
      code: "legacy_partial_history",
      message:
        "Some events predate canonical provenance capture and may have partial source data.",
    });
  }

  if (filteredEvents.some((event) => event.completeness.status === "source_unavailable")) {
    allWarnings.push({
      code: "source_unavailable",
      message: "Some provider-derived code evidence records lack delivery provenance.",
    });
  }

  const sortedEvents = sortEvents(filteredEvents, input.order ?? "desc");

  return {
    events: sortedEvents,
    warnings: allWarnings,
    caveats: allCaveats,
  };
}