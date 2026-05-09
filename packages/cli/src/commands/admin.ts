import { api } from '../client.js';

export function registerAdminCommands(program: any) {
  const admin = program.command('admin').description('Admin operations (webhooks, templates, batch)');

  admin.command('list-webhooks')
    .description('List webhooks on a board')
    .argument('<boardId>', 'Habitat UUID')
    .action(async (boardId: string) => {
      const result = await api.get<any>(`/api/boards/${boardId}/webhooks`);
      console.log(JSON.stringify(result, null, 2));
    });

  admin.command('create-webhook')
    .description('Create a webhook on a board')
    .argument('<boardId>', 'Habitat UUID')
    .argument('<name>', 'Webhook name')
    .argument('<url>', 'Webhook URL')
    .option('--events <events>', 'Comma-separated event types (e.g., task.created,task.completed)')
    .option('--format <format>', 'Payload format: standard, slack, discord', 'standard')
    .action(async (boardId: string, name: string, url: string, options: { events?: string; format: string }) => {
      const body: Record<string, any> = { name, url, format: options.format };
      if (options.events) body.events = options.events.split(',').map((s: string) => s.trim());
      const result = await api.post<any>(`/api/boards/${boardId}/webhooks`, body);
      console.log(JSON.stringify(result, null, 2));
    });

  admin.command('delete-webhook')
    .description('Delete a webhook')
    .argument('<webhookId>', 'Webhook UUID')
    .action(async (webhookId: string) => {
      await api.delete(`/api/webhooks/${webhookId}`);
      console.log(JSON.stringify({ success: true }, null, 2));
    });

  admin.command('list-templates')
    .description('List templates on a board')
    .argument('<boardId>', 'Habitat UUID')
    .action(async (boardId: string) => {
      const result = await api.get<any>(`/api/boards/${boardId}/templates`);
      console.log(JSON.stringify(result, null, 2));
    });

  admin.command('create-template')
    .description('Create a template on a board')
    .argument('<boardId>', 'Habitat UUID')
    .argument('<name>', 'Template name')
    .option('--title-pattern <pattern>', 'Default title pattern')
    .option('--description-pattern <pattern>', 'Default description pattern')
    .option('--priority <priority>', 'Default priority')
    .option('--labels <labels>', 'Comma-separated default labels')
    .option('--domain <domain>', 'Default required domain')
    .action(async (boardId: string, name: string, options: any) => {
      const body: Record<string, any> = { name };
      if (options.titlePattern) body.titlePattern = options.titlePattern;
      if (options.descriptionPattern) body.descriptionPattern = options.descriptionPattern;
      if (options.priority) body.priority = options.priority;
      if (options.labels) body.labels = options.labels.split(',').map((s: string) => s.trim());
      if (options.domain) body.domain = options.domain;
      const result = await api.post<any>(`/api/boards/${boardId}/templates`, body);
      console.log(JSON.stringify(result, null, 2));
    });

  admin.command('delete-template')
    .description('Delete a template')
    .argument('<templateId>', 'Template UUID')
    .action(async (templateId: string) => {
      await api.delete(`/api/templates/${templateId}`);
      console.log(JSON.stringify({ success: true }, null, 2));
    });

  admin.command('batch-assign-tasks')
    .description('Batch assign tasks to an agent')
    .argument('<boardId>', 'Habitat UUID')
    .argument('<taskIds>', 'Comma-separated task UUIDs')
    .argument('<agentId>', 'Agent UUID')
    .action(async (boardId: string, taskIds: string, agentId: string) => {
      const ids = taskIds.split(',').map((s: string) => s.trim());
      const result = await api.post<any>(`/api/boards/${boardId}/tasks/batch`, {
        taskIds: ids,
        operation: 'assign',
        payload: { assignedAgentId: agentId },
      });
      console.log(JSON.stringify(result, null, 2));
    });

  admin.command('batch-set-priority')
    .description('Batch set task priority')
    .argument('<boardId>', 'Habitat UUID')
    .argument('<taskIds>', 'Comma-separated task UUIDs')
    .argument('<priority>', 'New priority: low, medium, high, critical')
    .action(async (boardId: string, taskIds: string, priority: string) => {
      const ids = taskIds.split(',').map((s: string) => s.trim());
      const result = await api.post<any>(`/api/boards/${boardId}/tasks/batch`, {
        taskIds: ids,
        operation: 'priority',
        payload: { priority },
      });
      console.log(JSON.stringify(result, null, 2));
    });

  admin.command('batch-delete-tasks')
    .description('Batch delete tasks')
    .argument('<boardId>', 'Habitat UUID')
    .argument('<taskIds>', 'Comma-separated task UUIDs')
    .action(async (boardId: string, taskIds: string) => {
      const ids = taskIds.split(',').map((s: string) => s.trim());
      const result = await api.post<any>(`/api/boards/${boardId}/tasks/batch`, {
        taskIds: ids,
        operation: 'delete',
        payload: {},
      });
      console.log(JSON.stringify(result, null, 2));
    });
}
