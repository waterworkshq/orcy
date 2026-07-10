import type {
  AuditEntityType,
  AuditSource,
} from "@orcy/shared/types";
import { AUDIT_SOURCES } from "@orcy/shared/types";
import { normalizeAuditActorAndSource } from "../auditProjectionNormalizer.js";

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