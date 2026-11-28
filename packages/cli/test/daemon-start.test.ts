import { beforeAll, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ServerResponse } from 'node:http';

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
const recordedChild = (home: string) => join(home, 'spawned-child.pid');
const launcherEnv = (home: string) => ({ ...process.env, HOME: home, ORCY_DAEMON_DIR: join(home, 'data'), NODE_OPTIONS: `--import=${preload}`, ORCY_TEST_RECORD_CHILD: recordedChild(home) });
async function requestDeadline<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('recovery request not reached')), 5000); })]);
  } finally { clearTimeout(timer!); }
}

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

test('an unreserved child is terminated at the deadline', () => withHome((home) => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  mkdirSync(join(home, '.orcy/run'), { recursive: true });
  writeFileSync(join(home, '.orcy/run/daemon.start.lock'), 'another-owner');
  const result = run(home, ['start', '--detach'], synthetic('hang'));
  const pid = Number(readFileSync(join(home, 'synthetic-child.pid'), 'utf8'));
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /timed out before recovery after 15 seconds/);
    assert.throws(() => process.kill(pid, 0));
    assert.equal(existsSync(pidFile(home)), false);
    assert.equal(readFileSync(join(home, '.orcy/run/daemon.start.lock'), 'utf8'), 'another-owner');
    assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
  } finally {
    unrelated.kill('SIGKILL');
  }
}), 22000);

