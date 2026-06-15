import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KanbanApiClient } from "../api.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * Domain action handler invoked by the dispatch router with a {@link KanbanApiClient} and the parsed tool arguments.
 */
export type Handler<TResult = unknown> = (
  client: KanbanApiClient,
  args: any,
) => TResult | Promise<TResult>;

/** Top-level MCP tool handler returned by {@link createDispatchHandler}; routes an action to its {@link Handler}. */
export type ToolHandler = (client: KanbanApiClient, args: any) => Promise<ToolResult>;

/** Shape of the MCP tool descriptor passed to {@link createDispatchTool}. */
export interface DispatchToolConfig {
  name: string;
  description: string;
  actions: string[];
  sharedParams?: Record<string, unknown>;
  requiredFor?: Record<string, string[]>;
}

/** Builds the MCP {@link Tool} descriptor for a dispatch-backed `orcy_*` tool from its name, description, and action list. */
export function createDispatchTool(config: DispatchToolConfig): Tool {
  return {
    name: config.name,
    description: config.description,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: config.actions,
          description: "The operation to perform",
        },
        ...config.sharedParams,
      },
      required: ["action"],
    },
  };
}

function validateRequired(
  action: string,
  args: Record<string, unknown>,
  requiredFor: Record<string, string[]>,
): string | null {
  const required = requiredFor[action];
  if (!required) return null;
  const missing = required.filter(
    (param) => args[param] === undefined || args[param] === null || args[param] === "",
  );
  if (missing.length === 0) return null;
  return `Action "${action}" is missing required parameters: ${missing.join(", ")}`;
}

const formatResult = (result: unknown): ToolResult => ({
  content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
});

const formatError = (err: unknown): ToolResult => {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
};

/**
 * Wraps an action-name → {@link Handler} map into a single MCP {@link ToolHandler} that validates required args and normalizes results.
 */
export function createDispatchHandler(
  actions: Record<string, Handler<any>>,
  requiredFor?: Record<string, string[]>,
): ToolHandler {
  return async (client, args) => {
    const action = args.action as string;
    const handler = actions[action];
    if (!handler) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Unknown action: ${action}. Valid actions: ${Object.keys(actions).join(", ")}`,
          },
        ],
        isError: true,
      };
    }
    if (requiredFor) {
      const validationError = validateRequired(action, args, requiredFor);
      if (validationError) {
        return {
          content: [{ type: "text" as const, text: validationError }],
          isError: true,
        };
      }
    }
    try {
      const result = await handler(client, args);
      return formatResult(result);
    } catch (err) {
      return formatError(err);
    }
  };
}
