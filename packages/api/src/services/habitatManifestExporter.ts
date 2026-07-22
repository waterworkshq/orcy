/**
 * Native v3 Habitat Exporter — `exportHabitatManifest`.
 *
 * Produces a {@link HabitatImportManifest} (version 3) from a live habitat by
 * composing the 8 portable domains. PURE READ: no writes, no SSE, no side
 * effects. The legacy v2 `exportHabitat` (`habitatService.ts:336`) stays
 * byte-identical — this is the native v3 counterpart that emits source IDs
 * + lineage directly (no structural-ID synthesis, no C4 absorption work).
 *
 * # Round-trip contract (load-bearing)
 *
 * `exportHabitatManifest(habitatId)` → `prepareImport({rawManifest, ...})` →
 * `publishImportAggregateWithClient(db, {prepared})` reproduces the original
 * habitat's portable domains in a new habitat (mode:"new",
 * identityPolicy:"remap" by default). Every emitted field MUST satisfy the M3
 * domain handlers' `validate` phase or `prepareImport` rejects the manifest.
 *
 * # Source IDs
 *
 * Native v3 export uses the habitat's existing UUIDs as `sourceId` for every
 * entity. NO structural synthesis (that's the legacy adapter's job for v1/v2
 * inputs). The exporter reads the UUID column directly.
 *
 * # Drift (recorded as findings, NOT silently worked around)
 *
 *   - **ColumnPortable.color** — the `columns` schema has no `color` column.
 *     Emitted as `null` (the type's nullable slot). Round-trips lossy: re-
 *     export of an imported habitat preserves the null (cosmetic; UI color
 *     is a planning-config concern M3/M4 may extend).
 *   - **Column autoAdvance / requiresClaim** — ColumnPortable has no slots
 *     for these v2 fields. Dropped on emission (the import-side apply
 *     defaults them per the schema).
 *   - **Mission dependsOn / blocks** — emitted from the `missions.dependsOn`
 *     + `missions.blocks` JSON columns (matches v2 precedent). The
 *     `mission_dependencies` join table is the authoritative source for
 *     runtime stats; the JSON columns are the export-stable source.
 *   - **DependencyPortable.kind** — the `task_dependencies` schema has no
 *     `kind` column (composite PK `(taskId, dependsOnId)`). Emitted as
 *     `"blocks"` (the schema's default semantics).
 *   - **TemplateContentPortable.missions** — v2 templates carry task-level
 *     patterns (`titlePattern` / `descriptionPattern` / `priority` /
 *     `labels`); v3 synthesizes a single mission per template carrying those
 *     fields. Task-level fields the v3 type has no slot for
 *     (`requiredDomain` / `requiredCapabilities` /
 *     `tasksTemplate` / `workflowTemplate`) are dropped at emission.
 *   - **CommentPortable.author** — native v3 has a canonical `authorId`,
 *     emitted as both `resolvedActorId` (T10B resolves at apply time) AND
 *     `importedAttribution` (the validator requires a non-empty string).
 *
 * @see packages/api/src/services/importManifest/types.ts for the v3 contract.
 * @see packages/api/src/services/importManifest/domainHandlers/*.ts for the
 *      per-domain validate requirements the emission MUST satisfy.
 */
import { eq, inArray } from "drizzle-orm";

import { getDb } from "../db/index.js";
import { taskDependencies } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as subtaskRepo from "../repositories/subtask.js";
import * as commentRepo from "../repositories/comment.js";
import * as templateRepo from "../repositories/template.js";
import type { Column, Habitat, Mission, MissionTemplate, Task } from "../models/index.js";
import type { Comment as TaskComment } from "../repositories/comment.js";
import type { Subtask as TaskSubtask } from "../repositories/subtask.js";

import { maskSecretSettings } from "./habitatService.js";
import type {
  ColumnPortable,
  CommentPortable,
  DependencyPortable,
  DomainEnvelope,
  HabitatImportManifest,
  HabitatSettingsPortable,
  ManifestLineage,
  MissionPortable,
  SubtaskPortable,
  TaskPortable,
  TemplatePortable,
} from "./importManifest/types.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Options for {@link exportHabitatManifest}. Both fields default to the v3
 * native-export defaults: `mode:"new"` + `identityPolicy:"remap"`. The route
 * layer (M3) may pass through caller overrides; the defaults reproduce the
 * legacy v2 "fresh habitat on import" semantics.
 */
