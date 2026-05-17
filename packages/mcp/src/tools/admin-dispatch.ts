import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createDispatchTool, createDispatchHandler, type Handler } from './dispatch-utils.js';
import { habitatListWebhooks, habitatCreateWebhook, habitatDeleteWebhook } from './webhook.js';
import { habitatListTemplates, habitatCreateTemplate, habitatDeleteTemplate } from './template.js';
import { habitatBatchAssignTasks, habitatBatchSetTaskPriority, habitatBatchDeleteTasks } from './task-batch.js';
import { adminExportAuditLog, adminGetAuditSummary } from './audit.js';
import { adminListScheduledTasks, adminCreateScheduledTask, adminRunScheduledTask, adminGetScheduledTask, adminUpdateScheduledTask, adminDeleteScheduledTask, adminToggleScheduledTask } from './scheduled-task.js';
import { PRIORITY_LEVELS, WEBHOOK_FORMATS } from './constants.js';

export const ADMIN_DISPATCH_TOOL: Tool = createDispatchTool({
  name: 'orcy_admin',
  description: 'Admin operations: webhooks (list, create, delete), templates (list, create, delete), batch operations (assign-tasks, set-priority, delete-tasks), audit (export-audit-log, get-audit-summary), scheduled tasks (list-scheduled-tasks, create-scheduled-task, run-scheduled-task, get-scheduled-task, update-scheduled-task, delete-scheduled-task, toggle-scheduled-task)',
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
    'list-scheduled-tasks',
    'create-scheduled-task',
    'run-scheduled-task',
    'get-scheduled-task',
    'update-scheduled-task',
    'delete-scheduled-task',
    'toggle-scheduled-task',
  ],
  sharedParams: {
    boardId: { type: 'string', description: 'The UUID of the Orcy habitat (webhooks, templates, batch operations)' },
    name: { type: 'string', description: 'A descriptive name for the webhook/template (action=create-webhook, action=create-template) or scheduled task (action=create-scheduled-task)' },
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
    scheduledTaskId: { type: 'string', description: 'The UUID of the scheduled task (action=run-scheduled-task, action=get-scheduled-task, action=update-scheduled-task, action=delete-scheduled-task, action=toggle-scheduled-task)' },
    scheduleType: { type: 'string', enum: ['once', 'interval', 'cron'], description: 'Schedule type (action=create-scheduled-task, action=update-scheduled-task)' },
    cronExpression: { type: 'string', description: 'Cron expression (action=create-scheduled-task, action=update-scheduled-task)' },
    intervalMinutes: { type: 'number', description: 'Interval in minutes (action=create-scheduled-task, action=update-scheduled-task)' },
    timezone: { type: 'string', description: 'Timezone for the schedule (action=create-scheduled-task, action=update-scheduled-task)' },
    featureTitle: { type: 'string', description: 'Title of the feature to create (action=create-scheduled-task, action=update-scheduled-task)' },
    featureDescription: { type: 'string', description: 'Description of the feature to create (action=create-scheduled-task, action=update-scheduled-task)' },
    featurePriority: { type: 'string', enum: [...PRIORITY_LEVELS], description: 'Priority of the feature (action=create-scheduled-task, action=update-scheduled-task)' },
    featureLabels: {
      type: 'array',
      items: { type: 'string' },
      description: 'Labels for the feature (action=create-scheduled-task, action=update-scheduled-task)',
    },
    featureDomain: { type: 'string', description: 'Domain for the feature (action=create-scheduled-task, action=update-scheduled-task)' },
    tasksTemplate: {
      type: 'array',
      items: { type: 'object' },
      description: 'Task templates for the feature (action=create-scheduled-task, action=update-scheduled-task)',
    },
    enabled: { type: 'boolean', description: 'Enable or disable the scheduled task (action=toggle-scheduled-task)' },
  },
});

export const ADMIN_ACTIONS: Record<string, Handler> = {
  'list-webhooks': habitatListWebhooks,
  'create-webhook': habitatCreateWebhook,
  'delete-webhook': habitatDeleteWebhook,
  'list-templates': habitatListTemplates,
  'create-template': habitatCreateTemplate,
  'delete-template': habitatDeleteTemplate,
  'batch-assign-tasks': habitatBatchAssignTasks,
  'batch-set-priority': habitatBatchSetTaskPriority,
  'batch-delete-tasks': habitatBatchDeleteTasks,
  'export-audit-log': adminExportAuditLog,
  'get-audit-summary': adminGetAuditSummary,
  'list-scheduled-tasks': adminListScheduledTasks,
  'create-scheduled-task': adminCreateScheduledTask,
  'run-scheduled-task': adminRunScheduledTask,
  'get-scheduled-task': adminGetScheduledTask,
  'update-scheduled-task': adminUpdateScheduledTask,
  'delete-scheduled-task': adminDeleteScheduledTask,
  'toggle-scheduled-task': adminToggleScheduledTask,
};

export const ADMIN_DISPATCH_HANDLER = createDispatchHandler(ADMIN_ACTIONS);
