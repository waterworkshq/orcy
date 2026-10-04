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
 * Used by recovery agents investigating a failed task. The bundle is served in full to
 * admitted local actors once the captured Habitat matches the Task's current Habitat.
 */
export async function getFailureContext(
  client: KanbanApiClient,
  args: { taskId: string },
): Promise<{ failureContext: Record<string, unknown> }> {
  return client.getTaskFailureContext(args.taskId);
}

/**
 * Reads the upstream and downstream workflow gates for a single task.
 *
 * The served route returns a RESTRICTED projection (ADR-0052): each entry is
 * exactly `{gateType, satisfied, restricted}`. There is no chain navigation,
 * no join semantics, no gate config and no Task/Workflow/Mission/Recovery ids,
 * so this CANNOT determine whether a Task is claimable. Claimability is
 * resolved at the claim mutation, which is the single authority (ADR-0038);
 * every read surface, including this one, is an advisory projection. Callers
 * must not treat `satisfied: false` as "unblocked" and must not treat this
 * projection as a substitute for the claim attempt.
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
    "Returns 404 (Error) if the task has no failure context, and 409 (Error) if the captured " +
    "context belongs to a different Habitat than the task's current Habitat (a data-integrity " +
    "condition, not a permissions problem).",
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
    "Read a RESTRICTED view of the workflow gates around a task: how many gates feed into it " +
    "(upstream) and how many wait on it (downstream), each with only its gate type and whether it " +
    "is satisfied. Gate configuration, join semantics, the connected Task ids and the owning " +
    "workflow are NOT returned, so this is chain awareness only and cannot tell you whether the " +
    "task is claimable — claimability is decided by the claim attempt itself, which is the single " +
    "authority; this projection (like every read) is advisory. " +
    "Returns 404 (Error) if the task is not part of any workflow.",
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
