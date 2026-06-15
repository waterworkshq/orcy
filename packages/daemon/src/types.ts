import type {
  CliType,
  DetectedCli,
  ClaimResult,
  RegisteredAgent,
  SessionStatus,
  ActiveSession,
  ISessionManager,
  ISessionUpdater,
  ICliDetector,
} from "@orcy/shared/types";

export type {
  CliType,
  DetectedCli,
  ClaimResult,
  RegisteredAgent,
  SessionStatus,
  ActiveSession,
  ISessionManager,
  ISessionUpdater,
  ICliDetector,
};

/** Resolved runtime configuration for a daemon process — built by {@link loadConfig} from env + overrides. */
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

/** Identity record returned by the daemon register API; carries the daemon token and the agent roster this daemon owns. */
export interface RegisteredDaemon {
  daemonId: string;
  daemonToken: string;
  heartbeatIntervalSeconds: number;
  agents: RegisteredAgent[];
}

/** On-disk shape of `credentials.json` written by {@link Store}, capturing everything needed to rejoin as a registered daemon. */
export interface StoredCredentials {
  daemonId: string;
  daemonToken: string;
  apiUrl: string;
  habitatIds?: string[];
  agents: RegisteredAgent[];
  registeredAt: string;
}

/** Result of {@link createWorkdir}: the resolved worktree path, the git branch checked out, and the worktree path (equal to `path`). */
export interface WorkdirResult {
  path: string;
  branch: string;
  worktreePath: string;
}

/** Shape of a `.mcp.json` MCP server config; produced by {@link generateMcpConfig}. */
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

/** Tuning knobs for {@link gcWorkdirs}: how old a workspace link must be (in ms) to be swept, and the clock to measure against. */
export interface WorkdirGcOptions {
  retentionMs: number;
  now?: number;
}

/** Per-CLI adapter contract — how to build args/env for a given {@link CliType}, parse its output, and probe resume support. */
export interface AdapterConfig {
  type: CliType;
  bin: string;
  buildArgs(taskId: string, taskTitle: string, workdir: string): string[];
  buildEnv(agentApiKey: string, agentId: string, apiUrl: string): Record<string, string>;
  parseOutput(chunk: string): string | null;
  supportsResume(version: string | null): boolean;
}

/** Result of spawning a CLI: the OS pid and the live `ChildProcess` handle. */
export interface SpawnResult {
  pid: number;
  process: NodeJS.Process;
}

/** Full input to {@link spawnCli}: task/agent identity, runtime env, binary path, and the output/exit callbacks. */
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
