import type {
  AuditEntityRef,
  AuditEntityType,
  AuditEvent,
  AuditQueryEntityType,
  AuditSource,
} from "@orcy/shared/types";
import { AUDIT_SOURCES } from "@orcy/shared/types";
import { normalizeAuditActorAndSource } from "../auditProjectionNormalizer.js";
import type { AuditQueryInput } from "../auditQueryService.js";
import { badRequest } from "../../errors.js";
import { getDb } from "../../db/index.js";
import { missions, tasks } from "../../db/schema/index.js";
import { eq, inArray } from "drizzle-orm";

export const AUDIT_SOURCE_SET = new Set<AuditSource>(AUDIT_SOURCES);

export interface MissionInfo {
  habitatId: string;
  missionId: string;
  missionTitle: string | null;
}

export interface TaskInfo extends MissionInfo {
  taskId: string;
  taskTitle: string;
}

/** Coerces and validates an audit query, converting `taskId`/`missionId` shortcuts into explicit entity-type/entity-id pairs and rejecting conflicting combinations. */
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

/** Returns true when an {@link AuditEvent} satisfies every filter field of an {@link AuditQueryInput}. */
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

/** Returns audit events sorted by `occurredAt` then `id`, breaking ties deterministically. */
export function sortEvents(events: AuditEvent[], order: "asc" | "desc"): AuditEvent[] {
  return events.toSorted((a, b) => {
    const time = a.occurredAt.localeCompare(b.occurredAt);
    const direction = order === "asc" ? time : -time;
    if (direction !== 0) return direction;
    return a.id.localeCompare(b.id);
  });
}

interface ResolvedRef {
  ref: AuditEntityRef;
  /** For task refs, the owning mission id (resolved and verified within habitat). */
  owningMissionId?: string;
}

/**
 * Batch-resolves `(type, id)` pairs against the task and mission tables,
 * returning the deduplicated list of resolved {@link AuditEntityRef}s (with
 * titles) plus a list of unresolved pair warnings. Cross-habitat or missing
 * references are reported as warnings and omitted from the resolved list.
 */
