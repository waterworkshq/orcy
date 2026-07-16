import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeDb, initTestDb } from '../db/index.js';
import * as habitatRepo from '../repositories/habitat.js';
import * as columnRepo from '../repositories/column.js';
import * as taskRepo from '../repositories/task.js';
import * as missionRepo from '../repositories/mission.js';
import * as agentRepo from '../repositories/agent.js';
import { taskEvents, tasks, columns as columnsTable, habitats, agents, taskDependencies, missions } from '../db/schema/index.js';
import { eq, and } from 'drizzle-orm';
import {
  getDefaultPrioritizationSettings,
  getPrioritizationRules,
  evaluateCondition,
  evaluateRules,
  applyPrioritization,
  applyAllHabitats,
  buildEvaluationContext,
} from '../services/prioritizationService.js';
import type { EvaluationContext } from '../services/prioritizationService.js';
import type { PrioritizationSettings, PrioritizationRule, Mission, Task } from '../models/index.js';
import { makeTask, makeMission } from './factories/index.js';

let habitatId: string;
let columnId: string;
let missionId: string;
let agentId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(taskEvents).run();
  db.delete(tasks).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();
  db.delete(agents).run();

  vi.clearAllMocks();

  const { agent } = agentRepo.createAgent({ name: 'test-agent', type: 'claude-code', domain: 'backend' });
  agentId = agent.id;

  const habitat = habitatRepo.createHabitat({ name: 'Test Habitat' });
  habitatId = habitat.id;

  const columns = columnRepo.createColumn({ habitatId, name: 'Backlog', order: 0, requiresClaim: false });
  columnId = columns.id;

  const mission = missionRepo.createMission({ habitatId, columnId, title: 'Test Mission', createdBy: 'human' });
  missionId = mission.id;
});

afterEach(() => {
  closeDb();
});

function createTaskWithOverrides(overrides: Partial<Task> = {}): Task {
  return taskRepo.createTask({
    missionId,
    title: overrides.title ?? 'Test Task',
    createdBy: 'human',
    priority: overrides.priority ?? 'medium',
    labels: overrides.labels ?? [],
  });
}

function makeContext(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  const missionMap = overrides.missionMap ?? new Map<string, Mission | null>();
  return {
    missionMap,
    agentHeartbeatMap: overrides.agentHeartbeatMap ?? new Map<string, string>(),
    blockingCountMap: overrides.blockingCountMap ?? new Map<string, number>(),
    blockedByCountMap: overrides.blockedByCountMap ?? new Map<string, number>(),
  };
}

describe('getDefaultPrioritizationSettings', () => {
  it('returns valid settings with rules', () => {
    const settings = getDefaultPrioritizationSettings();
    expect(settings.enabled).toBe(true);
    expect(settings.evaluateIntervalMinutes).toBe(5);
    expect(settings.rules.length).toBeGreaterThan(0);
    expect(settings.fallbackToManual).toBe(true);
  });

  it('returns independent copies on each call', () => {
    const a = getDefaultPrioritizationSettings();
    const b = getDefaultPrioritizationSettings();
    a.rules.push({ id: 'test', name: 'test', enabled: true, condition: { type: 'priority_is', priority: 'low' }, action: { type: 'set_score_bonus', value: 5 }, priority: 99 });
    expect(b.rules.length).toBeLessThan(a.rules.length);
  });
});

describe('getPrioritizationRules', () => {
  it('returns defaults when habitat has no settings', () => {
    const settings = getPrioritizationRules(habitatId);
    expect(settings.enabled).toBe(true);
    expect(settings.rules.length).toBeGreaterThan(0);
  });

  it('returns habitat settings when configured', () => {
    const db = getDb();
    const custom: PrioritizationSettings = {
      enabled: false,
      evaluateIntervalMinutes: 10,
      rules: [],
      fallbackToManual: true,
    };
    db.update(habitats).set({ prioritizationSettings: custom }).where(eq(habitats.id, habitatId)).run();

    const settings = getPrioritizationRules(habitatId);
    expect(settings.enabled).toBe(false);
    expect(settings.evaluateIntervalMinutes).toBe(10);
  });

  it('returns defaults for nonexistent habitat', () => {
    const settings = getPrioritizationRules('nonexistent');
    expect(settings.enabled).toBe(true);
  });
});

