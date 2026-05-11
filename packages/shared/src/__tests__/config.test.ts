import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const FIXTURE_DIR = join(tmpdir(), 'orcy-test-config');

vi.mock('../paths.js', () => ({
  ORCY_PATHS: {
    home: FIXTURE_DIR,
    envFile: join(FIXTURE_DIR, '.env'),
  },
}));

describe('getOrcyConfig', () => {
  let resetConfig: () => void;
  let getOrcyConfig: () => { apiUrl: string; agentId: string; apiKey: string; orcyHome: string };

  beforeEach(async () => {
    vi.unstubAllEnvs();
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const mod = await import('../config.js');
    resetConfig = mod.resetConfig;
    getOrcyConfig = mod.getOrcyConfig;
    resetConfig();
  });

  afterEach(() => {
    resetConfig();
    if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('defaults to http://localhost:3000 when nothing is set', () => {
    const config = getOrcyConfig();
    expect(config.apiUrl).toBe('http://localhost:3000');
  });

  it('uses ORCY_API_URL from process.env', () => {
    vi.stubEnv('ORCY_API_URL', 'https://custom.example.com');
    const config = getOrcyConfig();
    expect(config.apiUrl).toBe('https://custom.example.com');
  });

  it('uses HOST and PORT fallback from process.env', () => {
    vi.stubEnv('HOST', '192.168.1.5');
    vi.stubEnv('PORT', '8080');
    const config = getOrcyConfig();
    expect(config.apiUrl).toBe('http://192.168.1.5:8080');
  });

  it('ORCY_API_URL takes precedence over HOST/PORT', () => {
    vi.stubEnv('ORCY_API_URL', 'https://priority.example.com');
    vi.stubEnv('HOST', '192.168.1.5');
    vi.stubEnv('PORT', '8080');
    const config = getOrcyConfig();
    expect(config.apiUrl).toBe('https://priority.example.com');
  });

  it('falls back to localhost:3000 when only HOST is set', () => {
    vi.stubEnv('HOST', '192.168.1.5');
    const config = getOrcyConfig();
    expect(config.apiUrl).toBe('http://localhost:3000');
  });

  it('reads HOST and PORT from dotenv file', () => {
    writeFileSync(join(FIXTURE_DIR, '.env'), 'HOST=10.0.0.1\nPORT=9090\n');
    const config = getOrcyConfig();
    expect(config.apiUrl).toBe('http://10.0.0.1:9090');
  });

  it('reads ORCY_API_URL from dotenv file', () => {
    writeFileSync(join(FIXTURE_DIR, '.env'), 'ORCY_API_URL=https://dotenv.example.com\n');
    const config = getOrcyConfig();
    expect(config.apiUrl).toBe('https://dotenv.example.com');
  });

  it('process.env ORCY_API_URL overrides dotenv HOST/PORT', () => {
    vi.stubEnv('ORCY_API_URL', 'https://env-wins.com');
    writeFileSync(join(FIXTURE_DIR, '.env'), 'HOST=10.0.0.1\nPORT=9090\n');
    const config = getOrcyConfig();
    expect(config.apiUrl).toBe('https://env-wins.com');
  });
});
