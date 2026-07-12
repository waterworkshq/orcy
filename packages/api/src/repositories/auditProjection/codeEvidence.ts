import type { AuditQueryEntityType } from "@orcy/shared/types";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import {
  codeChangedFiles,
  codeCommits,
  codeEvidenceGaps,
  codeEvidenceLinks,
  codeReviews,
  habitatCodeRepositories,
  missions,
  pipelineEvents,
  pullRequests,
  tasks,
} from "../../db/schema/index.js";
import type { MissionInfo, TaskInfo } from "../../services/auditProjection/helpers.js";

export type CodeEvidenceLinkRow = typeof codeEvidenceLinks.$inferSelect;
export type CodeEvidenceGapRow = typeof codeEvidenceGaps.$inferSelect;
export type CodeCommitRow = typeof codeCommits.$inferSelect;
export type CodeChangedFileRow = typeof codeChangedFiles.$inferSelect;
export type PullRequestRow = typeof pullRequests.$inferSelect;
export type CodeReviewRow = typeof codeReviews.$inferSelect;
export type CodeRepositoryRow = typeof habitatCodeRepositories.$inferSelect;
export type PipelineEventRow = typeof pipelineEvents.$inferSelect;

/**
 * Full audit context for the code-evidence collector. The repository loads
 * every habitat-scoped row the collector needs and pre-builds the lookup maps.
 * `evidenceTargetsByEvidence` is left to the collector because it depends on
 * projection-adjacent helpers.
 *
 * Row arrays are gated by the caller's entity-type selection: an array is empty
 * when its entity type is not selected (and the query is skipped entirely).
 */
export interface CodeEvidenceAuditContext {
  codeEvidenceLinkRows: CodeEvidenceLinkRow[];
  codeEvidenceGapRows: CodeEvidenceGapRow[];
  codeCommitRows: CodeCommitRow[];
  codeChangedFileRows: CodeChangedFileRow[];
  pullRequestRows: PullRequestRow[];
  codeReviewRows: CodeReviewRow[];
  pipelineEventRows: PipelineEventRow[];
  taskById: Map<string, TaskInfo>;
  missionById: Map<string, MissionInfo>;
  repositoryById: Map<string, CodeRepositoryRow>;
  pullRequestById: Map<string, PullRequestRow>;
  commitById: Map<string, CodeCommitRow>;
}

/**
 * Loads the complete code-evidence audit context for a habitat.
 *
 * Task, mission, and repository lookups are always loaded (they drive the `IN`
 * clauses for the evidence tables). The seven evidence tables are queried only
 * when their entity type is selected (empty selection = all types).
 *
 * No exception handling — the code-evidence collector has a `fatal` failure
 * policy, so any query error propagates to the dispatcher.
 */
export function loadCodeEvidenceAuditContext(
  habitatId: string,
  selectedEntityTypes: ReadonlySet<AuditQueryEntityType>,
): CodeEvidenceAuditContext {
  const db = getDb();
  const has = (t: AuditQueryEntityType) =>
    selectedEntityTypes.size === 0 || selectedEntityTypes.has(t);

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
    .where(eq(missions.habitatId, habitatId))
    .all();
  const missionInfoRows = db
    .select({
      missionId: missions.id,
      missionTitle: missions.title,
      habitatId: missions.habitatId,
    })
    .from(missions)
    .where(eq(missions.habitatId, habitatId))
    .all();

  const taskIds = new Set(taskInfoRows.map((r) => r.taskId));
  const missionIds = new Set(missionInfoRows.map((r) => r.missionId));
  const repoRows = db
    .select()
    .from(habitatCodeRepositories)
    .where(eq(habitatCodeRepositories.habitatId, habitatId))
    .all() as CodeRepositoryRow[];
  const repoIds = new Set(repoRows.map((r) => r.id));

  const codeEvidenceLinkRows = has("code_evidence_link")
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
  const codeEvidenceGapRows = has("code_evidence_gap")
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
  const codeCommitRows = has("commit")
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
  const codeChangedFileRows = has("changed_file")
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
  const pullRequestRows = has("pull_request")
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
  const codeReviewRows = has("code_review")
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
  const pipelineEventRows = has("pipeline_event")
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

  return {
    codeEvidenceLinkRows,
    codeEvidenceGapRows,
    codeCommitRows,
    codeChangedFileRows,
    pullRequestRows,
    codeReviewRows,
    pipelineEventRows,
    taskById,
    missionById,
    repositoryById: new Map(repoRows.map((row) => [row.id, row])),
    pullRequestById: new Map(pullRequestRows.map((row) => [row.id, row])),
    commitById: new Map(codeCommitRows.map((row) => [row.id, row])),
  };
}
