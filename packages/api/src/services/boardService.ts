import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as taskRepo from "../repositories/task.js";
import * as missionRepo from "../repositories/feature.js";
import * as commentRepo from "../repositories/comment.js";
import * as templateRepo from "../repositories/template.js";
import * as eventRepo from "../repositories/event.js";
import * as savedFilterRepo from "../repositories/savedFilter.js";
import { getWebhookSubscriptions, createWebhookSubscription } from "./webhookDispatcher.js";
import { badRequest } from "../errors.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { rebuildCache as rebuildHabitatSecretCache } from "./boardSecretCache.js";
import * as missionService from "./featureService.js";
import * as skillRepo from "../repositories/habitatSkill.js";
import type {
  Habitat,
  Column,
  MissionTemplate,
  AutoAssignSettings,
  TaskPriority,
} from "../models/index.js";

/** Input payload for {@link createHabitat} describing the new board's name, description, team binding, and whether the default column flow should be seeded. */
export interface CreateHabitatInput {
  name: string;
  description?: string;
  defaultColumns?: boolean;
  teamId?: string | null;
}

/** Creates a new {@link Habitat}, seeding builtin saved filters and the default skill and (optionally) a default column flow; side effects: publishes `habitat.created` SSE, fires a plugin `habitat.created` event, and rebuilds the board secret cache. */
export function createHabitat(input: CreateHabitatInput): { habitat: Habitat; columns: Column[] } {
  const habitat = habitatRepo.createHabitat({
    name: input.name,
    description: input.description,
    teamId: input.teamId,
  });

  let columns: Column[] = [];
  if (input.defaultColumns) {
    columns = createDefaultColumns(habitat.id);
  }

  savedFilterRepo.seedBuiltinFilters(habitat.id);
  skillRepo.getOrCreateSkill(habitat.id);

  sseBroadcaster.publish(habitat.id, { type: "habitat.created", data: habitat });
  rebuildHabitatSecretCache();
  return { habitat, columns };
}

/** Returns the {@link Habitat}, its {@link Column}s, and its non-archived missions joined with progress, or null when the habitat does not exist. */
export function getHabitat(
  habitatId: string,
): { habitat: Habitat; columns: Column[]; missions: missionService.MissionWithProgress[] } | null {
  const result = habitatRepo.getHabitatWithColumnsAndTasks(habitatId);
  if (!result) return null;

  const { missions: missionList } = missionService.listMissions(habitatId, { isArchived: false });

  return { habitat: result.habitat, columns: result.columns, missions: missionList };
}

/** Returns the list of {@link Habitat}s, optionally filtered by a case-insensitive name match and a set of team ids. */
export function listHabitats(name?: string, teamIds?: string[]): Habitat[] {
  return habitatRepo.listHabitats(name, teamIds);
}

/** Applies a partial update to a {@link Habitat}'s editable fields; side effect: rebuilds the board secret cache and publishes `habitat.updated` SSE when the update succeeds. */
export function updateHabitat(
  habitatId: string,
  input: {
    name?: string;
    description?: string;
    retrySettings?: import("../models/index.js").RetryPolicy | null;
    anomalySettings?: import("../models/index.js").AnomalySettings | null;
    autoAssignSettings?: AutoAssignSettings | null;
  },
): Habitat | null {
  const habitat = habitatRepo.updateHabitat(habitatId, input);
  if (habitat) {
    rebuildHabitatSecretCache();
    sseBroadcaster.publish(habitatId, { type: "habitat.updated", data: habitat });
  }
  return habitat;
}

/** Removes a {@link Habitat} and all of its dependents; side effect: rebuilds the board secret cache and publishes `habitat.deleted` SSE. */
export function deleteHabitat(habitatId: string): void {
  habitatRepo.deleteHabitat(habitatId);
  rebuildHabitatSecretCache();
  sseBroadcaster.publish(habitatId, { type: "habitat.deleted", data: { habitatId } });
}

/** Returns event-based activity statistics for a {@link Habitat}, augmented with per-column WIP health (`ok` / `warning` / `exceeded`) for every column. */
export function getHabitatStats(habitatId: string): eventRepo.HabitatStats {
  const stats = eventRepo.getHabitatStats(habitatId);

  const columns = columnRepo.getColumnsByHabitatId(habitatId);
  stats.wipHealth = columns.map((col) => {
    const current = missionRepo.getMissionsByHabitatId(habitatId, { columnId: col.id }).total;
    const limit = col.wipLimit;
    let health: "ok" | "warning" | "exceeded" = "ok";
    if (limit !== null) {
      if (current >= limit) health = "exceeded";
      else if (current >= limit * 0.8) health = "warning";
    }
    return {
      columnId: col.id,
      columnName: col.name,
      current,
      limit,
      health,
    };
  });

  return stats;
}

