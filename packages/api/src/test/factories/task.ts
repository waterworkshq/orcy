import type { Task, TaskPriority, TaskStatus } from '../../models/index.js';

function generateId(): string {
  return crypto.randomUUID();
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  const id = overrides.id ?? generateId();
  const now = new Date().toISOString();
  return {
    id,
    featureId: 'feat-1',
    title: 'Test task',
    description: 'A test task description',
    priority: 'medium' as TaskPriority,
    assignedAgentId: null,
    delegatedToAgentId: null,
    requiredDomain: null,
    requiredCapabilities: [],
    status: 'pending' as TaskStatus,
    claimedAt: null,
    startedAt: null,
    submittedAt: null,
    completedAt: null,
    rejectedCount: 0,
    rejectionReason: null,
    result: null,
    artifacts: [],
    order: 0,
    createdBy: 'test',
    createdAt: now,
    updatedAt: now,
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
  } as Task;
}
