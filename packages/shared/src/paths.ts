import { join } from "path";
import { homedir } from "os";

const isBrowser = typeof (globalThis as Record<string, unknown>).window !== "undefined";

/** Absolute path to the user's `.orcy` directory under their home folder, the root for all on-disk Orcy state. */
export const ORCY_HOME = isBrowser ? "" : join(homedir(), ".orcy");

/** Canonical filesystem layout derived from {@link ORCY_HOME}: subdirectories and files (bin, ui, env, credentials, database, run, logs) used across packages. */
export const ORCY_PATHS = {
  home: ORCY_HOME,
  bin: isBrowser ? "" : join(ORCY_HOME, "bin"),
  ui: isBrowser ? "" : join(ORCY_HOME, "ui"),
  envFile: isBrowser ? "" : join(ORCY_HOME, ".env"),
  credentialsFile: isBrowser ? "" : join(ORCY_HOME, "credentials.json"),
  databaseFile: isBrowser ? "" : join(ORCY_HOME, "orcy.db"),
  run: isBrowser ? "" : join(ORCY_HOME, "run"),
  logs: isBrowser ? "" : join(ORCY_HOME, "logs"),
} as const;
