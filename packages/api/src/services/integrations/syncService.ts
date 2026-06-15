import * as connectionRepo from "../../repositories/integrationConnection.js";
import * as linkRepo from "../../repositories/externalIssueLink.js";
import * as syncRunRepo from "../../repositories/integrationSyncRun.js";
import * as candidateRepo from "../../repositories/externalIntakeCandidate.js";
import * as missionRepo from "../../repositories/feature.js";
import * as taskRepo from "../../repositories/task.js";
import { resolveImportColumn } from "../../repositories/column.js";
import { emitMissionAuditEvent } from "../auditEventEmitter.js";
import type { IntegrationConnection } from "@orcy/shared";
import type {
  IssueProviderAdapter,
  IntegrationSyncResult,
  ExternalIssueSyncResult,
} from "./types.js";
import type { ExternalIssue, IntegrationSyncTrigger } from "@orcy/shared";
import { logger } from "../../lib/logger.js";
import { badRequest, notFound } from "../../errors.js";

const TERMINAL_TASK_STATUSES = ["done", "approved", "failed"];

/** Runs a full pull sync for an integration connection, importing or updating linked missions and intake candidates while recording sync run status. */
export async function syncConnection(
  connectionId: string,
  trigger: IntegrationSyncTrigger,
  adapter: IssueProviderAdapter,
): Promise<IntegrationSyncResult> {
  const connection = connectionRepo.getById(connectionId);
  if (!connection) throw new Error(`Connection ${connectionId} not found`);
  if (!connection.enabled) throw new Error("Connection is disabled");
  if (!connection.pullEnabled) throw new Error("Pull sync is disabled for this connection");

  const syncRun = syncRunRepo.create({
    connectionId,
    habitatId: connection.habitatId,
    trigger,
  });

  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let overallError: string | undefined;

  try {
    const issues = await adapter.listIssues(connection);

    for (const issue of issues) {
      try {
        const result = syncExternalIssue(connection, issue, syncRun.id);
        if (result.action === "created") createdCount++;
        else if (result.action === "updated" || result.action === "closed") updatedCount++;
        else skippedCount++;
      } catch (err: any) {
        failedCount++;
        logger.warn({ err, externalId: issue.externalId }, "Failed to sync external issue");
      }
    }

    const status =
      failedCount > 0 ? (createdCount + updatedCount > 0 ? "partial" : "failed") : "success";

    syncRunRepo.finish(syncRun.id, {
      status: status as any,
      createdCount,
      updatedCount,
      skippedCount,
      failedCount,
      error: overallError,
    });

    const now = new Date().toISOString();
    connectionRepo.update(connectionId, {
      lastSyncAt: now,
      lastSyncStatus: status as any,
      lastSyncError: status === "failed" ? (overallError ?? null) : null,
    });

    return {
      syncRunId: syncRun.id,
      status: status as any,
      createdCount,
      updatedCount,
      skippedCount,
      failedCount,
    };
  } catch (err: any) {
    overallError = err.message ?? String(err);

    syncRunRepo.finish(syncRun.id, {
      status: "failed",
      createdCount,
      updatedCount,
      skippedCount,
      failedCount,
      error: overallError,
    });

    connectionRepo.update(connectionId, {
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: "failed",
      lastSyncError: overallError,
    });

    return {
      syncRunId: syncRun.id,
      status: "failed",
      createdCount,
      updatedCount,
      skippedCount,
      failedCount,
      error: overallError,
    };
  }
}

/** Syncs a single external issue into Orcy, updating an existing linked mission or creating a mission or intake candidate. */
export function syncExternalIssue(
  connection: IntegrationConnection,
  issue: ExternalIssue,
  syncRunId?: string,
): ExternalIssueSyncResult {
  const existingLink = linkRepo.findByConnectionAndExternalId(connection.id, issue.externalId);

  if (existingLink) {
    return updateLinkedMission(
      connection,
      issue,
      existingLink.missionId,
      existingLink.id,
      syncRunId,
    );
  }

  if (connection.provider !== "github") {
    return syncAsIntakeCandidate(connection, issue);
  }

  if (!connection.autoImport) {
    return syncAsIntakeCandidate(connection, issue);
  }

  if (issue.status === "closed") {
    return { action: "skipped", missionId: "", linkId: "" };
  }

  const col = resolveImportColumn(connection.habitatId);
  if (!col) {
    throw new Error(`No non-terminal column found for habitat ${connection.habitatId}`);
  }

  const labels = [...issue.labels, `external:${issue.provider}`];

  const mission = missionRepo.createMission({
    habitatId: connection.habitatId,
    columnId: col.columnId,
    title: issue.title,
    description: issue.body || "",
    priority: "medium",
    labels,
    createdBy: connection.createdBy,
  });

  const link = linkRepo.create({
    connectionId: connection.id,
    habitatId: connection.habitatId,
    missionId: mission.id,
    provider: issue.provider,
    externalId: issue.externalId,
    externalKey: issue.externalKey,
    externalUrl: issue.url,
    externalStatus: issue.status,
    externalUpdatedAt: issue.updatedAt,
    providerLabels: issue.labels,
  });

  emitMissionAuditEvent({
    missionId: mission.id,
    actorType: "system",
    actorId: "system:integration-sync",
    action: "created",
    metadata: integrationAuditMetadata(connection, issue, syncRunId, {
      externalIssueLinkId: link.id,
      changedFields: ["title", "description", "labels"],
    }),
  });

  return { action: "created", missionId: mission.id, linkId: link.id };
}