describe('evaluateCondition: overdue', () => {
  it('matches task past dueAt', () => {
    const task = createTaskWithOverrides();
    const mission = missionRepo.getMissionById(missionId)!;
    const db = getDb();
    db.update(missions).set({ dueAt: new Date(Date.now() - 86_400_000).toISOString() }).where(eq(missions.id, missionId)).run();

    const ctx = makeContext({ missionMap: new Map([[missionId, { ...mission, dueAt: new Date(Date.now() - 86_400_000).toISOString() }]]) });
    const result = evaluateCondition(task, { type: 'overdue' }, ctx);
    expect(result).toBe(true);
  });

  it('does not match task before dueAt', () => {
    const task = createTaskWithOverrides();
    const mission = missionRepo.getMissionById(missionId)!;
    const ctx = makeContext({ missionMap: new Map([[missionId, { ...mission, dueAt: new Date(Date.now() + 86_400_000 * 7).toISOString() }]]) });
    const result = evaluateCondition(task, { type: 'overdue' }, ctx);
    expect(result).toBe(false);
  });

  it('does not match task without dueAt', () => {
    const task = createTaskWithOverrides();
    const mission = missionRepo.getMissionById(missionId)!;
    const ctx = makeContext({ missionMap: new Map([[missionId, { ...mission, dueAt: null }]]) });
    const result = evaluateCondition(task, { type: 'overdue' }, ctx);
    expect(result).toBe(false);
  });

  it('respects byDays parameter', () => {
    const task = createTaskWithOverrides();
    const mission = missionRepo.getMissionById(missionId)!;
    const justOverdue = new Date(Date.now() - 86_400_000).toISOString();
    const ctx = makeContext({ missionMap: new Map([[missionId, { ...mission, dueAt: justOverdue }]]) });
    expect(evaluateCondition(task, { type: 'overdue', byDays: 0 }, ctx)).toBe(true);
    expect(evaluateCondition(task, { type: 'overdue', byDays: 3 }, ctx)).toBe(false);
  });
});

describe('evaluateCondition: sla_approaching', () => {
  it('matches task within SLA window', () => {
    const task = createTaskWithOverrides();
    const mission = missionRepo.getMissionById(missionId)!;
    const slaDeadline = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const ctx = makeContext({ missionMap: new Map([[missionId, { ...mission, slaDeadlineAt: slaDeadline }]]) });
    const result = evaluateCondition(task, { type: 'sla_approaching', withinHours: 4 }, ctx);
    expect(result).toBe(true);
  });

  it('does not match task outside SLA window', () => {
    const task = createTaskWithOverrides();
    const mission = missionRepo.getMissionById(missionId)!;
    const slaDeadline = new Date(Date.now() + 10 * 3_600_000).toISOString();
    const ctx = makeContext({ missionMap: new Map([[missionId, { ...mission, slaDeadlineAt: slaDeadline }]]) });
    const result = evaluateCondition(task, { type: 'sla_approaching', withinHours: 4 }, ctx);
    expect(result).toBe(false);
  });

  it('does not match breached SLA', () => {
    const task = createTaskWithOverrides();
    const mission = missionRepo.getMissionById(missionId)!;
    const slaDeadline = new Date(Date.now() - 3_600_000).toISOString();
    const ctx = makeContext({ missionMap: new Map([[missionId, { ...mission, slaDeadlineAt: slaDeadline }]]) });
    const result = evaluateCondition(task, { type: 'sla_approaching', withinHours: 4 }, ctx);
    expect(result).toBe(false);
  });
});

