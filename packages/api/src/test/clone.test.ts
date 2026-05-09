import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../repositories/task.js', () => ({
  getTaskById: vi.fn(),
  createTask: vi.fn(),
  getBoardIdForTask: vi.fn().mockReturnValue('board-1'),
}));

vi.mock('../repositories/event.js', () => ({
  createEvent: vi.fn(),
}));

vi.mock('../sse/broadcaster.js', () => ({
  sseBroadcaster: {
    publish: vi.fn(),
  },
}));

vi.mock('../repositories/subtask.js', () => ({
  getSubtasksByTaskId: vi.fn(),
  createSubtask: vi.fn(),
}));

vi.mock('../repositories/comment.js', () => ({
  getCommentsByTaskId: vi.fn(),
  createComment: vi.fn(),
}));

vi.mock('../repositories/feature.js', () => ({
  getFeatureById: vi.fn().mockReturnValue({ id: 'feat-1', boardId: 'board-1' }),
}));

vi.mock('../services/watcherService.js', () => ({
  notifyWatchers: vi.fn(),
}));

vi.mock('../services/autoAssignService.js', () => ({
  assignTask: vi.fn(),
}));

vi.mock('../services/featureService.js', () => ({
  recalculateFeatureStatus: vi.fn(),
}));

vi.mock('../plugins/pluginManager.js', () => ({
  emitTaskCreated: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../repositories/board.js', () => ({
  getBoardById: vi.fn().mockReturnValue({ id: 'board-1', name: 'Test Board' }),
}));

import { cloneTask } from '../services/tasks/index.js';
import * as taskRepo from '../repositories/task.js';
import * as eventRepo from '../repositories/event.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import * as subtaskRepo from '../repositories/subtask.js';
import * as commentRepo from '../repositories/comment.js';

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    featureId: 'feat-1',
    title: 'Original task',
    description: 'Desc',
    priority: 'high',
    assignedAgentId: null,
    delegatedToAgentId: null,
    requiredDomain: 'backend',
    requiredCapabilities: ['typescript'],
    status: 'in_progress',
    claimedAt: null,
    startedAt: null,
    submittedAt: null,
    completedAt: null,
    rejectedCount: 0,
    rejectionReason: null,
    result: 'done',
    artifacts: [{ type: 'pr', url: 'https://example.com', description: 'PR' }],
    order: 0,
    createdBy: 'user-1',
    createdAt: '2026-04-10T00:00:00.000Z',
    updatedAt: '2026-04-10T00:00:00.000Z',
    version: 1,
    estimatedMinutes: null,
    retryPolicy: null,
    retryCount: 0,
    nextRetryAt: null,
    actualMinutes: null,
    cycleTimeMinutes: null,
    leadTimeMinutes: null,
    estimationAccuracy: null,
    ...overrides,
  };
}

describe('cloneTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_found when source task does not exist', () => {
    vi.mocked(taskRepo.getTaskById).mockReturnValue(null);

    const result = cloneTask('missing-task', 'user-1');

    expect(result).toEqual({ success: false, reason: 'not_found' });
  });

  it('creates a cloned task with copied fields and reset lifecycle fields', () => {
    const sourceTask = makeTask();
    const clonedTask = makeTask({
      id: 'task-copy-1',
      title: 'Original task (Copy)',
      status: 'pending',
      assignedAgentId: null,
      delegatedToAgentId: null,
      result: null,
      artifacts: [],
      createdBy: 'user-2',
    });
    vi.mocked(taskRepo.getTaskById).mockReturnValue(sourceTask as never);
    vi.mocked(taskRepo.createTask).mockReturnValue(clonedTask as never);

    const result = cloneTask('task-1', 'user-2');

    expect(result).toEqual({ success: true, task: clonedTask });
    expect(taskRepo.createTask).toHaveBeenCalledWith({
      featureId: 'feat-1',
      title: 'Original task (Copy)',
      description: 'Desc',
      priority: 'high',
      requiredDomain: 'backend',
      requiredCapabilities: ['typescript'],
      estimatedMinutes: null,
      createdBy: 'user-2',
    });
    expect(eventRepo.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-copy-1',
      action: 'cloned',
      actorId: 'user-2',
      metadata: { sourceTaskId: 'task-1', sourceTitle: 'Original task' },
    }));
    expect(sseBroadcaster.publish).toHaveBeenCalledWith('board-1', {
      type: 'task.cloned',
      data: { sourceTaskId: 'task-1', clonedTask },
    });
    expect(sseBroadcaster.publish).toHaveBeenCalledWith('board-1', {
      type: 'task.created',
      data: clonedTask,
    });
  });

  it('copies subtasks and comments when requested', () => {
    const sourceTask = makeTask();
    const clonedTask = makeTask({ id: 'task-copy-2', title: 'Original task (Copy)', status: 'pending' });
    vi.mocked(taskRepo.getTaskById).mockReturnValue(sourceTask as never);
    vi.mocked(taskRepo.createTask).mockReturnValue(clonedTask as never);
    vi.mocked(subtaskRepo.getSubtasksByTaskId).mockReturnValue([
      { id: 'sub-1', taskId: 'task-1', title: 'Subtask A', completed: false, order: 1, assigneeId: null, createdAt: '', updatedAt: '' },
    ] as never);
    vi.mocked(commentRepo.getCommentsByTaskId).mockReturnValue({
      comments: [
        { id: 'comment-1', taskId: 'task-1', parentId: null, authorType: 'human', authorId: 'user-1', content: 'Comment A', createdAt: '', updatedAt: '' },
      ],
      total: 1,
    } as never);

    cloneTask('task-1', 'user-2', { includeSubtasks: true, includeComments: true });

    expect(subtaskRepo.getSubtasksByTaskId).toHaveBeenCalledWith('task-1');
    expect(subtaskRepo.createSubtask).toHaveBeenCalledWith({
      taskId: 'task-copy-2',
      title: 'Subtask A',
      order: 1,
    });
    expect(commentRepo.getCommentsByTaskId).toHaveBeenCalledWith('task-1', 200);
    expect(commentRepo.createComment).toHaveBeenCalledWith({
      taskId: 'task-copy-2',
      content: 'Comment A',
      authorType: 'human',
      authorId: 'user-1',
      parentId: null,
    });
  });
});