test('timeout after reservation but before permission cannot enter recovery', () => withHome((home) => {
  mkdirSync(join(home, 'data'), { recursive: true });
  writeFileSync(join(home, 'data/credentials.json'), JSON.stringify({ daemonId: 'synthetic', daemonToken: 'synthetic', apiUrl: 'http://127.0.0.1:1', habitatIds: [], agents: [], registeredAt: 'test' }));
  const result = run(home, ['start', '--detach'], { NODE_OPTIONS: `--import=${preload}`, ORCY_TEST_DELAY_RESERVED: '1', ORCY_TEST_RECORD_CHILD: recordedChild(home) });
  const pid = Number(readFileSync(recordedChild(home), 'utf8'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /timed out before recovery after 15 seconds/);
  assert.throws(() => process.kill(pid, 0));
  assert.equal(existsSync(pidFile(home)), false);
  assert.doesNotMatch(readFileSync(join(home, '.orcy/logs/daemon.log'), 'utf8'), /Daemon synthetic starting/);
}), 22000);

test('timeout while acquiring the startup lock releases only that child lock', () => withHome((home) => {
  const result = run(home, ['start', '--detach'], { NODE_OPTIONS: `--import=${preload}`, ORCY_TEST_DELAY_LOCK: '1', ORCY_TEST_RECORD_CHILD: recordedChild(home) });
  const pid = Number(readFileSync(recordedChild(home), 'utf8'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /timed out before recovery after 15 seconds/);
  assert.throws(() => process.kill(pid, 0));
  assert.equal(existsSync(join(home, '.orcy/run/daemon.start.lock')), false);
  assert.equal(readdirSync(join(home, '.orcy/run')).some((name) => name.startsWith('daemon.start.lock.')), false);
  const next = run(home, ['start']);
  assert.match(next.stderr, /No credentials found/);
}), 22000);

test('a stranded acquisition lock fails closed with an actionable message', () => withHome((home) => {
  mkdirSync(join(home, '.orcy/run/daemon.start.lock'), { recursive: true });
  const result = run(home, ['start', '--detach']);
  assert.equal(result.status, 1);
  assert.match(readFileSync(join(home, '.orcy/logs/daemon.log'), 'utf8'), /startup reservation is busy/);
  const foreground = run(home, ['start']);
  assert.equal(foreground.status, 1);
  assert.match(foreground.stderr, /startup reservation is busy/);
  assert.equal(existsSync(pidFile(home)), false);
  assert.equal(existsSync(join(home, '.orcy/run/daemon.start.lock')), true);
}));

test('candidate unlink errors do not change lock acquisition outcomes', () => withHome((home) => {
  const env = { NODE_OPTIONS: `--import=${preload}`, ORCY_TEST_FAIL_CANDIDATE_UNLINK: '1' };
  const first = run(home, ['start'], env);
  assert.equal(first.status, 1);
  assert.match(first.stderr, /No credentials found/);
  const lock = join(home, '.orcy/run/daemon.start.lock');
  assert.equal(existsSync(lock), false);

  writeFileSync(lock, 'another-owner');
  const second = run(home, ['start'], env);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /startup reservation is busy/);
  assert.equal(readFileSync(lock, 'utf8'), 'another-owner');
}));

test('concurrent start and timeout preserve a tracked recovering child', () => withHome(async (home) => {
  let release!: (response: ServerResponse) => void;
  const request = new Promise<ServerResponse>((resolve) => { release = resolve; });
  const server = createServer((_req, res) => release(res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  mkdirSync(join(home, 'data'), { recursive: true });
  writeFileSync(join(home, 'data/credentials.json'), JSON.stringify({ daemonId: 'synthetic', daemonToken: 'synthetic', apiUrl: `http://127.0.0.1:${address.port}`, habitatIds: [], agents: [], registeredAt: 'test' }));
  const launcher = spawn(process.execPath, [cli, 'daemon', 'start', '--detach'], { env: launcherEnv(home) });
  let stderr = '';
  launcher.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = new Promise<number | null>((resolve) => launcher.once('exit', resolve));
  let pid = 0;
  try {
    const response = await requestDeadline(request);
    pid = Number(readFileSync(pidFile(home), 'utf8'));
    assert.match(run(home, ['status']).stdout, /starting/);
    const contender = run(home, ['start', '--detach']);
    assert.equal(contender.status, 1);
    assert.match(contender.stderr, /already starting/);
    assert.equal(Number(readFileSync(pidFile(home), 'utf8')), pid);
    const start = Date.now();
    assert.equal(await exit, 1);
    assert.ok(Date.now() - start >= 14000);
    assert.match(stderr, /still pending after 15 seconds/);
    assert.doesNotThrow(() => process.kill(pid, 0));
    assert.match(run(home, ['status']).stdout, /starting/);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ sessions: [] }));
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('child did not become ready')), 5000);
      const check = () => {
        if (run(home, ['status']).stdout.includes('running')) { clearTimeout(deadline); resolve(); }
        else setTimeout(check, 50);
      };
      check();
    });
    assert.match(run(home, ['stop']).stdout, /Stopped daemon/);
    pid = 0;
  } finally {
    if (!pid && launcher.exitCode === null && launcher.signalCode === null && existsSync(recordedChild(home))) pid = Number(readFileSync(recordedChild(home), 'utf8'));
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}), 25000);

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
    const alreadyRunning = run(home, ['start', '--detach']);
    assert.equal(alreadyRunning.status, 0);
    assert.match(alreadyRunning.stdout, /already running/);
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