export function resolveEntityReferences(
  habitatId: string,
  references: Iterable<{ type: "task" | "mission"; id: string | null }>,
): { resolved: AuditEntityRef[]; unresolved: { type: "task" | "mission"; id: string }[]; byKey: Map<string, ResolvedRef> } {
  const taskIds = new Set<string>();
  const missionIds = new Set<string>();
  const seen = new Set<string>();
  for (const ref of references) {
    if (!ref.id) continue;
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (ref.type === "task") taskIds.add(ref.id);
    else missionIds.add(ref.id);
  }
  const byKey = new Map<string, ResolvedRef>();
  const resolved: AuditEntityRef[] = [];
  const unresolved: { type: "task" | "mission"; id: string }[] = [];

  if (taskIds.size === 0 && missionIds.size === 0) {
    return { resolved, unresolved, byKey };
  }

  const db = getDb();

  if (taskIds.size > 0) {
    const taskRows = db
      .select({
        id: tasks.id,
        title: tasks.title,
        missionId: tasks.missionId,
        habitatId: missions.habitatId,
      })
      .from(tasks)
      .innerJoin(missions, eq(tasks.missionId, missions.id))
      .where(inArray(tasks.id, Array.from(taskIds)))
      .all();

    const foundTaskIds = new Set<string>();
    for (const row of taskRows) {
      foundTaskIds.add(row.id);
      if (row.habitatId !== habitatId) {
        unresolved.push({ type: "task", id: row.id });
        continue;
      }
      const taskRef: AuditEntityRef = { type: "task", id: row.id, title: row.title };
      resolved.push(taskRef);
      byKey.set(`task:${row.id}`, { ref: taskRef, owningMissionId: row.missionId });
    }
    for (const taskId of taskIds) {
      if (!foundTaskIds.has(taskId)) unresolved.push({ type: "task", id: taskId });
    }
  }

  if (missionIds.size > 0) {
    const missionRows = db
      .select({ id: missions.id, title: missions.title, habitatId: missions.habitatId })
      .from(missions)
      .where(inArray(missions.id, Array.from(missionIds)))
      .all();
    const foundMissionIds = new Set<string>();
    for (const row of missionRows) {
      foundMissionIds.add(row.id);
      if (row.habitatId !== habitatId) {
        unresolved.push({ type: "mission", id: row.id });
        continue;
      }
      const missionRef: AuditEntityRef = {
        type: "mission",
        id: row.id,
        title: row.title,
      };
      resolved.push(missionRef);
      byKey.set(`mission:${row.id}`, { ref: missionRef });
    }
    for (const missionId of missionIds) {
      if (!foundMissionIds.has(missionId)) unresolved.push({ type: "mission", id: missionId });
    }
  }

  // Attach owning-mission refs for any task that's been resolved.
  const owningMissionIds = new Set<string>();
  for (const entry of byKey.values()) {
    if (entry.owningMissionId) owningMissionIds.add(entry.owningMissionId);
  }
  if (owningMissionIds.size > 0) {
    const missing = Array.from(owningMissionIds).filter((id) => !byKey.has(`mission:${id}`));
    if (missing.length > 0) {
      const owningRows = db
        .select({ id: missions.id, title: missions.title, habitatId: missions.habitatId })
        .from(missions)
        .where(inArray(missions.id, missing))
        .all();
      for (const row of owningRows) {
        if (row.habitatId !== habitatId) continue;
        const missionRef: AuditEntityRef = {
          type: "mission",
          id: row.id,
          title: row.title,
        };
        resolved.push(missionRef);
        byKey.set(`mission:${row.id}`, { ref: missionRef });
      }
    }
  }

  return { resolved, unresolved, byKey };
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function sanitizeMetadata(metadata: Record<string, unknown> | null | undefined) {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    const normalized = key.toLowerCase();
    if (
      normalized === "rawproviderpayload" ||
      normalized === "rawpayload" ||
      normalized === "payload" ||
      normalized === "diff" ||
      normalized === "patch" ||
      normalized === "content"
    ) {
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

export function auditMetadata(metadata: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(metadata.audit) ? metadata.audit : null;
}

export function hasAuditMetadata(metadata: Record<string, unknown>): boolean {
  return Boolean(
    metadata.audit && typeof metadata.audit === "object" && !Array.isArray(metadata.audit),
  );
}

export function sourceFromAuditMetadata(metadata: Record<string, unknown>): AuditSource | null {
  const source = readString(auditMetadata(metadata)?.source);
  if (!source) return null;
  if (AUDIT_SOURCE_SET.has(source as AuditSource)) {
    return source as AuditSource;
  }
  return null;
}

export function buildCompleteness(metadata: Record<string, unknown>) {
  if (hasAuditMetadata(metadata)) {
    return { status: "complete" as const, caveats: [] };
  }
  return {
    status: "legacy_partial" as const,
    caveats: ["Source/provenance metadata was not captured for this historical event."],
  };
}

export function codeEvidenceCompleteness(metadata: Record<string, unknown>) {
  if (!hasAuditMetadata(metadata)) {
    return {
      status: "legacy_partial" as const,
      caveats: ["Evidence row predates canonical provenance capture or lacks request metadata."],
    };
  }
  const audit = metadata.audit as Record<string, unknown>;
  const actorType = audit.actorType;
  const remoteMeta = audit.remote;
  if (
    (actorType === "remote_human" || actorType === "remote_orcy" || actorType === "remote_pod") &&
    remoteMeta &&
    typeof remoteMeta === "object"
  ) {
    return {
      status: "complete" as const,
      caveats: [
        "Evidence was supplied by a remote participant. It is labeled remote-supplied until host/provider verification enriches it.",
      ],
    };
  }
  return { status: "complete" as const, caveats: [] };
}

export function providerCompleteness(metadata: Record<string, unknown>) {
  if (hasAuditMetadata(metadata)) return { status: "complete" as const, caveats: [] };
  return {
    status: "source_unavailable" as const,
    caveats: ["Provider delivery provenance was not captured for this code evidence record."],
  };
}

export function targetEntityRef(info: TaskInfo | MissionInfo) {
  if ("taskId" in info) return { type: "task" as const, id: info.taskId, title: info.taskTitle };
  return { type: "mission" as const, id: info.missionId, title: info.missionTitle };
}

export function targetLinkedEntities(info: TaskInfo | MissionInfo) {
  if ("taskId" in info) {
    return [{ type: "mission" as const, id: info.missionId, title: info.missionTitle }];
  }
  return [];
}

export function evidenceTargetKey(evidenceType: string, evidenceId: string | null) {
  return evidenceId ? `${evidenceType}:${evidenceId}` : null;
}

export function evidenceTypeToAuditEntityType(evidenceType: string): AuditEntityType | null {
  if (evidenceType === "review") return "code_review" as const;
  if (evidenceType === "pipeline_run") return "pipeline_event" as const;
  if (evidenceType === "external_url") return null;
  if (
    evidenceType === "branch" ||
    evidenceType === "commit" ||
    evidenceType === "changed_file" ||
    evidenceType === "pull_request"
  ) {
    return evidenceType as AuditEntityType;
  }
  return null;
}

export function evidenceLinkSourceToAuditSource(linkSource: string): AuditSource {
  if (linkSource === "webhook") return "webhook";
  if (linkSource === "agent_reported") return "mcp_tool";
  if (linkSource === "api" || linkSource === "human_manual") return "rest_api";
  if (linkSource === "migration") return "migration";
  if (linkSource === "commit_trailer" || linkSource === "branch_pattern") return "integration_sync";
  return "unknown";
}

export function pushEvidenceTarget(
  map: Map<string, Array<TaskInfo | MissionInfo>>,
  evidenceType: string,
  evidenceId: string | null,
  target: TaskInfo | MissionInfo | null,
) {
  const key = evidenceTargetKey(evidenceType, evidenceId);
  if (!key || !target) return;
  const existing = map.get(key) ?? [];
  existing.push(target);
  map.set(key, existing);
}

export function taskSummary(
  row: { action: string; taskTitle: string },
): string {
  if (row.action === "moved") return `Task moved: ${row.taskTitle}`;
  if (row.action === "updated") return `Task updated: ${row.taskTitle}`;
  return `Task ${row.action}: ${row.taskTitle}`;
}

export function missionSummary(row: { action: string }, title: string): string {
  if (row.action === "status_changed") return `Mission status changed: ${title}`;
  if (row.action === "moved") return `Mission moved: ${title}`;
  return `Mission ${row.action}: ${title}`;
}

export function effortSummary(
  row: { correctsEntryId: string | null },
  taskTitle: string,
): string {
  if (row.correctsEntryId) return `Effort corrected for task: ${taskTitle}`;
  return `Effort logged for task: ${taskTitle}`;
}

export { normalizeAuditActorAndSource };