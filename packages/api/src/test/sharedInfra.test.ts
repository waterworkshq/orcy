import { describe, it, expect } from 'vitest';
import { habitats, missionTemplates } from '../db/schema/index.js';
import type { PrioritizationSettings, PrioritizationRule, PrioritizationRuleCondition, PrioritizationRuleAction, TaskTemplateEntry, MissionTemplate } from '../models/index.js';
import type { CreateTemplateInput, UpdateTemplateInput } from '../repositories/template.js';

describe('Shared Infra: PrioritizationSettings type', () => {
  it('PrioritizationSettings serializes and deserializes as JSON', () => {
    const settings: PrioritizationSettings = {
      enabled: true,
      evaluateIntervalMinutes: 5,
      rules: [
        {
          id: 'rule-1',
          name: 'Overdue boost',
          enabled: true,
          condition: { type: 'overdue', byDays: 2 },
          action: { type: 'bump_priority', value: 10 },
          priority: 1,
        },
      ],
      fallbackToManual: true,
    };
    const json = JSON.stringify(settings);
    const parsed: PrioritizationSettings = JSON.parse(json);
    expect(parsed.enabled).toBe(true);
    expect(parsed.evaluateIntervalMinutes).toBe(5);
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.rules[0].name).toBe('Overdue boost');
    expect(parsed.fallbackToManual).toBe(true);
  });

  it('PrioritizationSettings handles null rules array', () => {
    const minimal: PrioritizationSettings = {
      enabled: false,
      evaluateIntervalMinutes: 10,
      rules: [],
      fallbackToManual: true,
    };
    const json = JSON.stringify(minimal);
    const parsed: PrioritizationSettings = JSON.parse(json);
    expect(parsed.rules).toEqual([]);
  });

  it('all RuleCondition types compile', () => {
    const conditions: PrioritizationRuleCondition[] = [
      { type: 'overdue', byDays: 1 },
      { type: 'sla_approaching', withinHours: 4 },
      { type: 'due_soon', withinDays: 3 },
      { type: 'pending_duration', greaterThanHours: 48 },
      { type: 'dependency_count', greaterThan: 2, direction: 'blocking' },
      { type: 'rejection_count', greaterThan: 3 },
      { type: 'mission_status', status: 'in_progress' },
      { type: 'agent_idle', greaterThanMinutes: 30 },
      { type: 'label_match', labels: ['urgent'] },
      { type: 'priority_is', priority: 'high' },
      { type: 'and', conditions: [{ type: 'overdue' }, { type: 'priority_is', priority: 'low' }] },
      { type: 'or', conditions: [{ type: 'overdue' }, { type: 'sla_approaching', withinHours: 1 }] },
    ];
    expect(conditions).toHaveLength(12);
  });

  it('all RuleAction types compile', () => {
    const actions: PrioritizationRuleAction[] = [
      { type: 'set_priority', value: 'critical' },
      { type: 'bump_priority', value: 5 },
      { type: 'add_label', value: 'escalated' },
      { type: 'set_score_bonus', value: 20 },
    ];
    expect(actions).toHaveLength(4);
  });
});

describe('Shared Infra: TaskTemplateEntry type', () => {
  it('TaskTemplateEntry compiles with all optional fields', () => {
    const entry: TaskTemplateEntry = {
      title: 'Write tests',
      description: 'Add unit tests for the module',
      priority: 'high',
      requiredDomain: 'backend',
      requiredCapabilities: ['testing', 'typescript'],
      estimatedMinutes: 60,
      order: 1,
    };
    const json = JSON.stringify(entry);
    const parsed: TaskTemplateEntry = JSON.parse(json);
    expect(parsed.title).toBe('Write tests');
    expect(parsed.priority).toBe('high');
    expect(parsed.requiredCapabilities).toEqual(['testing', 'typescript']);
    expect(parsed.estimatedMinutes).toBe(60);
  });

  it('TaskTemplateEntry compiles with only required fields', () => {
    const minimal: TaskTemplateEntry = { title: 'Review code' };
    expect(minimal.title).toBe('Review code');
    expect(minimal.description).toBeUndefined();
    expect(minimal.priority).toBeUndefined();
  });
});

describe('Shared Infra: Schema changes', () => {
  it('habitats table has prioritizationSettings column', () => {
    expect(habitats.prioritizationSettings).toBeDefined();
  });

  it('missionTemplates table has tasksTemplate column', () => {
    expect(missionTemplates.tasksTemplate).toBeDefined();
  });
});

describe('Shared Infra: Template repository inputs', () => {
  it('CreateTemplateInput accepts tasksTemplate array', () => {
    const input: CreateTemplateInput = {
      habitatId: 'habitat-1',
      name: 'Bug Template',
      titlePattern: 'Fix: ',
      tasksTemplate: [
        { title: 'Reproduce', priority: 'high', order: 1 },
        { title: 'Fix', description: 'Apply the fix', estimatedMinutes: 30, order: 2 },
        { title: 'Verify', requiredCapabilities: ['testing'], order: 3 },
      ],
      createdBy: 'user-1',
    };
    expect(input.tasksTemplate).toHaveLength(3);
    expect(input.tasksTemplate![0].title).toBe('Reproduce');
  });

  it('CreateTemplateInput works without tasksTemplate', () => {
    const input: CreateTemplateInput = {
      habitatId: null,
      name: 'Simple',
      titlePattern: 'Do ',
      createdBy: 'user-1',
    };
    expect(input.tasksTemplate).toBeUndefined();
  });

  it('UpdateTemplateInput accepts tasksTemplate array', () => {
    const input: UpdateTemplateInput = {
      tasksTemplate: [
        { title: 'Investigate' },
        { title: 'Implement', priority: 'medium' },
      ],
    };
    expect(input.tasksTemplate).toHaveLength(2);
  });

  it('UpdateTemplateInput works without tasksTemplate', () => {
    const input: UpdateTemplateInput = { name: 'Updated' };
    expect(input.tasksTemplate).toBeUndefined();
  });
});

describe('Shared Infra: cron-parser import', () => {
  it('cron-parser is importable', async () => {
    const cronParser = await import('cron-parser');
    expect(cronParser).toBeDefined();
    expect(cronParser.CronExpressionParser).toBeDefined();
  });

  it('cron-parser parses a basic expression', async () => {
    const { CronExpressionParser } = await import('cron-parser');
    const interval = CronExpressionParser.parse('*/5 * * * *');
    const next = interval.next();
    expect(next).toBeDefined();
    expect(next.getTime()).toBeGreaterThan(Date.now() - 1);
  });
});