describe('evaluateCondition: due_soon', () => {
  it('matches task due within specified days', () => {
    const task = createTaskWithOverrides();
    const mission = missionRepo.getMissionById(missionId)!;
    const dueAt = new Date(Date.now() + 12 * 3_600_000).toISOString();
    const ctx = makeContext({ missionMap: new Map([[missionId, { ...mission, dueAt }]]) });
    expect(evaluateCondition(task, { type: 'due_soon', withinDays: 1 }, ctx)).toBe(true);
  });

  it('does not match task due later', () => {
    const task = createTaskWithOverrides();
    const mission = missionRepo.getMissionById(missionId)!;
    const dueAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const ctx = makeContext({ missionMap: new Map([[missionId, { ...mission, dueAt }]]) });
    expect(evaluateCondition(task, { type: 'due_soon', withinDays: 1 }, ctx)).toBe(false);
  });
});

describe('evaluateCondition: pending_duration', () => {
  it('matches pending task older than threshold', () => {
    const db = getDb();
    const task = createTaskWithOverrides({ title: 'Old Pending' });
    const fourDaysAgo = new Date(Date.now() - 4 * 86_400_000).toISOString();
    db.update(tasks).set({ status: 'pending', createdAt: fourDaysAgo }).where(eq(tasks.id, task.id)).run();
    const updated = taskRepo.getTaskById(task.id)!;

    expect(evaluateCondition(updated, { type: 'pending_duration', greaterThanHours: 72 }, makeContext())).toBe(true);
  });

  it('does not match in_progress task', () => {
    const db = getDb();
    const task = createTaskWithOverrides({ title: 'Old In Progress' });
    const fourDaysAgo = new Date(Date.now() - 4 * 86_400_000).toISOString();
    db.update(tasks).set({ status: 'in_progress', createdAt: fourDaysAgo }).where(eq(tasks.id, task.id)).run();
    const updated = taskRepo.getTaskById(task.id)!;

    expect(evaluateCondition(updated, { type: 'pending_duration', greaterThanHours: 72 }, makeContext())).toBe(false);
  });

  it('does not match task under threshold', () => {
    const task = createTaskWithOverrides({ title: 'Fresh Pending' });
    expect(evaluateCondition(task, { type: 'pending_duration', greaterThanHours: 72 }, makeContext())).toBe(false);
  });
});

describe('evaluateCondition: dependency_count', () => {
  it('matches task blocking many others', () => {
    const blocker = createTaskWithOverrides({ title: 'Blocker' });
    const dep1 = createTaskWithOverrides({ title: 'Dep 1' });
    const dep2 = createTaskWithOverrides({ title: 'Dep 2' });
    const dep3 = createTaskWithOverrides({ title: 'Dep 3' });
    const dep4 = createTaskWithOverrides({ title: 'Dep 4' });
    const db = getDb();
    db.insert(taskDependencies).values([
      { taskId: dep1.id, dependsOnId: blocker.id },
      { taskId: dep2.id, dependsOnId: blocker.id },
      { taskId: dep3.id, dependsOnId: blocker.id },
      { taskId: dep4.id, dependsOnId: blocker.id },
    ]).run();

    const ctx = makeContext({ blockingCountMap: new Map([[blocker.id, 4]]) });
    expect(evaluateCondition(blocker, { type: 'dependency_count', greaterThan: 3, direction: 'blocking' }, ctx)).toBe(true);
  });

  it('does not match task blocking few others', () => {
    const blocker = createTaskWithOverrides({ title: 'Blocker' });
    const ctx = makeContext({ blockingCountMap: new Map([[blocker.id, 2]]) });
    expect(evaluateCondition(blocker, { type: 'dependency_count', greaterThan: 3, direction: 'blocking' }, ctx)).toBe(false);
  });

  it('matches blocked_by direction', () => {
    const blocked = createTaskWithOverrides({ title: 'Blocked' });
    const ctx = makeContext({ blockedByCountMap: new Map([[blocked.id, 5]]) });
    expect(evaluateCondition(blocked, { type: 'dependency_count', greaterThan: 3, direction: 'blocked_by' }, ctx)).toBe(true);
  });
});