function createDefaultColumns(habitatId: string): Column[] {
  const columns = ["Todo", "In Progress", "Review", "Done"];
  const result: Column[] = [];

  for (let i = 0; i < columns.length; i++) {
    const name = columns[i];
    const isLast = i === columns.length - 1;

    const col = columnRepo.createColumn({
      habitatId,
      name,
      order: i,
      requiresClaim: i > 0,
      autoAdvance: isLast,
      isTerminal: isLast,
    });
    result.push(col);
  }

  for (let i = 0; i < result.length - 1; i++) {
    columnRepo.updateColumn(result[i].id, { nextColumnId: result[i + 1].id });
  }

  return result.map((c, i) =>
    i < result.length - 1 ? { ...c, nextColumnId: result[i + 1].id } : c,
  );
}

/** Versioned, serializable snapshot of a habitat's columns, missions, tasks, comments, templates, and webhooks, produced by {@link exportHabitat} and consumed by {@link importHabitat}. */
export interface HabitatExportData {
  version: number;
  exportedAt: string;
  habitat: {
    name: string;
    description: string;
    columns: Array<{
      name: string;
      order: number;
      wipLimit: number | null;
      autoAdvance: boolean;
      requiresClaim: boolean;
      nextColumnName: string | null;
      isTerminal: boolean;
    }>;
    missions: Array<{
      title: string;
      description: string;
      acceptanceCriteria: string;
      priority: TaskPriority;
      labels: string[];
      columnName: string;
      status: string;
      dependsOn: string[];
      blocks: string[];
      dueAt: string | null;
      tasks: Array<{
        title: string;
        description: string;
        priority: TaskPriority;
        status: string;
        requiredDomain: string | null;
        requiredCapabilities: string[];
        result: string | null;
        artifacts: Array<{ type: string; url: string; description: string }>;
        createdBy: string;
      }>;
    }>;
    comments: Array<{
      taskTitle: string;
      parentTaskTitle: string | null;
      content: string;
      authorType: "human" | "agent" | "remote_human" | "remote_orcy";
      authorId: string;
    }>;
    templates: Array<{
      name: string;
      titlePattern: string;
      descriptionPattern: string;
      priority: TaskPriority;
      labels: string[];
      requiredDomain: string | null;
      requiredCapabilities: string[];
      isDefault: boolean;
    }>;
    webhooks: Array<{
      name: string;
      url: string;
      events: string[];
      headers: Record<string, string>;
      format: string;
      enabled: boolean;
    }>;
  };
}

/** Outcome of {@link importHabitat}: the reconstructed habitat and columns, per-kind import counts, and any non-fatal warnings collected during reconstruction. */
export interface ImportResult {
  habitat: Habitat;
  columns: Column[];
  imported: {
    missions: number;
    tasks: number;
    comments: number;
    templates: number;
    webhooks: number;
  };
  warnings: string[];
}

