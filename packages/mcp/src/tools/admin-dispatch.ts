import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createDispatchTool, createDispatchHandler, type Handler } from './dispatch-utils.js';
import { boardListWebhooks, boardCreateWebhook, boardDeleteWebhook } from './webhook.js';
import { boardListTemplates, boardCreateTemplate, boardDeleteTemplate } from './template.js';
import { boardBatchAssignTasks, boardBatchSetTaskPriority, boardBatchDeleteTasks } from './task-batch.js';
import { adminExportAuditLog, adminGetAuditSummary } from './audit.js';
import { PRIORITY_LEVELS, WEBHOOK_FORMATS } from './constants.js';

export const ADMIN_DISPATCH_TOOL: Tool = createDispatchTool({
  name: 'orcy_admin',
  description: 'Admin operations: webhooks (list, create, delete), templates (list, create, delete), batch operations (assign-tasks, set-priority, delete-tasks), audit (export-audit-log, get-audit-summary)',
  actions: [
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
  ],
  sharedParams: {
    boardId: { type: 'string', description: 'The UUID of the Orcy habitat (webhooks, templates, batch operations)' },
    name: { type: 'string', description: 'A descriptive name for the webhook/template (action=create-webhook, action=create-template)' },
    url: { type: 'string', description: 'The URL to send webhook payloads to (action=create-webhook)' },
    events: {
      type: 'array',
      items: { type: 'string' },
      description: 'Array of event types to subscribe to, e.g. ["task.created", "task.completed"] (action=create-webhook)',
    },
    format: {
      type: 'string',
      enum: [...WEBHOOK_FORMATS],
      description: 'Webhook payload format: standard, slack, or discord (action=create-webhook)',
    },
    webhookId: { type: 'string', description: 'The UUID of the webhook to delete (action=delete-webhook)' },
    titlePattern: { type: 'string', description: 'Default title pattern for tasks (action=create-template)' },
    descriptionPattern: { type: 'string', description: 'Default description pattern for tasks (action=create-template)' },
    priority: {
      type: 'string',
      enum: [...PRIORITY_LEVELS],
      description: 'Default priority (action=create-template) or new priority level (action=batch-set-priority)',
    },
    labels: {
      type: 'array',
      items: { type: 'string' },
      description: 'Default labels for tasks (action=create-template)',
    },
    domain: { type: 'string', description: 'Default required domain (action=create-template)' },
    templateId: { type: 'string', description: 'The UUID of the template to delete (action=delete-template)' },
    taskIds: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 100,
      description: 'Array of task UUIDs (action=batch-assign-tasks, action=batch-set-priority, action=batch-delete-tasks)',
    },
    agentId: { type: 'string', description: 'The UUID of the agent to assign tasks to (action=batch-assign-tasks)' },
  },
});

export const ADMIN_ACTIONS: Record<string, Handler> = {
  'list-webhooks': boardListWebhooks,
  'create-webhook': boardCreateWebhook,
  'delete-webhook': boardDeleteWebhook,
  'list-templates': boardListTemplates,
  'create-template': boardCreateTemplate,
  'delete-template': boardDeleteTemplate,
  'batch-assign-tasks': boardBatchAssignTasks,
  'batch-set-priority': boardBatchSetTaskPriority,
  'batch-delete-tasks': boardBatchDeleteTasks,
  'export-audit-log': adminExportAuditLog,
  'get-audit-summary': adminGetAuditSummary,
};

export const ADMIN_DISPATCH_HANDLER = createDispatchHandler(ADMIN_ACTIONS);