test('interrupting the launcher leaves the recovering child tracked and stoppable', () => withHome(async (home) => {
  let gotRequest!: () => void;
  const request = new Promise<void>((resolve) => { gotRequest = resolve; });
  const server = createServer(() => gotRequest());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  mkdirSync(join(home, 'data'), { recursive: true });
  writeFileSync(join(home, 'data/credentials.json'), JSON.stringify({ daemonId: 'synthetic', daemonToken: 'synthetic', apiUrl: `http://127.0.0.1:${address.port}`, habitatIds: [], agents: [], registeredAt: 'test' }));
  const launcher = spawn(process.execPath, [cli, 'daemon', 'start', '--detach'], { env: launcherEnv(home) });
  const exited = new Promise<NodeJS.Signals | null>((resolve) => launcher.once('exit', (_code, signal) => resolve(signal)));
  let pid = 0;
  try {
    await requestDeadline(request);
    pid = Number(readFileSync(pidFile(home), 'utf8'));
    launcher.kill('SIGTERM');
    assert.equal(await exited, 'SIGTERM');
    assert.match(run(home, ['status']).stdout, /starting/);
    assert.doesNotThrow(() => process.kill(pid, 0));
    assert.match(run(home, ['stop']).stdout, /Stopped daemon/);
    pid = 0;
  } finally {
    if (!pid && launcher.exitCode === null && launcher.signalCode === null && existsSync(recordedChild(home))) pid = Number(readFileSync(recordedChild(home), 'utf8'));
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}));

test('a dead owner is replaced and old cleanup preserves a newer owner', () => withHome(async (home) => {
  const dead = spawnSync(process.execPath, ['-e', '']);
  assert.equal(dead.status, 0);
  mkdirSync(join(home, '.orcy/run'), { recursive: true });
  writeFileSync(pidFile(home), String(dead.pid));
  writeFileSync(join(home, '.orcy/run/daemon.starting'), String(dead.pid));
  mkdirSync(join(home, 'data'), { recursive: true });
  writeFileSync(join(home, 'data/credentials.json'), JSON.stringify({ daemonId: 'synthetic', daemonToken: 'synthetic', apiUrl: 'http://127.0.0.1:1', habitatIds: [], agents: [], registeredAt: 'test' }));
  const old = spawn(process.execPath, [cli, 'daemon', 'start'], {
    env: { ...process.env, HOME: home, ORCY_DAEMON_DIR: join(home, 'data'), ORCY_DAEMON_DETACHED_START: '1' },
  });
  const exited = new Promise<number | null>((resolve) => old.once('exit', resolve));
  const newer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('replacement did not start')), 5000);
      old.once('error', reject);
      old.stdout.on('data', (chunk) => {
        if (String(chunk).includes('Daemon running')) { clearTimeout(timer); resolve(); }
      });
    });
    assert.equal(Number(readFileSync(pidFile(home), 'utf8')), old.pid);
    assert.notEqual(old.pid, dead.pid);
    // Model a new owner having acquired the slot before the old process exits.
    writeFileSync(pidFile(home), String(newer.pid));
    writeFileSync(join(home, '.orcy/run/daemon.starting'), String(newer.pid));
    old.kill('SIGTERM');
    assert.equal(await exited, 0);
    assert.equal(readFileSync(pidFile(home), 'utf8'), String(newer.pid));
    assert.equal(readFileSync(join(home, '.orcy/run/daemon.starting'), 'utf8'), String(newer.pid));
  } finally {
    if (old.exitCode === null && old.signalCode === null) old.kill('SIGKILL');
    newer.kill('SIGKILL');
  }
}));

test('foreground startup rejects an existing owner before contacting recovery', () => withHome(async (home) => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessions: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  mkdirSync(join(home, '.orcy/run'), { recursive: true });
  writeFileSync(pidFile(home), String(owner.pid));
  mkdirSync(join(home, 'data'), { recursive: true });
  writeFileSync(join(home, 'data/credentials.json'), JSON.stringify({ daemonId: 'synthetic', daemonToken: 'synthetic', apiUrl: `http://127.0.0.1:${address.port}`, habitatIds: [], agents: [], registeredAt: 'test' }));
  const foreground = spawn(process.execPath, [cli, 'daemon', 'start'], { env: { ...process.env, HOME: home, ORCY_DAEMON_DIR: join(home, 'data') } });
  try {
    const code = await new Promise<number | null>((resolve) => foreground.once('exit', resolve));
    assert.equal(code, 1);
    assert.equal(requests, 0);
    assert.equal(readFileSync(pidFile(home), 'utf8'), String(owner.pid));
    assert.doesNotThrow(() => process.kill(owner.pid!, 0));
  } finally {
    if (foreground.exitCode === null && foreground.signalCode === null) foreground.kill('SIGKILL');
    owner.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}));
