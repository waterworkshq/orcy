#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  ALL_TOOLS,
  orcyInstructions,
  HABITAT_DISPATCH_HANDLER,
  MISSION_DISPATCH_HANDLER,
  TASK_DISPATCH_HANDLER,
  AGENT_DISPATCH_HANDLER,
  ADMIN_DISPATCH_HANDLER,
  SUGGEST_DISPATCH_HANDLER,
  WORKTREE_DISPATCH_HANDLER,
  MESSAGE_DISPATCH_HANDLER,
  SUBSCRIPTION_DISPATCH_HANDLER,
} from './tools/index.js';
import { KanbanApiClient } from './api.js';
import { setNotificationSender, cleanupAll as cleanupSubscriptions } from './subscriptions.js';
import { logger } from './logger.js';

function resolveApiUrl(): string {
  const explicit = process.env.ORCY_API_URL;
  if (explicit) return explicit;

  const orcyEnvPath = path.join(os.homedir(), '.orcy', '.env');
  try {
    const content = fs.readFileSync(orcyEnvPath, 'utf-8');
    const vars: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) vars[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
    if (vars['ORCY_API_URL']) return vars['ORCY_API_URL'];
    if (vars['HOST'] && vars['PORT']) return `http://${vars['HOST']}:${vars['PORT']}`;
  } catch {}

  return 'http://localhost:3000';
}

const ORCY_API_URL = resolveApiUrl();

const client = new KanbanApiClient(ORCY_API_URL);

const server = new Server(
  {
    name: 'orcy-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ---------------------------------------------------------------------------
// Handler types and helpers
// ---------------------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

type ToolHandler = (client: KanbanApiClient, args: any) => Promise<ToolResult>;

const formatResult = (result: unknown): ToolResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
});

const createHandler = <T extends (client: KanbanApiClient, args: any) => any>(
  fn: T
): ToolHandler => {
  return (client, args) => Promise.resolve(fn(client, args)).then(formatResult);
};

// ---------------------------------------------------------------------------
// Individual non-passthrough handlers
// ---------------------------------------------------------------------------

const handleOrcyInstructions: ToolHandler = () =>
  Promise.resolve({
    content: [{ type: 'text' as const, text: orcyInstructions() }],
  });

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  orcy_instructions: handleOrcyInstructions,
  orcy_habitat: HABITAT_DISPATCH_HANDLER,
  orcy_habitat_mission: MISSION_DISPATCH_HANDLER,
  orcy_habitat_task: TASK_DISPATCH_HANDLER,
  orcy_habitat_agent: AGENT_DISPATCH_HANDLER,
  orcy_admin: ADMIN_DISPATCH_HANDLER,
  orcy_suggest: SUGGEST_DISPATCH_HANDLER,
  orcy_worktree: WORKTREE_DISPATCH_HANDLER,
  orcy_habitat_message: MESSAGE_DISPATCH_HANDLER,
  orcy_habitat_subscription: SUBSCRIPTION_DISPATCH_HANDLER,
};

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: ALL_TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return {
      content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  try {
    const result = await handler(client, args as Record<string, unknown>);
    return result;
  } catch (err) {
    const error = err as Error & { status?: number };
    const isApiError = error.status !== undefined;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              error: error.message ?? 'Unknown error',
              status: error.status ?? 500,
            },
            null,
            2
          ),
        },
      ],
      isError: !isApiError,
    };
  }
});

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();

  setNotificationSender((notification) => {
    server.notification(notification);
  });

  await server.connect(transport);
}

main().catch((err) => {
  logger.error('MCP server error', { err });
  cleanupSubscriptions();
  process.exit(1);
});

process.on('SIGTERM', () => {
  cleanupSubscriptions();
  process.exit(0);
});

process.on('SIGINT', () => {
  cleanupSubscriptions();
  process.exit(0);
});
