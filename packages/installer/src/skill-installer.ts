import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { InstallContext } from './context.js';
import { record } from './manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getInstallerDir(): string {
  return path.resolve(__dirname, '..');
}

export function determineSkillsToInstall(components: string[]): string[] {
  const hasCli = components.includes('cli');
  const hasMcp = components.includes('mcp');
  if (hasCli && hasMcp) return ['orcy-overview', 'orcy-cli-usage', 'orcy-mcp-usage'];
  if (hasCli) return ['orcy-overview', 'orcy-cli-usage'];
  if (hasMcp) return ['orcy-overview', 'orcy-mcp-usage'];
  return ['orcy-overview'];
}

export function installSkills(
  ctx: InstallContext,
  roots: string[],
  skillNames: string[]
): void {
  const installerDir = getInstallerDir();
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      fs.mkdirSync(root, { recursive: true });
    }
    for (const skillName of skillNames) {
      const src = path.join(installerDir, 'skills', skillName);
      const dest = path.join(root, skillName);
      if (!fs.existsSync(src)) {
        console.warn(`    Skill "${skillName}" not found in installer bundle, skipping`);
        continue;
      }
      fs.cpSync(src, dest, { recursive: true });
      record({ path: dest, action: 'copied' });
      console.log(`    Installed skill: ${skillName} → ${root}`);
    }
  }
}

export function uninstallSkills(ctx: InstallContext): void {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ctx.orcyHome, 'install-manifest.json'), 'utf-8')
  );
  for (const entry of manifest.files) {
    if (entry.action === 'copied' && entry.path.includes('/skills/')) {
      try {
        fs.rmSync(entry.path, { recursive: true });
        console.log(`    Removed skill: ${entry.path}`);
      } catch {}
    }
  }
}
