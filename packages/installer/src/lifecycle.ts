import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import type { InstallContext } from './context.js';
import { ALL_WRITERS, removeMcpConfig, writeMcpConfig } from './writers/index.js';
import { injectIntoFile, removeFromFile } from './markdown-injector.js';
import { readManifest } from './manifest.js';
import { removeShims, SENTINEL_START, SENTINEL_END } from './path-shim.js';
import { generateMcpServerBlock, readCredentials } from './credentials.js';
import { stopService, installService, uninstallService } from './service-installer.js';

const OLD_SENTINEL_START = '# >>> agent-kanban PATH >>>';
const OLD_SENTINEL_END = '# <<< agent-kanban PATH <<<';
const OLD_SERVICE_UNIT = 'kanban-api';
const OLD_SERVICE_PLIST = 'ai.kanban.api';

function stopLegacyService(ctx: InstallContext): void {
  if (ctx.platform === 'linux') {
    try { execSync(`systemctl --user stop ${OLD_SERVICE_UNIT}`, { stdio: 'ignore' }); } catch {}
    try { execSync(`systemctl --user disable ${OLD_SERVICE_UNIT}`, { stdio: 'ignore' }); } catch {}
  }
  if (ctx.platform === 'darwin') {
    try {
      const uid = execSync('id -u', { encoding: 'utf-8' }).trim();
      execSync(`launchctl bootout gui/${uid}/${OLD_SERVICE_PLIST}`, { stdio: 'ignore' });
    } catch {}
  }
}

async function migrateLegacyInstallation(ctx: InstallContext): Promise<boolean> {
  const legacyHome = path.join(os.homedir(), '.kanban');

  if (!fs.existsSync(legacyHome)) return false;
  if (fs.existsSync(ctx.orcyHome)) return false;

  console.log('\n==> Detected legacy ~/.kanban/ installation. Migrating...\n');

  // 1. Stop old service before migration
  console.log('    Stopping legacy service...');
  stopLegacyService(ctx);
  stopService(ctx);

  // 2. Rename directory
  console.log('    Moving ~/.kanban/ → ~/.orcy/...');
  try {
    fs.renameSync(legacyHome, ctx.orcyHome);
    console.log('    Directory migrated.');
  } catch (err) {
    console.error('    Failed to rename ~/.kanban/ → ~/.orcy/:', err);
    throw err;
  }

  // 3. Rewrite PATH shim sentinels in shell rc files
  console.log('    Updating PATH shims...');
  const rcCandidates: Record<string, string> = {
    bash: path.join(ctx.homeDir, '.bashrc'),
    zsh: path.join(ctx.homeDir, '.zshrc'),
    fish: path.join(ctx.homeDir, '.config', 'fish', 'config.fish'),
  };
  for (const rcPath of Object.values(rcCandidates)) {
    if (!fs.existsSync(rcPath)) continue;
    try {
      let content = fs.readFileSync(rcPath, 'utf-8');
      const hasOld = content.includes(OLD_SENTINEL_START);
      if (hasOld) {
        content = content.replaceAll(OLD_SENTINEL_START, SENTINEL_START);
        content = content.replaceAll(OLD_SENTINEL_END, SENTINEL_END);
        fs.writeFileSync(rcPath, content, 'utf-8');
        console.log(`    Updated sentinels in ${rcPath}`);
      }
    } catch {}
  }

  // 4. Remove old service files, install new service
  console.log('    Re-installing service...');
  try { uninstallService(ctx); } catch {}
  installService(ctx);

  // 5. Update MCP config key "kanban" → "orcy" in client configs
  console.log('    Updating MCP config...');
  const creds = readCredentials();
  if (creds) {
    const block = generateMcpServerBlock(creds, ctx);
    for (const writer of ALL_WRITERS) {
      if (!writer.isAvailable) continue;
      try {
        if (fs.existsSync(writer.configPath)) {
          if (writer.format === 'toml') {
            const { parse, stringify } = await import('smol-toml');
            const data = parse(fs.readFileSync(writer.configPath, 'utf-8')) as any;
            if (data.mcp_servers?.kanban) delete data.mcp_servers.kanban;
            data.mcp_servers ??= {};
            fs.writeFileSync(writer.configPath, stringify(data), 'utf-8');
          } else {
            const raw = JSON.parse(fs.readFileSync(writer.configPath, 'utf-8'));
            const key = writer.format === 'opencode' ? 'mcp' : 'mcpServers';
            if (raw[key]?.kanban) delete raw[key].kanban;
            fs.writeFileSync(writer.configPath, JSON.stringify(raw, null, 2), 'utf-8');
          }
        }
        writeMcpConfig(writer, block);
        console.log(`    Updated MCP config: ${writer.label}`);
      } catch (e) {
        console.warn(`    Failed MCP config for ${writer.label}: ${e}`);
      }
    }
  }

  // 6. Rewrite markdown injected blocks (handle old + new markers)
  console.log('    Updating markdown blocks...');
  const manifest = readManifest();
  if (manifest) {
    for (const entry of manifest.files) {
      if (entry.action === 'fenced' && (entry.path.includes('AGENTS') || entry.path.includes('CLAUDE'))) {
        const filePath = entry.path;
        if (fs.existsSync(filePath)) {
          let content = fs.readFileSync(filePath, 'utf-8');
          const oldStart = '<!-- agent-kanban:start -->';
          const oldEnd = '<!-- agent-kanban:end -->';
          const newStart = '<!-- orcy:start -->';
          const newEnd = '<!-- orcy:end -->';
          if (content.includes(oldStart)) {
            content = content.replace(oldStart, newStart).replace(oldEnd, newEnd);
            fs.writeFileSync(filePath, content, 'utf-8');
          }
        }
        removeFromFile(entry.path);
        injectIntoFile(entry.path, ctx);
      }
    }
  }

  // 7. Rename skill directories
  console.log('    Updating skill directories...');
  const skillRoots = [
    path.join(os.homedir(), '.claude', 'skills'),
    path.join(os.homedir(), '.kilo', 'skills'),
    path.join(os.homedir(), '.codex', 'skills'),
  ];
  const oldSkills = ['kanban-overview', 'kanban-cli-usage', 'kanban-mcp-usage'];
  const newSkills = ['orcy-overview', 'orcy-cli-usage', 'orcy-mcp-usage'];
  for (const root of skillRoots) {
    if (!fs.existsSync(root)) continue;
    for (let i = 0; i < oldSkills.length; i++) {
      const oldSkill = path.join(root, oldSkills[i]);
      const newSkill = path.join(root, newSkills[i]);
      if (fs.existsSync(oldSkill) && !fs.existsSync(newSkill)) {
        try {
          fs.renameSync(oldSkill, newSkill);
          console.log(`    Renamed skill: ${oldSkills[i]} → ${newSkills[i]}`);
        } catch (e) {
          console.warn(`    Could not rename ${oldSkills[i]}: ${e}`);
        }
      }
    }
  }

  console.log('    Migration complete.\n');
  return true;
}

