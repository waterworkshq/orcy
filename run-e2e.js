#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
const { resolve } = require('path');
const http = require('http');

const ROOT = __dirname;
const API_DIR = resolve(ROOT, 'packages/api');
const UI_DIR = resolve(ROOT, 'packages/ui');

const API_PORT = process.env.PORT || '3000';
const API_HEALTH_URL = `http://127.0.0.1:${API_PORT}/health`;
const UI_URL = 'http://localhost:5173';

const POLL_INTERVAL = 500;
const HEALTH_TIMEOUT = 30_000;

const children = [];

function log(msg) {
  console.log(`[run-e2e] ${msg}`);
}

function run(command, opts = {}) {
  execSync(command, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function spawnProcess(command, args, opts = {}) {
  const child = spawn(command, args, { stdio: 'inherit', shell: true, ...opts });
  children.push(child);
  child.on('exit', () => {
    const idx = children.indexOf(child);
    if (idx !== -1) children.splice(idx, 1);
  });
  return child;
}

function killAll() {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch {}
  }
  try {
    execSync('pkill -f "node packages/api/dist/index.js" 2>/dev/null || true', { stdio: 'ignore' });
  } catch {}
  try {
    execSync('pkill -f "vite" 2>/dev/null || true', { stdio: 'ignore' });
  } catch {}
}

function waitForHealth(url, timeoutMs = HEALTH_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function poll() {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${url}`));
      }
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        setTimeout(poll, POLL_INTERVAL);
      });
      req.on('error', () => setTimeout(poll, POLL_INTERVAL));
      req.end();
    }
    poll();
  });
}

function showHelp() {
  console.log(`Usage: node run-e2e.js [options]

Build the API, seed the database, start services, run Playwright E2E tests,
and clean up background processes.

Options:
  --help              Show this help message
  --api-port <port>   API server port (default: 3000)

Pipeline:
  1. Build the API (pnpm build:api)
  2. Install Playwright browsers
  3. Start the API server
  4. Wait for API health check
  5. Seed the database
  6. Start the Vite dev server
  7. Wait for dev server
  8. Run Playwright tests
  9. Kill background processes
  10. Exit with Playwright exit code
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    showHelp();
    process.exit(0);
  }

  const portIndex = args.indexOf('--api-port');
  if (portIndex !== -1 && args[portIndex + 1]) {
    process.env.PORT = args[portIndex + 1];
  }

  const e2eDbDir = resolve(ROOT, '.e2e-db');
  process.env.DB_PATH = resolve(e2eDbDir, 'kanban.db');

  process.on('SIGINT', () => {
    log('Received SIGINT, cleaning up...');
    killAll();
    process.exit(130);
  });

  let exitCode = 0;

  try {
    log('Building API...');
    run('pnpm build:api');

    log('Installing Playwright browsers...');
    run('node packages/ui/install-browser.js');

    log('Starting API server...');
    spawnProcess('node', ['packages/api/dist/index.js']);

    log(`Waiting for API health check at ${API_HEALTH_URL}...`);
    await waitForHealth(API_HEALTH_URL);
    log('API is healthy.');

    log('Seeding database...');
    run('pnpm db:seed');

    log('Starting Vite dev server...');
    spawnProcess('pnpm', ['--filter', 'ui', 'dev'], { cwd: ROOT });

    log(`Waiting for UI at ${UI_URL}...`);
    await waitForHealth(UI_URL);
    log('UI is ready.');

    log('Running Playwright tests...');
    try {
      execSync('npx playwright test', {
        stdio: 'inherit',
        cwd: UI_DIR,
      });
    } catch (err) {
      exitCode = err.status || 1;
    }

    log(`Playwright finished with exit code ${exitCode}`);
  } catch (err) {
    log(`Fatal error: ${err.message}`);
    exitCode = 1;
  } finally {
    log('Cleaning up...');
    killAll();
    process.exit(exitCode);
  }
}

main();