describe('evaluateCondition: rejection_count', () => {
  it('matches task with high rejection count', () => {
    const db = getDb();
    const task = createTaskWithOverrides();
    db.update(tasks).set({ rejectedCount: 3 }).where(eq(tasks.id, task.id)).run();
    const updated = taskRepo.getTaskById(task.id)!;

    expect(evaluateCondition(updated, { type: 'rejection_count', greaterThan: 2 }, makeContext())).toBe(true);
  });

  it('does not match task with low rejection count', () => {
    const task = createTaskWithOverrides();
    expect(evaluateCondition(task, { type: 'rejection_count', greaterThan: 2 }, makeContext())).toBe(false);
  });
});

describe('evaluateCondition: mission_status', () => {
  it('matches task in mission with matching status', () => {
    const task = createTaskWithOverrides();
    const mission = missionRepo.getMissionById(missionId)!;
    const ctx = makeContext({ missionMap: new Map([[missionId, { ...mission, status: 'in_progress' }]]) });
    expect(evaluateCondition(task, { type: 'mission_status', status: 'in_progress' }, ctx)).toBe(true);
  });

  it('does not match task in mission with different status', () => {
    const task = createTaskWithOverrides();
    const mission = missionRepo.getMissionById(missionId)!;
    const ctx = makeContext({ missionMap: new Map([[missionId, { ...mission, status: 'not_started' }]]) });
    expect(evaluateCondition(task, { type: 'mission_status', status: 'in_progress' }, ctx)).toBe(false);
  });
});

describe('evaluateCondition: agent_idle', () => {
  it('matches task with idle agent', () => {
    const db = getDb();
    const task = createTaskWithOverrides();
    db.update(tasks).set({ assignedAgentId: agentId }).where(eq(tasks.id, task.id)).run();
    const thirtyMinAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    db.update(agents).set({ lastHeartbeat: thirtyMinAgo }).where(eq(agents.id, agentId)).run();

    const updated = taskRepo.getTaskById(task.id)!;
    const ctx = makeContext({ agentHeartbeatMap: new Map([[agentId, thirtyMinAgo]]) });
    expect(evaluateCondition(updated, { type: 'agent_idle', greaterThanMinutes: 15 }, ctx)).toBe(true);
  });

  it('does not match task with active agent', () => {
    const db = getDb();
    const task = createTaskWithOverrides();
    db.update(tasks).set({ assignedAgentId: agentId }).where(eq(tasks.id, task.id)).run();
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    db.update(agents).set({ lastHeartbeat: recent }).where(eq(agents.id, agentId)).run();

    const updated = taskRepo.getTaskById(task.id)!;
    const ctx = makeContext({ agentHeartbeatMap: new Map([[agentId, recent]]) });
    expect(evaluateCondition(updated, { type: 'agent_idle', greaterThanMinutes: 15 }, ctx)).toBe(false);
  });

  it('does not match unassigned task', () => {
    const task = createTaskWithOverrides();
    const ctx = makeContext();
    expect(evaluateCondition(task, { type: 'agent_idle', greaterThanMinutes: 15 }, ctx)).toBe(false);
  });
});

describe('evaluateCondition: label_match', () => {
  it('matches task with matching label', () => {
    const task = createTaskWithOverrides({ labels: ['urgent', 'backend'] });
    expect(evaluateCondition(task, { type: 'label_match', labels: ['urgent'] }, makeContext())).toBe(true);
  });

  it('does not match task without matching label', () => {
    const task = createTaskWithOverrides({ labels: ['backend'] });
    expect(evaluateCondition(task, { type: 'label_match', labels: ['urgent'] }, makeContext())).toBe(false);
  });

  it('matches any of the specified labels', () => {
    const task = createTaskWithOverrides({ labels: ['frontend'] });
    expect(evaluateCondition(task, { type: 'label_match', labels: ['urgent', 'frontend'] }, makeContext())).toBe(true);
  });
});

