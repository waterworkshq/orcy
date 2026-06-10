import * as taskRepo from '../repositories/task.js';
import * as habitatRepo from '../repositories/board.js';
import { logger } from '../lib/logger.js';
import type { Task, RetryPolicy } from '../models/index.js';
import { emitTransition } from './tasks/transition-emitter.js';

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
  const habitatId = taskRepo.getHabitatIdForTask(task.id);
  if (!habitatId) return null;
  const habitat = habitatRepo.getHabitatById(habitatId);
  if (habitat?.retrySettings) return habitat.retrySettings;
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

  const habitatId = taskRepo.getHabitatIdForTask(task.id) ?? '';

  emitTransition(task.id, 'retry_scheduled', habitatId, {
    actorType: 'system',
    actorId: 'retry-service',
    retryCount: task.retryCount,
    nextRetryAt,
    backoffSeconds,
    metadata: { nextRetryAt, retryCount: task.retryCount, backoffSeconds },
    task: result.task,
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

  const habitatId = taskRepo.getHabitatIdForTask(task.id) ?? '';

  emitTransition(task.id, 'retry_executed', habitatId, {
    actorType: 'system',
    actorId: 'retry-service',
    oldStatus: task.status,
    newStatus: 'pending',
    retryCount: newRetryCount,
    metadata: { retryCount: newRetryCount },
    task: result.task,
  });

  return result.task;
}

export function escalateToHuman(task: Task): Task | null {
  const policy = getEffectivePolicy(task);

  const result = taskRepo.updateTask(task.id, {
    assignedAgentId: null,
    nextRetryAt: null,
  });

  if (!result.success) return null;

  const habitatId = taskRepo.getHabitatIdForTask(task.id) ?? '';

  emitTransition(task.id, 'escalated', habitatId, {
    actorType: 'system',
    actorId: 'retry-service',
    reason: task.rejectionReason ?? 'max retries exceeded',
    retryCount: task.retryCount,
    metadata: {
      retryCount: task.retryCount,
      maxRetries: policy?.maxRetries ?? DEFAULT_POLICY.maxRetries,
      rejectionReason: task.rejectionReason,
    },
    task: result.task,
  });

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
