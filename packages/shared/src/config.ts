import { readFileSync, existsSync } from 'fs';
import { ORCY_PATHS } from './paths.js';

function loadDotEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    if (!existsSync(ORCY_PATHS.envFile)) return env;
    for (const line of readFileSync(ORCY_PATHS.envFile, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    return env;
  }
  return env;
}

export interface OrcyConfig {
  apiUrl: string;
  agentId: string;
  apiKey: string;
  orcyHome: string;
}

let _config: OrcyConfig | undefined;

export function getOrcyConfig(): OrcyConfig {
  if (_config) return _config;
  const dotEnv = loadDotEnv();
  const env = (key: string) => process.env[key] ?? dotEnv[key];
  const host = env('HOST');
  const port = env('PORT');
  const fallbackUrl =
    host && port ? `http://${host}:${port}` : 'http://localhost:3000';
  _config = {
    apiUrl: env('ORCY_API_URL') ?? fallbackUrl,
    agentId: env('ORCY_AGENT_ID') ?? '',
    apiKey: env('ORCY_API_KEY') ?? '',
    orcyHome: ORCY_PATHS.home,
  };
  return _config;
}

export function resetConfig(): void {
  _config = undefined;
}
