import type {
  AuditCompletenessSummary,
  AuditEntityType,
  AuditEvent,
  AuditWarning,
  AuditSource,
} from "@orcy/shared/types";
import { getDb } from "../db/index.js";
import {
  agents,
  codeChangedFiles,
  codeCommits,
  codeEvidenceGaps,
  codeEvidenceLinks,
  codeReviews,
  habitatCodeRepositories,
  habitatHealthSnapshots,
  effortEntries,
  integrationConnections,
  integrationSyncRuns,
  missionEvents,
  missions,
  pipelineEvents,
  pullRequests,
  remoteParticipants,
  remotePods,
  taskEvents,
  tasks,
  users,
  webhookDeliveries,
  webhookSubscriptions,
} from "../db/schema/index.js";
import { eq, and, sql, inArray } from "drizzle-orm";
import { badRequest } from "../errors.js";
import { normalizeAuditActorAndSource } from "./auditProjectionNormalizer.js";

/** Filter and pagination parameters for querying the canonical audit projection across task, mission, effort, code evidence, and system sources. */
export interface AuditQueryInput {
  habitatId: string;
  since?: string;
  until?: string;
  entityType?:
    | "task"
    | "mission"
    | "effort_entry"
    | "code_evidence_link"
    | "code_evidence_gap"
    | "commit"
    | "changed_file"
    | "pull_request"
    | "code_review"
    | "pipeline_event"
    | "integration_sync_run"
    | "webhook_delivery"
    | "health_snapshot";
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
}

/** Result envelope for an audit query containing projected {@link AuditEvent} records, data-quality warnings, and a completeness summary. */
export interface AuditQueryResult {
  events: AuditEvent[];
  warnings: AuditWarning[];
  completenessSummary: AuditCompletenessSummary;
}

interface TaskAuditRow {
  id: string;
  taskId: string;
  taskTitle: string;
  missionId: string;
  missionTitle: string;
  missionHabitatId: string;
  actorType: "human" | "agent" | "system" | "remote_human" | "remote_orcy" | "remote_pod";
  actorId: string;
  actorName: string | null;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  fromColumnId: string | null;
  toColumnId: string | null;
  metadata: Record<string, unknown>;
  timestamp: string;
}

interface MissionAuditRow {
  id: string;
  missionId: string;
  missionTitle: string | null;
  missionHabitatId: string | null;
  actorType: "human" | "agent" | "system" | "remote_human" | "remote_orcy" | "remote_pod";
  actorId: string;
  actorName: string | null;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  fromColumnId: string | null;
  toColumnId: string | null;
  metadata: Record<string, unknown>;
  timestamp: string;
}

interface EffortAuditRow {
  id: string;
  taskId: string;
  taskTitle: string;
  missionId: string;
  missionTitle: string;
  missionHabitatId: string;
  actorType: "human" | "agent" | "system" | "remote_human" | "remote_orcy" | "remote_pod";
  actorId: string | null;
  actorName: string | null;
  minutes: number;
  source: string;
  note: string | null;
  correctsEntryId: string | null;
  correctionReason: string | null;
  metadata: Record<string, unknown> | null;
  recordedAt: string;
}

type CodeEvidenceLinkRow = typeof codeEvidenceLinks.$inferSelect;
type CodeEvidenceGapRow = typeof codeEvidenceGaps.$inferSelect;
type CodeCommitRow = typeof codeCommits.$inferSelect;
type CodeChangedFileRow = typeof codeChangedFiles.$inferSelect;
type PullRequestRow = typeof pullRequests.$inferSelect;
type CodeReviewRow = typeof codeReviews.$inferSelect;
type CodeRepositoryRow = typeof habitatCodeRepositories.$inferSelect;
type PipelineEventRow = typeof pipelineEvents.$inferSelect;
type IntegrationSyncRunRow = typeof integrationSyncRuns.$inferSelect;
type IntegrationConnectionRow = typeof integrationConnections.$inferSelect;
type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
type WebhookSubscriptionRow = typeof webhookSubscriptions.$inferSelect;
type HabitatHealthSnapshotRow = typeof habitatHealthSnapshots.$inferSelect;

interface MissionInfo {
  habitatId: string;
  missionId: string;
  missionTitle: string | null;
}

interface TaskInfo extends MissionInfo {
  taskId: string;
  taskTitle: string;
}