export interface ExportHabitatManifestOptions {
  /** Import mode the resulting manifest declares. Default: `"new"`. */
  mode?: "new" | "replacement";
  /** Identity policy the resulting manifest declares. Default: `"remap"`. */
  identityPolicy?: "remap" | "restore";
}

/**
 * Produces a {@link HabitatImportManifest} (version 3) from a live habitat.
 * PURE READ — no writes, no SSE, no side effects. Returns `null` when the
 * habitat does not exist.
 *
 * The manifest's `manifestId` is deterministic for a given `(habitatId,
 * exportedAt)` pair: `export:<habitatId>:<exportedAt>`. Re-exporting the
 * same habitat at the same instant produces the same id; the `exportedAt`
 * timestamp makes it unique across time.
 *
 * @param habitatId  the live habitat's server id.
 * @param options    optional mode + identityPolicy overrides.
 */
export function exportHabitatManifest(
  habitatId: string,
  options?: ExportHabitatManifestOptions,
): HabitatImportManifest | null {
  // -------- Source reads (PURE — repository composition) ---------------
  const habitatResult = habitatRepo.getHabitatWithColumnsAndTasks(habitatId);
  if (!habitatResult) return null;
  const { habitat, columns } = habitatResult;

  const { missions: missionList } = missionRepo.getMissionsByHabitatId(habitatId);
  const templates = templateRepo
    .getTemplatesByHabitatId(habitatId)
    .filter((t) => t.habitatId === habitatId);

  // Index missions + columns by id for cross-reference resolution.
  const columnById = new Map(columns.map((c) => [c.id, c]));
  const missionById = new Map(missionList.map((m) => [m.id, m]));

  // Read tasks per mission; preserve mission order.
  const tasksByMission = new Map<string, Task[]>();
  for (const mission of missionList) {
    tasksByMission.set(mission.id, taskRepo.getTasksByMissionId(mission.id));
  }
  const allTasks = missionList.flatMap((m) => tasksByMission.get(m.id) ?? []);

  // Read subtasks + comments per task; preserve task order.
  const subtasksByTask = new Map<string, TaskSubtask[]>();
  const commentsByTask = new Map<string, TaskComment[]>();
  for (const task of allTasks) {
    subtasksByTask.set(task.id, subtaskRepo.getSubtasksByTaskId(task.id));
    // Comment pagination cap (1000) matches v2 exportHabitat precedent.
    commentsByTask.set(task.id, commentRepo.getCommentsByTaskId(task.id, 1000, 0).comments);
  }

  // Read task-level dependency edges directly from the join table. The
  // repository layer exposes no `getAllTaskDependencies` helper; the join
  // is the authoritative source.
  const taskDependencyEdges = readTaskDependencyEdges(allTasks.map((t) => t.id));

  // -------- Envelope + lineage -----------------------------------------
  const exportedAt = new Date().toISOString();
  const mode = options?.mode ?? "new";
  const identityPolicy = options?.identityPolicy ?? "remap";
  const manifestId = `export:${habitatId}:${exportedAt}`;
  const lineage: ManifestLineage = {
    sourceHabitatId: habitatId,
    sourceExportedAt: exportedAt,
    // First export has no chain reference — a subsequent re-import of this
    // manifest fills `sourceManifestId` with this manifest's id.
    sourceManifestId: null,
  };

  // -------- Per-domain emission ----------------------------------------
  const habitatSettings: DomainEnvelope<HabitatSettingsPortable> = {
    disposition: "replace",
    data: emitHabitatSettings(habitat),
  };

  const columnsEnvelope: DomainEnvelope<ColumnPortable[]> = {
    disposition: "replace",
    data: columns.map((c) => emitColumn(c, columnById)),
  };

  const missionsEnvelope: DomainEnvelope<MissionPortable[]> = {
    disposition: "replace",
    data: missionList.map((m) => emitMission(m, columnById)),
  };

  const tasksEnvelope: DomainEnvelope<TaskPortable[]> = {
    disposition: "replace",
    data: allTasks.map((t) => emitTask(t)),
  };

  const subtasksEnvelope: DomainEnvelope<SubtaskPortable[]> = {
    disposition: "replace",
    data: allTasks.flatMap((t) => (subtasksByTask.get(t.id) ?? []).map((s) => emitSubtask(s))),
  };

  const dependenciesEnvelope: DomainEnvelope<DependencyPortable[]> = {
    disposition: "replace",
    data: taskDependencyEdges.map((e) => emitDependency(e)),
  };

  const commentsEnvelope: DomainEnvelope<CommentPortable[]> = {
    disposition: "replace",
    data: allTasks.flatMap((t) => (commentsByTask.get(t.id) ?? []).map((c) => emitComment(c))),
  };

  const templatesEnvelope: DomainEnvelope<TemplatePortable[]> = {
    disposition: "replace",
    data: templates.map((t) => emitTemplate(t)),
  };

  return {
    version: 3,
    manifestId,
    generatedAt: exportedAt,
    mode,
    identityPolicy,
    lineage,
    domains: {
      habitatSettings,
      columns: columnsEnvelope,
      missions: missionsEnvelope,
      tasks: tasksEnvelope,
      subtasks: subtasksEnvelope,
      dependencies: dependenciesEnvelope,
      comments: commentsEnvelope,
      templates: templatesEnvelope,
    },
  };
}

