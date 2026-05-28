export interface DetectedCli {
  type: "claude-code" | "codex" | "opencode" | "cursor" | "gemini";
  version: string | null;
  path: string;
}

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

export interface RegisteredAgent {
  id: string;
  name: string;
  type: string;
  apiKey: string;
  binPath?: string;
}

export interface ClaimResult {
  task: {
    id: string;
    title: string;
    description: string | null;
    missionId: string;
    habitatId: string;
    priority: string;
    requiredDomain: string | null;
    requiredCapabilities: string[] | null;
  };
  worktreeSettings: {
    repoPath: string;
    branchPrefix: string;
    autoCleanup: boolean;
  } | null;
}

export interface StoredCredentials {
  daemonId: string;
  daemonToken: string;
  apiUrl: string;
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

export type CliType = "claude-code" | "codex" | "opencode" | "cursor" | "gemini";

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

export type SessionStatus = "starting" | "running" | "completed" | "failed" | "released" | "lost";

export interface ActiveSession {
  id: string;
  taskId: string;
  taskTitle: string;
  agentId: string;
  agentApiKey: string;
  agentType: CliType;
  agentBinPath: string;
  habitatId: string;
  workdir: string;
  status: SessionStatus;
  pid: number | null;
  startedAt: number;
  lastProgressAt: number;
  lastProgress: string | null;
}
