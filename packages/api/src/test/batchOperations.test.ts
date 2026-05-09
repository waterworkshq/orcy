import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from './factories/task.js';
import { makeAgent } from './factories/agent.js';

vi.mock('../repositories/task.js', () => ({
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  getTasksByDependency: vi.fn(),
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

vi.mock('../repositories/feature.js', () => ({
  getFeatureById: vi.fn().mockReturnValue({ id: 'feat-1', boardId: 'board-1' }),
}));

vi.mock('../repositories/board.js', () => ({
  getBoardById: vi.fn().mockReturnValue({ id: 'board-1', name: 'Test Board' }),
}));

vi.mock('../repositories/agent.js', () => ({
  getAgentById: vi.fn(),
}));

import { batchOperateTasks } from '../services/tasks/index.js';
import * as taskRepo from '../repositories/task.js';
import * as agentRepo from '../repositories/agent.js';

describe('batchOperateTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('priority: multiple successes with updated priority values in task results', () => {
    const task1 = makeTask({ id: 'task-1', priority: 'low' as const });
    const task2 = makeTask({ id: 'task-2', priority: 'low' as const });
    vi.mocked(taskRepo.getTaskById).mockImplementation((id: string) => {
      if (id === 'task-1') return task1;
      if (id === 'task-2') return task2;
      return null;
    });
    vi.mocked(taskRepo.updateTask).mockImplementation((id: string, _input: unknown) => {
      if (id === 'task-1') return { success: true, task: { ...task1, priority: 'critical' } };
      if (id === 'task-2') return { success: true, task: { ...task2, priority: 'critical' } };
      return { success: false, notFound: true };
    });

    const result = batchOperateTasks(
      'board-1',
      { taskIds: ['task-1', 'task-2'], operation: 'priority', payload: { priority: 'critical' } },
      'user-1',
      'human'
    );

    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(0);
    const task1Result = result.results.find((r) => r.taskId === 'task-1');
    expect(task1Result?.task?.priority).toBe('critical');
    const task2Result = result.results.find((r) => r.taskId === 'task-2');
    expect(task2Result?.task?.priority).toBe('critical');
  });

  it('assign: failure when target agent is missing required domain/capabilities', () => {
    const task = makeTask({
      id: 'task-1',
      requiredDomain: 'frontend',
      requiredCapabilities: ['typescript'],
      status: 'pending',
    });
    const wrongDomainAgent = makeAgent({ id: 'agent-2', domain: 'backend' });
    vi.mocked(taskRepo.getTaskById).mockReturnValue(task);
    vi.mocked(agentRepo.getAgentById).mockReturnValue(wrongDomainAgent as unknown as ReturnType<typeof agentRepo.getAgentById>);

    const result = batchOperateTasks(
      'board-1',
      { taskIds: ['task-1'], operation: 'assign', payload: { assignedAgentId: 'agent-2' } },
      'user-1',
      'human'
    );

    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(1);
    expect(result.results[0]).toEqual(
      expect.objectContaining({ taskId: 'task-1', success: false, error: 'Agent domain does not match task requirement' })
    );
  });

  it('delete: success for an isolated task and failure for a task with dependents', () => {
    const task1 = makeTask({ id: 'task-1' });
    const task2 = makeTask({ id: 'task-2' });
    vi.mocked(taskRepo.getTaskById).mockImplementation((id: string) => {
      if (id === 'task-1') return task1;
      if (id === 'task-2') return task2;
      return null;
    });
    vi.mocked(taskRepo.getTasksByDependency).mockImplementation((id: string) => {
      if (id === 'task-2') return [makeTask({ id: 'dep-1' }), makeTask({ id: 'dep-2' }), makeTask({ id: 'dep-3' })];
      return [];
    });
    vi.mocked(taskRepo.deleteTask).mockImplementation((id: string) => {
      if (id === 'task-1') return { success: true };
      if (id === 'task-2') return { success: false, reason: 'has_dependents', dependentCount: 3 };
      return { success: false, reason: 'not_found' };
    });

    const result = batchOperateTasks(
      'board-1',
      { taskIds: ['task-1', 'task-2'], operation: 'delete', payload: {} },
      'user-1',
      'human'
    );

    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(1);
    expect(result.results).toContainEqual(
      expect.objectContaining({ taskId: 'task-1', success: true })
    );
    expect(result.results).toContainEqual(
      expect.objectContaining({ taskId: 'task-2', success: false, error: 'Task has 3 dependent task(s)' })
    );
  });
});
