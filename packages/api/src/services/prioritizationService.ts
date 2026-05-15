import { getDb } from '../db/index.js';
import { tasks, features, agents, taskDependencies } from '../db/schema/index.js';
import { eq, and, sql, isNotNull, inArray, count, notInArray } from 'drizzle-orm';
import * as boardRepo from '../repositories/board.js';
import * as taskRepo from '../repositories/task.js';
import * as featureRepo from '../repositories/feature.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import { scoreTask } from './taskScoring.js';
import { logger } from '../lib/logger.js';
import type {
  PrioritizationSettings,
  PrioritizationRule,
  PrioritizationRuleCondition,
  PrioritizationRuleAction,
  Task,
  TaskPriority,
  Feature,
} from '../models/index.js';

const TERMINAL_STATUSES: Task['status'][] = ['done', 'approved', 'failed'];

const PRIORITY_LEVELS: TaskPriority[] = ['low', 'medium', 'high', 'critical'];

const DEFAULT_RULES: PrioritizationRule[] = [
  {
    id: 'default-overdue',
    name: 'Overdue tasks → critical',
    enabled: true,
    condition: { type: 'overdue' },
    action: { type: 'set_priority', value: 'critical' },
    priority: 1,
  },
  {
    id: 'default-sla-approaching',
    name: 'SLA approaching → high',
    enabled: true,
    condition: { type: 'sla_approaching', withinHours: 4 },
    action: { type: 'set_priority', value: 'high' },
    priority: 2,
  },
  {
    id: 'default-due-soon',
    name: 'Due within 1 day → high',
    enabled: true,
    condition: { type: 'due_soon', withinDays: 1 },
    action: { type: 'set_priority', value: 'high' },
    priority: 3,
  },
  {
    id: 'default-pending-age',
    name: 'Pending >72h → bump priority',
    enabled: true,
    condition: { type: 'pending_duration', greaterThanHours: 72 },
    action: { type: 'bump_priority', value: 1 },
    priority: 4,
  },
  {
    id: 'default-blocking-many',
    name: 'Blocking 3+ tasks → score bonus',
    enabled: true,
    condition: { type: 'dependency_count', greaterThan: 3, direction: 'blocking' },
    action: { type: 'set_score_bonus', value: 15 },
    priority: 5,
  },
];

const DEFAULT_SETTINGS: PrioritizationSettings = {
  enabled: true,
  evaluateIntervalMinutes: 5,
  rules: DEFAULT_RULES,
  fallbackToManual: true,
};

export function getDefaultPrioritizationSettings(): PrioritizationSettings {
  return {
    ...DEFAULT_SETTINGS,
    rules: DEFAULT_SETTINGS.rules.map(r => ({ ...r })),
  };
}

export function getPrioritizationRules(boardId: string): PrioritizationSettings {
  const board = boardRepo.getBoardById(boardId);
  if (!board) return getDefaultPrioritizationSettings();
  return board.prioritizationSettings ?? getDefaultPrioritizationSettings();
}

export interface EvaluationContext {
  featureMap: Map<string, Feature | null>;
  agentHeartbeatMap: Map<string, string>;
  blockingCountMap: Map<string, number>;
  blockedByCountMap: Map<string, number>;
}

export function buildEvaluationContext(boardTasks: Task[]): EvaluationContext {
  const db = getDb();

  const featureIds = [...new Set(boardTasks.map(t => t.featureId))];
  const agentIds = [...new Set(boardTasks.map(t => t.assignedAgentId).filter((id): id is string => id !== null))];
  const taskIds = boardTasks.map(t => t.id);

  const featureMap = new Map<string, Feature | null>();
  for (const fid of featureIds) {
    featureMap.set(fid, featureRepo.getFeatureById(fid));
  }

  const agentHeartbeatMap = new Map<string, string>();
  if (agentIds.length > 0) {
    const agentRows = db.select({ id: agents.id, lastHeartbeat: agents.lastHeartbeat })
      .from(agents)
      .where(inArray(agents.id, agentIds))
      .all();
    for (const row of agentRows) {
      agentHeartbeatMap.set(row.id, row.lastHeartbeat);
    }
  }

  const blockingCountMap = new Map<string, number>();
  const blockedByCountMap = new Map<string, number>();

  if (taskIds.length > 0) {
    const blockingRows = db.select({
      dependsOnId: taskDependencies.dependsOnId,
      cnt: count(),
    })
      .from(taskDependencies)
      .where(inArray(taskDependencies.dependsOnId, taskIds))
      .groupBy(taskDependencies.dependsOnId)
      .all();
    for (const row of blockingRows) {
      blockingCountMap.set(row.dependsOnId, row.cnt);
    }

    const blockedByRows = db.select({
      taskId: taskDependencies.taskId,
      cnt: count(),
    })
      .from(taskDependencies)
      .where(inArray(taskDependencies.taskId, taskIds))
      .groupBy(taskDependencies.taskId)
      .all();
    for (const row of blockedByRows) {
      blockedByCountMap.set(row.taskId, row.cnt);
    }
  }

  return { featureMap, agentHeartbeatMap, blockingCountMap, blockedByCountMap };
}