/** Returns a versioned {@link HabitatExportData} snapshot of the habitat (columns, missions, tasks, comments, templates, and webhooks), or null when the habitat does not exist. */
export function exportHabitat(habitatId: string): HabitatExportData | null {
  const result = habitatRepo.getHabitatWithColumnsAndTasks(habitatId);
  if (!result) return null;

  const { habitat, columns: habitatColumns } = result;
  const webhooks = getWebhookSubscriptions(habitatId).filter((w) => w.habitatId === habitatId);
  const templates = templateRepo
    .getTemplatesByHabitatId(habitatId)
    .filter((t) => t.habitatId !== null);
  const { missions: missionList } = missionRepo.getMissionsByHabitatId(habitatId);

  const columnMap = new Map(habitatColumns.map((c) => [c.id, c]));
  const missionMap = new Map(missionList.map((f) => [f.id, f]));

  const comments: HabitatExportData["habitat"]["comments"] = [];

  const exportedMissions: HabitatExportData["habitat"]["missions"] = missionList.map((mission) => {
    const missionTasks = taskRepo.getTasksByMissionId(mission.id);
    const columnName = columnMap.get(mission.columnId)?.name ?? "";

    for (const task of missionTasks) {
      const { comments: taskComments } = commentRepo.getCommentsByTaskId(task.id, 1000, 0);
      for (const comment of taskComments) {
        comments.push({
          taskTitle: task.title,
          parentTaskTitle: null,
          content: comment.content,
          authorType: comment.authorType,
          authorId: comment.authorId,
        });
      }
    }

    return {
      title: mission.title,
      description: mission.description,
      acceptanceCriteria: mission.acceptanceCriteria,
      priority: mission.priority,
      labels: mission.labels,
      columnName,
      status: mission.status,
      dependsOn: mission.dependsOn
        .map((depId) => missionMap.get(depId)?.title ?? "")
        .filter(Boolean),
      blocks: mission.blocks.map((blockId) => missionMap.get(blockId)?.title ?? "").filter(Boolean),
      dueAt: mission.dueAt,
      tasks: missionTasks.map((task) => ({
        title: task.title,
        description: task.description,
        priority: task.priority,
        status: task.status,
        requiredDomain: task.requiredDomain,
        requiredCapabilities: task.requiredCapabilities,
        result: task.result,
        artifacts: task.artifacts,
        createdBy: task.createdBy,
      })),
    };
  });

  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    habitat: {
      name: habitat.name,
      description: habitat.description,
      columns: habitatColumns.map((col) => ({
        name: col.name,
        order: col.order,
        wipLimit: col.wipLimit,
        autoAdvance: col.autoAdvance,
        requiresClaim: col.requiresClaim,
        nextColumnName: col.nextColumnId ? (columnMap.get(col.nextColumnId)?.name ?? null) : null,
        isTerminal: col.isTerminal,
      })),
      missions: exportedMissions,
      comments,
      templates: templates.map((t) => ({
        name: t.name,
        titlePattern: t.titlePattern,
        descriptionPattern: t.descriptionPattern,
        priority: t.priority,
        labels: t.labels,
        requiredDomain: t.requiredDomain,
        requiredCapabilities: t.requiredCapabilities,
        isDefault: t.isDefault,
      })),
      webhooks: webhooks.map((w) => ({
        name: w.name,
        url: w.url,
        events: w.events,
        headers: w.headers,
        format: w.format,
        enabled: w.enabled === 1,
      })),
    },
  };
}

interface ImportHabitatData extends HabitatExportData {
  habitat: HabitatExportData["habitat"] & {
    tasks?: Array<{
      title: string;
      description: string;
      priority: TaskPriority;
      labels?: string[];
      requiredDomain: string | null;
      requiredCapabilities: string[];
      createdBy: string;
    }>;
  };
}