function syncAsIntakeCandidate(
  connection: IntegrationConnection,
  issue: ExternalIssue,
): ExternalIssueSyncResult {
  const existingCandidate = candidateRepo.findByConnectionAndExternalId(
    connection.id,
    issue.externalId,
  );

  if (existingCandidate) {
    const updates: Parameters<typeof candidateRepo.update>[1] = {
      sourceTitle: issue.title,
      sourceBody: issue.body,
      sourceStatus: issue.status,
      sourcePriority: issue.priority,
      sourceLabels: issue.labels,
      sourceAssignees: issue.assignees ?? [],
      externalUpdatedAt: issue.updatedAt,
      rawProviderPayload: issue.rawProviderPayload ?? null,
    };
    if (issue.status === "closed" && existingCandidate.reviewStatus === "new") {
      updates.reviewStatus = "ignored";
    }
    candidateRepo.update(existingCandidate.id, updates);
    return { action: "updated", missionId: "", linkId: "" };
  }

  if (issue.status === "closed") {
    return { action: "skipped", missionId: "", linkId: "" };
  }

  candidateRepo.create({
    connectionId: connection.id,
    habitatId: connection.habitatId,
    provider: issue.provider,
    externalId: issue.externalId,
    externalKey: issue.externalKey,
    externalUrl: issue.url,
    sourceKind: issue.sourceKind,
    sourceStatus: issue.status,
    sourcePriority: issue.priority,
    sourceAssignees: issue.assignees ?? [],
    sourceReporter: issue.reporter ?? null,
    sourceLabels: issue.labels,
    sourceTitle: issue.title,
    sourceBody: issue.body,
    rawProviderPayload: issue.rawProviderPayload ?? null,
    externalUpdatedAt: issue.updatedAt,
  });

  return { action: "created", missionId: "", linkId: "" };
}

function updateLinkedMission(
  connection: IntegrationConnection,
  issue: ExternalIssue,
  missionId: string,
  linkId: string,
  syncRunId?: string,
): ExternalIssueSyncResult {
  const existingLink = linkRepo.getById(linkId);
  if (!existingLink) throw new Error(`Link ${linkId} not found`);

  const currentLabels = missionRepo.getMissionById(missionId)?.labels ?? [];
  const previousProviderLabels = existingLink.providerLabels ?? [];

  const orcyOnlyLabels = currentLabels.filter((l) => !previousProviderLabels.includes(l));
  const newLabels = [...orcyOnlyLabels, ...issue.labels];
  if (!newLabels.includes(`external:${issue.provider}`)) {
    newLabels.push(`external:${issue.provider}`);
  }

  missionRepo.updateMission(missionId, {
    title: issue.title,
    description: issue.body || "",
    labels: newLabels,
  });

  emitMissionAuditEvent({
    missionId,
    actorType: "system",
    actorId: "system:integration-sync",
    action: "updated",
    metadata: integrationAuditMetadata(connection, issue, syncRunId, {
      externalIssueLinkId: linkId,
      changedFields: ["title", "description", "labels"],
    }),
  });

  if (issue.status === "closed") {
    return handleExternalClose(connection, missionId, linkId, issue, syncRunId);
  }

  linkRepo.update(linkId, {
    externalStatus: issue.status,
    externalUpdatedAt: issue.updatedAt,
    providerLabels: issue.labels,
    syncStatus: "synced",
    syncWarning: null,
    lastSyncedAt: new Date().toISOString(),
  });

  return { action: "updated", missionId, linkId };
}

