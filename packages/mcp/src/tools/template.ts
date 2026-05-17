import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { KanbanApiClient } from '../api.js';
import { PRIORITY_LEVELS } from './constants.js';

export const BOARD_LIST_TEMPLATES_TOOL: Tool = {
  name: 'board_list_templates',
  description:
    'List all task templates for a Kanban board. ' +
    'Templates provide pre-configured task settings for quick task creation.',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'The UUID of the Kanban board',
      },
    },
    required: ['boardId'],
  },
};

export async function habitatListTemplates(
  client: KanbanApiClient,
  args: { boardId: string }
) {
  const result = await client.listTemplates(args.boardId);
  return { templates: result.templates };
}

export const BOARD_CREATE_TEMPLATE_TOOL: Tool = {
  name: 'board_create_template',
  description:
    'Create a new task template for a Kanban board. ' +
    'Templates allow quick task creation with pre-configured title, description, priority, labels, and domain.',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'The UUID of the Kanban board',
      },
      name: {
        type: 'string',
        description: 'A descriptive name for the template',
      },
      titlePattern: {
        type: 'string',
        description: 'Default title pattern for tasks created from this template',
      },
      descriptionPattern: {
        type: 'string',
        description: 'Default description pattern for tasks created from this template',
      },
      priority: {
        type: 'string',
        enum: [...PRIORITY_LEVELS],
        description: 'Default priority for tasks created from this template',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Default labels for tasks created from this template',
      },
      domain: {
        type: 'string',
        description: 'Default required domain for tasks created from this template',
      },
    },
    required: ['boardId', 'name'],
  },
};

export async function habitatCreateTemplate(
  client: KanbanApiClient,
  args: {
    boardId: string;
    name: string;
    titlePattern?: string;
    descriptionPattern?: string;
    priority?: 'low' | 'medium' | 'high' | 'critical';
    labels?: string[];
    domain?: string;
  }
) {
  const result = await client.createTemplate(args.boardId, {
    name: args.name,
    titlePattern: args.titlePattern,
    descriptionPattern: args.descriptionPattern,
    priority: args.priority,
    labels: args.labels,
    requiredDomain: args.domain,
  });
  return { template: result.template };
}

export const BOARD_DELETE_TEMPLATE_TOOL: Tool = {
  name: 'board_delete_template',
  description:
    'Delete a task template by its ID. Deletion is permanent.',
  inputSchema: {
    type: 'object',
    properties: {
      templateId: {
        type: 'string',
        description: 'The UUID of the template to delete',
      },
    },
    required: ['templateId'],
  },
};

export async function habitatDeleteTemplate(
  client: KanbanApiClient,
  args: { templateId: string }
) {
  await client.deleteTemplate(args.templateId);
  return { success: true };
}
