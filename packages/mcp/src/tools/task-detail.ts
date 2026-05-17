import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { KanbanApiClient } from '../api.js';
import type { TaskContext } from '../types.js';
import { enrichTaskWithAgentName, enrichEventsWithActorNames, enrichCommentsWithAuthorNames } from './enrichment.js';
import type { EnrichedTaskEvent, EnrichedComment } from './enrichment.js';

export const BOARD_GET_TASK_CONTEXT_TOOL: Tool = {
  name: 'board_get_task_context',
  description:
    'Get full context for a task including dependencies, dependents, and board state. ' +
    'Use this when you need to understand: what a task depends on, what it blocks, ' +
    'current board status, or previous rejection reasons. ' +
    'Returns rejectionReason if the task was previously rejected and sent back for rework.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The UUID of the task',
      },
    },
    required: ['taskId'],
  },
};

export async function habitatGetTaskContext(
  client: KanbanApiClient,
  args: { taskId: string }
): Promise<TaskContext & { task: EnrichedTaskEvent extends any ? any : never }> {
  const result = await client.getTaskContext(args.taskId);
  const enrichedTask = await enrichTaskWithAgentName(client, result.task);
  return { ...result, task: enrichedTask };
}

export const BOARD_GET_TASK_EVENTS_TOOL: Tool = {
  name: 'board_get_task_events',
  description:
    'Get the event history for a task including all actions, transitions, and audit entries. ' +
    'Returns events sorted by timestamp (newest first).',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The UUID of the task',
      },
      limit: {
        type: 'number',
        description: 'Maximum events to return (default 20, max 200)',
        minimum: 1,
        maximum: 200,
      },
      offset: {
        type: 'number',
        description: 'Number of events to skip (for pagination)',
        minimum: 0,
      },
    },
    required: ['taskId'],
  },
};

export async function habitatGetTaskEvents(
  client: KanbanApiClient,
  args: { taskId: string; limit?: number; offset?: number }
): Promise<{ events: EnrichedTaskEvent[]; total: number }> {
  const result = await client.getTaskEvents(args.taskId, {
    limit: args.limit ?? 20,
    offset: args.offset ?? 0,
  });

  const enrichedEvents = await enrichEventsWithActorNames(client, result.events);
  return { events: enrichedEvents, total: result.total };
}

export const BOARD_GET_TASK_COMMENTS_TOOL: Tool = {
  name: 'board_get_task_comments',
  description:
    'Get comments on a task, sorted newest first. ' +
    'Use this to read human feedback, review notes, or conversation history on a task. ' +
    'Comments are how humans communicate with agents — check them after submission for review feedback. ' +
    'Supports pagination with limit/offset.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The UUID of the task',
      },
      limit: {
        type: 'number',
        description: 'Maximum comments to return (default 50, max 100)',
        minimum: 1,
        maximum: 100,
      },
      offset: {
        type: 'number',
        description: 'Number of comments to skip (for pagination)',
        minimum: 0,
      },
    },
    required: ['taskId'],
  },
};

export async function habitatGetTaskComments(
  client: KanbanApiClient,
  args: { taskId: string; limit?: number; offset?: number }
): Promise<{ comments: EnrichedComment[]; total: number }> {
  const result = await client.getTaskComments(args.taskId, {
    limit: args.limit ?? 50,
    offset: args.offset ?? 0,
  });

  const enrichedComments = await enrichCommentsWithAuthorNames(client, result.comments);
  return { comments: enrichedComments, total: result.total };
}

export const BOARD_ADD_TASK_COMMENT_TOOL: Tool = {
  name: 'board_add_task_comment',
  description:
    'Add a comment to a task. Use this to communicate with humans — ask clarifying questions, ' +
    'provide status updates, or respond to review feedback. ' +
    'Comments are the primary channel for agent-to-human communication. ' +
    'Optionally reply to a specific comment by providing parentId.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The UUID of the task',
      },
      content: {
        type: 'string',
        description: 'Comment text (1-5000 characters)',
        minLength: 1,
        maxLength: 5000,
      },
      parentId: {
        type: 'string',
        description: 'Optional UUID of the parent comment to reply to',
      },
    },
    required: ['taskId', 'content'],
  },
};

export async function habitatAddTaskComment(
  client: KanbanApiClient,
  args: { taskId: string; content: string; parentId?: string }
) {
  return client.addComment(args.taskId, args.content, args.parentId);
}