function evaluateOverdue(task: Task, condition: Extract<PrioritizationRuleCondition, { type: 'overdue' }>, context: EvaluationContext): boolean {
  const feature = context.featureMap.get(task.featureId);
  if (!feature?.dueAt) return false;
  const byDays = condition.byDays ?? 0;
  const threshold = new Date(feature.dueAt).getTime() + byDays * 86_400_000;
  return Date.now() > threshold;
}

function evaluateSlaApproaching(task: Task, condition: Extract<PrioritizationRuleCondition, { type: 'sla_approaching' }>, context: EvaluationContext): boolean {
  const feature = context.featureMap.get(task.featureId);
  if (!feature?.slaDeadlineAt) return false;
  const msRemaining = new Date(feature.slaDeadlineAt).getTime() - Date.now();
  return msRemaining > 0 && msRemaining <= condition.withinHours * 3_600_000;
}

function evaluateDueSoon(task: Task, condition: Extract<PrioritizationRuleCondition, { type: 'due_soon' }>, context: EvaluationContext): boolean {
  const feature = context.featureMap.get(task.featureId);
  if (!feature?.dueAt) return false;
  const msRemaining = new Date(feature.dueAt).getTime() - Date.now();
  return msRemaining > 0 && msRemaining <= condition.withinDays * 86_400_000;
}

function evaluatePendingDuration(task: Task, condition: Extract<PrioritizationRuleCondition, { type: 'pending_duration' }>): boolean {
  if (task.status !== 'pending') return false;
  const msElapsed = Date.now() - new Date(task.createdAt).getTime();
  return msElapsed > condition.greaterThanHours * 3_600_000;
}

function evaluateDependencyCount(task: Task, condition: Extract<PrioritizationRuleCondition, { type: 'dependency_count' }>, context: EvaluationContext): boolean {
  const map = condition.direction === 'blocking' ? context.blockingCountMap : context.blockedByCountMap;
  const cnt = map.get(task.id) ?? 0;
  return cnt > condition.greaterThan;
}

function evaluateRejectionCount(task: Task, condition: Extract<PrioritizationRuleCondition, { type: 'rejection_count' }>): boolean {
  return task.rejectedCount > condition.greaterThan;
}

function evaluateFeatureStatus(task: Task, condition: Extract<PrioritizationRuleCondition, { type: 'feature_status' }>, context: EvaluationContext): boolean {
  const feature = context.featureMap.get(task.featureId);
  if (!feature) return false;
  return feature.status === condition.status;
}

function evaluateAgentIdle(task: Task, condition: Extract<PrioritizationRuleCondition, { type: 'agent_idle' }>, context: EvaluationContext): boolean {
  if (!task.assignedAgentId) return false;
  const lastHeartbeat = context.agentHeartbeatMap.get(task.assignedAgentId);
  if (!lastHeartbeat) return false;
  const msSinceHeartbeat = Date.now() - new Date(lastHeartbeat).getTime();
  return msSinceHeartbeat > condition.greaterThanMinutes * 60_000;
}

function evaluateLabelMatch(task: Task, condition: Extract<PrioritizationRuleCondition, { type: 'label_match' }>): boolean {
  const taskLabels = task.labels ?? [];
  return condition.labels.some(label => taskLabels.includes(label));
}

function evaluatePriorityIs(task: Task, condition: Extract<PrioritizationRuleCondition, { type: 'priority_is' }>): boolean {
  return task.priority === condition.priority;
}

export function evaluateCondition(task: Task, condition: PrioritizationRuleCondition, context: EvaluationContext): boolean {
  switch (condition.type) {
    case 'overdue':
      return evaluateOverdue(task, condition, context);
    case 'sla_approaching':
      return evaluateSlaApproaching(task, condition, context);
    case 'due_soon':
      return evaluateDueSoon(task, condition, context);
    case 'pending_duration':
      return evaluatePendingDuration(task, condition);
    case 'dependency_count':
      return evaluateDependencyCount(task, condition, context);
    case 'rejection_count':
      return evaluateRejectionCount(task, condition);
    case 'feature_status':
      return evaluateFeatureStatus(task, condition, context);
    case 'agent_idle':
      return evaluateAgentIdle(task, condition, context);
    case 'label_match':
      return evaluateLabelMatch(task, condition);
    case 'priority_is':
      return evaluatePriorityIs(task, condition);
    case 'and':
      return condition.conditions.every(c => evaluateCondition(task, c, context));
    case 'or':
      return condition.conditions.some(c => evaluateCondition(task, c, context));
    default:
      return false;
  }
}