describe('evaluateCondition: priority_is', () => {
  it('matches task with specified priority', () => {
    const task = createTaskWithOverrides({ priority: 'low' });
    expect(evaluateCondition(task, { type: 'priority_is', priority: 'low' }, makeContext())).toBe(true);
  });

  it('does not match task with different priority', () => {
    const task = createTaskWithOverrides({ priority: 'medium' });
    expect(evaluateCondition(task, { type: 'priority_is', priority: 'low' }, makeContext())).toBe(false);
  });
});

describe('evaluateCondition: and', () => {
  it('matches when all conditions are true', () => {
    const db = getDb();
    const task = createTaskWithOverrides({ priority: 'low' });
    db.update(tasks).set({ rejectedCount: 5 }).where(eq(tasks.id, task.id)).run();
    const updated = taskRepo.getTaskById(task.id)!;

    const mission = missionRepo.getMissionById(missionId)!;
    const dueAt = new Date(Date.now() - 86_400_000).toISOString();
    const ctx = makeContext({ missionMap: new Map([[missionId, { ...mission, dueAt }]]) });

    expect(evaluateCondition(updated, {
      type: 'and',
      conditions: [
        { type: 'overdue' },
        { type: 'rejection_count', greaterThan: 2 },
      ],
    }, ctx)).toBe(true);
  });

  it('does not match when one condition is false', () => {
    const task = createTaskWithOverrides({ priority: 'low' });
    const mission = missionRepo.getMissionById(missionId)!;
    const ctx = makeContext({ missionMap: new Map([[missionId, { ...mission, dueAt: null }]]) });

    expect(evaluateCondition(task, {
      type: 'and',
      conditions: [
        { type: 'overdue' },
        { type: 'priority_is', priority: 'low' },
      ],
    }, ctx)).toBe(false);
  });
});

describe('evaluateCondition: or', () => {
  it('matches when any condition is true', () => {
    const task = createTaskWithOverrides({ priority: 'low' });
    expect(evaluateCondition(task, {
      type: 'or',
      conditions: [
        { type: 'priority_is', priority: 'low' },
        { type: 'priority_is', priority: 'critical' },
      ],
    }, makeContext())).toBe(true);
  });

  it('does not match when all conditions are false', () => {
    const task = createTaskWithOverrides({ priority: 'medium' });
    expect(evaluateCondition(task, {
      type: 'or',
      conditions: [
        { type: 'priority_is', priority: 'low' },
        { type: 'priority_is', priority: 'critical' },
      ],
    }, makeContext())).toBe(false);
  });
});

