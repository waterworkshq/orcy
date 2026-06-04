import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Handler } from "./dispatch-utils.js";

export const ADMIN_EXPORT_AUDIT_LOG_TOOL: Tool = {
  name: "admin_export_audit_log",
  description:
    "Export the audit log for a board. Returns canonical AuditEvent rows in csv, json, or jsonl format. Supports filters by date, entity, source, provider, actor, and preset.",
  inputSchema: {
    type: "object",
    properties: {
      boardId: { type: "string", description: "Habitat ID" },
      format: { type: "string", enum: ["csv", "json", "jsonl"], description: "Export format" },
      since: { type: "string", description: "ISO 8601 start date" },
      until: { type: "string", description: "ISO 8601 end date" },
      actions: { type: "string", description: "Comma-separated action types" },
      actorType: { type: "string", enum: ["human", "agent", "system"] },
      actorId: { type: "string", description: "Actor ID" },
      entityTypes: { type: "string", description: "Comma-separated canonical entity types" },
      entityType: { type: "string", description: "Single canonical entity type" },
      entityId: { type: "string", description: "Canonical entity ID" },
      taskId: { type: "string", description: "Scoped task ID" },
      missionId: { type: "string", description: "Scoped mission ID" },
      source: { type: "string", description: "Audit source" },
      provider: { type: "string", description: "Provider such as github" },
      preset: {
        type: "string",
        description: "effort_corrections, code_evidence_changes, or failed_pipelines",
      },
      includeProvenance: { type: "boolean" },
      includeIntegrity: { type: "boolean" },
      includeHealthSnapshots: { type: "boolean" },
    },
    required: ["boardId", "format"],
  },
};

export const ADMIN_GET_AUDIT_SUMMARY_TOOL: Tool = {
  name: "admin_get_audit_summary",
  description:
    "Get audit summary statistics for a board: total events, action breakdown, actor type breakdown, daily counts, and top missions.",
  inputSchema: {
    type: "object",
    properties: {
      boardId: { type: "string", description: "Habitat ID" },
      since: { type: "string", description: "ISO 8601 start date" },
      until: { type: "string", description: "ISO 8601 end date" },
    },
    required: ["boardId"],
  },
};

export const adminExportAuditLog: Handler = (client, args) =>
  client.exportAuditLog(args.boardId, {
    format: args.format ?? "json",
    since: args.since,
    until: args.until,
    actions: args.actions,
    actorType: args.actorType,
    actorId: args.actorId,
    entityTypes: args.entityTypes,
    entityType: args.entityType,
    entityId: args.entityId,
    taskId: args.taskId,
    missionId: args.missionId,
    source: args.source,
    provider: args.provider,
    preset: args.preset,
    includeProvenance: Boolean(args.includeProvenance),
    includeIntegrity: Boolean(args.includeIntegrity),
    includeHealthSnapshots: Boolean(args.includeHealthSnapshots),
  });

export const adminGetAuditSummary: Handler = (client, args) =>
  client.getAuditSummary(args.boardId, {
    since: args.since,
    until: args.until,
  });

export const habitatGetTaskAuditBundle: Handler = (client, args) =>
  client.getTaskAuditBundle(args.taskId, {
    includeHealthSnapshots: Boolean(args.includeHealthSnapshots),
  });

export const habitatGetMissionAuditBundle: Handler = (client, args) =>
  client.getMissionAuditBundle(args.missionId, {
    includeHealthSnapshots: Boolean(args.includeHealthSnapshots),
  });
