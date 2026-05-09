import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { KanbanApiClient } from '../api.js';
import { PRIORITY_LEVELS, FEATURE_STATUSES } from './constants.js';

export const HABITAT_CREATE_MISSION_TOOL: Tool = {
  name: 'habitat_create_mission',
  description:
    'Create a new mission in a habitat. Missions are the top-level work items that flow through habitat columns. ' +
    'Add tasks within missions using mission_create_task.',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'Habitat ID',
      },
      title: {
        type: 'string',
        description: 'Mission title',
      },
      description: {
        type: 'string',
        description: 'Mission description — the "brief" that provides context for all tasks within this mission',
      },
      acceptanceCriteria: {
        type: 'string',
        description: 'What defines this mission as complete',
      },
      priority: {
        type: 'string',
        enum: [...PRIORITY_LEVELS],
        description: 'Mission priority (default: medium)',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Labels to categorize the mission',
      },
      dependsOn: {
        type: 'array',
        items: { type: 'string' },
        description: 'Mission IDs this mission depends on',
      },
      dueAt: {
        type: 'string',
        description: 'ISO 8601 deadline for the mission',
      },
      slaMinutes: {
        type: 'number',
        description: 'Service-level agreement in minutes (triggers escalation if mission is not done by deadline = createdAt + slaMinutes)',
      },
      blocks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Mission IDs that this mission blocks',
      },
    },
    required: ['boardId', 'title'],
  },
};

export async function habitatCreateMission(
  client: KanbanApiClient,
  args: {
    boardId: string;
    title: string;
    description?: string;
    acceptanceCriteria?: string;
    priority?: 'low' | 'medium' | 'high' | 'critical';
    labels?: string[];
    dependsOn?: string[];
    dueAt?: string;
    slaMinutes?: number;
    blocks?: string[];
  }
) {
  const result = await client.createFeature(args.boardId, {
    title: args.title,
    description: args.description,
    acceptanceCriteria: args.acceptanceCriteria,
    priority: args.priority,
    labels: args.labels,
    dependsOn: args.dependsOn,
    dueAt: args.dueAt,
    slaMinutes: args.slaMinutes,
    blocks: args.blocks,
  });
  return { feature: result.feature };
}

export const HABITAT_LIST_MISSIONS_TOOL: Tool = {
  name: 'habitat_list_missions',
  description:
    'List missions in a habitat with progress information. Missions are the habitat cards; tasks live inside missions.',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'Habitat ID',
      },
      status: {
        type: 'string',
        enum: [...FEATURE_STATUSES],
        description: 'Filter by mission status',
      },
      priority: {
        type: 'string',
        enum: [...PRIORITY_LEVELS],
        description: 'Filter by priority',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of missions to return (default: 20)',
      },
      isArchived: {
        type: 'boolean',
        description: 'Set to true to retrieve archived missions instead of active ones (default: false)',
      },
    },
    required: ['boardId'],
  },
};

export async function habitatListMissions(
  client: KanbanApiClient,
  args: { boardId: string; status?: string; priority?: string; limit?: number; isArchived?: boolean }
) {
  return client.listFeatures(args.boardId, {
    status: args.status,
    priority: args.priority,
    limit: args.limit,
    isArchived: args.isArchived,
  });
}

export const MISSION_LIST_TASKS_TOOL: Tool = {
  name: 'mission_list_tasks',
  description:
    'List all tasks within a mission. Tasks are the work units that agents claim and complete.',
  inputSchema: {
    type: 'object',
    properties: {
      featureId: {
        type: 'string',
        description: 'Mission ID',
      },
    },
    required: ['featureId'],
  },
};

export async function missionListTasks(
  client: KanbanApiClient,
  args: { featureId: string }
) {
  return client.listTasksInFeature(args.featureId);
}

