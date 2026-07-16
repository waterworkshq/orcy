import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeTask } from './factories/task.js';

vi.mock('../repositories/task.js', () => ({
  getTaskById: vi.fn(),
  getHabitatIdForTask: vi.fn(() => 'habitat-1'),
  failTask: vi.fn(),
  getTasksByDependency: vi.fn(() => []),
  claimTask: vi.fn(),
}));

vi.mock('../repositories/mission.js', () => ({
  getMissionById: vi.fn(),
}));

vi.mock('../repositories/agent.js', () => ({
  getAgentById: vi.fn(),
}));

vi.mock('../repositories/event.js', () => ({
  createEvent: vi.fn(),
}));

vi.mock('../sse/broadcaster.js', () => ({
  sseBroadcaster: { publish: vi.fn() },
}));

vi.mock('../services/watcherService.js', () => ({
  notifyWatchers: vi.fn(),
}));

vi.mock('../services/retryService.js', () => ({
  shouldRetry: vi.fn(),
  scheduleRetry: vi.fn(),
  getEffectivePolicy: vi.fn(),
  escalateToHuman: vi.fn(),
}));

vi.mock('../services/gitWorktreeService.js', () => ({
  cleanupWorktree: vi.fn(),
}));

vi.mock('../plugins/pluginManager.js', () => ({
  emitTaskClaimed: vi.fn().mockResolvedValue(undefined),
  emitTaskSubmitted: vi.fn().mockResolvedValue(undefined),
  emitTaskApproved: vi.fn().mockResolvedValue(undefined),
  emitTaskRejected: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/featureService.js', () => ({
  recalculateMissionStatus: vi.fn(),
}));

vi.mock('../services/timeTrackingService.js', () => ({
  recordWork: vi.fn(),
  calculateAndSetCompletionMetrics: vi.fn(),
}));

vi.mock('../services/qualityGateService.js', () => ({
  ensureTaskChecklists: vi.fn(),
  validateQualityGates: vi.fn(() => ({ passed: true, failures: [] })),
}));

vi.mock('../services/dependencyService.js', () => ({
  validateTaskCompletion: vi.fn(() => ({ canComplete: true })),
}));

import { failTask } from '../services/tasks/task-lifecycle.js';
import * as taskRepo from '../repositories/task.js';
import * as retryService from '../services/retryService.js';

describe('failTask → retry integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls shouldRetry when task has retry policy', () => {
    const currentTask = makeTask({ status: 'in_progress', assignedAgentId: 'agent-1' });
    const failedTask = { ...currentTask, status: 'failed' as const };
    vi.mocked(taskRepo.getTaskById).mockReturnValue(currentTask);
    vi.mocked(taskRepo.failTask).mockReturnValue(failedTask);
    vi.mocked(retryService.shouldRetry).mockReturnValue(true);

    failTask('task-1', 'agent-1', 'agent', 'something broke');

    expect(retryService.shouldRetry).toHaveBeenCalledWith(failedTask);
  });

  it('calls scheduleRetry when shouldRetry returns true', () => {
    const currentTask = makeTask({ status: 'in_progress', assignedAgentId: 'agent-1' });
    const failedTask = { ...currentTask, status: 'failed' as const };
    vi.mocked(taskRepo.getTaskById).mockReturnValue(currentTask);
    vi.mocked(taskRepo.failTask).mockReturnValue(failedTask);
    vi.mocked(retryService.shouldRetry).mockReturnValue(true);

    failTask('task-1', 'agent-1', 'agent', 'something broke');

    expect(retryService.scheduleRetry).toHaveBeenCalledWith(failedTask);
  });

  it('calls escalateToHuman when policy has escalate flag and shouldRetry is false', () => {
    const currentTask = makeTask({ status: 'in_progress', assignedAgentId: 'agent-1' });
    const failedTask = { ...currentTask, status: 'failed' as const };
    vi.mocked(taskRepo.getTaskById).mockReturnValue(currentTask);
    vi.mocked(taskRepo.failTask).mockReturnValue(failedTask);
    vi.mocked(retryService.shouldRetry).mockReturnValue(false);
    vi.mocked(retryService.getEffectivePolicy).mockReturnValue({ escalateToHuman: true, maxRetries: 3, backoffBase: 60, backoffMultiplier: 2, maxBackoff: 3600, retryOnStatuses: ['all'] });

    failTask('task-1', 'agent-1', 'agent', 'something broke');

    expect(retryService.escalateToHuman).toHaveBeenCalledWith(failedTask);
  });

  it('does not call scheduleRetry when shouldRetry returns false and no escalate', () => {
    const currentTask = makeTask({ status: 'in_progress', assignedAgentId: 'agent-1' });
    const failedTask = { ...currentTask, status: 'failed' as const };
    vi.mocked(taskRepo.getTaskById).mockReturnValue(currentTask);
    vi.mocked(taskRepo.failTask).mockReturnValue(failedTask);
    vi.mocked(retryService.shouldRetry).mockReturnValue(false);
    vi.mocked(retryService.getEffectivePolicy).mockReturnValue(null);

    failTask('task-1', 'agent-1', 'agent', 'something broke');

    expect(retryService.scheduleRetry).not.toHaveBeenCalled();
    expect(retryService.escalateToHuman).not.toHaveBeenCalled();
  });
});
