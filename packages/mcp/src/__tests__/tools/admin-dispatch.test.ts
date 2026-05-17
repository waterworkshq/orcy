import { describe, it, expect } from 'vitest';
import * as webhook from '../../tools/webhook.js';
import * as template from '../../tools/template.js';
import * as taskBatch from '../../tools/task-batch.js';
import * as scheduledTask from '../../tools/scheduled-task.js';
import { ADMIN_DISPATCH_TOOL, ADMIN_ACTIONS } from '../../tools/admin-dispatch.js';

describe('ADMIN_DISPATCH_TOOL', () => {
  it('has the correct name', () => {
    expect(ADMIN_DISPATCH_TOOL.name).toBe('orcy_admin');
  });

  it('includes all 18 actions in the enum', () => {
    const actionProp = ADMIN_DISPATCH_TOOL.inputSchema.properties.action as {
      enum?: string[];
    };
    expect(actionProp.enum).toEqual([
      'list-webhooks',
      'create-webhook',
      'delete-webhook',
      'list-templates',
      'create-template',
      'delete-template',
      'batch-assign-tasks',
      'batch-set-priority',
      'batch-delete-tasks',
      'export-audit-log',
      'get-audit-summary',
      'list-scheduled-tasks',
      'create-scheduled-task',
      'run-scheduled-task',
      'get-scheduled-task',
      'update-scheduled-task',
      'delete-scheduled-task',
      'toggle-scheduled-task',
    ]);
  });

  it('requires action', () => {
    expect(ADMIN_DISPATCH_TOOL.inputSchema.required).toContain('action');
  });
});

describe('ADMIN_ACTIONS — webhook actions', () => {
  it('routes list-webhooks to habitatListWebhooks', () => {
    expect(ADMIN_ACTIONS['list-webhooks']).toBe(webhook.habitatListWebhooks);
  });

  it('routes create-webhook to habitatCreateWebhook', () => {
    expect(ADMIN_ACTIONS['create-webhook']).toBe(webhook.habitatCreateWebhook);
  });

  it('routes delete-webhook to habitatDeleteWebhook', () => {
    expect(ADMIN_ACTIONS['delete-webhook']).toBe(webhook.habitatDeleteWebhook);
  });
});

describe('ADMIN_ACTIONS — template actions', () => {
  it('routes list-templates to habitatListTemplates', () => {
    expect(ADMIN_ACTIONS['list-templates']).toBe(template.habitatListTemplates);
  });

  it('routes create-template to habitatCreateTemplate', () => {
    expect(ADMIN_ACTIONS['create-template']).toBe(template.habitatCreateTemplate);
  });

  it('routes delete-template to habitatDeleteTemplate', () => {
    expect(ADMIN_ACTIONS['delete-template']).toBe(template.habitatDeleteTemplate);
  });
});

describe('ADMIN_ACTIONS — batch actions', () => {
  it('routes batch-assign-tasks to habitatBatchAssignTasks', () => {
    expect(ADMIN_ACTIONS['batch-assign-tasks']).toBe(taskBatch.habitatBatchAssignTasks);
  });

  it('routes batch-set-priority to habitatBatchSetTaskPriority', () => {
    expect(ADMIN_ACTIONS['batch-set-priority']).toBe(taskBatch.habitatBatchSetTaskPriority);
  });

  it('routes batch-delete-tasks to habitatBatchDeleteTasks', () => {
    expect(ADMIN_ACTIONS['batch-delete-tasks']).toBe(taskBatch.habitatBatchDeleteTasks);
  });
});

describe('ADMIN_ACTIONS — scheduled task actions', () => {
  it('routes list-scheduled-tasks to adminListScheduledTasks', () => {
    expect(ADMIN_ACTIONS['list-scheduled-tasks']).toBe(scheduledTask.adminListScheduledTasks);
  });

  it('routes create-scheduled-task to adminCreateScheduledTask', () => {
    expect(ADMIN_ACTIONS['create-scheduled-task']).toBe(scheduledTask.adminCreateScheduledTask);
  });

  it('routes run-scheduled-task to adminRunScheduledTask', () => {
    expect(ADMIN_ACTIONS['run-scheduled-task']).toBe(scheduledTask.adminRunScheduledTask);
  });

  it('routes get-scheduled-task to adminGetScheduledTask', () => {
    expect(ADMIN_ACTIONS['get-scheduled-task']).toBe(scheduledTask.adminGetScheduledTask);
  });

  it('routes update-scheduled-task to adminUpdateScheduledTask', () => {
    expect(ADMIN_ACTIONS['update-scheduled-task']).toBe(scheduledTask.adminUpdateScheduledTask);
  });

  it('routes delete-scheduled-task to adminDeleteScheduledTask', () => {
    expect(ADMIN_ACTIONS['delete-scheduled-task']).toBe(scheduledTask.adminDeleteScheduledTask);
  });

  it('routes toggle-scheduled-task to adminToggleScheduledTask', () => {
    expect(ADMIN_ACTIONS['toggle-scheduled-task']).toBe(scheduledTask.adminToggleScheduledTask);
  });
});

describe('ADMIN_ACTIONS — completeness', () => {
  it('has exactly 18 actions', () => {
    expect(Object.keys(ADMIN_ACTIONS)).toHaveLength(18);
  });

  it('every action maps to a function', () => {
    for (const handler of Object.values(ADMIN_ACTIONS)) {
      expect(typeof handler).toBe('function');
    }
  });
});
