import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import type { InstallContext } from './context.js';
import { record } from './manifest.js';

const ORCY_HOME = path.join(os.homedir(), '.orcy');
const PID_FILE = path.join(ORCY_HOME, 'run', 'api.pid');
const WRAPPER_SCRIPT = path.join(ORCY_HOME, 'bin', 'orcy-api-wrapper');

function createWrapperScript(ctx: InstallContext): string {
  const apiScript = path.join(ctx.orcyHome, 'bin', 'orcy-api');
  return `#!/bin/bash
echo $$ > "${PID_FILE}"
exec "${apiScript}" "$@"
`;
}

export function installService(ctx: InstallContext): boolean {
  if (ctx.platform === 'linux') return installSystemd(ctx);
  if (ctx.platform === 'darwin') return installLaunchd(ctx);
  console.log('No init system detected. Use `orcy serve --detach` instead.');
  return false;
}

function installSystemd(ctx: InstallContext): boolean {
  // Create wrapper script that writes PID before exec
  fs.writeFileSync(WRAPPER_SCRIPT, createWrapperScript(ctx), 'utf-8');
  try { fs.chmodSync(WRAPPER_SCRIPT, 0o755); } catch {}
  record({ path: WRAPPER_SCRIPT, action: 'created' });

  const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', 'orcy-api.service');
  const content = `[Unit]
Description=Orcy API
After=network-online.target

[Service]
ExecStart=${WRAPPER_SCRIPT}
Restart=on-failure
EnvironmentFile=${ctx.orcyHome}/.env
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.writeFileSync(unitPath, content, 'utf-8');
  record({ path: unitPath, action: 'created' });

  try {
    execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
    execSync('systemctl --user enable --now orcy-api', { stdio: 'ignore' });
    console.log('systemd user service installed and started');
    return true;
  } catch (err) {
    console.error('Failed to start systemd service:', err instanceof Error ? err.message : 'unknown');
    return false;
  }
}

function installLaunchd(ctx: InstallContext): boolean {
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.orcy.api.plist');
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.orcy.api</string>
  <key>ProgramArguments</key>
  <array>
    <string>${WRAPPER_SCRIPT}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ORCY_API_URL</key>
    <string>${ctx.apiUrl}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${ctx.logsDir}/api.log</string>
  <key>StandardErrorPath</key>
  <string>${ctx.logsDir}/api-error.log</string>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, content, 'utf-8');
  record({ path: plistPath, action: 'created' });

  try {
    const uid = execSync('id -u', { encoding: 'utf-8' }).trim();
    execSync(`launchctl bootstrap gui/${uid} ${plistPath}`, { stdio: 'ignore' });
    console.log('launchd service installed and started');
    return true;
  } catch (err) {
    console.error('Failed to start launchd service:', err instanceof Error ? err.message : 'unknown');
    return false;
  }
}

export function stopService(ctx: InstallContext): boolean {
  if (ctx.platform === 'linux') {
    try {
      execSync('systemctl --user stop orcy-api', { stdio: 'inherit' });
      console.log('Service stopped.');
      return true;
    } catch {
      console.log('Service is not running.');
      return false;
    }
  }
  if (ctx.platform === 'darwin') {
    try {
      const uid = execSync('id -u', { encoding: 'utf-8' }).trim();
      execSync(`launchctl bootout gui/${uid}/ai.orcy.api`, { stdio: 'ignore' });
      console.log('Service stopped.');
      return true;
    } catch {
      console.log('Service is not running.');
      return false;
    }
  }
  console.log('No init system available');
  return false;
}

export function uninstallService(ctx: InstallContext): boolean {
  if (ctx.platform === 'linux') {
    try {
      execSync('systemctl --user stop orcy-api', { stdio: 'ignore' });
      execSync('systemctl --user disable orcy-api', { stdio: 'ignore' });
      const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', 'orcy-api.service');
      if (fs.existsSync(unitPath)) fs.rmSync(unitPath);
      if (fs.existsSync(WRAPPER_SCRIPT)) fs.rmSync(WRAPPER_SCRIPT);
      execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
      return true;
    } catch { return false; }
  }
  if (ctx.platform === 'darwin') {
    try {
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.orcy.api.plist');
      if (fs.existsSync(plistPath)) fs.rmSync(plistPath);
      if (fs.existsSync(WRAPPER_SCRIPT)) fs.rmSync(WRAPPER_SCRIPT);
      return true;
    } catch { return false; }
  }
  return false;
}
