#!/usr/bin/env node
export { DaemonApiClient } from "./api-client.js";
export { loadConfig, DEFAULTS } from "./config.js";
export { detectClis, SUPPORTED_CLIS } from "./detector.js";
export { Store } from "./store.js";
export { redact, redactObject } from "./redact.js";
export {
  createWorkdir,
  validateWorktreeConfig,
  removeWorkdir,
  gcWorkdirs,
  WorkdirError,
} from "./workdir.js";
export { generateMcpConfig, generateEnv, writeMcpConfig, MCP_SERVER_NAME } from "./mcp-config.js";
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
} from "./types.js";
