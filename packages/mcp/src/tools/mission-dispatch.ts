import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createDispatchTool, createDispatchHandler, type Handler } from './dispatch-utils.js';
import {
  habitatListMissions,
  habitatCreateMission,
  habitatDeleteMission,
  missionArchive,
  missionUnarchive,
  missionGetContext,
  missionGetComments,
  missionAddComment,
} from './mission.js';
import { PRIORITY_LEVELS } from './constants.js';

export const MISSION_DISPATCH_TOOL: Tool = createDispatchTool({
  name: 'orcy_habitat_mission',
  description: 'Mission operations: list (with optional isArchived), create, delete, archive, unarchive, get-context, get-comments, add-comment',
  actions: ['list', 'create', 'delete', 'archive', 'unarchive', 'get-context', 'get-comments', 'add-comment'],
  sharedParams: {
    boardId: { type: 'string', description: 'Habitat UUID (used with action=list, action=create)' },
    featureId: { type: 'string', description: 'Mission UUID (used with action=delete, action=archive, action=unarchive, action=get-context)' },
    title: { type: 'string', description: 'Mission title (action=create)' },
    description: { type: 'string', description: 'Mission description (action=create)' },
    acceptanceCriteria: { type: 'string', description: 'What defines completion (action=create)' },
    priority: {
      type: 'string',
      enum: [...PRIORITY_LEVELS],
      description: 'Mission priority (action=create)',
    },
    labels: { type: 'array', items: { type: 'string' }, description: 'Labels to categorize the mission (action=create)' },
    dependsOn: { type: 'array', items: { type: 'string' }, description: 'Mission IDs this mission depends on (action=create)' },
    dueAt: { type: 'string', description: 'ISO 8601 deadline (action=create)' },
    slaMinutes: { type: 'number', description: 'Service-level agreement in minutes (action=create)' },
    blocks: { type: 'array', items: { type: 'string' }, description: 'Mission IDs that this mission blocks (action=create)' },
    isArchived: { type: 'boolean', description: 'Set to true to list archived missions instead of active ones (action=list)' },
    status: {
      type: 'string',
      description: 'Filter by mission status (action=list)',
    },
    limit: { type: 'number', description: 'Maximum number of missions to return (action=list)' },
    content: { type: 'string', description: 'Comment text (action=add-comment)' },
    parentId: { type: 'string', description: 'Optional parent comment UUID to reply to (action=add-comment)' },
  },
});

export const MISSION_ACTIONS: Record<string, Handler> = {
  'list': habitatListMissions,
  'create': habitatCreateMission,
  'delete': habitatDeleteMission,
  'archive': missionArchive,
  'unarchive': missionUnarchive,
  'get-context': missionGetContext,
  'get-comments': missionGetComments,
  'add-comment': missionAddComment,
};

export const MISSION_DISPATCH_HANDLER = createDispatchHandler(MISSION_ACTIONS);
