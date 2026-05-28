import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { DaemonConfig } from "./types.js";

const DEFAULTS = {
  apiUrl: "http://localhost:3000",
  maxConcurrent: 4,
  pollIntervalSeconds: 30,
  heartbeatIntervalSeconds: 30,
} as const;

export function loadConfig(overrides?: Partial<DaemonConfig>): DaemonConfig {
  const name = overrides?.name ?? process.env.ORCY_DAEMON_NAME ?? hostname();
  const apiUrl = overrides?.apiUrl ?? process.env.ORCY_API_URL ?? DEFAULTS.apiUrl;
  const registrationToken =
    overrides?.registrationToken ?? process.env.ORCY_REGISTRATION_TOKEN ?? null;
  const maxConcurrent =
    overrides?.maxConcurrent ??
    (process.env.ORCY_MAX_CONCURRENT
      ? parseInt(process.env.ORCY_MAX_CONCURRENT, 10)
      : DEFAULTS.maxConcurrent);
  const pollIntervalSeconds =
    overrides?.pollIntervalSeconds ??
    (process.env.ORCY_POLL_INTERVAL
      ? parseInt(process.env.ORCY_POLL_INTERVAL, 10)
      : DEFAULTS.pollIntervalSeconds);
  const heartbeatIntervalSeconds =
    overrides?.heartbeatIntervalSeconds ??
    (process.env.ORCY_HEARTBEAT_INTERVAL
      ? parseInt(process.env.ORCY_HEARTBEAT_INTERVAL, 10)
      : DEFAULTS.heartbeatIntervalSeconds);
  const dataDir =
    overrides?.dataDir ?? process.env.ORCY_DAEMON_DIR ?? join(homedir(), ".orcy", "daemon");
  const habitatIds =
    overrides?.habitatIds ??
    (process.env.ORCY_HABITAT_IDS
      ? process.env.ORCY_HABITAT_IDS.split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
      : []);

  if (habitatIds.length === 0) {
    throw new Error(
      "At least one habitat ID is required (set ORCY_HABITAT_IDS or pass habitatIds)",
    );
  }

  return {
    apiUrl,
    registrationToken,
    name,
    maxConcurrent,
    pollIntervalSeconds,
    heartbeatIntervalSeconds,
    dataDir,
    habitatIds,
  };
}

export { DEFAULTS };
