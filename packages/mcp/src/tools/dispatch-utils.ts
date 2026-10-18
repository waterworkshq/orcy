import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KanbanApiClient } from "../api.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * Generic tool handler. Uses KanbanApiClient because dispatch handlers
 * route to domain-specific implementations at runtime.
 */
export type Handler<TResult = unknown> = (
  client: KanbanApiClient,
  args: any,
) => TResult | Promise<TResult>;

/**
 * Generic tool handler. Uses KanbanApiClient because dispatch handlers
 * route to domain-specific implementations at runtime.
 */
export type ToolHandler = (client: KanbanApiClient, args: any) => Promise<ToolResult>;

/** Shape of the MCP tool descriptor passed to {@link createDispatchTool}. */
export interface DispatchToolConfig {
  name: string;
  description: string;
  actions: string[];
  sharedParams?: Record<string, unknown>;
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
  if (!Object.hasOwn(requiredFor, action)) return null;
  const required = requiredFor[action];
  if (!Array.isArray(required) || !Array.from(required).every((param) => typeof param === "string")) {
    throw new Error(`Invalid required parameters for action: ${action}`);
  }
  const missing = required.filter(
    (param) => {
      if (param === "habitatId" && args["boardId"] !== undefined && args["boardId"] !== null && args["boardId"] !== "") {
        return false;
      }
      return args[param] === undefined || args[param] === null || args[param] === "";
    },
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
    try {
      if (args === null || typeof args !== "object" || Array.isArray(args)) {
        return { content: [{ type: "text", text: "Arguments must be an object." }], isError: true };
      }
      const action = args.action;
      if (typeof action !== "string") {
        const message = action === undefined ? "Unknown action: undefined." : "Action must be a string.";
        return {
          content: [{ type: "text", text: `${message} Valid actions: ${Object.keys(actions).join(", ")}` }],
          isError: true,
        };
      }
      const handler = Object.hasOwn(actions, action) ? actions[action] : undefined;
      if (typeof handler !== "function") {
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
      const result = await handler(client, args);
      return formatResult(result);
    } catch (err) {
      return formatError(err);
    }
  };
}