interface CodeProjectionContext {
  taskById: Map<string, TaskInfo>;
  missionById: Map<string, MissionInfo>;
  repositoryById: Map<string, CodeRepositoryRow>;
  pullRequestById: Map<string, PullRequestRow>;
  commitById: Map<string, CodeCommitRow>;
  evidenceTargetsByEvidence: Map<string, Array<TaskInfo | MissionInfo>>;
  integrationConnectionById: Map<string, IntegrationConnectionRow>;
  webhookSubscriptionById: Map<string, WebhookSubscriptionRow>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sanitizeMetadata(metadata: Record<string, unknown> | null | undefined) {
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

function auditMetadata(metadata: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(metadata.audit) ? metadata.audit : null;
}

function sourceFromAuditMetadata(metadata: Record<string, unknown>): AuditSource | null {
  const source = readString(auditMetadata(metadata)?.source);
  if (!source) return null;
  if (
    source === "rest_api" ||
    source === "mcp_tool" ||
    source === "webhook" ||
    source === "daemon" ||
    source === "system" ||
    source === "integration_sync" ||
    source === "scheduler" ||
    source === "migration" ||
    source === "unknown"
  ) {
    return source;
  }
  return null;
}

function evidenceLinkSourceToAuditSource(linkSource: string): AuditSource {
  if (linkSource === "webhook") return "webhook";
  if (linkSource === "agent_reported") return "mcp_tool";
  if (linkSource === "api" || linkSource === "human_manual") return "rest_api";
  if (linkSource === "migration") return "migration";
  if (linkSource === "commit_trailer" || linkSource === "branch_pattern") return "integration_sync";
  return "unknown";
}

function codeEvidenceCompleteness(metadata: Record<string, unknown>) {
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

function providerCompleteness(metadata: Record<string, unknown>) {
  if (hasAuditMetadata(metadata)) return { status: "complete" as const, caveats: [] };
  return {
    status: "source_unavailable" as const,
    caveats: ["Provider delivery provenance was not captured for this code evidence record."],
  };
}

function targetEntityRef(info: TaskInfo | MissionInfo) {
  if ("taskId" in info) return { type: "task" as const, id: info.taskId, title: info.taskTitle };
  return { type: "mission" as const, id: info.missionId, title: info.missionTitle };
}

function targetLinkedEntities(info: TaskInfo | MissionInfo) {
  if ("taskId" in info) {
    return [{ type: "mission" as const, id: info.missionId, title: info.missionTitle }];
  }
  return [];
}

function evidenceTargetKey(evidenceType: string, evidenceId: string | null) {
  return evidenceId ? `${evidenceType}:${evidenceId}` : null;
}

function evidenceTypeToAuditEntityType(evidenceType: string): AuditEntityType | null {
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

function pushEvidenceTarget(
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

function normalizeFilters(input: AuditQueryInput): AuditQueryInput {
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

function hasAuditMetadata(metadata: Record<string, unknown>): boolean {
  return Boolean(
    metadata.audit && typeof metadata.audit === "object" && !Array.isArray(metadata.audit),
  );
}

function buildCompleteness(metadata: Record<string, unknown>) {
  if (hasAuditMetadata(metadata)) {
    return { status: "complete" as const, caveats: [] };
  }
  return {
    status: "legacy_partial" as const,
    caveats: ["Source/provenance metadata was not captured for this historical event."],
  };
}

function taskSummary(row: TaskAuditRow): string {
  if (row.action === "moved") return `Task moved: ${row.taskTitle}`;
  if (row.action === "updated") return `Task updated: ${row.taskTitle}`;
  return `Task ${row.action}: ${row.taskTitle}`;
}

function missionSummary(row: MissionAuditRow, title: string): string {
  if (row.action === "status_changed") return `Mission status changed: ${title}`;
  if (row.action === "moved") return `Mission moved: ${title}`;
  return `Mission ${row.action}: ${title}`;
}

function effortSummary(row: EffortAuditRow, taskTitle: string): string {
  if (row.correctsEntryId) return `Effort corrected for task: ${taskTitle}`;
  return `Effort logged for task: ${taskTitle}`;
}

function projectTaskRow(row: TaskAuditRow): AuditEvent {
  const normalized = normalizeAuditActorAndSource({
    actorType: row.actorType,
    actorId: row.actorId,
    actorName: row.actorName,
    metadata: row.metadata,
  });

  return {
    id: `task_event:${row.id}`,
    habitatId: row.missionHabitatId,
    occurredAt: row.timestamp,
    entity: { type: "task", id: row.taskId, title: row.taskTitle },
    action: row.action,
    actor: normalized.actor,
    source: normalized.source,
    provenance: normalized.provenance,
    linkedEntities: [{ type: "mission", id: row.missionId, title: row.missionTitle }],
    summary: taskSummary(row),
    metadata: row.metadata,
    completeness: buildCompleteness(row.metadata),
  };
}

function projectMissionRow(row: MissionAuditRow, fallbackHabitatId: string): AuditEvent {
  const title = row.missionTitle ?? readString(row.metadata.title) ?? row.missionId;
  const habitatId = row.missionHabitatId ?? readString(row.metadata.habitatId) ?? fallbackHabitatId;
  const normalized = normalizeAuditActorAndSource({
    actorType: row.actorType,
    actorId: row.actorId,
    actorName: row.actorName,
    metadata: row.metadata,
  });

  return {
    id: `mission_event:${row.id}`,
    habitatId,
    occurredAt: row.timestamp,
    entity: { type: "mission", id: row.missionId, title },
    action: row.action,
    actor: normalized.actor,
    source: normalized.source,
    provenance: normalized.provenance,
    linkedEntities: [],
    summary: missionSummary(row, title),
    metadata: row.metadata,
    completeness: buildCompleteness(row.metadata),
  };
}

function projectEffortRow(row: EffortAuditRow): AuditEvent {
  const metadata = row.metadata ?? {};
  const taskTitle = row.taskTitle;
  const normalized = normalizeAuditActorAndSource({
    actorType: row.actorType,
    actorId: row.actorId,
    actorName: row.actorName,
    metadata,
  });

  return {
    id: `effort_entry:${row.id}`,
    habitatId: row.missionHabitatId,
    occurredAt: row.recordedAt,
    entity: { type: "effort_entry", id: row.id, title: effortSummary(row, taskTitle) },
    action: row.correctsEntryId ? "corrected" : "logged",
    actor: normalized.actor,
    source: normalized.source,
    provenance: normalized.provenance,
    linkedEntities: [
      { type: "task", id: row.taskId, title: row.taskTitle },
      { type: "mission", id: row.missionId, title: row.missionTitle },
      ...(row.correctsEntryId
        ? [
            {
              type: "effort_entry" as const,
              id: row.correctsEntryId,
              title: "Corrected effort entry",
            },
          ]
        : []),
    ],
    summary: effortSummary(row, taskTitle),
    metadata: {
      ...metadata,
      minutes: row.minutes,
      effortSource: row.source,
      note: row.note,
      correctsEntryId: row.correctsEntryId,
      correctionReason: row.correctionReason,
    },
    completeness: buildCompleteness(metadata),
  };
}

function projectCodeEvidenceLinkRow(
  row: CodeEvidenceLinkRow,
  target: TaskInfo | MissionInfo,
): AuditEvent {
  const metadata = sanitizeMetadata(row.metadata);
  const normalized = normalizeAuditActorAndSource({
    actorType: row.linkedByType,
    actorId: row.linkedById,
    actorName: null,
    metadata: {
      ...metadata,
      audit: {
        ...auditMetadata(metadata),
        source:
          sourceFromAuditMetadata(metadata) ?? evidenceLinkSourceToAuditSource(row.linkSource),
      },
    },
  });
  const title = row.title ?? `${row.evidenceType} evidence`;
  const evidenceEntityType = evidenceTypeToAuditEntityType(row.evidenceType);

  return {
    id: `code_evidence_link:${row.id}`,
    habitatId: target.habitatId,
    occurredAt: row.linkedAt,
    entity: { type: "code_evidence_link", id: row.id, title },
    action: row.status === "active" ? "linked" : row.status,
    actor: normalized.actor,
    source: normalized.source,
    provenance: normalized.provenance,
    linkedEntities: [
      targetEntityRef(target),
      ...targetLinkedEntities(target),
      ...(row.evidenceId && evidenceEntityType
        ? [
            {
              type: evidenceEntityType,
              id: row.evidenceId,
              title,
            },
          ]
        : []),
    ],
    summary: `Code evidence ${row.status === "active" ? "linked" : row.status}: ${title}`,
    metadata: {
      ...metadata,
      evidenceType: row.evidenceType,
      evidenceId: row.evidenceId,
      externalUrl: row.externalUrl,
      linkSource: row.linkSource,
      linkSources: row.linkSources,
      verificationState: row.verificationState,
      confidence: row.confidence,
      correctionReason: row.correctionReason,
      replacementLinkId: row.replacementLinkId,
      allowExternalRepository: row.allowExternalRepository,
    },
    completeness: codeEvidenceCompleteness(metadata),
  };
}

function projectCodeEvidenceGapRow(
  row: CodeEvidenceGapRow,
  target: TaskInfo | MissionInfo,
): AuditEvent {
  const metadata = sanitizeMetadata(row.metadata);
  const actorType =
    row.status === "resolved" && row.resolvedByType ? row.resolvedByType : row.reportedByType;
  const actorId =
    row.status === "resolved" && row.resolvedById ? row.resolvedById : row.reportedById;
  const normalized = normalizeAuditActorAndSource({
    actorType: actorType as "human" | "agent" | "system",
    actorId,
    actorName: null,
    metadata,
  });
  const action = row.status === "resolved" ? "resolved" : "reported";

  return {
    id: `code_evidence_gap:${row.id}`,
    habitatId: target.habitatId,
    occurredAt: row.status === "resolved" && row.resolvedAt ? row.resolvedAt : row.reportedAt,
    entity: { type: "code_evidence_gap", id: row.id, title: row.reasonCode },
    action,
    actor: normalized.actor,
    source: normalized.source,
    provenance: normalized.provenance,
    linkedEntities: [targetEntityRef(target), ...targetLinkedEntities(target)],
    summary: `Code evidence gap ${action}: ${row.reasonCode}`,
    metadata: {
      ...metadata,
      reasonCode: row.reasonCode,
      reasonNote: row.reasonNote,
      status: row.status,
      resolutionReason: row.resolutionReason,
    },
    completeness: codeEvidenceCompleteness(metadata),
  };
}

function projectCommitRow(row: CodeCommitRow, context: CodeProjectionContext): AuditEvent | null {
  const metadata = sanitizeMetadata(row.metadata);
  const repository = row.repositoryId ? context.repositoryById.get(row.repositoryId) : null;
  const targets = context.evidenceTargetsByEvidence.get(`commit:${row.id}`) ?? [];
  const habitatId = repository?.habitatId ?? targets[0]?.habitatId;
  if (!habitatId) return null;
  const normalized = normalizeAuditActorAndSource({
    actorType: "system",
    actorId: `system:${row.provider}-code`,
    actorName: row.authorName,
    metadata,
  });

  return {
    id: `commit:${row.id}`,
    habitatId,
    occurredAt: row.authoredAt ?? row.createdAt,
    entity: { type: "commit", id: row.id, title: row.sha.slice(0, 12) },
    action: "observed",
    actor: normalized.actor,
    source: sourceFromAuditMetadata(metadata) ?? "unknown",
    provenance: normalized.provenance,
    linkedEntities: targets.map(targetEntityRef),
    summary: `Commit observed: ${row.sha.slice(0, 12)}`,
    metadata: {
      ...metadata,
      provider: row.provider,
      repositoryId: repository?.id,
      repositoryName: repository?.displayName,
      repoSlug: row.repoSlug,
      sha: row.sha,
      message: row.message,
      authorName: row.authorName,
      authoredAt: row.authoredAt,
      url: row.url,
      verificationState: row.verificationState,
    },
    completeness: providerCompleteness(metadata),
  };
}

function projectChangedFileRow(
  row: CodeChangedFileRow,
  context: CodeProjectionContext,
): AuditEvent | null {
  const metadata = sanitizeMetadata(row.metadata);
  const repository = row.repositoryId ? context.repositoryById.get(row.repositoryId) : null;
  const commit = row.commitId ? context.commitById.get(row.commitId) : null;
  const pr = row.pullRequestId ? context.pullRequestById.get(row.pullRequestId) : null;
  const prTask = pr ? context.taskById.get(pr.taskId) : null;
  const commitMetadata = sanitizeMetadata(commit?.metadata);
  const commitTargets = row.commitId
    ? (context.evidenceTargetsByEvidence.get(`commit:${row.commitId}`) ?? [])
    : [];
  const habitatId = repository?.habitatId ?? prTask?.habitatId ?? commitTargets[0]?.habitatId;
  if (!habitatId) return null;

  return {
    id: `changed_file:${row.id}`,
    habitatId,
    occurredAt: row.capturedAt,
    entity: { type: "changed_file", id: row.id, title: row.path },
    action: "observed",
    actor: { type: "system", id: `system:${row.provider}-code` },
    source:
      sourceFromAuditMetadata(metadata) ?? sourceFromAuditMetadata(commitMetadata) ?? "unknown",
    provenance: auditMetadata(metadata) ?? auditMetadata(commitMetadata) ?? {},
    linkedEntities: [
      ...(row.commitId ? [{ type: "commit" as const, id: row.commitId, title: commit?.sha }] : []),
      ...(row.pullRequestId
        ? [{ type: "pull_request" as const, id: row.pullRequestId, title: pr?.prTitle }]
        : []),
      ...(prTask ? [targetEntityRef(prTask), ...targetLinkedEntities(prTask)] : []),
      ...commitTargets.map(targetEntityRef),
    ],
    summary: `Changed file observed: ${row.path}`,
    metadata: {
      ...metadata,
      provider: row.provider,
      repoSlug: row.repoSlug,
      path: row.path,
      previousPath: row.previousPath,
      changeType: row.changeType,
      additions: row.additions,
      deletions: row.deletions,
      source: row.source,
    },
    completeness: providerCompleteness(hasAuditMetadata(metadata) ? metadata : commitMetadata),
  };
}

function projectPullRequestRow(
  row: PullRequestRow,
  context: CodeProjectionContext,
): AuditEvent | null {
  const task = context.taskById.get(row.taskId);
  if (!task) return null;
  const metadata = sanitizeMetadata(row.metadata);
  const normalized = normalizeAuditActorAndSource({
    actorType: "system",
    actorId: `system:${row.provider}-code`,
    actorName: null,
    metadata,
  });

  return {
    id: `pull_request:${row.id}`,
    habitatId: task.habitatId,
    occurredAt: row.updatedAt ?? row.createdAt ?? "",
    entity: { type: "pull_request", id: row.id, title: row.prTitle ?? `PR #${row.prNumber}` },
    action: row.state ?? "observed",
    actor: normalized.actor,
    source: sourceFromAuditMetadata(metadata) ?? "unknown",
    provenance: normalized.provenance,
    linkedEntities: [targetEntityRef(task), ...targetLinkedEntities(task)],
    summary: `Pull request ${row.state ?? "observed"}: ${row.prTitle ?? `#${row.prNumber}`}`,
    metadata: {
      ...metadata,
      provider: row.provider,
      repo: row.repo,
      prNumber: row.prNumber,
      prUrl: row.prUrl,
      branchName: row.branchName,
      reviewStatus: row.reviewStatus,
      verificationState: row.verificationState,
    },
    completeness: codeEvidenceCompleteness(metadata),
  };
}

function projectCodeReviewRow(
  row: CodeReviewRow,
  context: CodeProjectionContext,
): AuditEvent | null {
  const metadata = sanitizeMetadata(row.metadata);
  const pr = row.pullRequestId ? context.pullRequestById.get(row.pullRequestId) : null;
  const task = pr ? context.taskById.get(pr.taskId) : null;
  const repository = row.repositoryId ? context.repositoryById.get(row.repositoryId) : null;
  const habitatId = task?.habitatId ?? repository?.habitatId;
  if (!habitatId) return null;
  const normalized = normalizeAuditActorAndSource({
    actorType: "system",
    actorId: row.reviewerId ?? `system:${row.provider}-review`,
    actorName: row.reviewerName,
    metadata,
  });

  return {
    id: `code_review:${row.id}`,
    habitatId,
    occurredAt: row.submittedAt ?? row.updatedAt,
    entity: { type: "code_review", id: row.id, title: row.reviewStatus },
    action: row.reviewStatus,
    actor: normalized.actor,
    source: sourceFromAuditMetadata(metadata) ?? "unknown",
    provenance: normalized.provenance,
    linkedEntities: [
      ...(row.pullRequestId
        ? [{ type: "pull_request" as const, id: row.pullRequestId, title: pr?.prTitle }]
        : []),
      ...(task ? [targetEntityRef(task), ...targetLinkedEntities(task)] : []),
    ],
    summary: `Code review ${row.reviewStatus}: ${row.reviewerName ?? row.reviewerId ?? row.provider}`,
    metadata: {
      ...metadata,
      provider: row.provider,
      repoSlug: row.repoSlug,
      reviewUrl: row.reviewUrl,
      reviewerName: row.reviewerName,
      reviewerId: row.reviewerId,
      submittedAt: row.submittedAt,
      verificationState: row.verificationState,
    },
    completeness: codeEvidenceCompleteness(metadata),
  };
}

function projectPipelineEventRow(
  row: PipelineEventRow,
  context: CodeProjectionContext,
): AuditEvent | null {
  const task = context.taskById.get(row.taskId);
  if (!task) return null;
  const metadata = sanitizeMetadata(row.metadata);
  const normalized = normalizeAuditActorAndSource({
    actorType: "system",
    actorId: `system:${row.provider}-ci`,
    actorName: null,
    metadata,
  });

  return {
    id: `pipeline_event:${row.id}`,
    habitatId: task.habitatId,
    occurredAt: row.updatedAt ?? row.createdAt ?? "",
    entity: { type: "pipeline_event", id: row.id, title: `${row.provider} ${row.runId}` },
    action: row.status,
    actor: normalized.actor,
    source: sourceFromAuditMetadata(metadata) ?? "unknown",
    provenance: normalized.provenance,
    linkedEntities: [
      targetEntityRef(task),
      ...targetLinkedEntities(task),
      ...(row.commitId
        ? [{ type: "commit" as const, id: row.commitId, title: row.commitSha }]
        : []),
      ...(row.branchEvidenceId
        ? [{ type: "branch" as const, id: row.branchEvidenceId, title: row.branch }]
        : []),
    ],
    summary: `Pipeline ${row.status}: ${row.provider} ${row.runId}`,
    metadata: {
      ...metadata,
      provider: row.provider,
      repo: row.repo,
      runId: row.runId,
      status: row.status,
      branch: row.branch,
      commitSha: row.commitSha,
      repositoryId: row.repositoryId,
      verificationState: row.verificationState,
    },
    completeness: providerCompleteness(metadata),
  };
}

function projectIntegrationSyncRunRow(
  row: IntegrationSyncRunRow,
  context: CodeProjectionContext,
): AuditEvent {
  const connection = context.integrationConnectionById.get(row.connectionId);
  return {
    id: `integration_sync_run:${row.id}`,
    habitatId: row.habitatId,
    occurredAt: row.finishedAt ?? row.startedAt,
    entity: {
      type: "integration_sync_run",
      id: row.id,
      title: connection ? `${connection.provider} sync` : "Integration sync",
    },
    action: row.status,
    actor: { type: "system", id: "system:integration-sync" },
    source: "integration_sync",
    provenance: {
      provider: connection?.provider,
      integrationSyncRunId: row.id,
      reason: `trigger:${row.trigger}`,
    },
    linkedEntities: [],
    summary: `Integration sync ${row.status}: ${connection?.name ?? row.connectionId}`,
    metadata: {
      connectionId: row.connectionId,
      provider: connection?.provider,
      connectionName: connection?.name,
      trigger: row.trigger,
      status: row.status,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      createdCount: row.createdCount,
      updatedCount: row.updatedCount,
      skippedCount: row.skippedCount,
      failedCount: row.failedCount,
      error: row.error,
    },
    completeness: { status: "complete", caveats: [] },
  };
}

function projectWebhookDeliveryRow(
  row: WebhookDeliveryRow,
  context: CodeProjectionContext,
): AuditEvent | null {
  const subscription = context.webhookSubscriptionById.get(row.subscriptionId);
  if (!subscription?.habitatId) return null;

  return {
    id: `webhook_delivery:${row.id}`,
    habitatId: subscription.habitatId,
    occurredAt: row.lastAttemptAt ?? row.createdAt,
    entity: { type: "webhook_delivery", id: row.id, title: row.eventType },
    action: row.status,
    actor: { type: "system", id: "system:webhook-dispatcher" },
    source: "webhook",
    provenance: { webhookDeliveryId: row.id, reason: `subscription:${row.subscriptionId}` },
    linkedEntities: [],
    summary: `Webhook delivery ${row.status}: ${row.eventType}`,
    metadata: {
      subscriptionId: row.subscriptionId,
      subscriptionName: subscription.name,
      eventType: row.eventType,
      status: row.status,
      statusCode: row.statusCode,
      attempts: row.attempts,
      createdAt: row.createdAt,
      lastAttemptAt: row.lastAttemptAt,
      nextRetryAt: row.nextRetryAt,
    },
    completeness: {
      status: "complete",
      caveats: ["Webhook payload and response body are intentionally excluded from audit output."],
    },
  };
}

function projectHealthSnapshotRow(row: HabitatHealthSnapshotRow): AuditEvent {
  return {
    id: `health_snapshot:${row.id}`,
    habitatId: row.habitatId,
    occurredAt: row.snapshotAt,
    entity: { type: "health_snapshot", id: row.id, title: `Health ${row.grade}` },
    action: "snapshot_recorded",
    actor: { type: "system", id: "system:health-engine" },
    source: "system",
    provenance: { reason: "habitat_health_snapshot" },
    linkedEntities: [],
    summary: `Habitat health snapshot recorded: ${row.grade} (${row.score})`,
    metadata: {
      score: row.score,
      grade: row.grade,
      dimensions: row.dimensions,
      metrics: row.metrics,
      recommendations: row.recommendations,
      createdAt: row.createdAt,
    },
    completeness: { status: "complete", caveats: [] },
  };
}

function matchesFilters(event: AuditEvent, query: AuditQueryInput): boolean {
  if (event.habitatId !== query.habitatId) return false;
  if (query.since && event.occurredAt < query.since) return false;
  if (query.until && event.occurredAt > query.until) return false;
  if (query.entityType && event.entity.type !== query.entityType) return false;
  if (query.entityId && event.entity.id !== query.entityId) return false;
  if (query.actorType && event.actor.type !== query.actorType) return false;
  if (query.actorId && event.actor.id !== query.actorId) return false;
  if (query.source && event.source !== query.source) return false;
  return true;
}

function sortEvents(events: AuditEvent[], order: "asc" | "desc"): AuditEvent[] {
  return events.toSorted((a, b) => {
    const time = a.occurredAt.localeCompare(b.occurredAt);
    const direction = order === "asc" ? time : -time;
    if (direction !== 0) return direction;
    return a.id.localeCompare(b.id);
  });
}

/** Aggregates per-event completeness statuses into counts by status and a deduplicated list of caveats. */
export function summarizeAuditCompleteness(events: AuditEvent[]): AuditCompletenessSummary {
  const caveats = new Set<string>();
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
  const db = getDb();
  const warnings: AuditWarning[] = [];
  const effectiveLimit = Math.min(query.limit ?? DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT);
  const effectiveOffset = query.offset ?? 0;

  const entityTypeFilter = query.entityType;
  const habitatFilter = query.habitatId;

  const shouldQueryTasks = !entityTypeFilter || entityTypeFilter === "task";
  const shouldQueryMissions = !entityTypeFilter || entityTypeFilter === "mission";
  const shouldQueryEffort = !entityTypeFilter || entityTypeFilter === "effort_entry";
  const shouldQueryCodeLinks = !entityTypeFilter || entityTypeFilter === "code_evidence_link";
  const shouldQueryCodeGaps = !entityTypeFilter || entityTypeFilter === "code_evidence_gap";
  const shouldQueryCommits = !entityTypeFilter || entityTypeFilter === "commit";
  const shouldQueryChangedFiles = !entityTypeFilter || entityTypeFilter === "changed_file";
  const shouldQueryPullRequests = !entityTypeFilter || entityTypeFilter === "pull_request";
  const shouldQueryCodeReviews = !entityTypeFilter || entityTypeFilter === "code_review";
  const shouldQueryPipelineEvents = !entityTypeFilter || entityTypeFilter === "pipeline_event";
  const shouldQueryIntegrationSyncs =
    !entityTypeFilter || entityTypeFilter === "integration_sync_run";
  const shouldQueryWebhookDeliveries = !entityTypeFilter || entityTypeFilter === "webhook_delivery";
  const shouldQueryHealthSnapshots =
    query.includeHealthSnapshots || entityTypeFilter === "health_snapshot";

  const taskRows = shouldQueryTasks
    ? (db
        .select({
          id: taskEvents.id,
          taskId: taskEvents.taskId,
          taskTitle: tasks.title,
          missionId: tasks.missionId,
          missionTitle: missions.title,
          missionHabitatId: missions.habitatId,
          actorType: taskEvents.actorType,
          actorId: taskEvents.actorId,
          actorName: agents.name,
          action: taskEvents.action,
          fromStatus: taskEvents.fromStatus,
          toStatus: taskEvents.toStatus,
          fromColumnId: taskEvents.fromColumnId,
          toColumnId: taskEvents.toColumnId,
          metadata: taskEvents.metadata,
          timestamp: taskEvents.timestamp,
        })
        .from(taskEvents)
        .innerJoin(tasks, eq(taskEvents.taskId, tasks.id))
        .innerJoin(missions, eq(tasks.missionId, missions.id))
        .leftJoin(agents, eq(taskEvents.actorId, agents.id))
        .where(eq(missions.habitatId, habitatFilter))
        .all() as TaskAuditRow[])
    : [];

  const missionRows = shouldQueryMissions
    ? (db
        .select({
          id: missionEvents.id,
          missionId: missionEvents.missionId,
          missionTitle: missions.title,
          missionHabitatId: missions.habitatId,
          actorType: missionEvents.actorType,
          actorId: missionEvents.actorId,
          actorName: agents.name,
          action: missionEvents.action,
          fromStatus: missionEvents.fromStatus,
          toStatus: missionEvents.toStatus,
          fromColumnId: missionEvents.fromColumnId,
          toColumnId: missionEvents.toColumnId,
          metadata: missionEvents.metadata,
          timestamp: missionEvents.timestamp,
        })
        .from(missionEvents)
        .leftJoin(missions, eq(missionEvents.missionId, missions.id))
        .leftJoin(agents, eq(missionEvents.actorId, agents.id))
        .where(sql`(${missions.habitatId} = ${habitatFilter} OR ${missions.id} IS NULL)`)
        .all() as MissionAuditRow[])
    : [];

  const effortRows = shouldQueryEffort
    ? (db
        .select({
          id: effortEntries.id,
          taskId: effortEntries.taskId,
          taskTitle: tasks.title,
          missionId: tasks.missionId,
          missionTitle: missions.title,
          missionHabitatId: missions.habitatId,
          actorType: effortEntries.actorType,
          actorId: effortEntries.actorId,
          actorName: agents.name,
          minutes: effortEntries.minutes,
          source: effortEntries.source,
          note: effortEntries.note,
          correctsEntryId: effortEntries.correctsEntryId,
          correctionReason: effortEntries.correctionReason,
          metadata: effortEntries.metadata,
          recordedAt: effortEntries.recordedAt,
        })
        .from(effortEntries)
        .innerJoin(tasks, eq(effortEntries.taskId, tasks.id))
        .innerJoin(missions, eq(tasks.missionId, missions.id))
        .leftJoin(agents, eq(effortEntries.actorId, agents.id))
        .where(eq(missions.habitatId, habitatFilter))
        .all() as EffortAuditRow[])
    : [];

  const taskInfoRows = db
    .select({
      taskId: tasks.id,
      taskTitle: tasks.title,
      missionId: tasks.missionId,
      missionTitle: missions.title,
      habitatId: missions.habitatId,
    })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(eq(missions.habitatId, habitatFilter))
    .all();
  const missionInfoRows = db
    .select({
      missionId: missions.id,
      missionTitle: missions.title,
      habitatId: missions.habitatId,
    })
    .from(missions)
    .where(eq(missions.habitatId, habitatFilter))
    .all();

  const taskIds = new Set(taskInfoRows.map((r) => r.taskId));
  const missionIds = new Set(missionInfoRows.map((r) => r.missionId));
  const repoRows = db
    .select()
    .from(habitatCodeRepositories)
    .where(eq(habitatCodeRepositories.habitatId, habitatFilter))
    .all() as CodeRepositoryRow[];
  const repoIds = new Set(repoRows.map((r) => r.id));

  const codeEvidenceLinkRows = shouldQueryCodeLinks
    ? (db
        .select()
        .from(codeEvidenceLinks)
        .where(
          and(
            sql`(${codeEvidenceLinks.targetType} = 'task' AND ${codeEvidenceLinks.targetId} IN (${sql.join([...taskIds], sql`, `)})) OR (${codeEvidenceLinks.targetType} = 'mission' AND ${codeEvidenceLinks.targetId} IN (${sql.join([...missionIds], sql`, `)}))`,
          ),
        )
        .all() as CodeEvidenceLinkRow[])
    : [];
  const codeEvidenceGapRows = shouldQueryCodeGaps
    ? (db
        .select()
        .from(codeEvidenceGaps)
        .where(
          and(
            sql`(${codeEvidenceGaps.targetType} = 'task' AND ${codeEvidenceGaps.targetId} IN (${sql.join([...taskIds], sql`, `)})) OR (${codeEvidenceGaps.targetType} = 'mission' AND ${codeEvidenceGaps.targetId} IN (${sql.join([...missionIds], sql`, `)}))`,
          ),
        )
        .all() as CodeEvidenceGapRow[])
    : [];
  const codeCommitRows = shouldQueryCommits
    ? (db
        .select()
        .from(codeCommits)
        .where(
          repoIds.size > 0
            ? sql`${codeCommits.repositoryId} IN (${sql.join([...repoIds], sql`, `)})`
            : sql`1 = 0`,
        )
        .all() as CodeCommitRow[])
    : [];
  const codeChangedFileRows = shouldQueryChangedFiles
    ? (db
        .select()
        .from(codeChangedFiles)
        .where(
          repoIds.size > 0
            ? sql`${codeChangedFiles.repositoryId} IN (${sql.join([...repoIds], sql`, `)})`
            : sql`1 = 0`,
        )
        .all() as CodeChangedFileRow[])
    : [];
  const pullRequestRows = shouldQueryPullRequests
    ? (db
        .select()
        .from(pullRequests)
        .where(
          taskIds.size > 0
            ? sql`${pullRequests.taskId} IN (${sql.join([...taskIds], sql`, `)})`
            : sql`1 = 0`,
        )
        .all() as PullRequestRow[])
    : [];
  const codeReviewRows = shouldQueryCodeReviews
    ? (db
        .select()
        .from(codeReviews)
        .where(
          repoIds.size > 0
            ? sql`${codeReviews.repositoryId} IN (${sql.join([...repoIds], sql`, `)})`
            : sql`1 = 0`,
        )
        .all() as CodeReviewRow[])
    : [];
  const pipelineEventRows = shouldQueryPipelineEvents
    ? (db
        .select()
        .from(pipelineEvents)
        .where(
          taskIds.size > 0
            ? sql`${pipelineEvents.taskId} IN (${sql.join([...taskIds], sql`, `)})`
            : sql`1 = 0`,
        )
        .all() as PipelineEventRow[])
    : [];

  const integrationSyncRunRows = shouldQueryIntegrationSyncs
    ? (db
        .select()
        .from(integrationSyncRuns)
        .where(eq(integrationSyncRuns.habitatId, habitatFilter))
        .all() as IntegrationSyncRunRow[])
    : [];
  const connectionIds = new Set(integrationSyncRunRows.map((r) => r.connectionId));
  const integrationConnectionRows =
    connectionIds.size > 0
      ? (db
          .select()
          .from(integrationConnections)
          .where(sql`${integrationConnections.id} IN (${sql.join([...connectionIds], sql`, `)})`)
          .all() as IntegrationConnectionRow[])
      : [];

  const webhookSubscriptionRows = shouldQueryWebhookDeliveries
    ? (db
        .select()
        .from(webhookSubscriptions)
        .where(eq(webhookSubscriptions.habitatId, habitatFilter))
        .all() as WebhookSubscriptionRow[])
    : [];
  const subscriptionIds = new Set(webhookSubscriptionRows.map((r) => r.id));
  const webhookDeliveryRows =
    shouldQueryWebhookDeliveries && subscriptionIds.size > 0
      ? (db
          .select()
          .from(webhookDeliveries)
          .where(
            sql`${webhookDeliveries.subscriptionId} IN (${sql.join([...subscriptionIds], sql`, `)})`,
          )
          .all() as WebhookDeliveryRow[])
      : [];
  const healthSnapshotRows = shouldQueryHealthSnapshots
    ? (db
        .select()
        .from(habitatHealthSnapshots)
        .where(eq(habitatHealthSnapshots.habitatId, habitatFilter))
        .all() as HabitatHealthSnapshotRow[])
    : [];

  const taskById = new Map<string, TaskInfo>();
  for (const row of taskInfoRows) {
    taskById.set(row.taskId, {
      taskId: row.taskId,
      taskTitle: row.taskTitle,
      missionId: row.missionId,
      missionTitle: row.missionTitle,
      habitatId: row.habitatId,
    });
  }
  const missionById = new Map<string, MissionInfo>();
  for (const row of missionInfoRows) {
    missionById.set(row.missionId, {
      missionId: row.missionId,
      missionTitle: row.missionTitle,
      habitatId: row.habitatId,
    });
  }

  const context: CodeProjectionContext = {
    taskById,
    missionById,
    repositoryById: new Map(repoRows.map((row) => [row.id, row])),
    pullRequestById: new Map(pullRequestRows.map((row) => [row.id, row])),
    commitById: new Map(codeCommitRows.map((row) => [row.id, row])),
    evidenceTargetsByEvidence: new Map(),
    integrationConnectionById: new Map(integrationConnectionRows.map((row) => [row.id, row])),
    webhookSubscriptionById: new Map(webhookSubscriptionRows.map((row) => [row.id, row])),
  };

  for (const row of codeEvidenceLinkRows) {
    const target =
      row.targetType === "task" ? taskById.get(row.targetId) : missionById.get(row.targetId);
    pushEvidenceTarget(
      context.evidenceTargetsByEvidence,
      row.evidenceType,
      row.evidenceId,
      target ?? null,
    );
  }

  const codeEvents: AuditEvent[] = [];
  let skippedCodeRows = 0;
  for (const row of codeEvidenceLinkRows) {
    const target =
      row.targetType === "task" ? taskById.get(row.targetId) : missionById.get(row.targetId);
    if (!target) {
      skippedCodeRows++;
      continue;
    }
    codeEvents.push(projectCodeEvidenceLinkRow(row, target));
  }
  for (const row of codeEvidenceGapRows) {
    const target =
      row.targetType === "task" ? taskById.get(row.targetId) : missionById.get(row.targetId);
    if (!target) {
      skippedCodeRows++;
      continue;
    }
    codeEvents.push(projectCodeEvidenceGapRow(row, target));
  }
  for (const row of codeCommitRows) {
    const event = projectCommitRow(row, context);
    if (event) codeEvents.push(event);
    else skippedCodeRows++;
  }
  for (const row of codeChangedFileRows) {
    const event = projectChangedFileRow(row, context);
    if (event) codeEvents.push(event);
    else skippedCodeRows++;
  }
  for (const row of pullRequestRows) {
    const event = projectPullRequestRow(row, context);
    if (event) codeEvents.push(event);
    else skippedCodeRows++;
  }
  for (const row of codeReviewRows) {
    const event = projectCodeReviewRow(row, context);
    if (event) codeEvents.push(event);
    else skippedCodeRows++;
  }
  for (const row of pipelineEventRows) {
    const event = projectPipelineEventRow(row, context);
    if (event) codeEvents.push(event);
    else skippedCodeRows++;
  }

  const systemEvents: AuditEvent[] = integrationSyncRunRows.map((row) =>
    projectIntegrationSyncRunRow(row, context),
  );
  let skippedSystemRows = 0;
  for (const row of webhookDeliveryRows) {
    const event = projectWebhookDeliveryRow(row, context);
    if (event) systemEvents.push(event);
    else skippedSystemRows++;
  }
  systemEvents.push(...healthSnapshotRows.map(projectHealthSnapshotRow));

  const projectedTaskEvents = taskRows
    .filter((row) => row.action !== "effort_logged" && row.action !== "effort_corrected")
    .map(projectTaskRow);

  const events = [
    ...projectedTaskEvents,
    ...missionRows.map((row) => projectMissionRow(row, habitatFilter)),
    ...effortRows.map(projectEffortRow),
    ...codeEvents,
    ...systemEvents,
  ].filter((event) => matchesFilters(event, query));

  if (events.some((event) => event.completeness.status === "legacy_partial")) {
    warnings.push({
      code: "legacy_partial_history",
      message: "Some events predate canonical provenance capture and may have partial source data.",
    });
  }

  if (events.some((event) => event.completeness.status === "source_unavailable")) {
    warnings.push({
      code: "source_unavailable",
      message: "Some provider-derived code evidence records lack delivery provenance.",
    });
  }

  if (skippedCodeRows > 0) {
    warnings.push({
      code: "code_evidence_projection_partial",
      message: `${skippedCodeRows} code evidence records could not be tied to a habitat and were not projected.`,
    });
  }

  if (skippedSystemRows > 0) {
    warnings.push({
      code: "system_projection_partial",
      message: `${skippedSystemRows} system/provider records could not be tied to a habitat and were not projected.`,
    });
  }

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

  // Phase E — resolve remote actor display names from remote_participants table
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

  const sortedEvents = sortEvents(events, query.order ?? "desc");
  const paginatedEvents = sortedEvents.slice(effectiveOffset, effectiveOffset + effectiveLimit);

  if (sortedEvents.length > effectiveLimit) {
    warnings.push({
      code: "result_truncated",
      message: `Result set truncated to ${effectiveLimit} of ${sortedEvents.length} matching events. Use limit/offset parameters for pagination.`,
    });
  }

  return {
    events: paginatedEvents,
    warnings,
    completenessSummary: summarizeAuditCompleteness(sortedEvents),
  };
}
