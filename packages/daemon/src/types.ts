import type {
  CliType,
  DetectedCli,
  ClaimResult,
  RegisteredAgent,
  SessionStatus,
  ActiveSession,
  ISessionUpdater,
} from "@orcy/shared/types";

export type {
  CliType,
  DetectedCli,
  ClaimResult,
  RegisteredAgent,
  SessionStatus,
  ActiveSession,
  ISessionUpdater,
};

export interface DaemonConfig {
  apiUrl: string;
  registrationToken: string | null;
  name: string;
  maxConcurrent: number;
  pollIntervalSeconds: number;
  heartbeatIntervalSeconds: number;
  sessionTimeoutSeconds: number;
  dataDir: string;
  habitatIds: string[];
}

export interface RegisteredDaemon {
  daemonId: string;
  daemonToken: string;
  heartbeatIntervalSeconds: number;
  agents: RegisteredAgent[];
}

export interface StoredCredentials {
  daemonId: string;
  daemonToken: string;
  apiUrl: string;
  habitatIds?: string[];
  agents: RegisteredAgent[];
  registeredAt: string;
}

export interface WorkdirResult {
  path: string;
  branch: string;
  worktreePath: string;
}

export interface McpConfig {
  mcpServers: Record<
    string,
    {
      command: string;
      args: string[];
      env: Record<string, string>;
    }
  >;
}

export interface WorkdirGcOptions {
  retentionMs: number;
  now?: number;
}

export interface AdapterConfig {
  type: CliType;
  bin: string;
  buildArgs(taskId: string, taskTitle: string, workdir: string): string[];
  buildEnv(agentApiKey: string, agentId: string, apiUrl: string): Record<string, string>;
  parseOutput(chunk: string): string | null;
  supportsResume(version: string | null): boolean;
}

export interface SpawnResult {
  pid: number;
  process: NodeJS.Process;
}

export interface SpawnOptions {
  type: CliType;
  taskId: string;
  taskTitle: string;
  workdir: string;
  agentId: string;
  agentApiKey: string;
  apiUrl: string;
  binPath: string;
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}
