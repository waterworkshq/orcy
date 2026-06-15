import type { AgentType, AgentStatus } from "./agent.js";

export type { AgentType, AgentStatus } from "./agent.js";

export type CliType = AgentType;

export const AGENT_TYPES = ["claude-code", "codex", "opencode", "cursor", "gemini"] as const;

export interface DetectedCli {
  type: CliType;
  version: string | null;
  path: string;
}

export const SESSION_STATUSES = [
  "starting",
  "running",
  "completed",
  "failed",
  "released",
  "lost",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface ClaimResult {
  daemonSessionId?: string;
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

export interface RegisteredAgent {
  id: string;
  name: string;
  type: string;
  apiKey: string;
  binPath?: string;
}

export interface ActiveSession {
  id: string;
  daemonSessionId?: string;
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

export interface ISessionUpdater {
  updateSession(sessionId: string, updates: Record<string, unknown>): Promise<void>;
}

export interface ISessionManager {
  readonly activeCount: number;
  readonly activeSessions: ReadonlyArray<ActiveSession>;
  getSession(id: string): ActiveSession | undefined;
  startSession(
    claim: ClaimResult,
    agentId: string,
    agentApiKey: string,
    agentType: CliType,
    agentBinPath: string,
    daemonSessionId?: string,
  ): Promise<ActiveSession>;
  terminateSession(sessionId: string): Promise<boolean>;
  releaseSession(sessionId: string): Promise<void>;
  shutdownAll(): Promise<void>;
  startTimeoutCheck(): void;
  stopTimeoutCheck(): void;
}

export interface ICliDetector {
  detectClis(): DetectedCli[];
}

export interface IClaimStrategy {
  claimNext(agentId: string, habitatId: string, daemonId: string): Promise<ClaimResult | null>;
}

export interface IHeartbeatStrategy {
  sendHeartbeat(
    daemonId: string,
    agents: ReadonlyArray<RegisteredAgent>,
    activeSessions: ReadonlyArray<ActiveSession>,
  ): Promise<void>;
}

export interface IPollLoop {
  start(): void;
  stop(): void;
  readonly isRunning: boolean;
}
