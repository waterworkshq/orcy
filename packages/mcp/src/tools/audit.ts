import type { Handler } from "./dispatch-utils.js";

export const habitatGetTaskAuditBundle: Handler = (client, args) =>
  client.getTaskAuditBundle(args.taskId, {
    includeHealthSnapshots: Boolean(args.includeHealthSnapshots),
  });

export const habitatGetMissionAuditBundle: Handler = (client, args) =>
  client.getMissionAuditBundle(args.missionId, {
    includeHealthSnapshots: Boolean(args.includeHealthSnapshots),
  });

export const adminExportAuditLog: Handler = (client, args) => {
  if (args.entityTypes && args.entityType) {
    throw new Error("Cannot specify both entityTypes and entityType. Use one or the other.");
  }
  return client.exportAuditLog(args.boardId, {
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
};

export const adminGetAuditSummary: Handler = (client, args) =>
  client.getAuditSummary(args.boardId, {
    since: args.since,
    until: args.until,
  });
