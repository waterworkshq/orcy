import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import type { InstallContext } from './context.js';

export function generateSecret(length = 32): string {
  return randomBytes(length).toString('hex');
}

export interface EnvConfig {
  port: number;
  host: string;
}

export function generateEnvFile(ctx: InstallContext, config: EnvConfig): void {
  const envPath = path.join(ctx.orcyHome, '.env');

  if (fs.existsSync(envPath)) {
    const existing = fs.readFileSync(envPath, 'utf-8');
    const lines = existing.split('\n');
    const keyCount = lines.filter(l => l.startsWith('JWT_SECRET=') || l.startsWith('ORCY_REGISTRATION_TOKEN=')).length;
    if (keyCount >= 2) {
      console.log('    .env already has secrets, skipping generation');
      return;
    }
    const bak = envPath + '.bak.' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(envPath, bak);
    const entries: Record<string, string> = {};
    for (const line of lines) {
      const idx = line.indexOf('=');
      if (idx > 0) entries[line.slice(0, idx)] = line.slice(idx + 1);
    }
    if (!entries['JWT_SECRET']) entries['JWT_SECRET'] = generateSecret(64);
    if (!entries['ORCY_REGISTRATION_TOKEN']) entries['ORCY_REGISTRATION_TOKEN'] = generateSecret(32);
    if (!entries['PORT']) entries['PORT'] = String(config.port);
    if (!entries['HOST']) entries['HOST'] = config.host;
    if (!entries['ORCY_API_URL']) entries['ORCY_API_URL'] = `http://${config.host}:${config.port}`;
    if (!entries['LOG_LEVEL']) entries['LOG_LEVEL'] = 'info';
    if (!entries['NODE_ENV']) entries['NODE_ENV'] = 'production';
    const updated = Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
    fs.writeFileSync(envPath, updated, { mode: 0o600 });
    // Don't track .env in manifest — it's preserved on uninstall
    // (lifecycle.ts explicitly says: ~/.orcy/orcy.db and ~/.orcy/.env preserved)
    console.log('    Updated existing .env with missing secrets');
    return;
  }

  const content = [
    `PORT=${config.port}`,
    `HOST=${config.host}`,
    `JWT_SECRET=${generateSecret(64)}`,
    `ORCY_REGISTRATION_TOKEN=${generateSecret(32)}`,
    `ORCY_API_URL=http://${config.host}:${config.port}`,
    `LOG_LEVEL=info`,
    `NODE_ENV=production`,
  ].join('\n') + '\n';

  fs.mkdirSync(ctx.orcyHome, { recursive: true });
  fs.writeFileSync(envPath, content, { mode: 0o600 });
  // Don't track .env in manifest — it's preserved on uninstall
  console.log('    Generated ~/.orcy/.env with secrets');
}

export function readRegistrationToken(): string | null {
  const envPath = path.join(os.homedir(), '.orcy', '.env');
  if (!fs.existsSync(envPath)) return null;
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const idx = line.indexOf('=');
    if (idx > 0 && line.slice(0, idx) === 'ORCY_REGISTRATION_TOKEN') {
      return line.slice(idx + 1).trim() || null;
    }
  }
  return null;
}
