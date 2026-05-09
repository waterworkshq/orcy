#!/usr/bin/env node

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { platform } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function detectPackageManager() {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, 'bun.lockb')) || existsSync(resolve(cwd, 'bun.lock'))) {
    return 'bun';
  }
  if (existsSync(resolve(cwd, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  return 'npm';
}

function detectPlatform() {
  const os = platform();
  if (os === 'win32') return 'windows';
  if (os === 'darwin') return 'macos';
  return 'linux';
}

function findPlaywright() {
  const candidates = [
    resolve(__dirname, 'node_modules', 'playwright'),
    resolve(__dirname, 'node_modules', '@playwright', 'test'),
    resolve(__dirname, '..', '..', 'node_modules', 'playwright'),
    resolve(__dirname, '..', '..', 'node_modules', '@playwright', 'test'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function main() {
  const osName = detectPlatform();
  const pm = detectPackageManager();

  console.log(`[install-browser] Platform: ${osName}`);
  console.log(`[install-browser] Package manager: ${pm}`);

  const pwPath = findPlaywright();
  if (!pwPath) {
    console.error('[install-browser] ERROR: Playwright is not installed.');
    console.error('[install-browser] Install it with:');
    console.error(`  ${pm === 'bun' ? 'bun add -D @playwright/test' : pm === 'pnpm' ? 'pnpm add -D @playwright/test' : 'npm install -D @playwright/test'}`);
    process.exit(1);
  }

  console.log('[install-browser] Installing Chromium...');

  try {
    execSync('npx playwright install chromium', {
      stdio: 'inherit',
      cwd: __dirname,
    });
    console.log('[install-browser] Chromium installed successfully.');
  } catch (err) {
    console.error('[install-browser] Failed to install Chromium:', err.message);
    process.exit(1);
  }
}

main();
