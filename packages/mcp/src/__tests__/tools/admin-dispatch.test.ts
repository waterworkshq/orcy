import { describe, it, expect } from 'vitest';
import * as webhook from '../../tools/webhook.js';
import * as template from '../../tools/template.js';
import * as taskBatch from '../../tools/task-batch.js';
import { ADMIN_DISPATCH_TOOL, ADMIN_ACTIONS } from '../../tools/admin-dispatch.js';

describe('ADMIN_DISPATCH_TOOL', () => {
  it('has the correct name', () => {
    expect(ADMIN_DISPATCH_TOOL.name).toBe('orcy_admin');
  });

  it('includes all 9 actions in the enum', () => {
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
    ]);
  });

  it('requires action', () => {
    expect(ADMIN_DISPATCH_TOOL.inputSchema.required).toContain('action');
  });
});

describe('ADMIN_ACTIONS — webhook actions', () => {
  it('routes list-webhooks to boardListWebhooks', () => {
    expect(ADMIN_ACTIONS['list-webhooks']).toBe(webhook.boardListWebhooks);
  });

  it('routes create-webhook to boardCreateWebhook', () => {
    expect(ADMIN_ACTIONS['create-webhook']).toBe(webhook.boardCreateWebhook);
  });

  it('routes delete-webhook to boardDeleteWebhook', () => {
    expect(ADMIN_ACTIONS['delete-webhook']).toBe(webhook.boardDeleteWebhook);
  });
});

describe('ADMIN_ACTIONS — template actions', () => {
  it('routes list-templates to boardListTemplates', () => {
    expect(ADMIN_ACTIONS['list-templates']).toBe(template.boardListTemplates);
  });

  it('routes create-template to boardCreateTemplate', () => {
    expect(ADMIN_ACTIONS['create-template']).toBe(template.boardCreateTemplate);
  });

  it('routes delete-template to boardDeleteTemplate', () => {
    expect(ADMIN_ACTIONS['delete-template']).toBe(template.boardDeleteTemplate);
  });
});

describe('ADMIN_ACTIONS — batch actions', () => {
  it('routes batch-assign-tasks to boardBatchAssignTasks', () => {
    expect(ADMIN_ACTIONS['batch-assign-tasks']).toBe(taskBatch.boardBatchAssignTasks);
  });

  it('routes batch-set-priority to boardBatchSetTaskPriority', () => {
    expect(ADMIN_ACTIONS['batch-set-priority']).toBe(taskBatch.boardBatchSetTaskPriority);
  });

  it('routes batch-delete-tasks to boardBatchDeleteTasks', () => {
    expect(ADMIN_ACTIONS['batch-delete-tasks']).toBe(taskBatch.boardBatchDeleteTasks);
  });
});

describe('ADMIN_ACTIONS — completeness', () => {
  it('has exactly 9 actions', () => {
    expect(Object.keys(ADMIN_ACTIONS)).toHaveLength(9);
  });

  it('every action maps to a function', () => {
    for (const handler of Object.values(ADMIN_ACTIONS)) {
      expect(typeof handler).toBe('function');
    }
  });
});
