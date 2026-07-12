import type { AuditEvent, AuditWarning } from "@orcy/shared/types";
import {
  loadCodeEvidenceAuditContext,
  type CodeChangedFileRow,
  type CodeCommitRow,
  type CodeEvidenceLinkRow,
  type CodeEvidenceGapRow,
  type CodeRepositoryRow,
  type CodeReviewRow,
  type PipelineEventRow,
  type PullRequestRow,
} from "../../repositories/auditProjection/codeEvidence.js";
import type { AuditProjectionCollector } from "./types.js";
import {
  auditMetadata,
  codeEvidenceCompleteness,
  evidenceLinkSourceToAuditSource,
  evidenceTypeToAuditEntityType,
  hasAuditMetadata,
  normalizeAuditActorAndSource,
  providerCompleteness,
  pushEvidenceTarget,
  sanitizeMetadata,
  sourceFromAuditMetadata,
  targetEntityRef,
  targetLinkedEntities,
  type MissionInfo,
  type TaskInfo,
} from "./helpers.js";

interface CodeProjectionContext {
  taskById: Map<string, TaskInfo>;
  missionById: Map<string, MissionInfo>;
  repositoryById: Map<string, CodeRepositoryRow>;
  pullRequestById: Map<string, PullRequestRow>;
  commitById: Map<string, CodeCommitRow>;
  evidenceTargetsByEvidence: Map<string, Array<TaskInfo | MissionInfo>>;
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

export const codeEvidenceCollector: AuditProjectionCollector = {
  key: "code_evidence",
  entityTypes: [
    "code_evidence_link",
    "code_evidence_gap",
    "commit",
    "changed_file",
    "pull_request",
    "code_review",
    "pipeline_event",
  ],
  failurePolicy: "fatal",
  collect(request) {
    const habitatId = request.habitatId;
    const loaded = loadCodeEvidenceAuditContext(habitatId, request.selectedEntityTypes);

    const evidenceTargetsByEvidence = new Map<string, Array<TaskInfo | MissionInfo>>();
    for (const row of loaded.codeEvidenceLinkRows) {
      const target =
        row.targetType === "task"
          ? loaded.taskById.get(row.targetId)
          : loaded.missionById.get(row.targetId);
      pushEvidenceTarget(
        evidenceTargetsByEvidence,
        row.evidenceType,
        row.evidenceId,
        target ?? null,
      );
    }

    const context: CodeProjectionContext = {
      taskById: loaded.taskById,
      missionById: loaded.missionById,
      repositoryById: loaded.repositoryById,
      pullRequestById: loaded.pullRequestById,
      commitById: loaded.commitById,
      evidenceTargetsByEvidence,
    };

    const events: AuditEvent[] = [];
    let skippedRows = 0;
    for (const row of loaded.codeEvidenceLinkRows) {
      const target =
        row.targetType === "task"
          ? context.taskById.get(row.targetId)
          : context.missionById.get(row.targetId);
      if (!target) {
        skippedRows++;
        continue;
      }
      events.push(projectCodeEvidenceLinkRow(row, target));
    }
    for (const row of loaded.codeEvidenceGapRows) {
      const target =
        row.targetType === "task"
          ? context.taskById.get(row.targetId)
          : context.missionById.get(row.targetId);
      if (!target) {
        skippedRows++;
        continue;
      }
      events.push(projectCodeEvidenceGapRow(row, target));
    }
    for (const row of loaded.codeCommitRows) {
      const event = projectCommitRow(row, context);
      if (event) events.push(event);
      else skippedRows++;
    }
    for (const row of loaded.codeChangedFileRows) {
      const event = projectChangedFileRow(row, context);
      if (event) events.push(event);
      else skippedRows++;
    }
    for (const row of loaded.pullRequestRows) {
      const event = projectPullRequestRow(row, context);
      if (event) events.push(event);
      else skippedRows++;
    }
    for (const row of loaded.codeReviewRows) {
      const event = projectCodeReviewRow(row, context);
      if (event) events.push(event);
      else skippedRows++;
    }
    for (const row of loaded.pipelineEventRows) {
      const event = projectPipelineEventRow(row, context);
      if (event) events.push(event);
      else skippedRows++;
    }

    const warnings: AuditWarning[] = [];
    if (skippedRows > 0) {
      warnings.push({
        code: "code_evidence_projection_partial",
        message: `${skippedRows} code evidence records could not be tied to a habitat and were not projected.`,
      });
    }

    return { events, warnings, caveats: [] };
  },
};