function applyAction(taskId: string, action: PrioritizationRuleAction): string | null {
  const db = getDb();
  const now = new Date().toISOString();

  switch (action.type) {
    case 'set_priority': {
      const newPriority = action.value as TaskPriority;
      db.update(tasks).set({ priority: newPriority, updatedAt: now }).where(eq(tasks.id, taskId)).run();
      return newPriority;
    }
    case 'bump_priority': {
      const task = taskRepo.getTaskById(taskId);
      if (!task) return null;
      const currentIdx = PRIORITY_LEVELS.indexOf(task.priority);
      const newIdx = Math.min(currentIdx + action.value, PRIORITY_LEVELS.length - 1);
      const newPriority = PRIORITY_LEVELS[newIdx];
      db.update(tasks).set({ priority: newPriority, updatedAt: now }).where(eq(tasks.id, taskId)).run();
      return newPriority;
    }
    case 'add_label': {
      const task = taskRepo.getTaskById(taskId);
      if (!task) return null;
      const labels = [...task.labels];
      if (!labels.includes(action.value)) {
        labels.push(action.value);
        db.update(tasks).set({ labels, updatedAt: now }).where(eq(tasks.id, taskId)).run();
      }
      return null;
    }
    case 'set_score_bonus':
      return `+${action.value}`;
  }
}

export interface RuleEvaluationResult {
  taskId: string;
  ruleId: string;
  ruleName: string;
  action: PrioritizationRuleAction;
  matched: boolean;
}

export function evaluateRules(boardId: string): RuleEvaluationResult[] {
  const settings = getPrioritizationRules(boardId);
  if (!settings.enabled) return [];

  const { tasks: boardTasks } = taskRepo.getTasksByBoardId(boardId);
  if (boardTasks.length === 0) return [];

  const activeTasks = boardTasks.filter(t => !TERMINAL_STATUSES.includes(t.status));
  if (activeTasks.length === 0) return [];

  const context = buildEvaluationContext(activeTasks);

  const sortedRules = [...settings.rules]
    .filter(r => r.enabled)
    .sort((a, b) => a.priority - b.priority);

  const matchedTaskIds = new Set<string>();
  const results: RuleEvaluationResult[] = [];

  for (const rule of sortedRules) {
    for (const task of activeTasks) {
      if (matchedTaskIds.has(task.id)) continue;

      const matched = evaluateCondition(task, rule.condition, context);
      if (matched) {
        matchedTaskIds.add(task.id);
        results.push({
          taskId: task.id,
          ruleId: rule.id,
          ruleName: rule.name,
          action: rule.action,
          matched: true,
        });
      }
    }
  }

  return results;
}

export interface PrioritizationResult {
  boardId: string;
  evaluatedTasks: number;
  changedTasks: number;
  results: Array<{
    taskId: string;
    ruleName: string;
    action: PrioritizationRuleAction;
    score: number;
  }>;
}

export function applyPrioritization(boardId: string): PrioritizationResult {
  const evaluations = evaluateRules(boardId);

  const results: PrioritizationResult['results'] = [];
  let changedCount = 0;

  for (const evaluation of evaluations) {
    try {
      applyAction(evaluation.taskId, evaluation.action);
    } catch (err) {
      logger.error({ err, taskId: evaluation.taskId, ruleName: evaluation.ruleName }, 'Failed to apply prioritization action for task');
      continue;
    }

    const task = taskRepo.getTaskById(evaluation.taskId);
    if (!task) continue;

    const baseScore = scoreTask(task);
    const scoreBonus = evaluation.action.type === 'set_score_bonus' ? evaluation.action.value : 0;
    const finalScore = baseScore + scoreBonus;

    sseBroadcaster.publish(boardId, {
      type: 'task.priority_changed',
      data: {
        taskId: evaluation.taskId,
        ruleName: evaluation.ruleName,
        score: finalScore,
      },
    });

    results.push({
      taskId: evaluation.taskId,
      ruleName: evaluation.ruleName,
      action: evaluation.action,
      score: finalScore,
    });

    changedCount++;
  }

  return {
    boardId,
    evaluatedTasks: evaluations.length,
    changedTasks: changedCount,
    results,
  };
}

export function applyAllBoards(): PrioritizationResult[] {
  const boards = boardRepo.listBoards();
  const results: PrioritizationResult[] = [];

  for (const board of boards) {
    try {
      const result = applyPrioritization(board.id);
      if (result.evaluatedTasks > 0) {
        results.push(result);
      }
    } catch (err) {
      logger.error({ err, boardId: board.id }, 'Failed to apply prioritization for board');
    }
  }

  return results;
}
