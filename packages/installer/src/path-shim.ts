import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import type { InstallContext } from './context.js';
import { record } from './manifest.js';

export const SENTINEL_START = '# >>> orcy PATH >>>';
export const SENTINEL_END = '# <<< orcy PATH <<<';
export const SENTINEL_START_FISH = '# >>> orcy PATH >>>';
export const SENTINEL_END_FISH = '# <<< orcy PATH <<<';

export function getComponentBinPath(component: 'cli' | 'api' | 'mcp'): string {
  const home = os.homedir();
  const base = path.join(home, '.orcy', 'node_modules', '@orcy', component, 'dist', 'index.js');
  if (fs.existsSync(base)) return base;
  return path.join(home, '.orcy', 'bin', component === 'cli' ? 'orcy' : `orcy-${component}`);
}

function resolveActualBin(component: 'cli' | 'api' | 'mcp'): string | null {
  const candidates = [
    path.join(os.homedir(), '.orcy', 'node_modules', '@orcy', component, 'dist', 'index.js'),
    path.join(os.homedir(), '.local', 'bin', component === 'cli' ? 'orcy' : `orcy-${component}`),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export function createShims(ctx: InstallContext, components: string[]): void {
  fs.mkdirSync(ctx.binDir, { recursive: true });

  const shebang = '#!/bin/sh\n';

  for (const comp of components) {
    const actual = resolveActualBin(comp as 'cli' | 'api' | 'mcp');
    if (!actual) {
      console.warn(`    Could not find ${comp} binary, skipping shim`);
      continue;
    }
    const binName = comp === 'cli' ? 'orcy' : `orcy-${comp}`;
    const shimPath = path.join(ctx.binDir, binName);
    const script = shebang + `exec node "${actual}" "$@"\n`;
    fs.writeFileSync(shimPath, script, 'utf-8');
    try { fs.chmodSync(shimPath, 0o755); } catch {}
    record({ path: shimPath, action: 'created' });
    console.log(`    Created shim: ${shimPath}`);
  }
}

export function editShellRc(ctx: InstallContext): void {
  const shell = ctx.shell;
  const candidates: Record<string, string> = {
    bash: path.join(ctx.homeDir, '.bashrc'),
    zsh: path.join(ctx.homeDir, '.zshrc'),
    fish: path.join(ctx.homeDir, '.config', 'fish', 'config.fish'),
  };
  const rcPath = candidates[shell] || candidates['bash'];
  if (!rcPath) return;

  const isFish = shell === 'fish' || rcPath.endsWith('fish');
  const line = isFish
    ? `fish_add_path "${ctx.binDir}"`
    : `export PATH="${ctx.binDir}:$PATH"`;

  const s = isFish ? SENTINEL_START_FISH : SENTINEL_START;
  const e = isFish ? SENTINEL_END_FISH : SENTINEL_END;

  const block = [
    s,
    line,
    e,
    '',
  ].join('\n');

  let content = '';
  if (fs.existsSync(rcPath)) {
    const existing = fs.readFileSync(rcPath, 'utf-8');
    if (existing.includes(s)) {
      console.log(`    PATH block already present in ${rcPath}`);
      return;
    }
    content = existing;
    const bak = rcPath + '.bak.' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(rcPath, bak);
  }

  fs.writeFileSync(rcPath, content.trimEnd() + '\n' + block, 'utf-8');
  record({ path: rcPath, action: 'appended', marker: s });
  console.log(`    Updated ${rcPath} with PATH block`);
}

export function removeShims(ctx: InstallContext): void {
  for (const bin of ['orcy', 'orcy-api', 'orcy-mcp']) {
    const p = path.join(ctx.binDir, bin);
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  }

  const candidates: Record<string, string> = {
    bash: path.join(ctx.homeDir, '.bashrc'),
    zsh: path.join(ctx.homeDir, '.zshrc'),
    fish: path.join(ctx.homeDir, '.config', 'fish', 'config.fish'),
  };
  for (const [, rcPath] of Object.entries(candidates)) {
    if (!fs.existsSync(rcPath)) continue;
    try {
      const content = fs.readFileSync(rcPath, 'utf-8');
      const start = content.indexOf(SENTINEL_START);
      const end = content.indexOf(SENTINEL_END);
      if (start !== -1 && end !== -1) {
        const next = end + SENTINEL_END.length;
        const restored = content.slice(0, start).trimEnd() + '\n' + content.slice(next).trimStart();
        fs.writeFileSync(rcPath, restored, 'utf-8');
      }
    } catch {}
  }
}
