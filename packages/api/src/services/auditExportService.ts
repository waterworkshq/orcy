import type { FastifyReply } from "fastify";
import type {
  AuditCompletenessSummary,
  AuditEvent,
  AuditSource,
  AuditWarning,
} from "@orcy/shared/types";
import {
  queryAuditEvents,
  summarizeAuditCompleteness,
  type AuditQueryInput,
} from "./auditQueryService.js";
import * as auditExportRepo from "../repositories/auditExport.js";

export interface AuditExportQuery {
  format: "csv" | "json" | "jsonl";
  since?: string;
  until?: string;
  actions?: string;
  actorType?: string;
  actorId?: string;
  entityTypes?: string;
  entityType?: string;
  entityId?: string;
  taskId?: string;
  missionId?: string;
  source?: string;
  provider?: string;
  preset?: string;
  includeMetadata?: string;
  includeProvenance?: string;
  includeIntegrity?: string;
  includeHealthSnapshots?: string;
}

export type AuditEventQuery = Omit<AuditExportQuery, "format">;

export interface CanonicalAuditEventResult {
  events: AuditEvent[];
  warnings: AuditWarning[];
  completenessSummary: AuditCompletenessSummary;
}

export interface AuditSummary {
  totalEvents: number;
  byAction: Record<string, number>;
  byActorType: Record<string, number>;
  byDay: { date: string; count: number }[];
  topMissions: { missionId: string; missionTitle: string; count: number }[];
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function parseCsvFilter(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function includeStructuredField(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function isAuditEntityType(
  value: string | undefined,
): value is NonNullable<AuditQueryInput["entityType"]> {
  if (!value) return false;
  return [
    "task",
    "mission",
    "effort_entry",
    "code_evidence_link",
    "code_evidence_gap",
    "commit",
    "changed_file",
    "pull_request",
    "code_review",
    "pipeline_event",
    "integration_sync_run",
    "webhook_delivery",
    "health_snapshot",
  ].includes(value);
}

function isAuditSource(value: string | undefined): value is AuditSource {
  if (!value) return false;
  return [
    "rest_api",
    "mcp_tool",
    "webhook",
    "daemon",
    "system",
    "integration_sync",
    "scheduler",
    "migration",
    "unknown",
  ].includes(value);
}

function toAuditQuery(habitatId: string, query: AuditEventQuery): AuditQueryInput {
  const entityType = isAuditEntityType(query.entityType) ? query.entityType : undefined;
  const source = isAuditSource(query.source) ? query.source : undefined;
  return {
    habitatId,
    since: query.since,
    until: query.until,
    entityType,
    entityId: query.entityId,
    taskId: query.taskId,
    missionId: query.missionId,
    actorType:
      query.actorType === "human" || query.actorType === "agent" || query.actorType === "system"
        ? query.actorType
        : undefined,
    actorId: query.actorId,
    source,
    order: "asc",
    includeHealthSnapshots: includeStructuredField(query.includeHealthSnapshots),
  };
}

function eventMatchesExportFilters(event: AuditEvent, query: AuditEventQuery): boolean {
  const actions = parseCsvFilter(query.actions);
  if (actions.length > 0 && !actions.includes(event.action)) return false;

  const entityTypes = parseCsvFilter(query.entityTypes);
  if (entityTypes.length > 0 && !entityTypes.includes(event.entity.type)) return false;

  if (query.provider) {
    const provider = event.provenance.provider ?? event.metadata.provider;
    if (provider !== query.provider) return false;
  }

  switch (query.preset) {
    case "effort_corrections":
      return event.entity.type === "effort_entry" && event.action === "corrected";
    case "code_evidence_changes":
      return (
        event.entity.type === "code_evidence_link" || event.entity.type === "code_evidence_gap"
      );
    case "failed_pipelines":
      return event.entity.type === "pipeline_event" && event.action === "failure";
    case undefined:
    case "":
      return true;
    default:
      return true;
  }
}

function collectCanonicalAuditEvents(habitatId: string, query: AuditEventQuery): AuditEvent[] {
  const result = queryAuditEvents(toAuditQuery(habitatId, query));
  return result.events.filter((event) => eventMatchesExportFilters(event, query));
}

export function getCanonicalAuditEvents(
  habitatId: string,
  query: AuditEventQuery,
): CanonicalAuditEventResult {
  const result = queryAuditEvents(toAuditQuery(habitatId, query));
  const events = result.events.filter((event) => eventMatchesExportFilters(event, query));
  return {
    events,
    warnings: result.warnings,
    completenessSummary: summarizeAuditCompleteness(events),
  };
}

function canonicalEventsToCsv(events: AuditEvent[], query: AuditExportQuery): string {
  const includeMetadata = includeStructuredField(query.includeMetadata);
  const includeProvenance = includeStructuredField(query.includeProvenance);
  const includeIntegrity = includeStructuredField(query.includeIntegrity);
  const headers = [
    "id",
    "occurredAt",
    "habitatId",
    "entityType",
    "entityId",
    "action",
    "actorType",
    "actorId",
    "source",
    "summary",
    "completenessStatus",
    ...(includeProvenance ? ["provenanceJson"] : []),
    ...(includeIntegrity ? ["integrityJson"] : []),
    ...(includeMetadata ? ["metadataJson"] : []),
  ];
  const lines = [headers.join(",")];
  for (const event of events) {
    lines.push(
      [
        event.id,
        event.occurredAt,
        event.habitatId,
        event.entity.type,
        event.entity.id,
        event.action,
        event.actor.type,
        event.actor.id,
        event.source,
        event.summary,
        event.completeness.status,
        ...(includeProvenance ? [JSON.stringify(event.provenance)] : []),
        ...(includeIntegrity ? [JSON.stringify(event.integrity ?? null)] : []),
        ...(includeMetadata ? [JSON.stringify(event.metadata)] : []),
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

function canonicalEventsToJson(events: AuditEvent[]): string {
  return JSON.stringify(events, null, 2);
}

function canonicalEventsToJsonl(events: AuditEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : "");
}

export function generateAuditExportContent(habitatId: string, query: AuditExportQuery): string {
  const events = collectCanonicalAuditEvents(habitatId, query);

  if (query.format === "csv") {
    return canonicalEventsToCsv(events, query);
  }
  if (query.format === "jsonl") {
    return canonicalEventsToJsonl(events);
  }
  return canonicalEventsToJson(events);
}

export function getExportFilename(habitatId: string, format: string): string {
  const date = new Date().toISOString().split("T")[0];
  return `audit-${habitatId.slice(0, 8)}-${date}.${format}`;
}

export function getExportContentType(format: string): string {
  switch (format) {
    case "csv":
      return "text/csv; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "jsonl":
      return "application/x-ndjson; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

export async function streamAuditExport(
  habitatId: string,
  query: AuditExportQuery,
  reply: FastifyReply,
): Promise<void> {
  const format = query.format;

  reply.header("Content-Type", getExportContentType(format));
  reply.header(
    "Content-Disposition",
    `attachment; filename="${getExportFilename(habitatId, format)}"`,
  );
  const content = generateAuditExportContent(habitatId, query);
  return reply.send(format === "json" ? JSON.parse(content) : content);
}

export function getAuditSummary(habitatId: string, since?: string, until?: string): AuditSummary {
  const allRows = auditExportRepo.getAuditSummaryRows(habitatId, since, until);

  const byAction: Record<string, number> = {};
  const byActorType: Record<string, number> = {};
  const byDayMap = new Map<string, number>();
  const missionMap = new Map<string, { missionId: string; missionTitle: string; count: number }>();

  for (const row of allRows) {
    byAction[row.action] = (byAction[row.action] || 0) + 1;
    byActorType[row.actorType] = (byActorType[row.actorType] || 0) + 1;

    const day = row.timestamp.slice(0, 10);
    byDayMap.set(day, (byDayMap.get(day) || 0) + 1);

    if (row.missionId) {
      const existing = missionMap.get(row.missionId);
      if (existing) {
        existing.count++;
      } else {
        missionMap.set(row.missionId, {
          missionId: row.missionId,
          missionTitle: row.missionTitle,
          count: 1,
        });
      }
    }
  }

  const byDay = Array.from(byDayMap.entries())
    .map(([date, eventCount]) => ({ date, count: eventCount }))
    .toSorted((a, b) => a.date.localeCompare(b.date));

  const topMissions = Array.from(missionMap.values())
    .toSorted((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    totalEvents: allRows.length,
    byAction,
    byActorType,
    byDay,
    topMissions,
  };
}

export interface AuditExportSchedule {
  id: string;
  habitatId: string;
  name: string;
  format: "csv" | "json" | "jsonl";
  filters: Record<string, unknown>;
  schedule: string;
  destination: string;
  destinationConfig: Record<string, unknown>;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  createdBy: string;
  createdAt: string;
}

export function createSchedule(
  habitatId: string,
  input: {
    name: string;
    format: "csv" | "json" | "jsonl";
    filters?: Record<string, unknown>;
    schedule: string;
  },
): AuditExportSchedule {
  return auditExportRepo.createScheduleRecord(habitatId, input);
}

export function getScheduleById(id: string): AuditExportSchedule | null {
  return auditExportRepo.getScheduleById(id);
}

export function listSchedules(habitatId: string): AuditExportSchedule[] {
  return auditExportRepo.listSchedules(habitatId);
}

export function deleteSchedule(id: string): boolean {
  auditExportRepo.deleteSchedule(id);
  return true;
}
