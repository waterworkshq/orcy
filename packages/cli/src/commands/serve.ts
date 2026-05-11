import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { ORCY_PATHS } from '@orcy/shared';

const PID_FILE = path.join(ORCY_PATHS.run, 'api.pid');
const LOG_FILE = path.join(ORCY_PATHS.logs, 'api.log');

interface ResolvedApi {
  execPath: string;
  args: string[];
}

function findOrcyApi(): ResolvedApi {
  const candidates: { path: string; isNodeScript: boolean }[] = [
    { path: path.join(ORCY_PATHS.home, 'node_modules', '@orcy', 'api', 'dist', 'index.js'), isNodeScript: true },
    { path: path.join(ORCY_PATHS.bin, 'orcy-api'), isNodeScript: false },
    { path: path.join(os.homedir(), '.local', 'bin', 'orcy-api'), isNodeScript: false },
  ];
  for (const c of candidates) {
    if (fs.existsSync(c.path)) {
      if (c.isNodeScript) return { execPath: process.execPath, args: [c.path] };
      return { execPath: c.path, args: [] };
    }
  }
  const fromPath = process.env.PATH?.split(':').map(d => path.join(d, 'orcy-api')).find(f => fs.existsSync(f));
  if (fromPath) return { execPath: fromPath, args: [] };
  return { execPath: 'orcy-api', args: [] };
}

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function readPid(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isRunning(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

function isSystemdRunning(): boolean {
  try {
    const out = execSync('systemctl --user is-active orcy-api', { encoding: 'utf-8' }).trim();
    return out === 'active';
  } catch {
    return false;
  }
}

function getSystemdPid(): number | null {
  try {
    const out = execSync('systemctl --user show orcy-api --property MainPID --value', { encoding: 'utf-8' }).trim();
    const pid = parseInt(out, 10);
    return isNaN(pid) || pid === 0 ? null : pid;
  } catch {
    return null;
  }
}

function updatePidFile(pid: number): void {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(pid));
}

function clearPidFile(): void {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

export function registerServeCommands(program: any) {
  const serve = program.command('serve').description('Start/stop the API server');

  serve.command('start')
    .description('Start the API server (blocks by default)')
    .option('--port <port>', 'Port to listen on', '4000')
    .option('--host <host>', 'Host to bind to', '127.0.0.1')
    .option('--detach', 'Run in background')
    .option('--open', 'Open browser after start')
    .action(async (options: { port: string; host: string; detach?: boolean; open?: boolean }) => {
      // Check systemd first (authoritative source for auto-started service)
      if (isSystemdRunning()) {
        const systemdPid = getSystemdPid();
        if (systemdPid) updatePidFile(systemdPid);
        console.log(`API already running via systemd (pid ${systemdPid})`);
        return;
      }
      // Check PID file for detached-mode processes
      const existingPid = readPid();
      if (existingPid && isRunning(existingPid)) {
        console.log(`API already running (pid ${existingPid})`);
        return;
      }
      const api = findOrcyApi();
      const env = {
        ...process.env,
        PORT: options.port,
        HOST: options.host,
        ORCY_API_URL: `http://${options.host}:${options.port}`,
      } as Record<string, string>;
      if (options.detach) {
        // Try to start via systemd if available, fall back to detached spawn
        try {
          execSync('systemctl --user start orcy-api', { stdio: 'ignore' });
          const systemdPid = getSystemdPid();
          if (systemdPid) {
            updatePidFile(systemdPid);
            console.log(`API started via systemd (pid ${systemdPid})`);
            return;
          }
        } catch {}
        // Fallback: spawn detached process and manage via PID file
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        const log = fs.openSync(LOG_FILE, 'a');
        const child = spawn(api.execPath, api.args, {
          env,
          stdio: ['ignore', log, log],
          detached: true,
        });
        child.unref();
        updatePidFile(child.pid!);
        const ready = await waitForHealth(`http://${options.host}:${options.port}`);
        if (ready) {
          console.log(`API started (pid ${child.pid}) — http://${options.host}:${options.port}`);
          if (options.open) {
            const { execSync: exec } = await import('node:child_process');
            const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
            exec(`${cmd} http://${options.host}:${options.port}/app`, { stdio: 'ignore' });
          }
        } else {
          console.error('API failed to respond to health check');
        }
      } else {
        const child = spawn(api.execPath, api.args, { env, stdio: 'inherit' });
        child.on('exit', (code) => process.exit(code ?? 0));
      }
    });

  serve.command('stop')
    .description('Stop the detached API server')
    .action(() => {
      // Try systemd first
      if (isSystemdRunning()) {
        try {
          execSync('systemctl --user stop orcy-api', { stdio: 'inherit' });
          clearPidFile();
          console.log('Stopped API via systemd');
          return;
        } catch {
          console.error('Failed to stop via systemd');
        }
      }
      // Fallback to PID file
      const pid = readPid();
      if (!pid || !isRunning(pid)) {
        console.log('API is not running');
        return;
      }
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`Stopped API (pid ${pid})`);
      } catch {
        console.error('Failed to stop API');
      }
      clearPidFile();
    });

  serve.command('status')
    .description('Check if the API server is running')
    .action(() => {
      // Check systemd first
      if (isSystemdRunning()) {
        const systemdPid = getSystemdPid();
        if (systemdPid) updatePidFile(systemdPid);
        console.log(`API is running via systemd (pid ${systemdPid})`);
        return;
      }
      // Fallback to PID file
      const pid = readPid();
      if (pid && isRunning(pid)) {
        console.log(`API is running (pid ${pid})`);
      } else {
        console.log('API is not running');
      }
    });
}
