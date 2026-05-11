import { join } from 'path';
import { homedir } from 'os';

export const ORCY_HOME = join(homedir(), '.orcy');

export const ORCY_PATHS = {
  home: ORCY_HOME,
  bin: join(ORCY_HOME, 'bin'),
  ui: join(ORCY_HOME, 'ui'),
  envFile: join(ORCY_HOME, '.env'),
  credentialsFile: join(ORCY_HOME, 'credentials.json'),
  databaseFile: join(ORCY_HOME, 'orcy.db'),
  run: join(ORCY_HOME, 'run'),
  logs: join(ORCY_HOME, 'logs'),
} as const;
