import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { KanbanApiClient } from '../api.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export type Handler = (client: KanbanApiClient, args: any) => any;

export type ToolHandler = (client: KanbanApiClient, args: any) => Promise<ToolResult>;

export interface DispatchToolConfig {
  name: string;
  description: string;
  actions: string[];
  sharedParams?: Record<string, unknown>;
}

export function createDispatchTool(config: DispatchToolConfig): Tool {
  return {
    name: config.name,
    description: config.description,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: config.actions,
          description: 'The operation to perform',
        },
        ...config.sharedParams,
      },
      required: ['action'],
    },
  };
}

const formatResult = (result: unknown): ToolResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
});

export function createDispatchHandler(
  actions: Record<string, Handler>
): ToolHandler {
  return (client, args) => {
    const handler = actions[args.action as string];
    if (!handler) {
      throw new Error(`Unknown action: ${args.action}`);
    }
    return Promise.resolve(handler(client, args)).then(formatResult);
  };
}