export async function updateInstall(ctx: InstallContext): Promise<void> {
  await migrateLegacyInstallation(ctx);

  const manifest = readManifest();
  if (!manifest) {
    console.log('No install manifest found. Run install first.');
    return;
  }
  const components = manifest.components;
  console.log(`    Re-installing components: ${components.join(', ')}`);
  const { installPackages } = await import('./install-packages.js');
  await installPackages(ctx, components);
  for (const entry of manifest.files) {
    if (entry.action === 'fenced' && (entry.path.includes('AGENTS') || entry.path.includes('CLAUDE'))) {
      injectIntoFile(entry.path, ctx);
    }
  }
  console.log('    Update complete');
}

export async function uninstallAll(ctx: InstallContext): Promise<void> {
  const manifest = readManifest();
  if (!manifest) {
    console.log('No install manifest found.');
    return;
  }

  console.log('==> Uninstalling orcy...');

  // Reverse order
  const reversed = [...manifest.files].toReversed();
  for (const entry of reversed) {
    try {
      switch (entry.action) {
        case 'created':
          if (fs.existsSync(entry.path)) {
            if (fs.statSync(entry.path).isDirectory()) {
              fs.rmSync(entry.path, { recursive: true });
            } else {
              fs.unlinkSync(entry.path);
            }
          }
          break;
        case 'appended':
          if (fs.existsSync(entry.path)) {
            const content = fs.readFileSync(entry.path, 'utf-8');
            const start = content.indexOf(SENTINEL_START);
            const end = content.indexOf(SENTINEL_END);
            if (start !== -1 && end !== -1) {
              const next = end + SENTINEL_END.length;
              fs.writeFileSync(entry.path, content.slice(0, start).trimEnd() + '\n' + content.slice(next).trimStart());
            }
          }
          break;
        case 'fenced':
          removeFromFile(entry.path);
          break;
        case 'merged-json': {
          const writer = ALL_WRITERS.find(w => w.configPath === entry.path);
          if (writer) removeMcpConfig(writer);
          break;
        }
        case 'copied':
          if (fs.existsSync(entry.path)) {
            if (fs.statSync(entry.path).isDirectory()) {
              fs.rmSync(entry.path, { recursive: true });
            } else {
              fs.unlinkSync(entry.path);
            }
          }
          break;
      }
    } catch (e) {
      console.warn(`    Could not remove ${entry.path}: ${e}`);
    }
  }

  removeShims(ctx);

  const manifestPath = path.join(ctx.orcyHome, 'install-manifest.json');
  if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);

  console.log('    Uninstall complete. ~/.orcy/orcy.db and ~/.orcy/.env preserved.');
}

export function listInstall(_ctx: InstallContext): void {
  const manifest = readManifest();
  if (!manifest) {
    console.log('No install manifest found. Run `orcy-install` first.');
    return;
  }
  console.log(`Installed: ${manifest.components.join(', ')}`);
  console.log(`Installed at: ${manifest.installedAt}`);
  console.log('\nFiles managed:');
  for (const entry of manifest.files) {
    console.log(`  [${entry.action}] ${entry.path}`);
  }
}

export function serviceStatus(ctx: InstallContext): boolean {
  if (ctx.platform === 'linux') {
    try {
      const out = execSync('systemctl --user is-active orcy-api', { encoding: 'utf-8' }).trim();
      console.log(`Service status: ${out}`);
      return out === 'active';
    } catch {
      console.log('Service status: inactive');
      return false;
    }
  }
  if (ctx.platform === 'darwin') {
    try {
      const uid = execSync('id -u', { encoding: 'utf-8' }).trim();
      const out = execSync(`launchctl print gui/${uid}/ai.orcy.api`, { encoding: 'utf-8' }).trim();
      console.log(`Service status: ${out.includes('path') ? 'active' : 'inactive'}`);
      return out.includes('path');
    } catch {
      console.log('Service status: inactive');
      return false;
    }
  }
  console.log('No init system available');
  return false;
}