// ---------------------------------------------------------------------------
// Per-domain emitters
// ---------------------------------------------------------------------------

/**
 * Emits the habitat-level planning settings. The `settings` JSON carries the
 * PUBLIC settings shape (webhook secrets stripped via `maskSecretSettings`)
 * so the manifest is safe to surface through a route boundary without a
 * second masking pass. Round-trips through `habitatSettings.apply`.
 */
function emitHabitatSettings(habitat: Habitat): HabitatSettingsPortable {
  const masked = maskSecretSettings(habitat);
  return {
    sourceId: habitat.id,
    name: habitat.name,
    description: habitat.description,
    settings: {
      retrySettings: masked.retrySettings,
      anomalySettings: masked.anomalySettings,
      autoAssignSettings: masked.autoAssignSettings,
      codeReviewSettings: masked.codeReviewSettings,
      ciCdSettings: masked.ciCdSettings,
      gitWorktreeSettings: masked.gitWorktreeSettings,
      prioritizationSettings: masked.prioritizationSettings,
      automationSettings: masked.automationSettings,
      wikiSettings: masked.wikiSettings,
      triageSettings: masked.triageSettings,
      releaseSettings: masked.releaseSettings,
      roadmapSettings: masked.roadmapSettings,
      eventRetentionDays: masked.eventRetentionDays,
    },
  };
}

/**
 * Emits a single column. `color` is `null` (the schema has no color column —
 * recorded drift). `autoAdvance` / `requiresClaim` are dropped (ColumnPortable
 * has no slots — recorded drift).
 */
function emitColumn(column: Column, columnById: Map<string, Column>): ColumnPortable {
  const nextColumnName = column.nextColumnId
    ? (columnById.get(column.nextColumnId)?.name ?? null)
    : null;
  return {
    sourceId: column.id,
    name: column.name,
    order: column.order,
    color: null,
    wipLimit: column.wipLimit,
    nextColumnName,
    isTerminal: column.isTerminal,
  };
}

/**
 * Emits a single mission. `columnName` resolves via the column map;
 * `dependsOnSourceIds` / `blocksSourceIds` carry the JSON-column UUIDs
 * directly (no title-keyed resolution — the v0.31 pattern the manifest v3
 * retires).
 */
function emitMission(mission: Mission, columnById: Map<string, Column>): MissionPortable {
  const columnName = columnById.get(mission.columnId)?.name ?? "";
  return {
    sourceId: mission.id,
    title: mission.title,
    description: mission.description,
    acceptanceCriteria: mission.acceptanceCriteria,
    priority: mission.priority,
    labels: mission.labels,
    columnName,
    dependsOnSourceIds: mission.dependsOn,
    blocksSourceIds: mission.blocks,
    dueAt: mission.dueAt,
  };
}

