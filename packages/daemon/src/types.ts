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
