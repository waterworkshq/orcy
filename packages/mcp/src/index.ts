#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  ALL_TOOLS,
  orcyInstructions,
  orcyPulseInstructions,
  HABITAT_DISPATCH_HANDLER,
  MISSION_DISPATCH_HANDLER,
  TASK_DISPATCH_HANDLER,
  AGENT_DISPATCH_HANDLER,
  SUGGEST_DISPATCH_HANDLER,
  WORKTREE_DISPATCH_HANDLER,
  MESSAGE_DISPATCH_HANDLER,
  PULSE_DISPATCH_HANDLER,
  SUBSCRIPTION_DISPATCH_HANDLER,
  REVIEW_DISPATCH_HANDLER,
  SPRINT_DISPATCH_HANDLER,
  HABITAT_SKILL_DISPATCH_HANDLER,
  NOTIFICATION_DISPATCH_HANDLER,
  AUTOMATION_DISPATCH_HANDLER,
  WORKFLOW_FAILURE_CONTEXT_HANDLER,
  WORKFLOW_CONTEXT_HANDLER,
} from "./tools/index.js";
import { KanbanApiClient } from "./api.js";
import { setNotificationSender, cleanupAll as cleanupSubscriptions } from "./subscriptions.js";
import { getOrcyConfig } from "@orcy/shared";
import { logger } from "./logger.js";

const ORCY_API_URL = getOrcyConfig().apiUrl;

const client = new KanbanApiClient(ORCY_API_URL);

const server = new Server(
  {
    name: "orcy-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// ---------------------------------------------------------------------------
// Handler types and helpers
// ---------------------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type ToolHandler = (client: KanbanApiClient, args: any) => Promise<ToolResult>;

// ---------------------------------------------------------------------------
// Individual non-passthrough handlers
// ---------------------------------------------------------------------------

const handleOrcyInstructions: ToolHandler = () =>
  Promise.resolve({
    content: [{ type: "text" as const, text: orcyInstructions() }],
  });

const handleOrcyPulseInstructions: ToolHandler = () =>
  Promise.resolve({
    content: [{ type: "text" as const, text: orcyPulseInstructions() }],
  });

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  orcy_instructions: handleOrcyInstructions,
  orcy_pulse_instructions: handleOrcyPulseInstructions,
  orcy_habitat: HABITAT_DISPATCH_HANDLER,
  orcy_habitat_mission: MISSION_DISPATCH_HANDLER,
  orcy_habitat_task: TASK_DISPATCH_HANDLER,
  orcy_habitat_agent: AGENT_DISPATCH_HANDLER,
  orcy_suggest: SUGGEST_DISPATCH_HANDLER,
  orcy_worktree: WORKTREE_DISPATCH_HANDLER,
  orcy_habitat_message: MESSAGE_DISPATCH_HANDLER,
  orcy_pulse: PULSE_DISPATCH_HANDLER,
  orcy_habitat_subscription: SUBSCRIPTION_DISPATCH_HANDLER,
  orcy_review: REVIEW_DISPATCH_HANDLER,
  orcy_sprint: SPRINT_DISPATCH_HANDLER,
  orcy_habitat_skill: HABITAT_SKILL_DISPATCH_HANDLER,
  orcy_notification: NOTIFICATION_DISPATCH_HANDLER,
  orcy_automation: AUTOMATION_DISPATCH_HANDLER,
  orcy_get_failure_context: WORKFLOW_FAILURE_CONTEXT_HANDLER,
  orcy_get_workflow_context: WORKFLOW_CONTEXT_HANDLER,
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
      content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  try {
    const action =
      typeof (args as Record<string, unknown>).action === "string"
        ? ((args as Record<string, unknown>).action as string)
        : undefined;
    const result = await client.withAuditToolContext(name, action, () =>
      handler(client, args as Record<string, unknown>),
    );
    return result;
  } catch (err) {
    const error = err as Error & { status?: number };
    const isApiError = error.status !== undefined;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              error: error.message ?? "Unknown error",
              status: error.status ?? 500,
            },
            null,
            2,
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
  logger.error("MCP server error", { err });
  cleanupSubscriptions();
  process.exit(1);
});

process.on("SIGTERM", () => {
  cleanupSubscriptions();
  process.exit(0);
});

process.on("SIGINT", () => {
  cleanupSubscriptions();
  process.exit(0);
});
