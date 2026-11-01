/**
 * Isolated seeded Learning Loop flow: fresh explicit DB path per evaluation,
 * dedicated ports, and no existing-server reuse or environment-derived root.
 * Teardown receives the main process's root through config.metadata.
 *
 * ponytail: workers: 1 bounds unused worker-evaluation roots to one empty
 * directory per run; add worker cleanup if needed, not ambient worker detection.
 *
 * Build shared, daemon, API and UI first (see docs/TESTING.md), then run:
 * `corepack pnpm --filter @orcy/ui test:e2e:seeded`.
 * Learning Loop opt-in is local to the test server; production defaults stay off.
 */
import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Owned ports for this harness. Distinct from the shared e2e harness (3000/5173). */
const API_PORT = 3147;
const UI_PORT = 5147;

/** mkdtemp prefix shared with the teardown's exact-match ownership check. */
export const RUN_ROOT_PREFIX = "orcy-seeded-e2e-";

/** Per-evaluation private run root — always fresh, never from env. */
const RUN_ROOT = mkdtempSync(path.join(tmpdir(), RUN_ROOT_PREFIX));
/** Explicit non-empty DB path inside the owned root — never ambient/user state. */
const DB_PATH = path.join(RUN_ROOT, "orcy-seeded.db");
if (!RUN_ROOT || !DB_PATH || path.dirname(DB_PATH) !== RUN_ROOT) {
  // Fail fast: an empty or relocated DB path would fall back to the API's
  // default (user) database location — refuse to boot rather than risk it.
  throw new Error(
    `[seeded-e2e] refusing to start: bad run root/db path (root=${RUN_ROOT} db=${DB_PATH})`,
  );
}
console.log(`[seeded-e2e] run root: ${RUN_ROOT} pid=${process.pid}`);

/**
 * POSIX shell single-quote escaping — inside single quotes NOTHING expands
 * (`$`, backticks, spaces are literal); the only special character is `'`
 * itself, closed-and-reopened as `'\''`. Applied to every interpolated path.
 */
const shq = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export default defineConfig({
  // The teardown deletes EXACTLY this evaluation's root (main-process value).
  metadata: { runRoot: RUN_ROOT, dbPath: DB_PATH },
  testDir: "./e2e",
  // Only the seeded spec — the shared harness specs stay on playwright.config.ts.
  testMatch: "learning-loop-seeded.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  globalTeardown: "./playwright.seeded.teardown.ts",
  use: {
    baseURL: `http://127.0.0.1:${UI_PORT}`,
    trace: "off",
    screenshot: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
  webServer: [
    {
      // process.execPath — the exact running Node binary, never a PATH guess.
      command: `${shq(process.execPath)} ${shq(path.resolve(__dirname, "../api/dist/index.js"))}`,
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(API_PORT),
        DB_PATH,
        ORCY_LEARNING_LOOP_ENABLED: "true",
      },
    },
    {
      // Test-only vite config (wraps production vite.config.ts; overrides the
      // preview proxy to API_PORT — see vite.e2e.seeded.config.ts).
      command: `${shq(process.execPath)} ${shq(path.resolve(__dirname, "node_modules/vite/bin/vite.js"))} preview --port ${UI_PORT} --strictPort --config ${shq(path.resolve(__dirname, "vite.e2e.seeded.config.ts"))}`,
      url: `http://127.0.0.1:${UI_PORT}/app/`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
