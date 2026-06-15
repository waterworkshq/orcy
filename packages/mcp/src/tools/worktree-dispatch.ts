import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createDispatchTool, createDispatchHandler, type Handler } from "./dispatch-utils.js";
import { habitatGetWorktree } from "./worktree.js";

/** MCP `Tool` registration schema for git worktree lookup (get-worktree). */
export const WORKTREE_DISPATCH_TOOL: Tool = createDispatchTool({
  name: "orcy_worktree",
  description:
    "Get git worktree path for the current task: returns worktree path, branch name, and repo root",
  actions: ["get-worktree"],
  sharedParams: {
    taskId: { type: "string", description: "The UUID of the task to get worktree info for" },
  },
});

/** Action-name → {@link Handler} map routing each worktree operation to its habitat client implementation. */
export const WORKTREE_ACTIONS: Record<string, Handler> = {
  "get-worktree": habitatGetWorktree,
};

/** Top-level {@link ToolHandler} that routes incoming `orcy_worktree` MCP calls to the matching action. */
export const WORKTREE_DISPATCH_HANDLER = createDispatchHandler(WORKTREE_ACTIONS);