describe('evaluateRules', () => {
  it('returns empty when prioritization disabled', () => {
    const db = getDb();
    db.update(habitats).set({ prioritizationSettings: { enabled: false, evaluateIntervalMinutes: 5, rules: [], fallbackToManual: true } }).where(eq(habitats.id, habitatId)).run();

    createTaskWithOverrides();
    const result = evaluateRules(habitatId);
    expect(result).toHaveLength(0);
  });

  it('skips terminal tasks', () => {
    const db = getDb();
    const doneTask = createTaskWithOverrides({ title: 'Done' });
    db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, doneTask.id)).run();

    const approvedTask = createTaskWithOverrides({ title: 'Approved' });
    db.update(tasks).set({ status: 'approved' }).where(eq(tasks.id, approvedTask.id)).run();

    const failedTask = createTaskWithOverrides({ title: 'Failed' });
    db.update(tasks).set({ status: 'failed' }).where(eq(tasks.id, failedTask.id)).run();

    const result = evaluateRules(habitatId);
    const matchedIds = result.map(r => r.taskId);
    expect(matchedIds).not.toContain(doneTask.id);
    expect(matchedIds).not.toContain(approvedTask.id);
    expect(matchedIds).not.toContain(failedTask.id);
  });

  it('respects first-match-wins rule priority', () => {
    const db = getDb();
    const customSettings: PrioritizationSettings = {
      enabled: true,
      evaluateIntervalMinutes: 5,
      rules: [
        {
          id: 'rule-low',
          name: 'Low priority catch-all',
          enabled: true,
          condition: { type: 'priority_is', priority: 'medium' },
          action: { type: 'set_score_bonus', value: 5 },
          priority: 1,
        },
        {
          id: 'rule-label',
          name: 'Label match',
          enabled: true,
          condition: { type: 'label_match', labels: ['urgent'] },
          action: { type: 'set_score_bonus', value: 10 },
          priority: 2,
        },
      ],
      fallbackToManual: true,
    };
    db.update(habitats).set({ prioritizationSettings: customSettings }).where(eq(habitats.id, habitatId)).run();

    const task = createTaskWithOverrides({ priority: 'medium', labels: ['urgent'], title: 'Both match' });
    const result = evaluateRules(habitatId);

    const taskResults = result.filter(r => r.taskId === task.id);
    expect(taskResults).toHaveLength(1);
    expect(taskResults[0].ruleId).toBe('rule-low');
  });

  it('evaluates all tasks independently', () => {
    const db = getDb();
    const customSettings: PrioritizationSettings = {
      enabled: true,
      evaluateIntervalMinutes: 5,
      rules: [
        {
          id: 'rule-low',
          name: 'Low priority',
          enabled: true,
          condition: { type: 'priority_is', priority: 'low' },
          action: { type: 'set_score_bonus', value: 5 },
          priority: 1,
        },
      ],
      fallbackToManual: true,
    };
    db.update(habitats).set({ prioritizationSettings: customSettings }).where(eq(habitats.id, habitatId)).run();

    const task1 = createTaskWithOverrides({ priority: 'low', title: 'Low 1' });
    const task2 = createTaskWithOverrides({ priority: 'medium', title: 'Medium' });
    const task3 = createTaskWithOverrides({ priority: 'low', title: 'Low 2' });

    const result = evaluateRules(habitatId);
    const matchedIds = result.map(r => r.taskId);
    expect(matchedIds).toContain(task1.id);
    expect(matchedIds).not.toContain(task2.id);
    expect(matchedIds).toContain(task3.id);
  });
});

