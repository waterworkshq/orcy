import * as boardRepo from '../repositories/board.js';
import * as columnRepo from '../repositories/column.js';
import * as taskRepo from '../repositories/task.js';
import * as featureRepo from '../repositories/feature.js';
import * as commentRepo from '../repositories/comment.js';
import * as templateRepo from '../repositories/template.js';
import * as eventRepo from '../repositories/event.js';
import * as savedFilterRepo from '../repositories/savedFilter.js';
import { getWebhookSubscriptions, createWebhookSubscription } from './webhookDispatcher.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import * as pluginManager from '../plugins/pluginManager.js';
import { rebuildCache as rebuildBoardSecretCache } from './boardSecretCache.js';
import * as featureService from './featureService.js';
import type { Board, Column, Feature, Task, FeatureTemplate, AutoAssignSettings, TaskPriority } from '../models/index.js';

export interface CreateBoardInput {
  name: string;
  description?: string;
  defaultColumns?: boolean;
  teamId?: string | null;
}

export function createBoard(input: CreateBoardInput): { board: Board; columns: Column[] } {
  const board = boardRepo.createBoard({
    name: input.name,
    description: input.description,
    teamId: input.teamId,
  });

  let columns: Column[] = [];
  if (input.defaultColumns) {
    columns = createDefaultColumns(board.id);
  }

  savedFilterRepo.seedBuiltinFilters(board.id);

  sseBroadcaster.publish(board.id, { type: 'board.created', data: board });
  pluginManager.emitBoardCreated(board).catch(() => {});
  rebuildBoardSecretCache();
  return { board, columns };
}

export function getBoard(boardId: string): { board: Board; columns: Column[]; features: featureService.FeatureWithProgress[] } | null {
  const result = boardRepo.getBoardWithColumnsAndTasks(boardId);
  if (!result) return null;

  const { features: featureList } = featureService.listFeatures(boardId, { isArchived: false });

  return { ...result, features: featureList };
}

export function listBoards(name?: string, teamIds?: string[]): Board[] {
  return boardRepo.listBoards(name, teamIds);
}

export function updateBoard(boardId: string, input: { name?: string; description?: string; retrySettings?: import('../models/index.js').RetryPolicy | null; anomalySettings?: import('../models/index.js').AnomalySettings | null; autoAssignSettings?: AutoAssignSettings | null }): Board | null {
  const board = boardRepo.updateBoard(boardId, input);
  if (board) {
    rebuildBoardSecretCache();
    sseBroadcaster.publish(boardId, { type: 'board.updated', data: board });
  }
  return board;
}

export function deleteBoard(boardId: string): void {
  boardRepo.deleteBoard(boardId);
  rebuildBoardSecretCache();
  sseBroadcaster.publish(boardId, { type: 'board.deleted', data: { boardId } });
}

