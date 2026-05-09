import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createDispatchTool, createDispatchHandler, type Handler } from './dispatch-utils.js';
import { boardGetWorktree } from './worktree.js';

export const WORKTREE_DISPATCH_TOOL: Tool = createDispatchTool({
  name: 'orcy_worktree',
  description: 'Get git worktree path for the current task: returns worktree path, branch name, and repo root',
  actions: ['get-worktree'],
  sharedParams: {
    taskId: { type: 'string', description: 'The UUID of the task to get worktree info for' },
  },
});

export const WORKTREE_ACTIONS: Record<string, Handler> = {
  'get-worktree': boardGetWorktree,
};

export const WORKTREE_DISPATCH_HANDLER = createDispatchHandler(WORKTREE_ACTIONS);
