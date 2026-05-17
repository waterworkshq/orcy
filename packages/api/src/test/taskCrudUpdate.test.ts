import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

import { logger } from '../lib/logger.js';

vi.mock('../repositories/task.js', () => ({
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
  getHabitatIdForTask: vi.fn().mockReturnValue('habitat-1'),
}));

vi.mock('../repositories/feature.js', () => ({
  getMissionById: vi.fn(() => ({ id: 'feat-1', habitatId: 'habitat-1', isArchived: false })),
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

vi.mock('../services/featureService.js', () => ({
  recalculateMissionStatus: vi.fn(),
}));

import { updateTask } from '../services/tasks/task-crud.js';
import * as taskRepo from '../repositories/task.js';
import * as missionService from '../services/featureService.js';

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    missionId: 'feat-1',
    title: 'Test task',
    description: 'Desc',
    priority: 'medium' as const,
    assignedAgentId: null,
    delegatedToAgentId: null,
    requiredDomain: 'backend' as const,
    requiredCapabilities: ['typescript'],
    status: 'approved' as const,
    claimedAt: null,
    startedAt: null,
    submittedAt: null,
    completedAt: null,
    rejectedCount: 0,
    rejectionReason: null,
    result: null,
    artifacts: [] as { type: string; url: string; description: string }[],
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
    labels: [],
    ...overrides,
  };
}

describe('updateTask — mission recalculation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recalculates mission status when task status changes', () => {
    const current = makeTask({ status: 'approved' });
    const updated = { ...current, status: 'done' };

    vi.mocked(taskRepo.getTaskById).mockReturnValue(current as never);
    vi.mocked(taskRepo.updateTask).mockReturnValue({ success: true, task: updated } as never);

    const result = updateTask('task-1', { status: 'done' }, 'user-1');

    expect(result.success).toBe(true);
    expect(missionService.recalculateMissionStatus).toHaveBeenCalledWith('feat-1');
  });

  it('does not recalculate mission status when status is unchanged', () => {
    const current = makeTask({ status: 'approved' });
    const updated = { ...current, title: 'New title' };

    vi.mocked(taskRepo.getTaskById).mockReturnValue(current as never);
    vi.mocked(taskRepo.updateTask).mockReturnValue({ success: true, task: updated } as never);

    updateTask('task-1', { title: 'New title' }, 'user-1');

    expect(missionService.recalculateMissionStatus).not.toHaveBeenCalled();
  });

  it('does not recalculate when status field is same as current', () => {
    const current = makeTask({ status: 'approved' });

    vi.mocked(taskRepo.getTaskById).mockReturnValue(current as never);
    vi.mocked(taskRepo.updateTask).mockReturnValue({ success: true, task: current } as never);

    updateTask('task-1', { status: 'approved' }, 'user-1');

    expect(missionService.recalculateMissionStatus).not.toHaveBeenCalled();
  });

  it('still returns success when recalculation throws', () => {
    const current = makeTask({ status: 'approved' });
    const updated = { ...current, status: 'done' };

    vi.mocked(taskRepo.getTaskById).mockReturnValue(current as never);
    vi.mocked(taskRepo.updateTask).mockReturnValue({ success: true, task: updated } as never);
    vi.mocked(missionService.recalculateMissionStatus).mockImplementation(() => {
      throw new Error('DB error');
    });
    const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    const result = updateTask('task-1', { status: 'done' }, 'user-1');

    expect(result.success).toBe(true);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
