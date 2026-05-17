import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import type { Task, Habitat, Agent } from '../models/index.js';

export interface PluginHookContext {
  task?: Task;
  habitat?: Habitat;
  agent?: Omit<Agent, 'apiKeyHash'>;
  reason?: string;
  eventType?: string;
  data?: unknown;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface KanbanPlugin {
  name: string;
  version: string;
  hooks?: {
    onTaskCreated?: (task: Task, habitat: Habitat | null) => void | Promise<void>;
    onTaskClaimed?: (task: Task, agent: Omit<Agent, 'apiKeyHash'>) => void | Promise<void>;
    onTaskSubmitted?: (task: Task) => void | Promise<void>;
    onTaskApproved?: (task: Task) => void | Promise<void>;
    onTaskRejected?: (task: Task, reason: string) => void | Promise<void>;
    onHabitatCreated?: (habitat: Habitat) => void | Promise<void>;
    onAgentRegistered?: (agent: Omit<Agent, 'apiKeyHash'>) => void | Promise<void>;
    onEvent?: (eventType: string, data: unknown) => void | Promise<void>;
  };
  customRoutes?: FastifyPluginCallback;
  customMcpTools?: McpToolDefinition[];
}

export interface PluginManifest {
  name: string;
  version: string;
  enabled: boolean;
  error?: string;
}
