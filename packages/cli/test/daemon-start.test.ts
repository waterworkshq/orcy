import { beforeAll, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const preload = fileURLToPath(new URL('./fixtures/daemon-spawn.mjs', import.meta.url));
const run = (home: string, args: string[], extra: Record<string, string> = {}) => spawnSync(process.execPath, [cli, 'daemon', ...args], {
  encoding: 'utf8', env: { ...process.env, HOME: home, ORCY_DAEMON_DIR: join(home, 'data'), ...extra }, timeout: 22000,
});
const pidFile = (home: string) => join(home, '.orcy/run/daemon.pid');
const withHome = async (fn: (home: string) => void | Promise<void>) => {
  const home = mkdtempSync(join(tmpdir(), 'orcy-daemon-test-'));
  try { await fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
};
const synthetic = (mode: string) => ({ NODE_OPTIONS: `--import=${preload}`, ORCY_TEST_SPAWN: mode });

beforeAll(() => {
  execFileSync('corepack', ['pnpm', '--filter', '@orcy/cli...', 'build'], { cwd: fileURLToPath(new URL('../../..', import.meta.url)), stdio: 'inherit' });
}, 60000);

test('missing credentials fail in the built child and leave no PID', () => withHome((home) => {
  const result = run(home, ['start', '--detach']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exited during startup/);
  assert.match(readFileSync(join(home, '.orcy/logs/daemon.log'), 'utf8'), /No credentials found/);
  assert.equal(existsSync(pidFile(home)), false);
  assert.match(run(home, ['status']).stdout, /stopped/);
  assert.match(run(home, ['start']).stderr, /No credentials found/);
}));

test('spawn failure and early exit are visible', () => withHome((home) => {
  for (const [mode, expected] of [['error', /could not be spawned/], ['exit', /code 23/]] as const) {
    const result = run(home, ['start', '--detach'], synthetic(mode));
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.equal(existsSync(pidFile(home)), false);
  }
}));

test('timeout kills only the spawned child and does not report success', () => withHome(async (home) => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const start = Date.now();
    const result = run(home, ['start', '--detach'], synthetic('hang'));
    const elapsed = Date.now() - start;
    assert.equal(result.status, 1);
    assert.match(result.stderr, /timed out after 15 seconds/);
    assert.ok(elapsed >= 15000 && elapsed < 20000, `elapsed ${elapsed}ms`);
    assert.equal(existsSync(pidFile(home)), false);
    assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
  } finally { unrelated.kill('SIGKILL'); }
}), 22000);

test('ready daemon remains manageable and an existing live PID is preserved', () => withHome((home) => {
  mkdirSync(join(home, 'data'), { recursive: true });
  writeFileSync(join(home, 'data/credentials.json'), JSON.stringify({ daemonId: 'synthetic', daemonToken: 'synthetic', apiUrl: 'http://127.0.0.1:1', habitatIds: [], agents: [], registeredAt: 'test' }));
  const result = run(home, ['start', '--detach']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Daemon started/);
  const pid = Number(readFileSync(pidFile(home), 'utf8'));
  let stopped = false;
  try {
    assert.match(run(home, ['status']).stdout, /running/);
    assert.match(run(home, ['start', '--detach']).stdout, /already running/);
    assert.equal(Number(readFileSync(pidFile(home), 'utf8')), pid);
    assert.match(run(home, ['stop']).stdout, /Stopped daemon/);
    stopped = true;
  } finally { if (!stopped) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
}));

test('foreground daemon starts and handles SIGTERM', () => withHome(async (home) => {
  mkdirSync(join(home, 'data'), { recursive: true });
  writeFileSync(join(home, 'data/credentials.json'), JSON.stringify({ daemonId: 'synthetic', daemonToken: 'synthetic', apiUrl: 'http://127.0.0.1:1', habitatIds: [], agents: [], registeredAt: 'test' }));
  const child = spawn(process.execPath, [cli, 'daemon', 'start'], {
    env: { ...process.env, HOME: home, ORCY_DAEMON_DIR: join(home, 'data') },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('foreground did not start')), 5000);
      child.once('error', reject);
      child.once('exit', () => reject(new Error('foreground exited before readiness')));
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('Daemon running')) { clearTimeout(timer); resolve(); }
      });
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
    assert.equal(existsSync(pidFile(home)), false);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}));