/**
 * Emits a single task. NO execution state (status / result / artifacts /
 * createdBy / etc.) — per C4 absorption, TaskPortable has no slots for them.
 */
function emitTask(task: Task): TaskPortable {
  return {
    sourceId: task.id,
    missionSourceId: task.missionId,
    title: task.title,
    description: task.description,
    priority: task.priority,
    requiredDomain: task.requiredDomain,
    requiredCapabilities: task.requiredCapabilities,
  };
}

/** Emits a single subtask. Direct 1:1 field mapping. */
function emitSubtask(subtask: TaskSubtask): SubtaskPortable {
  return {
    sourceId: subtask.id,
    taskSourceId: subtask.taskId,
    title: subtask.title,
    order: subtask.order,
    completed: subtask.completed,
    assigneeId: subtask.assigneeId,
  };
}

/**
 * Emits a single task-level dependency edge. The `task_dependencies` schema
 * has no `kind` column (composite PK `(taskId, dependsOnId)`) — `kind`
 * defaults to `"blocks"` (recorded drift). The `sourceId` is synthesized
 * deterministically from the composite key.
 */
function emitDependency(edge: { taskId: string; dependsOnId: string }): DependencyPortable {
  return {
    sourceId: `dep:${edge.taskId}:${edge.dependsOnId}`,
    taskSourceId: edge.taskId,
    dependsOnTaskSourceId: edge.dependsOnId,
    kind: "blocks",
  };
}

/**
 * Emits a single comment. Native v3 carries the canonical `authorId` — it
 * flows into BOTH `resolvedActorId` (T10B's resolution key) AND
 * `importedAttribution` (the validator requires a non-empty string; the
 * authorId is the natural documentary attribution).
 */
function emitComment(comment: TaskComment): CommentPortable {
  return {
    sourceId: comment.id,
    taskSourceId: comment.taskId,
    parentCommentSourceId: comment.parentId,
    content: comment.content,
    author: {
      resolvedActorId: comment.authorId,
      importedAttribution: comment.authorId,
    },
    authorType: comment.authorType,
    authoredAt: comment.createdAt,
  };
}

/**
 * Emits a single template. Synthesizes ONE mission per template carrying the
 * template's pattern fields (drift #1: v2 templates carry task-level
 * patterns; v3 lifts them into a single mission layout). Task-level fields
 * with no v3 slot (`requiredDomain` / `requiredCapabilities` /
 * `tasksTemplate` / `workflowTemplate`) are dropped at emission — the import
 * side captures this as a per-template warning.
 *
 * `content.columns` is empty: v2 templates carry no column graph.
 */
function emitTemplate(template: MissionTemplate): TemplatePortable {
  return {
    sourceId: template.id,
    name: template.name,
    // The v3 TemplatePortable has no titlePattern slot; the description
    // pattern carries the closest semantic match (the template's
    // free-form description).
    description: template.descriptionPattern,
    content: {
      columns: [],
      labels: template.labels,
      missions: [
        {
          title: template.titlePattern,
          description: template.descriptionPattern,
          acceptanceCriteria: "",
          priority: template.priority,
          labels: template.labels,
          dependsOnSourceIds: [],
          blocksSourceIds: [],
          dueAt: null,
        },
      ],
    },
    isDefault: template.isDefault,
  };
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * Reads every task-level dependency edge for the given task ids, directly
 * from the `task_dependencies` join table. Returns `{taskId, dependsOnId}`
 * pairs (the table has no `kind` column — `kind` is defaulted at emission).
 */
function readTaskDependencyEdges(
  taskIds: string[],
): Array<{ taskId: string; dependsOnId: string }> {
  if (taskIds.length === 0) return [];
  const db = getDb();
  const rows = db
    .select({
      taskId: taskDependencies.taskId,
      dependsOnId: taskDependencies.dependsOnId,
    })
    .from(taskDependencies)
    .where(inArray(taskDependencies.taskId, taskIds))
    .all();
  return rows.map((r) => ({ taskId: r.taskId, dependsOnId: r.dependsOnId }));
}
