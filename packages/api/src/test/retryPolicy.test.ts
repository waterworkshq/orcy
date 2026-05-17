import { describe, it, expect } from 'vitest';
import {
  getDefaultPolicy,
  shouldRetry,
  calculateBackoff,
} from '../services/retryService.js';
import type { Task, RetryPolicy } from '../models/index.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    missionId: 'feat-1',
    title: 'Test task',
    description: '',
    priority: 'medium',
    assignedAgentId: null,
    delegatedToAgentId: null,
    requiredDomain: null,
    requiredCapabilities: [],
    status: 'rejected',
    claimedAt: null,
    startedAt: null,
    submittedAt: null,
    completedAt: null,
    rejectedCount: 1,
    rejectionReason: 'quality',
    result: null,
    artifacts: [],
    order: 0,
    createdBy: 'agent-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
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

describe('getDefaultPolicy', () => {
  it('returns sensible defaults', () => {
    const policy = getDefaultPolicy();
    expect(policy.maxRetries).toBe(3);
    expect(policy.backoffBase).toBe(60);
    expect(policy.backoffMultiplier).toBe(2);
    expect(policy.maxBackoff).toBe(3600);
    expect(policy.escalateToHuman).toBe(true);
    expect(policy.retryOnStatuses).toEqual(['all']);
  });
});

describe('shouldRetry', () => {
  it('returns false when no policy is configured on task', () => {
    const task = makeTask();
    expect(shouldRetry(task, null)).toBe(false);
  });

  it('returns true when retry count is below max', () => {
    const task = makeTask({ retryPolicy: getDefaultPolicy(), retryCount: 0 });
    expect(shouldRetry(task)).toBe(true);
  });

  it('returns false when retry count equals max', () => {
    const task = makeTask({ retryPolicy: { ...getDefaultPolicy(), maxRetries: 3 }, retryCount: 3 });
    expect(shouldRetry(task)).toBe(false);
  });

  it('returns false when retry count exceeds max', () => {
    const task = makeTask({ retryPolicy: { ...getDefaultPolicy(), maxRetries: 3 }, retryCount: 5 });
    expect(shouldRetry(task)).toBe(false);
  });

  it('returns true when retryOnStatuses includes the rejection reason', () => {
    const task = makeTask({
      retryPolicy: { ...getDefaultPolicy(), retryOnStatuses: ['quality', 'format'] },
      rejectionReason: 'quality',
    });
    expect(shouldRetry(task)).toBe(true);
  });

  it('returns false when retryOnStatuses does not include the rejection reason', () => {
    const task = makeTask({
      retryPolicy: { ...getDefaultPolicy(), retryOnStatuses: ['timeout'] },
      rejectionReason: 'quality',
    });
    expect(shouldRetry(task)).toBe(false);
  });

  it('returns true when retryOnStatuses is all regardless of rejection reason', () => {
    const task = makeTask({
      retryPolicy: { ...getDefaultPolicy(), retryOnStatuses: ['all'] },
      rejectionReason: 'anything',
    });
    expect(shouldRetry(task)).toBe(true);
  });

  it('returns true when retryOnStatuses is empty (defaults to all)', () => {
    const task = makeTask({
      retryPolicy: { ...getDefaultPolicy(), retryOnStatuses: [] },
      rejectionReason: 'anything',
    });
    expect(shouldRetry(task)).toBe(true);
  });
});

describe('calculateBackoff', () => {
  it('calculates exponential backoff correctly', () => {
    const policy = getDefaultPolicy();
    expect(calculateBackoff(policy, 0)).toBe(60);
    expect(calculateBackoff(policy, 1)).toBe(120);
    expect(calculateBackoff(policy, 2)).toBe(240);
    expect(calculateBackoff(policy, 3)).toBe(480);
  });

  it('caps at maxBackoff', () => {
    const policy: RetryPolicy = { maxRetries: 10, backoffBase: 60, backoffMultiplier: 2, maxBackoff: 300, escalateToHuman: true, retryOnStatuses: ['all'] };
    expect(calculateBackoff(policy, 0)).toBe(60);
    expect(calculateBackoff(policy, 1)).toBe(120);
    expect(calculateBackoff(policy, 2)).toBe(240);
    expect(calculateBackoff(policy, 3)).toBe(300);
    expect(calculateBackoff(policy, 10)).toBe(300);
  });

  it('respects custom backoffBase and multiplier', () => {
    const policy: RetryPolicy = { maxRetries: 3, backoffBase: 10, backoffMultiplier: 3, maxBackoff: 3600, escalateToHuman: true, retryOnStatuses: ['all'] };
    expect(calculateBackoff(policy, 0)).toBe(10);
    expect(calculateBackoff(policy, 1)).toBe(30);
    expect(calculateBackoff(policy, 2)).toBe(90);
  });
});
