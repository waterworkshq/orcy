import os from 'node:os';
import path from 'node:path';
import { ORCY_PATHS, getOrcyConfig } from '@orcy/shared';

export interface InstallContext {
  orcyHome: string;
  binDir: string;
  uiDir: string;
  runDir: string;
  logsDir: string;
  apiUrl: string;
  platform: NodeJS.Platform;
  shell: string;
  homeDir: string;
}

export function getContext(): InstallContext {
  const homeDir = os.homedir();
  const config = getOrcyConfig();
  return {
    orcyHome: ORCY_PATHS.home,
    binDir: ORCY_PATHS.bin,
    uiDir: ORCY_PATHS.ui,
    runDir: ORCY_PATHS.run,
    logsDir: ORCY_PATHS.logs,
    apiUrl: config.apiUrl,
    platform: os.platform(),
    shell: path.basename(process.env.SHELL || 'bash'),
    homeDir,
  };
}
