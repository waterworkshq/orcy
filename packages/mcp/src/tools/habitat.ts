import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { KanbanApiClient } from '../api.js';
import { TIME_RANGES } from './constants.js';

export const HABITAT_LIST_HABITATS_TOOL: Tool = {
  name: 'habitat_list_habitats',
  description:
    'List all available Orcy habitats. Use this to discover habitat IDs before listing missions ' +
    'or creating new missions. Returns all habitats with their IDs, names, and descriptions.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export async function habitatListHabitats(
  client: KanbanApiClient,
  _args: Record<string, never>
) {
  const result = await client.listBoards();
  return { boards: result.boards.map(b => ({ id: b.id, name: b.name, description: b.description })) };
}

export const HABITAT_FIND_TOOL: Tool = {
  name: 'habitat_find',
  description:
    'Find a habitat by name. Searches all habitats and returns matching ones with their IDs. ' +
    'Use this when a user refers to a habitat by name instead of ID. ' +
    'Performs case-insensitive partial matching on habitat names.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The habitat name or partial name to search for',
      },
    },
    required: ['name'],
  },
};

export async function habitatFind(
  client: KanbanApiClient,
  args: { name: string }
) {
  const result = await client.listBoards(args.name);
  return { boards: result.boards.map(b => ({ id: b.id, name: b.name, description: b.description })) };
}

export const HABITAT_GET_SETTINGS_TOOL: Tool = {
  name: 'habitat_get_settings',
  description:
    'Get the settings and metadata for an Orcy habitat. ' +
    'Returns habitat name, description, columns, and other configuration.',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'The UUID of the Orcy habitat',
      },
    },
    required: ['boardId'],
  },
};

export async function habitatGetSettings(
  client: KanbanApiClient,
  args: { boardId: string }
) {
  return client.getBoardSettings(args.boardId);
}

export const HABITAT_UPDATE_SETTINGS_TOOL: Tool = {
  name: 'habitat_update_settings',
  description:
    'Update the editable settings for an Orcy habitat. ' +
    'Only name and description can be changed through this tool.',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'The UUID of the Orcy habitat',
      },
      name: {
        type: 'string',
        description: 'Updated habitat name',
      },
      description: {
        type: 'string',
        description: 'Updated habitat description',
      },
    },
    required: ['boardId'],
  },
};

export async function habitatUpdateSettings(
  client: KanbanApiClient,
  args: { boardId: string; name?: string; description?: string }
) {
  return client.updateBoardSettings(args.boardId, {
    name: args.name,
    description: args.description,
  });
}

export const HABITAT_GET_SUMMARY_TOOL: Tool = {
  name: 'habitat_get_summary',
  description:
    'Get a temporal summary of habitat activity — what was done, by whom, when, and in what order. ' +
    'Returns a compact digest with task lifecycle narratives, metrics, and current habitat state. ' +
    'Use this FIRST when you need to understand what work has been done in a habitat, ' +
    'instead of listing and inspecting missions individually. ' +
    'Each task narrative shows the full lifecycle: Created → Claimed → Started → Submitted → Approved/Rejected → Done. ' +
    'The digest field contains a pre-formatted markdown summary ready for context.',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'The UUID of the Orcy habitat',
      },
      since: {
        type: 'string',
        enum: [...TIME_RANGES],
        description: 'Time range for activity (default: 7d)',
      },
      maxTasks: {
        type: 'number',
        description: 'Maximum number of task narratives to return (default: 20, max: 50)',
        minimum: 1,
        maximum: 50,
      },
      includeDigest: {
        type: 'boolean',
        description: 'Whether to include the pre-formatted markdown digest (default: true)',
      },
    },
    required: ['boardId'],
  },
};

export async function habitatGetSummary(
  client: KanbanApiClient,
  args: { boardId: string; since?: '24h' | '7d' | '30d' | 'all'; maxTasks?: number; includeDigest?: boolean }
) {
  return client.getBoardSummary(args.boardId, {
    since: args.since,
    maxTasks: args.maxTasks,
    includeDigest: args.includeDigest,
  });
}