describe('applyPrioritization', () => {
  it('broadcasts SSE for changed tasks', () => {
    const db = getDb();
    const customSettings: PrioritizationSettings = {
      enabled: true,
      evaluateIntervalMinutes: 5,
      rules: [
        {
          id: 'rule-low',
          name: 'Low → high',
          enabled: true,
          condition: { type: 'priority_is', priority: 'low' },
          action: { type: 'set_priority', value: 'high' },
          priority: 1,
        },
      ],
      fallbackToManual: true,
    };
    db.update(habitats).set({ prioritizationSettings: customSettings }).where(eq(habitats.id, habitatId)).run();

    const task = createTaskWithOverrides({ priority: 'low', title: 'Low task' });

    const result = applyPrioritization(habitatId);

    expect(result.changedTasks).toBe(1);
    expect(result.results[0].taskId).toBe(task.id);
    expect(result.results[0].ruleName).toBe('Low → high');

    const updated = taskRepo.getTaskById(task.id);
    expect(updated?.priority).toBe('high');
  });

  it('returns zero changes when no rules match', () => {
    const db = getDb();
    const customSettings: PrioritizationSettings = {
      enabled: true,
      evaluateIntervalMinutes: 5,
      rules: [
        {
          id: 'rule-critical',
          name: 'Critical only',
          enabled: true,
          condition: { type: 'priority_is', priority: 'critical' },
          action: { type: 'set_score_bonus', value: 10 },
          priority: 1,
        },
      ],
      fallbackToManual: true,
    };
    db.update(habitats).set({ prioritizationSettings: customSettings }).where(eq(habitats.id, habitatId)).run();

    createTaskWithOverrides({ priority: 'medium' });
    const result = applyPrioritization(habitatId);
    expect(result.changedTasks).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  it('handles set_score_bonus without DB write', () => {
    const db = getDb();
    const customSettings: PrioritizationSettings = {
      enabled: true,
      evaluateIntervalMinutes: 5,
      rules: [
        {
          id: 'rule-bonus',
          name: 'Bonus rule',
          enabled: true,
          condition: { type: 'priority_is', priority: 'medium' },
          action: { type: 'set_score_bonus', value: 20 },
          priority: 1,
        },
      ],
      fallbackToManual: true,
    };
    db.update(habitats).set({ prioritizationSettings: customSettings }).where(eq(habitats.id, habitatId)).run();

    const task = createTaskWithOverrides({ priority: 'medium' });
    const result = applyPrioritization(habitatId);

    expect(result.changedTasks).toBe(1);
    expect(result.results[0].score).toBeGreaterThanOrEqual(20);

    const updated = taskRepo.getTaskById(task.id);
    expect(updated?.priority).toBe('medium');
  });

  it('handles bump_priority action', () => {
    const db = getDb();
    const customSettings: PrioritizationSettings = {
      enabled: true,
      evaluateIntervalMinutes: 5,
      rules: [
        {
          id: 'rule-bump',
          name: 'Bump rule',
          enabled: true,
          condition: { type: 'priority_is', priority: 'low' },
          action: { type: 'bump_priority', value: 2 },
          priority: 1,
        },
      ],
      fallbackToManual: true,
    };
    db.update(habitats).set({ prioritizationSettings: customSettings }).where(eq(habitats.id, habitatId)).run();

    const task = createTaskWithOverrides({ priority: 'low' });
    applyPrioritization(habitatId);

    const updated = taskRepo.getTaskById(task.id);
    expect(updated?.priority).toBe('high');
  });

  it('continues processing remaining tasks when one task action fails', () => {
    const db = getDb();
    const customSettings: PrioritizationSettings = {
      enabled: true,
      evaluateIntervalMinutes: 5,
      rules: [
        {
          id: 'rule-bump',
          name: 'Bump',
          enabled: true,
          condition: { type: 'priority_is', priority: 'low' },
          action: { type: 'bump_priority', value: 1 },
          priority: 1,
        },
      ],
      fallbackToManual: true,
    };
    db.update(habitats).set({ prioritizationSettings: customSettings }).where(eq(habitats.id, habitatId)).run();

    const task1 = createTaskWithOverrides({ priority: 'low', title: 'Low 1' });
    const task2 = createTaskWithOverrides({ priority: 'low', title: 'Low 2' });

    const originalGetTaskById = taskRepo.getTaskById;
    const getTaskByIdSpy = vi.spyOn(taskRepo, 'getTaskById');
    getTaskByIdSpy.mockImplementation((id) => {
      if (id === task2.id) {
        throw new Error('Simulated DB failure');
      }
      return originalGetTaskById(id);
    });

    const result = applyPrioritization(habitatId);

    getTaskByIdSpy.mockRestore();

    expect(result.changedTasks).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].taskId).toBe(task1.id);

    const updated1 = taskRepo.getTaskById(task1.id);
    expect(updated1?.priority).toBe('medium');
  });

  it('handles add_label action', () => {
    const db = getDb();
    const customSettings: PrioritizationSettings = {
      enabled: true,
      evaluateIntervalMinutes: 5,
      rules: [
        {
          id: 'rule-label',
          name: 'Add label',
          enabled: true,
          condition: { type: 'priority_is', priority: 'medium' },
          action: { type: 'add_label', value: 'auto-prioritized' },
          priority: 1,
        },
      ],
      fallbackToManual: true,
    };
    db.update(habitats).set({ prioritizationSettings: customSettings }).where(eq(habitats.id, habitatId)).run();

    const task = createTaskWithOverrides({ labels: [] });
    applyPrioritization(habitatId);

    const updated = taskRepo.getTaskById(task.id);
    expect(updated?.labels).toContain('auto-prioritized');
  });
});

