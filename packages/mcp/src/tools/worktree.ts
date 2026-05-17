import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { KanbanApiClient } from '../api.js';

export const BOARD_GET_WORKTREE_TOOL: Tool = {
  name: 'board_get_worktree',
  description:
    'Get the git worktree path for the current task (if worktree integration is enabled). ' +
    'Returns the worktree path, branch name, and repo root. ' +
    'Worktrees are automatically created when an agent claims a task if git_worktree_settings ' +
    'is configured on the board.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The UUID of the task to get worktree info for',
      },
    },
    required: ['taskId'],
  },
};

export async function habitatGetWorktree(
  client: KanbanApiClient,
  args: { taskId: string }
) {
  const result = await client.getWorktree(args.taskId);
  return result;
}