export function getBoardStats(boardId: string): eventRepo.BoardStats {
  const stats = eventRepo.getBoardStats(boardId);

  const columns = columnRepo.getColumnsByBoardId(boardId);
  stats.wipHealth = columns.map((col) => {
    const current = featureRepo.getFeaturesByBoardId(boardId, { columnId: col.id }).total;
    const limit = col.wipLimit;
    let health: 'ok' | 'warning' | 'exceeded' = 'ok';
    if (limit !== null) {
      if (current >= limit) health = 'exceeded';
      else if (current >= limit * 0.8) health = 'warning';
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

function createDefaultColumns(boardId: string): Column[] {
  const columns = ['Todo', 'In Progress', 'Review', 'Done'];
  const result: Column[] = [];

  for (let i = 0; i < columns.length; i++) {
    const name = columns[i];
    const isLast = i === columns.length - 1;

    const col = columnRepo.createColumn({
      boardId,
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

  return result.map((c, i) => i < result.length - 1 ? { ...c, nextColumnId: result[i + 1].id } : c);
}

export interface BoardExportData {
  version: number;
  exportedAt: string;
  board: {
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
    features: Array<{
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
      authorType: 'human' | 'agent';
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

export interface ImportResult {
  board: Board;
  columns: Column[];
  imported: { features: number; tasks: number; comments: number; templates: number; webhooks: number };
  warnings: string[];
}

export function exportBoard(boardId: string): BoardExportData | null {
  const result = boardRepo.getBoardWithColumnsAndTasks(boardId);
  if (!result) return null;

  const { board, columns: boardColumns } = result;
  const webhooks = getWebhookSubscriptions(boardId).filter(w => w.boardId === boardId);
  const templates = templateRepo.getTemplatesByBoardId(boardId).filter(t => t.boardId !== null);
  const { features: featureList } = featureRepo.getFeaturesByBoardId(boardId);

  const columnMap = new Map(boardColumns.map(c => [c.id, c]));
  const featureMap = new Map(featureList.map(f => [f.id, f]));

  const comments: BoardExportData['board']['comments'] = [];

  const exportedFeatures: BoardExportData['board']['features'] = featureList.map(feature => {
    const featureTasks = taskRepo.getTasksByFeatureId(feature.id);
    const columnName = columnMap.get(feature.columnId)?.name ?? '';

    for (const task of featureTasks) {
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
      title: feature.title,
      description: feature.description,
      acceptanceCriteria: feature.acceptanceCriteria,
      priority: feature.priority,
      labels: feature.labels,
      columnName,
      status: feature.status,
      dependsOn: feature.dependsOn.map(depId => featureMap.get(depId)?.title ?? '').filter(Boolean),
      blocks: feature.blocks.map(blockId => featureMap.get(blockId)?.title ?? '').filter(Boolean),
      dueAt: feature.dueAt,
      tasks: featureTasks.map(task => ({
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
    board: {
      name: board.name,
      description: board.description,
      columns: boardColumns.map(col => ({
        name: col.name,
        order: col.order,
        wipLimit: col.wipLimit,
        autoAdvance: col.autoAdvance,
        requiresClaim: col.requiresClaim,
        nextColumnName: col.nextColumnId ? columnMap.get(col.nextColumnId)?.name ?? null : null,
        isTerminal: col.isTerminal,
      })),
      features: exportedFeatures,
      comments,
      templates: templates.map(t => ({
        name: t.name,
        titlePattern: t.titlePattern,
        descriptionPattern: t.descriptionPattern,
        priority: t.priority,
        labels: t.labels,
        requiredDomain: t.requiredDomain,
        requiredCapabilities: t.requiredCapabilities,
        isDefault: t.isDefault,
      })),
      webhooks: webhooks.map(w => ({
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

interface ImportBoardData extends BoardExportData {
  board: BoardExportData['board'] & {
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

export function importBoard(
  data: ImportBoardData,
  existingBoardId?: string
): ImportResult | null {
  const warnings: string[] = [];

  if (data.version !== 1 && data.version !== 2) {
    throw new Error(`Unsupported export version: ${data.version}`);
  }

  const { board: boardData } = data;

  if (existingBoardId) {
    boardRepo.deleteBoard(existingBoardId);
  }

  const board = boardRepo.createBoard({
    name: boardData.name,
    description: boardData.description,
  });
  const boardId = board.id;

  const columnNameToId = new Map<string, string>();
  const columns: Column[] = [];

  for (const colData of boardData.columns.sort((a, b) => a.order - b.order)) {
    const col = columnRepo.createColumn({
      boardId,
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

  for (const colData of boardData.columns.sort((a, b) => a.order - b.order)) {
    if (colData.nextColumnName) {
      const nextColId = columnNameToId.get(colData.nextColumnName);
      if (nextColId) {
        const col = columns.find(c => c.name === colData.name);
        if (col) {
          columnRepo.updateColumn(col.id, { nextColumnId: nextColId });
        }
      }
    }
  }

  const featuresData = data.board.features ?? [];
  const tasksData = data.board.tasks ?? [];

  const featureTitleToId = new Map<string, string>();
  let taskCount = 0;

  for (const featureData of featuresData) {
    const columnId = columnNameToId.get(featureData.columnName);
    if (!columnId) {
      warnings.push(`Feature "${featureData.title}": column "${featureData.columnName}" not found, skipping`);
      continue;
    }

    const feature = featureRepo.createFeature({
      boardId,
      columnId,
      title: featureData.title,
      description: featureData.description,
      acceptanceCriteria: featureData.acceptanceCriteria,
      priority: featureData.priority,
      labels: featureData.labels,
      createdBy: 'import',
    });

    featureTitleToId.set(featureData.title, feature.id);

    if (featureData.tasks) {
      for (const taskData of featureData.tasks) {
        taskRepo.createTask({
          featureId: feature.id,
          title: taskData.title,
          description: taskData.description,
          priority: taskData.priority,
          requiredDomain: taskData.requiredDomain,
          requiredCapabilities: taskData.requiredCapabilities,
          createdBy: taskData.createdBy ?? 'import',
        });
        taskCount++;
      }
    }
  }

  if (featuresData.length === 0 && tasksData.length > 0) {
    const firstColumnId = columnNameToId.get(boardData.columns[0]?.name ?? '');
    if (firstColumnId) {
      for (const taskData of tasksData) {
        const feature = featureRepo.createFeature({
          boardId,
          columnId: firstColumnId,
          title: taskData.title,
          description: taskData.description,
          priority: taskData.priority,
          labels: taskData.labels,
          createdBy: taskData.createdBy ?? 'import',
        });
        taskRepo.createTask({
          featureId: feature.id,
          title: taskData.title,
          description: taskData.description,
          priority: taskData.priority,
          requiredDomain: taskData.requiredDomain,
          requiredCapabilities: taskData.requiredCapabilities,
          createdBy: taskData.createdBy ?? 'import',
        });
        taskCount++;
      }
    }
  }

  for (const featureData of featuresData) {
    const featureId = featureTitleToId.get(featureData.title);
    if (!featureId) continue;

    const resolvedDependsOn = (featureData.dependsOn || [])
      .map((depTitle: string) => featureTitleToId.get(depTitle))
      .filter((id: string | undefined): id is string => id !== undefined);

    if (resolvedDependsOn.length > 0) {
      featureRepo.updateFeature(featureId, { dependsOn: resolvedDependsOn });
    }
  }

  let commentCount = 0;
  const taskTitleToId = new Map<string, string>();
  const { tasks: allTasks } = taskRepo.getTasksByBoardId(boardId);
  for (const task of allTasks) {
    taskTitleToId.set(task.title, task.id);
  }

  const commentsData = data.board.comments ?? [];
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
  for (const tmplData of boardData.templates) {
    templateRepo.createTemplate({
      boardId,
      name: tmplData.name,
      titlePattern: tmplData.titlePattern,
      descriptionPattern: tmplData.descriptionPattern,
      priority: tmplData.priority as FeatureTemplate['priority'],
      labels: tmplData.labels,
      requiredDomain: tmplData.requiredDomain,
      requiredCapabilities: tmplData.requiredCapabilities,
      isDefault: tmplData.isDefault,
      createdBy: 'import',
    });
    templateCount++;
  }

  let webhookCount = 0;
  for (const webhookData of boardData.webhooks) {
    createWebhookSubscription(
      boardId,
      webhookData.name,
      webhookData.url,
      webhookData.format as 'standard' | 'slack' | 'discord',
      webhookData.events,
      webhookData.headers
    );
    webhookCount++;
  }

  sseBroadcaster.publish(board.id, { type: 'board.created', data: board });

  return {
    board,
    columns: columnRepo.getColumnsByBoardId(boardId),
    imported: {
      features: featuresData.length || 0,
      tasks: taskCount,
      comments: commentCount,
      templates: templateCount,
      webhooks: webhookCount,
    },
    warnings,
  };
}