function handleExternalClose(
  connection: IntegrationConnection,
  missionId: string,
  linkId: string,
  issue: ExternalIssue,
  syncRunId?: string,
): ExternalIssueSyncResult {
  const tasks = taskRepo.getTasksByMissionId(missionId);

  const allTerminal = tasks.every((t) => TERMINAL_TASK_STATUSES.includes(t.status));

  if (allTerminal) {
    missionRepo.updateMission(missionId, { status: "done" });

    emitMissionAuditEvent({
      missionId,
      actorType: "system",
      actorId: "system:integration-sync",
      action: "status_changed",
      toStatus: "done",
      metadata: integrationAuditMetadata(connection, issue, syncRunId, {
        externalIssueLinkId: linkId,
        externalStatus: "closed",
      }),
    });

    linkRepo.update(linkId, {
      externalStatus: "closed",
      externalUpdatedAt: issue.updatedAt,
      syncStatus: "synced",
      syncWarning: null,
      lastSyncedAt: new Date().toISOString(),
    });

    return { action: "closed", missionId, linkId };
  }

  const currentLabels = missionRepo.getMissionById(missionId)?.labels ?? [];
  if (!currentLabels.includes("external-closed")) {
    missionRepo.updateMission(missionId, { labels: [...currentLabels, "external-closed"] });
    emitMissionAuditEvent({
      missionId,
      actorType: "system",
      actorId: "system:integration-sync",
      action: "updated",
      metadata: integrationAuditMetadata(connection, issue, syncRunId, {
        externalIssueLinkId: linkId,
        externalStatus: "closed",
        changedFields: ["labels"],
        warning: "External issue closed while Orcy mission has active tasks",
      }),
    });
  }

  linkRepo.update(linkId, {
    externalStatus: "closed",
    externalUpdatedAt: issue.updatedAt,
    syncStatus: "warning",
    syncWarning: "External issue closed while Orcy mission has active tasks",
    lastSyncedAt: new Date().toISOString(),
  });

  return { action: "warning", missionId, linkId };
}

function integrationAuditMetadata(
  connection: IntegrationConnection,
  issue: ExternalIssue,
  syncRunId: string | undefined,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...metadata,
    provider: issue.provider,
    externalId: issue.externalId,
    externalKey: issue.externalKey,
    externalUrl: issue.url,
    audit: {
      source: "integration_sync",
      provider: issue.provider,
      externalId: issue.externalId,
      ...(syncRunId ? { integrationSyncRunId: syncRunId } : {}),
      reason: `integration:${connection.provider}`,
    },
  };
}

/** Input shape for promoting an external intake candidate into a mission. */
export interface PromoteIntakeCandidateInput {
  candidateId: string;
  createdBy: string;
  verifyAccess: (habitatId: string) => void;
}

/** Result of promoting an intake candidate into a mission. */
export interface PromoteIntakeCandidateResult {
  mission: ReturnType<typeof missionRepo.createMission>;
  link: ReturnType<typeof linkRepo.create>;
  candidate: ReturnType<typeof candidateRepo.getById>;
}

/** Promotes an external intake candidate into a mission and links it to the external issue. */
export function promoteIntakeCandidate(
  input: PromoteIntakeCandidateInput,
): PromoteIntakeCandidateResult {
  const candidate = candidateRepo.getById(input.candidateId);
  if (!candidate) throw notFound("Candidate not found");

  input.verifyAccess(candidate.habitatId);

  if (candidate.reviewStatus === "promoted") {
    throw badRequest("Candidate has already been promoted");
  }

  const col = resolveImportColumn(candidate.habitatId);
  if (!col) throw badRequest("No import column found for habitat");

  const labels = [...candidate.sourceLabels, `external:${candidate.provider}`];
  const mission = missionRepo.createMission({
    habitatId: candidate.habitatId,
    columnId: col.columnId,
    title: candidate.sourceTitle,
    description: candidate.sourceBody || "",
    priority: "medium",
    labels,
    createdBy: input.createdBy,
  });

  const link = linkRepo.create({
    connectionId: candidate.connectionId,
    habitatId: candidate.habitatId,
    missionId: mission.id,
    provider: candidate.provider,
    externalId: candidate.externalId,
    externalKey: candidate.externalKey,
    externalUrl: candidate.externalUrl,
    externalStatus: candidate.sourceStatus === "closed" ? "closed" : "open",
    providerLabels: candidate.sourceLabels,
  });

  candidateRepo.update(candidate.id, {
    reviewStatus: "promoted",
    promotedMissionId: mission.id,
  });

  return { mission, link, candidate: candidateRepo.getById(candidate.id)! };
}
