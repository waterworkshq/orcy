import type { AgentType, AgentStatus } from "./agent.js";

export type { AgentType, AgentStatus } from "./agent.js";

/** Alias of {@link AgentType} used in the daemon seam for the CLI binary backing an agent. */
export type CliType = AgentType;

/** Exhaustive readonly list of supported agent/CLI types. Used for Zod schema derivation and CLI detection. */
export const AGENT_TYPES = ["claude-code", "codex", "opencode", "cursor", "gemini"] as const;

/** Result of probing the host for an installed CLI. Produced by {@link ICliDetector}. */
export interface DetectedCli {
  type: CliType;
  version: string | null;
  path: string;
}

/** Exhaustive readonly list of session lifecycle states. */
export const SESSION_STATUSES = [
  "starting",
  "running",
  "completed",
  "failed",
  "released",
  "lost",
] as const;

/** Canonical state of an {@link ActiveSession} in the daemon seam. */
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Payload returned by {@link IClaimStrategy.claimNext} on a successful claim. Drives {@link ISessionManager.startSession}. */
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

/** Identity record for an agent registered with a daemon. The `type` field is intentionally `string` to support heterogeneous agent lists. */
export interface RegisteredAgent {
  id: string;
  name: string;
  type: string;
  apiKey: string;
  binPath?: string;
}

/** Live snapshot of a session owned by {@link ISessionManager}. Iterated by the poll loop and reported via heartbeats. */
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

/** Strategy interface for writing session updates back to storage. Implemented by `InProcessSessionUpdater`; injected into {@link ISessionManager}. */
export interface ISessionUpdater {
  updateSession(sessionId: string, updates: Record<string, unknown>): Promise<void>;
}

/** Core seam interface for owning and supervising sessions. Implemented by `SessionManager` in the daemon package; constructed via `createSessionManager`. */
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

/** Strategy interface for probing the host for installed CLIs. Constructed via `createCliDetector` in the daemon factory. */
export interface ICliDetector {
  detectClis(): DetectedCli[];
}

/** Strategy interface for claiming the next task for an agent. Implemented by `InProcessClaimStrategy` (API) and `HttpClaimStrategy` (standalone daemon). */
export interface IClaimStrategy {
  claimNext(agentId: string, habitatId: string, daemonId: string): Promise<ClaimResult | null>;
}

/** Strategy interface for reporting agent statuses and session progress. Implemented by `HttpHeartbeatStrategy` over the daemon HTTP API. */
export interface IHeartbeatStrategy {
  sendHeartbeat(
    daemonId: string,
    agents: ReadonlyArray<RegisteredAgent>,
    activeSessions: ReadonlyArray<ActiveSession>,
  ): Promise<void>;
}

/** Control surface for the daemon polling loop. Drives {@link runPollTick} on each tick. */
export interface IPollLoop {
  start(): void;
  stop(): void;
  readonly isRunning: boolean;
}
