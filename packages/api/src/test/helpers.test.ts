import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../repositories/task.js', () => ({
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
  getTasksByDependency: vi.fn(),
  areAllDependenciesMet: vi.fn(),
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

vi.mock('../plugins/pluginManager.js', () => ({
  emitTaskApproved: vi.fn().mockResolvedValue(undefined),
}));

import {
  validateTransition,
  formatClonedTitle,
  validateAgentCapabilities,
  mergeArtifacts,
  VALID_TRANSITIONS,
} from '../services/tasks/helpers.js';
import * as taskRepo from '../repositories/task.js';
import * as eventRepo from '../repositories/event.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import type { Task } from '../models/index.js';

function makeTask(overrides: Record<string, unknown> = {}): Task {
  return {
    id: 'task-1',
    featureId: 'feat-1',
    title: 'Test task',
    description: '',
    priority: 'medium',
    assignedAgentId: null,
    delegatedToAgentId: null,
    requiredDomain: null,
    requiredCapabilities: [],
    status: 'pending',
    claimedAt: null,
    startedAt: null,
    submittedAt: null,
    completedAt: null,
    rejectedCount: 0,
    rejectionReason: null,
    result: null,
    artifacts: [],
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
  } as Task;
}

describe('helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validateTransition', () => {
    it('allows valid transitions', () => {
      expect(validateTransition('pending', 'claimed')).toBe(true);
      expect(validateTransition('claimed', 'in_progress')).toBe(true);
      expect(validateTransition('in_progress', 'submitted')).toBe(true);
      expect(validateTransition('submitted', 'approved')).toBe(true);
      expect(validateTransition('approved', 'done')).toBe(true);
      expect(validateTransition('failed', 'pending')).toBe(true);
    });

    it('blocks invalid transitions', () => {
      expect(validateTransition('pending', 'done')).toBe(false);
      expect(validateTransition('done', 'pending')).toBe(false);
      expect(validateTransition('done', 'done')).toBe(false);
    });
  });

  describe('formatClonedTitle', () => {
    it('appends (Copy) to short titles', () => {
      expect(formatClonedTitle('My Task')).toBe('My Task (Copy)');
    });

    it('truncates long titles at 193 chars and appends suffix', () => {
      const longTitle = 'A'.repeat(200);
      const result = formatClonedTitle(longTitle);
      expect(result).toBe('A'.repeat(193) + '... (Copy)');
      expect(result.endsWith('... (Copy)')).toBe(true);
    });

    it('does not truncate titles at exactly 193 chars', () => {
      const title = 'A'.repeat(193);
      expect(formatClonedTitle(title)).toBe(title + ' (Copy)');
    });
  });

  describe('validateAgentCapabilities', () => {
    it('returns empty array when all capabilities match', () => {
      expect(validateAgentCapabilities(['typescript', 'react'], ['typescript'])).toEqual([]);
    });

    it('returns missing capabilities case-insensitively', () => {
      expect(validateAgentCapabilities(['TypeScript'], ['typescript', 'docker'])).toEqual(['docker']);
    });

    it('returns empty when no capabilities required', () => {
      expect(validateAgentCapabilities(['typescript'], [])).toEqual([]);
    });
  });

  describe('mergeArtifacts', () => {
    it('merges artifacts into existing ones', () => {
      const task = makeTask({ artifacts: [{ type: 'pr' as const, url: 'https://a.com', description: 'A' }] });
      const newArtifacts = [{ type: 'log' as const, url: 'https://b.com', description: 'B' }];

      mergeArtifacts('task-1', task, newArtifacts);

      expect(taskRepo.updateTask).toHaveBeenCalledWith('task-1', {
        artifacts: [
          { type: 'pr', url: 'https://a.com', description: 'A' },
          { type: 'log', url: 'https://b.com', description: 'B' },
        ],
      });
    });

    it('does nothing when artifacts is empty', () => {
      mergeArtifacts('task-1', makeTask(), []);
      expect(taskRepo.updateTask).not.toHaveBeenCalled();
    });

    it('does nothing when artifacts is undefined', () => {
      mergeArtifacts('task-1', makeTask(), undefined);
      expect(taskRepo.updateTask).not.toHaveBeenCalled();
    });
  });

  describe('VALID_TRANSITIONS', () => {
    it('done has no outbound transitions', () => {
      expect(VALID_TRANSITIONS['done']).toEqual([]);
    });

    it('pending can only transition to claimed', () => {
      expect(VALID_TRANSITIONS['pending']).toEqual(['claimed']);
    });
  });
});
