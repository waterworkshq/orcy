#!/usr/bin/env node
export { DaemonApiClient } from "./api-client.js";
export { loadConfig, DEFAULTS } from "./config.js";
export { detectClis, SUPPORTED_CLIS } from "./detector.js";
export { Store } from "./store.js";
export { redact, redactObject } from "./redact.js";
export { createSessionManager, createCliDetector } from "./factory.js";
export {
  createWorkdir,
  validateWorktreeConfig,
  removeWorkdir,
  gcWorkdirs,
  WorkdirError,
} from "./workdir.js";
export { generateMcpConfig, generateEnv, writeMcpConfig, MCP_SERVER_NAME } from "./mcp-config.js";
export { getAdapter, getAllAdapters } from "./session/adapters.js";
export { spawnCli, terminateProcess } from "./session/spawner.js";
export { SessionManager } from "./session/manager.js";
export { PollLoop } from "./poll-loop.js";
export { recoverSessions } from "./recovery.js";
export type { RecoveredSession } from "./recovery.js";
export type {
  DaemonConfig,
  DetectedCli,
  RegisteredDaemon,
  RegisteredAgent,
  ClaimResult,
  StoredCredentials,
  WorkdirResult,
  McpConfig,
  WorkdirGcOptions,
  CliType,
  AdapterConfig,
  SpawnOptions,
  SessionStatus,
  ActiveSession,
  ISessionUpdater,
} from "./types.js";
export type { SpawnedProcess, SpawnCallbacks } from "./session/spawner.js";
export type { PollLoopDeps } from "./poll-loop.js";
