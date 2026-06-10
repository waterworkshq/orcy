import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KanbanApiClient } from "../api.js";
import type { AgentClient } from "../api/interfaces.js";
import type { Agent } from "@orcy/shared";
import { AGENT_STATUSES, AGENT_TYPES } from "./constants.js";

export const BOARD_REGISTER_AGENT_TOOL: Tool = {
  name: "board_register_agent",
  description:
    "Register a new AI agent with the Orcy platform. " +
    "Returns the agent details and API key — these MUST be configured in your " +
    "MCP server environment (ORCY_AGENT_ID and ORCY_API_KEY) before " +
    "using any other tools. The API key is shown only once. " +
    "Store the API key securely — it cannot be retrieved again.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: 'Unique name for the agent (e.g., "coding-agent-1")',
      },
      type: {
        type: "string",
        enum: [...AGENT_TYPES],
        description: "The type of AI agent",
      },
      domain: {
        type: "string",
        description: "Primary domain: frontend, backend, devops, testing, or fullstack",
      },
      capabilities: {
        type: "string",
        description: 'Comma-separated capabilities (e.g., "typescript, react, postgresql")',
      },
    },
    required: ["name", "type", "domain"],
  },
};

export async function habitatRegisterAgent(
  client: KanbanApiClient,
  args: {
    name: string;
    type: "claude-code" | "codex" | "opencode" | "cursor" | "gemini";
    domain: string;
    capabilities?: string;
  },
) {
  const input = {
    name: args.name,
    type: args.type,
    domain: args.domain,
    capabilities: args.capabilities ? args.capabilities.split(",").map((c) => c.trim()) : [],
  };
  const result = await client.registerAgent(input);
  return {
    success: true,
    agentId: result.agent.id,
    name: result.agent.name,
    apiKey: result.apiKey,
    message: `Agent "${result.agent.name}" registered successfully. Your API key is provided in the structured apiKey field above — store it securely now as it cannot be retrieved again. Configure ORCY_AGENT_ID=${result.agent.id} and ORCY_API_KEY with the key shown above in your MCP server environment.`,
  };
}

export const BOARD_LIST_AGENTS_TOOL: Tool = {
  name: "board_list_agents",
  description:
    "List all registered agents with their current task titles. " +
    "Returns agents with their status, domain, capabilities, and the title of their current task if any. " +
    "Optionally filter by status or domain.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: [...AGENT_STATUSES],
        description: "Filter by agent status",
      },
      domain: {
        type: "string",
        description: "Filter by agent domain (e.g., frontend, backend, devops)",
      },
    },
  },
};

export async function habitatListAgents(
  client: KanbanApiClient,
  args: { status?: string; domain?: string },
) {
  const result = await client.listAgents({
    status: args.status,
    domain: args.domain,
    include: "currentTask",
  });
  const agents = result.agents as Array<{ agent: Agent; currentTaskTitle: string | null }>;
  return {
    agents: agents.map((a) => ({
      id: a.agent.id,
      name: a.agent.name,
      type: a.agent.type,
      domain: a.agent.domain,
      capabilities: a.agent.capabilities,
      status: a.agent.status,
      currentTaskTitle: a.currentTaskTitle,
      lastHeartbeat: a.agent.lastHeartbeat,
    })),
  };
}

export const BOARD_HEARTBEAT_TOOL: Tool = {
  name: "board_heartbeat",
  description:
    "Signal the agent is still alive and working. " +
    "Call every 5 minutes while holding a task to prevent silence detection. " +
    "Tasks idle for more than 30 minutes without a heartbeat are automatically released. " +
    "Returns next recommended check-in interval and current task status. " +
    "Can be called without taskId when idle (omit the field entirely).",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The UUID of the task currently being worked on",
      },
      progress: {
        type: "string",
        description: "Brief description of current progress",
      },
    },
  },
};

export async function habitatHeartbeat(
  client: KanbanApiClient,
  args: { taskId?: string; progress?: string },
) {
  return client.heartbeat(args.taskId, args.progress);
}

export const BOARD_GET_MY_STATS_TOOL: Tool = {
  name: "board_get_my_stats",
  description:
    "Get the calling agent's own performance statistics. " +
    "Returns completed count, failed count, average cycle time, rejection rate, throughput, and streak. " +
    "Uses the agent's configured credentials to determine identity.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export async function habitatGetMyStats(client: KanbanApiClient, _args: Record<string, never>) {
  const agentResp = await client.getAgent();
  const statsResp = await client.getAgentStats(agentResp.agent.id);
  return { agentId: agentResp.agent.id, stats: statsResp.stats };
}
