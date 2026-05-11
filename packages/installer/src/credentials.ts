import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ORCY_PATHS } from '@orcy/shared';
import type { InstallContext } from './context.js';
import type { McpServerBlock } from './writers/index.js';
import { record } from './manifest.js';
import { readRegistrationToken } from './env-bootstrap.js';

export interface Credentials {
  agentId: string;
  apiKey: string;
  agentName: string;
}

const CREDENTIALS_PATH = ORCY_PATHS.credentialsFile;

function isValidCredentials(data: unknown): data is Credentials {
  if (!data || typeof data !== 'object') return false;
  const c = data as Record<string, unknown>;
  return typeof c.agentId === 'string' && c.agentId.length > 0
    && typeof c.apiKey === 'string' && c.apiKey.length > 0
    && typeof c.agentName === 'string';
}

export function readCredentials(): Credentials | null {
  try {
    const data = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
    return isValidCredentials(data) ? data : null;
  } catch {
    return null;
  }
}

export function writeCredentials(creds: Credentials): void {
  const dir = path.dirname(CREDENTIALS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
  record({ path: CREDENTIALS_PATH, action: 'created' });
}

export interface AgentRegistrationOpts {
  name?: string;
  type?: string;
  domain?: string;
}

export async function registerAgent(ctx: InstallContext, opts: AgentRegistrationOpts = {}): Promise<Credentials | null> {
  const existing = readCredentials();
  if (existing) {
    console.log(`Already registered as "${existing.agentName}" (${existing.agentId})`);
    return existing;
  }

  try {
    const hostname = os.hostname().replace(/[^a-zA-Z0-9-]/g, '').slice(0, 16) || 'local';
    const body = {
      name: opts.name || `orcy-${hostname}`,
      type: opts.type || 'claude-code',
      domain: opts.domain || 'fullstack',
      capabilities: ['typescript', 'node'],
    };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = readRegistrationToken();
    if (token) headers['x-registration-token'] = token;
    const res = await fetch(`${ctx.apiUrl}/api/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (res.status === 403) {
      const text = await res.text();
      if (text.includes('registration token')) {
        console.error('    API rejected registration: ORCY_REGISTRATION_TOKEN mismatch.');
        console.error('    Ensure the token in ~/.orcy/.env matches the API server\'s ORCY_REGISTRATION_TOKEN.');
      } else {
        console.error(`    API registration rejected (403): ${text}`);
      }
      return null;
    }
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    const data = await res.json() as any;
    const creds: Credentials = {
      agentId: data.agent?.id ?? data.id,
      apiKey: data.apiKey ?? data.api_key,
      agentName: body.name,
    };
    if (!creds.agentId || !creds.apiKey) throw new Error('API did not return agent ID or API key');
    writeCredentials(creds);
    console.log(`Registered agent "${creds.agentName}" (${creds.agentId})`);
    return creds;
  } catch (err) {
    console.error('Failed to register agent:', err instanceof Error ? err.message : err);
    return null;
  }
}

export function generateMcpServerBlock(creds: Credentials, ctx: InstallContext): McpServerBlock {
  const block: McpServerBlock = {
    command: 'orcy-mcp',
    env: {
      ORCY_API_URL: ctx.apiUrl,
      ORCY_AGENT_ID: creds.agentId,
      ORCY_API_KEY: creds.apiKey,
    },
  };
  const pathDirs = (process.env.PATH || '').split(':');
  const mcpNodeModules = path.join(ORCY_PATHS.home, 'node_modules', '@orcy', 'mcp', 'dist', 'index.js');
  const onPath = pathDirs.some(d => fs.existsSync(path.join(d, 'orcy-mcp')));
  if (!onPath && fs.existsSync(mcpNodeModules)) {
    block.command = 'node';
    block.args = [mcpNodeModules];
  }
  return block;
}