/** Reconstructs a {@link Habitat} from an import payload (export versions 1 and 2 are supported), optionally replacing an existing habitat id; side effect: deletes the existing habitat, persists columns, missions, tasks, comments, templates, and webhooks, and publishes `habitat.created` SSE. */
export function importHabitat(
  data: ImportHabitatData,
  existingHabitatId?: string,
): ImportResult | null {
  const warnings: string[] = [];

  if (data.version !== 1 && data.version !== 2) {
    throw badRequest(`Unsupported export version: ${data.version}`);
  }

  const { habitat: habitatData } = data;

  if (existingHabitatId) {
    habitatRepo.deleteHabitat(existingHabitatId);
  }

  const habitat = habitatRepo.createHabitat({
    name: habitatData.name,
    description: habitatData.description,
  });
  const habitatId = habitat.id;
  skillRepo.getOrCreateSkill(habitatId);

  const columnNameToId = new Map<string, string>();
  const columns: Column[] = [];

  for (const colData of habitatData.columns.toSorted((a, b) => a.order - b.order)) {
    const col = columnRepo.createColumn({
      habitatId,
      name: colData.name,
      order: colData.order,
      wipLimit: colData.wipLimit,
      autoAdvance: colData.autoAdvance,
      requiresClaim: colData.requiresClaim,
      isTerminal: colData.isTerminal,
    });
    columns.push(col);
    columnNameToId.set(colData.name, col.id);
  }

  for (const colData of habitatData.columns.toSorted((a, b) => a.order - b.order)) {
    if (colData.nextColumnName) {
      const nextColId = columnNameToId.get(colData.nextColumnName);
      if (nextColId) {
        const col = columns.find((c) => c.name === colData.name);
        if (col) {
          columnRepo.updateColumn(col.id, { nextColumnId: nextColId });
        }
      }
    }
  }

  const missionsData = data.habitat.missions ?? [];
  const tasksData = data.habitat.tasks ?? [];

  const missionTitleToId = new Map<string, string>();
  let taskCount = 0;

  for (const missionData of missionsData) {
    const columnId = columnNameToId.get(missionData.columnName);
    if (!columnId) {
      warnings.push(
        `Mission "${missionData.title}": column "${missionData.columnName}" not found, skipping`,
      );
      continue;
    }

    const mission = missionRepo.createMission({
      habitatId,
      columnId,
      title: missionData.title,
      description: missionData.description,
      acceptanceCriteria: missionData.acceptanceCriteria,
      priority: missionData.priority,
      labels: missionData.labels,
      createdBy: "import",
    });

    missionTitleToId.set(missionData.title, mission.id);

    if (missionData.tasks) {
      for (const taskData of missionData.tasks) {
        taskRepo.createTask({
          missionId: mission.id,
          title: taskData.title,
          description: taskData.description,
          priority: taskData.priority,
          requiredDomain: taskData.requiredDomain,
          requiredCapabilities: taskData.requiredCapabilities,
          createdBy: taskData.createdBy ?? "import",
        });
        taskCount++;
      }
    }
  }

  if (missionsData.length === 0 && tasksData.length > 0) {
    const firstColumnId = columnNameToId.get(habitatData.columns[0]?.name ?? "");
    if (firstColumnId) {
      for (const taskData of tasksData) {
        const mission = missionRepo.createMission({
          habitatId,
          columnId: firstColumnId,
          title: taskData.title,
          description: taskData.description,
          priority: taskData.priority,
          labels: taskData.labels,
          createdBy: taskData.createdBy ?? "import",
        });
        taskRepo.createTask({
          missionId: mission.id,
          title: taskData.title,
          description: taskData.description,
          priority: taskData.priority,
          requiredDomain: taskData.requiredDomain,
          requiredCapabilities: taskData.requiredCapabilities,
          createdBy: taskData.createdBy ?? "import",
        });
        taskCount++;
      }
    }
  }

  for (const missionData of missionsData) {
    const missionId = missionTitleToId.get(missionData.title);
    if (!missionId) continue;

    const resolvedDependsOn = (missionData.dependsOn || [])
      .map((depTitle: string) => missionTitleToId.get(depTitle))
      .filter((id: string | undefined): id is string => id !== undefined);

    if (resolvedDependsOn.length > 0) {
      missionRepo.updateMission(missionId, { dependsOn: resolvedDependsOn });
    }
  }

  let commentCount = 0;
  const taskTitleToId = new Map<string, string>();
  const { tasks: allTasks } = taskRepo.getTasksByHabitatId(habitatId);
  for (const task of allTasks) {
    taskTitleToId.set(task.title, task.id);
  }

  const commentsData = data.habitat.comments ?? [];
  for (const commentData of commentsData) {
    const taskId = taskTitleToId.get(commentData.taskTitle);
    if (!taskId) continue;

    commentRepo.createComment({
      taskId,
      authorType: commentData.authorType,
      authorId: commentData.authorId,
      content: commentData.content,
      parentId: null,
    });
    commentCount++;
  }

  let templateCount = 0;
  for (const tmplData of habitatData.templates) {
    templateRepo.createTemplate({
      habitatId,
      name: tmplData.name,
      titlePattern: tmplData.titlePattern,
      descriptionPattern: tmplData.descriptionPattern,
      priority: tmplData.priority as MissionTemplate["priority"],
      labels: tmplData.labels,
      requiredDomain: tmplData.requiredDomain,
      requiredCapabilities: tmplData.requiredCapabilities,
      isDefault: tmplData.isDefault,
      createdBy: "import",
    });
    templateCount++;
  }

  let webhookCount = 0;
  for (const webhookData of habitatData.webhooks) {
    createWebhookSubscription(
      habitatId,
      webhookData.name,
      webhookData.url,
      webhookData.format as "standard" | "slack" | "discord",
      webhookData.events,
      webhookData.headers,
    );
    webhookCount++;
  }

  sseBroadcaster.publish(habitat.id, { type: "habitat.created", data: habitat });

  return {
    habitat,
    columns: columnRepo.getColumnsByHabitatId(habitatId),
    imported: {
      missions: missionsData.length || 0,
      tasks: taskCount,
      comments: commentCount,
      templates: templateCount,
      webhooks: webhookCount,
    },
    warnings,
  };
}
