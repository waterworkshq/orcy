import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { KanbanApiClient } from '../api.js';
import type { Task } from '../types.js';
import { enrichTaskWithAgentName } from './enrichment.js';
import { ARTIFACT_SCHEMA_FRAGMENT, TASK_UPDATE_STATUSES } from './constants.js';

export const BOARD_CLAIM_TASK_TOOL: Tool = {
  name: 'board_claim_task',
  description:
    'Atomically claim a task for an agent. Only one agent can claim a task at a time. ' +
    'Prerequisites: Call board_list_features and feature_get_context first to find available work. ' +
    'After claiming, immediately call board_update_task with status="in_progress". ' +
    'Failure reasons: already_claimed (try another task), not_found, domain_mismatch, capability_mismatch (missing required skills), dependencies_unmet. ' +
    'Only one agent can claim a task at a time — concurrent claims are rejected.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The UUID of the task to claim',
      },
    },
    required: ['taskId'],
  },
};

export async function boardClaimTask(
  client: KanbanApiClient,
  args: { taskId: string }
) {
  const result = await client.claimTask(args.taskId);
  if (!result.success) {
    return result;
  }
  const enrichedTask = await enrichTaskWithAgentName(client, result.task);
  return { success: true, task: enrichedTask };
}

export const BOARD_SUBMIT_TASK_TOOL: Tool = {
  name: 'board_submit_task',
  description:
    'Submit completed work for human review. This is the correct endpoint for finished work. ' +
    'Always include: (1) Clear result summary describing what was done, (2) Artifact links (PR, commits, files) if applicable. ' +
    'After submission, the human will either approve or reject. ' +
    'Check board_heartbeat to monitor status while waiting for review.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The UUID of the task to submit',
      },
      result: {
        type: 'string',
        description: 'Summary of what was accomplished (be specific about changes made)',
      },
      artifacts: {
        type: 'array',
        items: ARTIFACT_SCHEMA_FRAGMENT,
        description: 'Links to PRs, commits, files, screenshots, or logs',
      },
    },
    required: ['taskId', 'result'],
  },
};

export async function boardSubmitTask(
  client: KanbanApiClient,
  args: { taskId: string; result: string; artifacts?: { type: string; url: string; description: string }[] }
) {
  return client.submitTask(args.taskId, args.result, args.artifacts as Task['artifacts']);
}

export const BOARD_COMPLETE_TASK_TOOL: Tool = {
  name: 'board_complete_task',
  description:
    'Agent self-approves their submitted task after reviewing the work. ' +
    'Use AFTER calling board_get_task_context, board_get_task_comments, and board_get_task_events ' +
    'to verify the work is complete and review any human feedback. ' +
    'This bypasses human-in-the-loop review and moves the task directly to Done column. ' +
    'Required when: (1) task was rejected and you fixed the issues, (2) you want to advance a submitted task to Done without waiting for human approval.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The UUID of the task to complete',
      },
      reviewNote: {
        type: 'string',
        description: 'Review note describing what was verified',
      },
      artifacts: {
        type: 'array',
        items: ARTIFACT_SCHEMA_FRAGMENT,
        description: 'Optional artifact links to attach at completion',
      },
    },
    required: ['taskId'],
  },
};

export async function boardCompleteTask(
  client: KanbanApiClient,
  args: { taskId: string; reviewNote?: string; artifacts?: { type: string; url: string; description: string }[] }
) {
  return client.completeTask(args.taskId, args.reviewNote, args.artifacts as Task['artifacts']);
}

export const BOARD_RELEASE_TASK_TOOL: Tool = {
  name: 'board_release_task',
  description:
    'Release a claimed task back to the pending pool. ' +
    'Use when you cannot complete the task and need to return it to the queue. ' +
    'Always provide a clear reason: blocked_by_dependency, requires_domain_expertise, external_blocker, etc. ' +
    'After releasing, call board_list_features to find alternative work.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The UUID of the task to release',
      },
      reason: {
        type: 'string',
        description: 'Why the task is being released',
      },
    },
    required: ['taskId', 'reason'],
  },
};

export async function boardReleaseTask(
  client: KanbanApiClient,
  args: { taskId: string; reason: string }
) {
  return client.releaseTask(args.taskId, args.reason);
}

export const BOARD_RETRY_TASK_TOOL: Tool = {
  name: 'board_retry_task',
  description:
    'Manually retry a failed task, resetting it to pending status so it can be reclaimed. ' +
    'Use when a task has failed but the underlying issue has been resolved and you want to give it another attempt. ' +
    'Only works on tasks currently in failed status.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The UUID of the failed task to retry',
      },
    },
    required: ['taskId'],
  },
};

export async function boardRetryTask(
  client: KanbanApiClient,
  args: { taskId: string }
) {
  return client.retryTask(args.taskId);
}
