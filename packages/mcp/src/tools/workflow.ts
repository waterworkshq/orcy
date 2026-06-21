import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KanbanApiClient } from "../api.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type ToolHandler = (client: KanbanApiClient, args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * Reads the most recent unresolved failure context for a task, including the failure bundle
 * (artifacts, lifecycle events, experience signals, retry history, category summary).
 * Used by recovery agents investigating a failed task.
 */
export async function getFailureContext(
  client: KanbanApiClient,
  args: { taskId: string },
): Promise<{ failureContext: Record<string, unknown> }> {
  return client.getTaskFailureContext(args.taskId);
}

/**
 * Reads the upstream and downstream workflow gates for a single task, giving an agent
 * awareness of its place in a workflow chain (what feeds into this task, what waits on it).
 */
export async function getWorkflowContext(
  client: KanbanApiClient,
  args: { taskId: string },
): Promise<{ upstream: Record<string, unknown>[]; downstream: Record<string, unknown>[] }> {
  return client.getTaskWorkflowContext(args.taskId);
}

/** MCP {@link Tool} descriptor for `orcy_get_failure_context`. */
export const WORKFLOW_FAILURE_CONTEXT_TOOL: Tool = {
  name: "orcy_get_failure_context",
  description:
    "Read the failure context bundle for a task — including failure kind, reason, lifecycle events, " +
    "experience signals from the failing agent, retry history, and recovery status. " +
    "Use this when picking up a recovery task to understand what went wrong and why. " +
    "Returns 404 (Error) if the task has no failure context.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The failed task ID to read the failure context for.",
      },
    },
    required: ["taskId"],
  },
};

/** MCP {@link Tool} descriptor for `orcy_get_workflow_context`. */
export const WORKFLOW_CONTEXT_TOOL: Tool = {
  name: "orcy_get_workflow_context",
  description:
    "Read the upstream and downstream workflow gates for a task to understand its place in a " +
    "workflow chain — what tasks feed into this one (and their gate states), and what tasks are " +
    "waiting on this one. Returns 404 (Error) if the task is not part of any workflow.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The task ID to read the workflow context for.",
      },
    },
    required: ["taskId"],
  },
};

/** Wraps a raw handler function into a MCP {@link ToolHandler} that JSON-formats the result and catches errors. */
function wrapHandler(
  fn: (client: KanbanApiClient, args: { taskId: string }) => Promise<unknown>,
): ToolHandler {
  return async (client, args) => {
    const taskId = args["taskId"] as string | undefined;
    if (!taskId) {
      return {
        content: [{ type: "text", text: "Error: taskId is required" }],
        isError: true,
      };
    }
    try {
      const result = await fn(client, { taskId });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  };
}

/** MCP {@link ToolHandler} for `orcy_get_failure_context`. */
export const WORKFLOW_FAILURE_CONTEXT_HANDLER = wrapHandler(getFailureContext);

/** MCP {@link ToolHandler} for `orcy_get_workflow_context`. */
export const WORKFLOW_CONTEXT_HANDLER = wrapHandler(getWorkflowContext);
