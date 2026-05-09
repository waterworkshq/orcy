import * as taskRepo from '../repositories/task.js';
import * as boardRepo from '../repositories/board.js';
import * as eventRepo from '../repositories/event.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import * as featureService from './featureService.js';
import { logger } from '../lib/logger.js';
import type { Task, RetryPolicy } from '../models/index.js';

const DEFAULT_POLICY: RetryPolicy = {
  maxRetries: 3,
  backoffBase: 60,
  backoffMultiplier: 2,
  maxBackoff: 3600,
  escalateToHuman: true,
  retryOnStatuses: ['all'],
};

export function getDefaultPolicy(): RetryPolicy {
  return { ...DEFAULT_POLICY };
}

export function getEffectivePolicy(task: Task): RetryPolicy | null {
  if (task.retryPolicy) return task.retryPolicy;
  const boardId = taskRepo.getBoardIdForTask(task.id);
  if (!boardId) return null;
  const board = boardRepo.getBoardById(boardId);
  if (board?.retrySettings) return board.retrySettings;
  return null;
}

export function shouldRetry(task: Task, explicitPolicy?: RetryPolicy | null): boolean {
  const policy = explicitPolicy !== undefined ? explicitPolicy : getEffectivePolicy(task);
  if (!policy) return false;
  if ((task.retryCount ?? 0) >= (policy.maxRetries ?? 3)) return false;
  const statuses = policy.retryOnStatuses ?? ['all'];
  if (task.rejectionReason && statuses.length > 0 && !statuses.includes('all')) {
    return statuses.includes(task.rejectionReason);
  }
  return true;
}

export function calculateBackoff(policy: RetryPolicy, retryCount: number): number {
  const base = policy.backoffBase ?? 60;
  const multiplier = policy.backoffMultiplier ?? 2;
  const max = policy.maxBackoff ?? 3600;
  const delay = base * Math.pow(multiplier, retryCount);
  return Math.min(delay, max);
}

export function scheduleRetry(task: Task): Task | null {
  const policy = getEffectivePolicy(task);
  if (!policy) return null;

  const backoffSeconds = calculateBackoff(policy, task.retryCount);
  const nextRetryAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();

  const result = taskRepo.updateTask(task.id, { nextRetryAt });
  if (!result.success) return null;

  const boardId = taskRepo.getBoardIdForTask(task.id) ?? '';

  eventRepo.createEvent({
    taskId: task.id,
    actorType: 'system',
    actorId: 'retry-service',
    action: 'retry_scheduled',
    metadata: { nextRetryAt, retryCount: task.retryCount, backoffSeconds },
  });

  sseBroadcaster.publish(boardId, {
    type: 'task.retry_scheduled',
    data: { taskId: task.id, nextRetryAt, retryCount: task.retryCount },
  });

  return result.task;
}

export function executeRetry(task: Task): Task | null {
  const newRetryCount = task.retryCount + 1;

  const result = taskRepo.updateTask(task.id, {
    status: 'pending',
    assignedAgentId: null,
    rejectionReason: null,
    retryCount: newRetryCount,
    nextRetryAt: null,
  });

  if (!result.success) return null;

  const boardId = taskRepo.getBoardIdForTask(task.id) ?? '';

  eventRepo.createEvent({
    taskId: task.id,
    actorType: 'system',
    actorId: 'retry-service',
    action: 'retry_executed',
    toStatus: 'pending',
    metadata: { retryCount: newRetryCount },
  });

  sseBroadcaster.publish(boardId, {
    type: 'task.retry_executed',
    data: { taskId: task.id, retryCount: newRetryCount },
  });
  sseBroadcaster.publish(boardId, { type: 'task.updated', data: result.task });

  featureService.recalculateFeatureStatus(task.featureId);

  return result.task;
}

export function escalateToHuman(task: Task): Task | null {
  const policy = getEffectivePolicy(task);

  const result = taskRepo.updateTask(task.id, {
    assignedAgentId: null,
    nextRetryAt: null,
  });

  if (!result.success) return null;

  const boardId = taskRepo.getBoardIdForTask(task.id) ?? '';

  eventRepo.createEvent({
    taskId: task.id,
    actorType: 'system',
    actorId: 'retry-service',
    action: 'escalated',
    metadata: {
      retryCount: task.retryCount,
      maxRetries: policy?.maxRetries ?? DEFAULT_POLICY.maxRetries,
      rejectionReason: task.rejectionReason,
    },
  });

  sseBroadcaster.publish(boardId, {
    type: 'task.escalated',
    data: { taskId: task.id, retryCount: task.retryCount, reason: task.rejectionReason ?? 'max retries exceeded' },
  });
  sseBroadcaster.publish(boardId, { type: 'task.updated', data: result.task });

  featureService.recalculateFeatureStatus(task.featureId);

  return result.task;
}

export function processPendingRetries(): void {
  const pendingTasks = taskRepo.getTasksPendingRetry();
  for (const task of pendingTasks) {
    const policy = getEffectivePolicy(task);
    if (!policy) continue;

    if (task.retryCount < (policy.maxRetries ?? 3)) {
      executeRetry(task);
    } else if (policy.escalateToHuman) {
      escalateToHuman(task);
    }
  }
}

export function startRetryProcessor(intervalMs: number = 30_000): NodeJS.Timeout {
  return setInterval(() => {
    try {
      processPendingRetries();
    } catch (err) {
      logger.error({ err }, 'Error processing pending retries');
    }
  }, intervalMs);
}
