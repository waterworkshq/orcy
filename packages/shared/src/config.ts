import { readFileSync, existsSync } from "fs";
import { ORCY_PATHS } from "./paths.js";

function loadDotEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    if (!existsSync(ORCY_PATHS.envFile)) return env;
    for (const line of readFileSync(ORCY_PATHS.envFile, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    return env;
  }
  return env;
}

/** Resolved local-agent runtime configuration for the MCP client, read from `process.env` and the Orcy `.env` file on first access via {@link getOrcyConfig}. */
export interface OrcyConfig {
  apiUrl: string;
  agentId: string;
  apiKey: string;
  orcyHome: string;
}

/**
 * v0.19 Phase D — remote participant config. Used when an MCP client
 * connects to a remote Orcy host using a per-remote-participant credential
 * (header: `X-Orcy-Remote-Key`) rather than a local agent API key.
 */
export interface OrcyRemoteConfig {
  apiUrl: string;
  remoteKey: string;
  remotePodId?: string;
  remoteParticipantId?: string;
  orcyHome: string;
}

/** Whether the MCP client authenticates as a local agent (`local_agent`) or a remote participant (`remote`). */
export type AuthMode = "local_agent" | "remote";

let _config: OrcyConfig | undefined;
let _remoteConfig: OrcyRemoteConfig | undefined;

/** Returns the cached {@link OrcyConfig}, lazily building it from `process.env` and the Orcy `.env` file on the first call. */
export function getOrcyConfig(): OrcyConfig {
  if (_config) return _config;
  const dotEnv = loadDotEnv();
  const env = (key: string) => process.env[key] ?? dotEnv[key];
  const host = env("HOST");
  const port = env("PORT");
  const fallbackUrl = host && port ? `http://${host}:${port}` : "http://localhost:3000";
  _config = {
    apiUrl: env("ORCY_API_URL") ?? fallbackUrl,
    agentId: env("ORCY_AGENT_ID") ?? "",
    apiKey: env("ORCY_API_KEY") ?? "",
    orcyHome: ORCY_PATHS.home,
  };
  return _config;
}

/**
 * Get the remote participant config. Used by MCP clients configured for
 * remote mode (X-Orcy-Remote-Key auth). Reads ORCY_REMOTE_KEY and related
 * env vars.
 */
export function getRemoteConfig(): OrcyRemoteConfig {
  if (_remoteConfig) return _remoteConfig;
  const dotEnv = loadDotEnv();
  const env = (key: string) => process.env[key] ?? dotEnv[key];
  const host = env("HOST");
  const port = env("PORT");
  const fallbackUrl = host && port ? `http://${host}:${port}` : "http://localhost:3000";
  _remoteConfig = {
    apiUrl: env("ORCY_API_URL") ?? env("ORCY_REMOTE_API_URL") ?? fallbackUrl,
    remoteKey: env("ORCY_REMOTE_KEY") ?? "",
    remotePodId: env("ORCY_REMOTE_POD_ID"),
    remoteParticipantId: env("ORCY_REMOTE_PARTICIPANT_ID"),
    orcyHome: ORCY_PATHS.home,
  };
  return _remoteConfig;
}

/**
 * Determine whether the MCP client should run in local-agent mode or
 * remote-participant mode. Defaults to local unless ORCY_REMOTE_KEY is set.
 */
export function getAuthMode(): AuthMode {
  const env = process.env["ORCY_REMOTE_KEY"];
  if (env && env.length > 0) return "remote";
  return "local_agent";
}

/** Clears the cached local-agent and remote configs so the next access re-reads from the environment. */
export function resetConfig(): void {
  _config = undefined;
  _remoteConfig = undefined;
}
