import * as taskRepo from '../../repositories/task.js';
import * as featureRepo from '../../repositories/feature.js';
import * as boardRepo from '../../repositories/board.js';
import * as columnRepo from '../../repositories/column.js';
import * as subtaskRepo from '../../repositories/subtask.js';
import * as pullRequestRepo from '../../repositories/pullRequest.js';
import * as pipelineEventRepo from '../../repositories/pipelineEvent.js';
import * as eventRepo from '../../repositories/event.js';
import * as commentRepo from '../../repositories/comment.js';
import * as attachmentRepo from '../../repositories/attachment.js';
import * as featureEventRepo from '../../repositories/events/event-feature.js';
import * as watcherService from '../watcherService.js';
import type { Task, Feature } from '../../models/index.js';

export interface TaskWithFeatureContext {
  task: Task;
  feature: {
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
    priority: string;
    status: string;
    dueAt: string | null;
    slaMinutes: number | null;
  } | null;
  siblingTasks: {
    id: string;
    title: string;
    status: string;
    result: string | null;
  }[];
  subtasks: any[];
  pullRequests: any[];
  pipelineEvents: any[];
  events: any[];
  comments: any[];
  totalComments: number;
  attachments: any[];
  watchers: any[];
  isWatching: boolean;
  boardContext: {
    name: string;
    columns: { name: string; featureCount: number }[];
  };
}

export async function getTaskDetails(taskId: string, userId?: string): Promise<TaskWithFeatureContext | null> {
  const task = taskRepo.getTaskById(taskId);
  if (!task) return null;

  const feature = featureRepo.getFeatureById(task.featureId);
  const boardId = feature?.boardId;
  const board = boardId ? boardRepo.getBoardById(boardId) : null;

  const [subtasks, pullRequests, pipelineEvents, taskEvents, commentsResult, attachments] = await Promise.all([
    subtaskRepo.getSubtasksByTaskId(taskId),
    pullRequestRepo.getByTaskId(taskId),
    pipelineEventRepo.getByTaskId(taskId),
    eventRepo.getEventsByTaskId(taskId, 50),
    commentRepo.getCommentsByTaskId(taskId, 100),
    attachmentRepo.getAttachmentsByTaskId(taskId),
  ]);

  const watchers = watcherService.getWatchers(taskId);
  const isWatching = userId ? watcherService.isWatching(taskId, userId) : false;

  let featureContext: TaskWithFeatureContext['feature'] = null;
  if (feature) {
    featureContext = {
      id: feature.id,
      title: feature.title,
      description: feature.description,
      acceptanceCriteria: feature.acceptanceCriteria,
      priority: feature.priority,
      status: feature.status,
      dueAt: feature.dueAt,
      slaMinutes: feature.slaMinutes,
    };
  }

  const allFeatureTasks = feature ? taskRepo.getTasksByFeatureId(feature.id) : [];
  const siblingTasks = allFeatureTasks
    .filter(t => t.id !== taskId)
    .map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      result: t.result,
    }));

  const boardColumns = board ? columnRepo.getColumnsByBoardId(board.id).map(col => {
    const featureCount = featureRepo.getFeaturesByBoardId(board.id, { columnId: col.id }).total;
    return { name: col.name, featureCount };
  }) : [];

  return {
    task,
    feature: featureContext,
    siblingTasks,
    subtasks,
    pullRequests,
    pipelineEvents,
    events: taskEvents.events,
    comments: commentsResult.comments,
    totalComments: commentsResult.total,
    attachments,
    watchers,
    isWatching,
    boardContext: board ? { name: board.name, columns: boardColumns } : { name: '', columns: [] },
  };
}

export { getTaskDetails as assembleBoardContext };
export { getTaskDetails as assembleCrossBoardDependencies };
