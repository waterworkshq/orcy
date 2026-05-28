import type { AdapterConfig, CliType } from "../types.js";

const adapters: Map<CliType, AdapterConfig> = new Map();

function register(adapter: AdapterConfig): void {
  adapters.set(adapter.type, adapter);
}

register({
  type: "claude-code",
  bin: "claude",
  buildArgs(taskId: string, taskTitle: string, _workdir: string): string[] {
    return [
      "--print",
      `Work on task "${taskTitle}" (ID: ${taskId}). Read AGENTS.md first if present. Follow the task lifecycle: claim, implement, submit.`,
    ];
  },
  buildEnv(agentApiKey: string, agentId: string, apiUrl: string): Record<string, string> {
    return {
      ORCY_API_URL: apiUrl,
      ORCY_AGENT_ID: agentId,
      ORCY_API_KEY: agentApiKey,
    };
  },
  parseOutput(chunk: string): string | null {
    const trimmed = chunk.trim();
    if (!trimmed) return null;
    return trimmed;
  },
  supportsResume(_version: string | null): boolean {
    return false;
  },
});

register({
  type: "codex",
  bin: "codex",
  buildArgs(taskId: string, taskTitle: string, _workdir: string): string[] {
    return [
      "--quiet",
      `Work on task "${taskTitle}" (ID: ${taskId}). Read AGENTS.md first if present. Follow the task lifecycle: claim, implement, submit.`,
    ];
  },
  buildEnv(agentApiKey: string, agentId: string, apiUrl: string): Record<string, string> {
    return {
      ORCY_API_URL: apiUrl,
      ORCY_AGENT_ID: agentId,
      ORCY_API_KEY: agentApiKey,
    };
  },
  parseOutput(chunk: string): string | null {
    const trimmed = chunk.trim();
    if (!trimmed) return null;
    return trimmed;
  },
  supportsResume(_version: string | null): boolean {
    return false;
  },
});

register({
  type: "opencode",
  bin: "opencode",
  buildArgs(taskId: string, taskTitle: string, _workdir: string): string[] {
    return [
      "--task",
      `${taskTitle} (ID: ${taskId}). Read AGENTS.md first if present. Follow the task lifecycle: claim, implement, submit.`,
    ];
  },
  buildEnv(agentApiKey: string, agentId: string, apiUrl: string): Record<string, string> {
    return {
      ORCY_API_URL: apiUrl,
      ORCY_AGENT_ID: agentId,
      ORCY_API_KEY: agentApiKey,
    };
  },
  parseOutput(chunk: string): string | null {
    const trimmed = chunk.trim();
    if (!trimmed) return null;
    return trimmed;
  },
  supportsResume(_version: string | null): boolean {
    return false;
  },
});

register({
  type: "cursor",
  bin: "cursor-agent",
  buildArgs(taskId: string, taskTitle: string, _workdir: string): string[] {
    return [
      "--prompt",
      `Work on task "${taskTitle}" (ID: ${taskId}). Read AGENTS.md first if present. Follow the task lifecycle: claim, implement, submit.`,
    ];
  },
  buildEnv(agentApiKey: string, agentId: string, apiUrl: string): Record<string, string> {
    return {
      ORCY_API_URL: apiUrl,
      ORCY_AGENT_ID: agentId,
      ORCY_API_KEY: agentApiKey,
    };
  },
  parseOutput(chunk: string): string | null {
    const trimmed = chunk.trim();
    if (!trimmed) return null;
    return trimmed;
  },
  supportsResume(_version: string | null): boolean {
    return false;
  },
});

register({
  type: "gemini",
  bin: "gemini",
  buildArgs(taskId: string, taskTitle: string, _workdir: string): string[] {
    return [
      "--prompt",
      `Work on task "${taskTitle}" (ID: ${taskId}). Read AGENTS.md first if present. Follow the task lifecycle: claim, implement, submit.`,
    ];
  },
  buildEnv(agentApiKey: string, agentId: string, apiUrl: string): Record<string, string> {
    return {
      ORCY_API_URL: apiUrl,
      ORCY_AGENT_ID: agentId,
      ORCY_API_KEY: agentApiKey,
    };
  },
  parseOutput(chunk: string): string | null {
    const trimmed = chunk.trim();
    if (!trimmed) return null;
    return trimmed;
  },
  supportsResume(_version: string | null): boolean {
    return false;
  },
});

export function getAdapter(type: CliType): AdapterConfig {
  const adapter = adapters.get(type);
  if (!adapter) {
    throw new Error(`No adapter registered for CLI type: ${type}`);
  }
  return adapter;
}

export function getAllAdapters(): Map<CliType, AdapterConfig> {
  return new Map(adapters);
}
