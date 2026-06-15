import { join } from "path";
import { homedir } from "os";

/** Absolute path to the user's `.orcy` directory under their home folder, the root for all on-disk Orcy state. */
export const ORCY_HOME = join(homedir(), ".orcy");

/** Canonical filesystem layout derived from {@link ORCY_HOME}: subdirectories and files (bin, ui, env, credentials, database, run, logs) used across packages. */
export const ORCY_PATHS = {
  home: ORCY_HOME,
  bin: join(ORCY_HOME, "bin"),
  ui: join(ORCY_HOME, "ui"),
  envFile: join(ORCY_HOME, ".env"),
  credentialsFile: join(ORCY_HOME, "credentials.json"),
  databaseFile: join(ORCY_HOME, "orcy.db"),
  run: join(ORCY_HOME, "run"),
  logs: join(ORCY_HOME, "logs"),
} as const;
