import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse, stringify } from 'smol-toml';
import { record } from '../manifest.js';

export interface McpServerBlock {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

type McpFormat = 'standard' | 'opencode' | 'toml';

export interface McpWriterConfig {
  id: string;
  label: string;
  format: McpFormat;
  configPath: string;
  isAvailable: boolean;
}

function blockToEntry(block: McpServerBlock, format: McpFormat): any {
  if (format === 'opencode') {
    const entry: any = {
      type: 'local',
      command: [block.command, ...(block.args ?? [])],
      enabled: true,
    };
    if (block.env && Object.keys(block.env).length > 0) {
      entry.environment = { ...block.env };
    }
    return entry;
  }
  return {
    command: block.command,
    ...(block.args?.length && { args: block.args }),
    ...(block.env && Object.keys(block.env).length > 0 && { env: { ...block.env } }),
  };
}

function writeJson(format: McpFormat, filePath: string, block: McpServerBlock): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let bakPath: string | null = null;
  if (fs.existsSync(filePath)) {
    bakPath = backupFile(filePath);
  }

  const existing: Record<string, any> = {};
  if (fs.existsSync(filePath)) {
    try { Object.assign(existing, JSON.parse(fs.readFileSync(filePath, 'utf-8'))); } catch {}
  }

  const key = format === 'opencode' ? 'mcp' : 'mcpServers';
  if (!existing[key]) existing[key] = {};
  existing[key].orcy = blockToEntry(block, format);

  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
  record({ path: filePath, action: 'merged-json', keys: [key + '.orcy'], backup: bakPath ?? undefined });
}

function removeJson(format: McpFormat, filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const key = format === 'opencode' ? 'mcp' : 'mcpServers';
    if (data[key]?.orcy) {
      delete data[key].orcy;
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    }
  } catch {}
}

function writeToml(filePath: string, block: McpServerBlock): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let bakPath: string | null = null;
  if (fs.existsSync(filePath)) {
    bakPath = backupFile(filePath);
  }
  let existing: Record<string, any> = {};
  if (fs.existsSync(filePath)) {
    try { existing = parse(fs.readFileSync(filePath, 'utf-8')) as any; } catch {}
  }
  if (!existing.mcp_servers) existing.mcp_servers = {};
  existing.mcp_servers.orcy = blockToEntry(block, 'standard');
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, stringify(existing), 'utf-8');
  fs.renameSync(tmp, filePath);
  record({ path: filePath, action: 'merged-json', keys: ['mcp_servers.orcy'], backup: bakPath ?? undefined });
}

function removeToml(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  try {
    const data = parse(fs.readFileSync(filePath, 'utf-8')) as any;
    if (data.mcp_servers?.orcy) {
      delete data.mcp_servers.orcy;
      fs.writeFileSync(filePath, stringify(data), 'utf-8');
    }
  } catch {}
}

export function writeMcpConfig(config: McpWriterConfig, block: McpServerBlock): void {
  if (config.format === 'toml') writeToml(config.configPath, block);
  else writeJson(config.format, config.configPath, block);
}

export function removeMcpConfig(config: McpWriterConfig): void {
  if (config.format === 'toml') removeToml(config.configPath);
  else removeJson(config.format, config.configPath);
}

export const ALL_WRITERS: McpWriterConfig[] = [
  {
    id: 'claude-code', label: 'Claude Code', format: 'standard',
    configPath: path.join(os.homedir(), '.claude', 'settings.json'),
    isAvailable: fs.existsSync(path.join(os.homedir(), '.claude')),
  },
  {
    id: 'claude-desktop', label: 'Claude Desktop', format: 'standard',
    configPath: os.platform() === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json'),
    isAvailable: fs.existsSync(
      os.platform() === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude')
        : path.join(os.homedir(), '.config', 'Claude')
    ),
  },
  {
    id: 'cursor', label: 'Cursor', format: 'standard',
    configPath: path.join(os.homedir(), '.cursor', 'mcp.json'),
    isAvailable: fs.existsSync(path.join(os.homedir(), '.cursor')),
  },
  {
    id: 'gemini-antigravity', label: 'Gemini Antigravity', format: 'standard',
    configPath: path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
    isAvailable: fs.existsSync(path.join(os.homedir(), '.gemini')),
  },
  {
    id: 'kilo', label: 'Kilo Code', format: 'standard',
    configPath: path.join(os.homedir(), '.kilocode', 'mcp.json'),
    isAvailable: fs.existsSync(path.join(os.homedir(), '.kilocode')),
  },
  {
    id: 'codex', label: 'Codex (OpenAI)', format: 'toml',
    configPath: path.join(os.homedir(), '.codex', 'config.toml'),
    isAvailable: fs.existsSync(path.join(os.homedir(), '.codex')),
  },
  {
    id: 'opencode', label: 'OpenCode', format: 'opencode',
    configPath: path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
    isAvailable: fs.existsSync(path.join(os.homedir(), '.config', 'opencode')),
  },
];

export function backupFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = filePath + '.bak.' + ts;
  fs.copyFileSync(filePath, bak);
  return bak;
}
