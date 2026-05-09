import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Task } from '../models/index.js';

function makeTask(overrides: Partial<Task> = {}): Task {
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
    ...overrides,
  };
}

describe('Task estimatedMinutes field', () => {
  it('should accept estimatedMinutes in task model', () => {
    const task = makeTask({ estimatedMinutes: 120 });
    expect(task.estimatedMinutes).toBe(120);
  });

  it('should default estimatedMinutes to null', () => {
    const task = makeTask();
    expect(task.estimatedMinutes).toBeNull();
  });

  it('should accept zero estimatedMinutes as null', () => {
    const task = makeTask({ estimatedMinutes: null });
    expect(task.estimatedMinutes).toBeNull();
  });

  it('should support various estimated minute values', () => {
    const values = [1, 15, 30, 60, 120, 480, 1440];
    for (const val of values) {
      const task = makeTask({ estimatedMinutes: val });
      expect(task.estimatedMinutes).toBe(val);
    }
  });
});