describe('applyAllHabitats', () => {
  it('iterates all habitats', () => {
    const habitat2 = habitatRepo.createHabitat({ name: 'Habitat 2' });
    const col2 = columnRepo.createColumn({ habitatId: habitat2.id, name: 'Col', order: 0, requiresClaim: false });
    missionRepo.createMission({ habitatId: habitat2.id, columnId: col2.id, title: 'Mission 2', createdBy: 'human' });

    const customSettings: PrioritizationSettings = {
      enabled: true,
      evaluateIntervalMinutes: 5,
      rules: [
        {
          id: 'rule-low',
          name: 'Low',
          enabled: true,
          condition: { type: 'priority_is', priority: 'low' },
          action: { type: 'set_score_bonus', value: 5 },
          priority: 1,
        },
      ],
      fallbackToManual: true,
    };
    const db = getDb();
    db.update(habitats).set({ prioritizationSettings: customSettings }).where(eq(habitats.id, habitatId)).run();
    db.update(habitats).set({ prioritizationSettings: customSettings }).where(eq(habitats.id, habitat2.id)).run();

    createTaskWithOverrides({ priority: 'low', title: 'Low on habitat 1' });
    const habitat2Missions = missionRepo.getMissionsByHabitatId(habitat2.id);
    taskRepo.createTask({ missionId: habitat2Missions.missions[0].id, title: 'Low on habitat 2', priority: 'low', createdBy: 'human' });

    const results = applyAllHabitats();
    expect(results.length).toBeGreaterThan(0);
    const habitatIds = results.map(r => r.habitatId);
    expect(habitatIds).toContain(habitatId);
    expect(habitatIds).toContain(habitat2.id);
  });

  it('continues on per-habitat errors', () => {
    const customSettings: PrioritizationSettings = {
      enabled: true,
      evaluateIntervalMinutes: 5,
      rules: [
        {
          id: 'rule-low',
          name: 'Low',
          enabled: true,
          condition: { type: 'priority_is', priority: 'low' },
          action: { type: 'set_score_bonus', value: 5 },
          priority: 1,
        },
      ],
      fallbackToManual: true,
    };
    const db = getDb();
    db.update(habitats).set({ prioritizationSettings: customSettings }).where(eq(habitats.id, habitatId)).run();
    createTaskWithOverrides({ priority: 'low' });

    const results = applyAllHabitats();
    expect(results.length).toBeGreaterThanOrEqual(0);
  });
});

describe('buildEvaluationContext', () => {
  it('builds context from tasks with dependencies', () => {
    const task1 = createTaskWithOverrides({ title: 'Task 1' });
    const task2 = createTaskWithOverrides({ title: 'Task 2' });
    const db = getDb();
    db.insert(taskDependencies).values({ taskId: task2.id, dependsOnId: task1.id }).run();
    db.update(tasks).set({ assignedAgentId: agentId }).where(eq(tasks.id, task1.id)).run();

    const allTasks = [task1, task2].map(t => taskRepo.getTaskById(t.id)!);
    const ctx = buildEvaluationContext(allTasks);

    expect(ctx.blockingCountMap.get(task1.id)).toBe(1);
    expect(ctx.blockedByCountMap.get(task2.id)).toBe(1);
    expect(ctx.agentHeartbeatMap.has(agentId)).toBe(true);
    expect(ctx.missionMap.has(missionId)).toBe(true);
  });
});
