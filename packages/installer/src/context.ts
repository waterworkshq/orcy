import os from 'node:os';
import path from 'node:path';

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
  const orcyHome = path.join(homeDir, '.orcy');
  return {
    orcyHome,
    binDir: path.join(orcyHome, 'bin'),
    uiDir: path.join(orcyHome, 'ui'),
    runDir: path.join(orcyHome, 'run'),
    logsDir: path.join(orcyHome, 'logs'),
    apiUrl: process.env.ORCY_API_URL || 'http://127.0.0.1:4000',
    platform: os.platform(),
    shell: path.basename(process.env.SHELL || 'bash'),
    homeDir,
  };
}