export const MISSION_CREATE_TASK_TOOL: Tool = {
  name: 'mission_create_task',
  description:
    'Create a task within a mission. Tasks are implementation steps that agents claim, work on, and submit.',
  inputSchema: {
    type: 'object',
    properties: {
      featureId: {
        type: 'string',
        description: 'Parent mission ID',
      },
      title: {
        type: 'string',
        description: 'Task title',
      },
      description: {
        type: 'string',
        description: 'Detailed description with context and expected behavior',
      },
      priority: {
        type: 'string',
        enum: [...PRIORITY_LEVELS],
        description: 'Task priority (default: medium)',
      },
      requiredDomain: {
        type: 'string',
        description: 'Domain filter: frontend, backend, devops, testing, or fullstack',
      },
      requiredCapabilities: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required capabilities (e.g., ["typescript", "react"])',
      },
      estimatedMinutes: {
        type: 'number',
        description: 'Estimated time to complete in minutes',
      },
    },
    required: ['featureId', 'title'],
  },
};

export async function missionCreateTask(
  client: KanbanApiClient,
  args: {
    featureId: string;
    title: string;
    description?: string;
    priority?: 'low' | 'medium' | 'high' | 'critical';
    requiredDomain?: string | null;
    requiredCapabilities?: string[];
    estimatedMinutes?: number;
  }
) {
  const result = await client.createTaskInFeature(args.featureId, {
    title: args.title,
    description: args.description,
    priority: args.priority,
    requiredDomain: args.requiredDomain,
    requiredCapabilities: args.requiredCapabilities,
    estimatedMinutes: args.estimatedMinutes,
  });
  return { task: result.task };
}

export const MISSION_GET_CONTEXT_TOOL: Tool = {
  name: 'mission_get_context',
  description:
    'Get full mission context including description, acceptance criteria, all task statuses, and completed task results. ' +
    'Use this to understand the mission before claiming a task.',
  inputSchema: {
    type: 'object',
    properties: {
      featureId: {
        type: 'string',
        description: 'Mission ID',
      },
    },
    required: ['featureId'],
  },
};

export async function missionGetContext(
  client: KanbanApiClient,
  args: { featureId: string }
) {
  return client.getFeatureContext(args.featureId);
}

export const HABITAT_DELETE_MISSION_TOOL: Tool = {
  name: 'habitat_delete_mission',
  description:
    'Delete a mission and all its tasks. This action is permanent and cannot be undone.',
  inputSchema: {
    type: 'object',
    properties: {
      featureId: {
        type: 'string',
        description: 'Mission ID to delete',
      },
    },
    required: ['featureId'],
  },
};

export async function habitatDeleteMission(
  client: KanbanApiClient,
  args: { featureId: string }
) {
  await client.deleteFeature(args.featureId);
  return { success: true, featureId: args.featureId, message: `Mission ${args.featureId} deleted` };
}

export const HABITAT_LIST_ARCHIVED_MISSIONS_TOOL: Tool = {
  name: 'habitat_list_archived_missions',
  description:
    'List all archived missions in a habitat. Archived missions are completed work items that are hidden from the main habitat.',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'Habitat ID',
      },
    },
    required: ['boardId'],
  },
};

export async function habitatListArchivedMissions(
  client: KanbanApiClient,
  args: { boardId: string }
) {
  return client.listFeatures(args.boardId, {
    isArchived: true,
  });
}

export const MISSION_ARCHIVE_TOOL: Tool = {
  name: 'mission_archive',
  description:
    'Archive a completed mission. This removes it from the main habitat while keeping its metrics intact. Mission must have status=done.',
  inputSchema: {
    type: 'object',
    properties: {
      featureId: {
        type: 'string',
        description: 'Mission ID to archive',
      },
    },
    required: ['featureId'],
  },
};

export async function missionArchive(
  client: KanbanApiClient,
  args: { featureId: string }
) {
  const result = await client.archiveFeature(args.featureId);
  return { success: true, feature: result.feature };
}

export const MISSION_UNARCHIVE_TOOL: Tool = {
  name: 'mission_unarchive',
  description:
    'Unarchive a previously archived mission. This returns it to the main habitat in the done column.',
  inputSchema: {
    type: 'object',
    properties: {
      featureId: {
        type: 'string',
        description: 'Mission ID to unarchive',
      },
    },
    required: ['featureId'],
  },
};

export async function missionUnarchive(
  client: KanbanApiClient,
  args: { featureId: string }
) {
  const result = await client.unarchiveFeature(args.featureId);
  return { success: true, feature: result.feature };
}
