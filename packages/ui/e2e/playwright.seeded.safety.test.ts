/**
 * Safety proof for the seeded Learning Loop harness (#147).
 *
 * The harness's dangerous surface is its run-root/DB-path selection and its
 * teardown deletion. This suite proves, on every run, that a HOSTILE ambient
 * environment (a preset `ORCY_SEEDED_E2E_RUN_ROOT`, a preset `DB_PATH`, a
 * fake `HOME`, `TEST_WORKER_INDEX=0`, a hostile `HOST`/`NODE_ENV`) cannot
 * steer the config toward a user-owned path or the API child env, that every
 * config evaluation allocates a fresh non-empty mkdtemp root with the DB
 * inside it, that a config returning an untrusted root is rejected BEFORE any
 * cleanup tracking, and that the teardown refuses any target that is not
 * exactly this harness's mkdtemp shape — leaving siblings and the fake HOME
 * untouched.
 *
 * Run: `corepack pnpm --filter @orcy/ui test:e2e:seeded:safety`
 * (vitest.config.ts excludes e2e/** on purpose — the Playwright specs are not
 * vitest tests; this safety suite runs under vitest.safety.config.ts instead.)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { FullConfig } from "@playwright/test";
import { RUN_ROOT_PREFIX } from "../seeded.harness.constants.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** packages/ui — where node_modules/@playwright/test/cli.js and configs live. */
const pkgRoot = path.resolve(__dirname, "..");

/** Track every dir this test creates so cleanup removes exactly those. */
const created: string[] = [];
function ownTemp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

const savedEnv: Record<string, string | undefined> = {};
const HOSTILE_KEYS = [
  "TEST_WORKER_INDEX",
  "ORCY_SEEDED_E2E_RUN_ROOT",
  "DB_PATH",
  "HOME",
  "HOST",
  "NODE_ENV",
] as const;

afterEach(() => {
  for (const key of HOSTILE_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

/**
 * Validate a config-provided root BEFORE registering it for recursive
 * cleanup. An unvalidated push would let afterEach `rmSync` delete whatever
 * an untrusted/mutated config reported — so every ownership assertion runs
 * first and a failing config never reaches `created`.
 */
function registerConfigRoot(meta: { runRoot: string; dbPath: string }): void {
  expect(meta.runRoot).toBeTruthy();
  expect(isOwnedRoot(meta.runRoot)).toBe(true);
  expect(meta.dbPath).toBeTruthy();
  expect(path.dirname(meta.dbPath)).toBe(meta.runRoot);
  expect(path.basename(meta.dbPath).length).toBeGreaterThan(0);
  // Never the env-supplied root, the env DB's parent, or anything under HOME.
  const envRoot = process.env.ORCY_SEEDED_E2E_RUN_ROOT;
  if (envRoot) expect(meta.runRoot).not.toBe(envRoot);
  const envDb = process.env.DB_PATH;
  if (envDb) expect(meta.runRoot).not.toBe(path.dirname(envDb));
  const home = process.env.HOME;
  if (home && home !== tmpdir() && home !== path.sep) {
    expect(meta.runRoot.startsWith(home + path.sep)).toBe(false);
  }
  created.push(meta.runRoot); // validated config-owned mkdtemp root — clean it up too
}

/**
 * Import the config module as a FRESH evaluation. `vi.resetModules()` clears
 * the module registry so the dynamic import re-runs all module side effects
 * (a second `mkdtempSync`) — exactly how a Playwright worker re-evaluates it.
 * The mkdtemp root each evaluation allocates is registered for exact cleanup
 * only after `registerConfigRoot` accepts it.
 */
async function importConfigFresh(): Promise<{
  runRoot: string;
  dbPath: string;
  apiEnv: Record<string, string | undefined>;
  previewCommand: string;
}> {
  vi.resetModules();
  const mod = (await import("../playwright.seeded.config.ts")) as unknown as {
    default: {
      metadata?: { runRoot?: unknown; dbPath?: unknown };
      webServer?: Array<{ env?: Record<string, string | undefined>; command?: string }>;
    };
  };
  const meta = {
    runRoot: String(mod.default.metadata?.runRoot ?? ""),
    dbPath: String(mod.default.metadata?.dbPath ?? ""),
  };
  registerConfigRoot(meta);
  return {
    ...meta,
    apiEnv: mod.default.webServer?.[0]?.env ?? {},
    previewCommand: mod.default.webServer?.[1]?.command ?? "",
  };
}

/** The hard ownership shape the teardown demands (mirrors its check). */
function isOwnedRoot(root: string): boolean {
  return (
    path.dirname(root) === tmpdir() &&
    path.basename(root).startsWith(RUN_ROOT_PREFIX) &&
    path.basename(root).length > RUN_ROOT_PREFIX.length
  );
}

describe("seeded harness safety (#147)", () => {
  test("hostile env cannot steer run root or DB path; each evaluation gets a fresh non-empty root", async () => {
    const fakeHome = ownTemp("orcy-safety-fakehome-");
    const sentinelRoot = ownTemp("orcy-safety-sentinel-root-");
    const sentinelDb = path.join(fakeHome, "sentinel.db");
    for (const key of HOSTILE_KEYS) savedEnv[key] = process.env[key];
    process.env.TEST_WORKER_INDEX = "0";
    process.env.ORCY_SEEDED_E2E_RUN_ROOT = sentinelRoot;
    process.env.DB_PATH = sentinelDb;
    process.env.HOME = fakeHome;

    const first = await importConfigFresh();
    const second = await importConfigFresh();

    for (const meta of [first, second]) {
      expect(meta.runRoot).toBeTruthy();
      expect(isOwnedRoot(meta.runRoot)).toBe(true);
      // Not the env-supplied root; not anywhere under the fake (or real) HOME.
      expect(meta.runRoot).not.toBe(sentinelRoot);
      expect(meta.dbPath).toBeTruthy();
      expect(meta.dbPath).not.toBe(sentinelDb);
      expect(path.dirname(meta.dbPath)).toBe(meta.runRoot);
      expect(path.basename(meta.dbPath).length).toBeGreaterThan(0);
      expect(meta.dbPath.startsWith(fakeHome)).toBe(false);
      expect(meta.dbPath.startsWith(sentinelRoot)).toBe(false);
    }
    // Re-evaluation must allocate a NEW root — never share or reuse.
    expect(first.runRoot).not.toBe(second.runRoot);
  });

  test("hostile HOST/NODE_ENV cannot steer the API child env; preview stays loopback", async () => {
    for (const key of HOSTILE_KEYS) savedEnv[key] = process.env[key];
    process.env.HOST = "0.0.0.0";
    process.env.NODE_ENV = "production";

    const cfg = await importConfigFresh();

    expect(cfg.apiEnv.HOST).toBe("127.0.0.1");
    expect(cfg.apiEnv.NODE_ENV).toBe("development");
    expect(cfg.previewCommand).toContain("--host 127.0.0.1");
  });

  test("a config returning an untrusted root is rejected BEFORE cleanup tracking — sentinel survives", async () => {
    const fakeHome = ownTemp("orcy-safety-fakehome-");
    const evilRoot = path.join(fakeHome, "evil-root");
    mkdirSync(evilRoot, { recursive: true });
    const marker = path.join(evilRoot, "sentinel.txt");
    writeFileSync(marker, "sentinel");
    for (const key of HOSTILE_KEYS) savedEnv[key] = process.env[key];
    process.env.ORCY_SEEDED_E2E_RUN_ROOT = evilRoot;

    vi.resetModules();
    vi.doMock("../playwright.seeded.config.ts", () => ({
      default: {
        metadata: { runRoot: evilRoot, dbPath: path.join(evilRoot, "evil.db") },
      },
    }));
    try {
      // The ownership assertion must fire inside importConfigFresh, BEFORE the
      // root can be pushed into `created` — otherwise afterEach would rmSync
      // an untrusted path.
      await expect(importConfigFresh()).rejects.toThrow();
      expect(created).not.toContain(evilRoot);
      expect(existsSync(marker)).toBe(true);
    } finally {
      vi.doUnmock("../playwright.seeded.config.ts");
    }
  });

  test("teardown refuses unowned targets (empty, sentinel, fake HOME) — nothing deleted", async () => {
    const teardown = (await import("../playwright.seeded.teardown.ts")) as {
      default: (config: FullConfig) => Promise<void>;
    };

    // Empty string: no-op.
    await teardown.default({ metadata: { runRoot: "" } } as unknown as FullConfig);

    // Env-sentinel-shaped target: refused, and the target still exists.
    const fakeHome = ownTemp("orcy-safety-fakehome-");
    const marker = path.join(fakeHome, "do-not-delete.txt");
    writeFileSync(marker, "sentinel");
    await teardown.default({ metadata: { runRoot: fakeHome } } as unknown as FullConfig);
    expect(existsSync(marker)).toBe(true);

    const sentinelRoot = ownTemp("orcy-safety-sentinel-root-");
    await teardown.default({
      metadata: { runRoot: sentinelRoot },
    } as unknown as FullConfig);
    expect(existsSync(sentinelRoot)).toBe(true);
  });

  test("teardown deletes exactly the owned mkdtemp root and leaves siblings untouched", async () => {
    const teardown = (await import("../playwright.seeded.teardown.ts")) as {
      default: (config: FullConfig) => Promise<void>;
    };

    const owned = ownTemp(RUN_ROOT_PREFIX);
    const sibling = ownTemp(RUN_ROOT_PREFIX);
    const siblingMarker = path.join(sibling, "sibling-marker.txt");
    mkdirSync(sibling, { recursive: true }); // no-op if present; owned shape stays valid
    writeFileSync(siblingMarker, "sibling");

    await teardown.default({ metadata: { runRoot: owned } } as unknown as FullConfig);

    expect(existsSync(owned)).toBe(false);
    expect(existsSync(siblingMarker)).toBe(true);
    expect(existsSync(sibling)).toBe(true);
    // Remove from cleanup tracking — teardown already removed it.
    const idx = created.indexOf(owned);
    if (idx >= 0) created.splice(idx, 1);
  });

  // T6 regression: `--list` loads configs but boots no servers, so these are
  // cheap; execFileSync throws on any non-zero exit (real exit codes only).
  test("default playwright run collects neither seeded harness file (--list)", { timeout: 90_000 }, async () => {
    const out = execFileSync(
      process.execPath,
      ["node_modules/@playwright/test/cli.js", "test", "--list"],
      { cwd: pkgRoot, encoding: "utf8", timeout: 60_000 },
    );
    expect(out).not.toContain("learning-loop-seeded");
    expect(out).not.toContain("playwright.seeded.safety");
  });

  test("dedicated seeded config lists exactly the seeded spec (--list)", { timeout: 90_000 }, async () => {
    const out = execFileSync(
      process.execPath,
      ["node_modules/@playwright/test/cli.js", "test", "-c", "playwright.seeded.config.ts", "--list"],
      { cwd: pkgRoot, encoding: "utf8", timeout: 60_000 },
    );
    expect(out).toContain("learning-loop-seeded.spec.ts");
    expect(out).not.toContain("playwright.seeded.safety");
    // --list evaluates the config module (allocating a run root no teardown
    // will clean) — remove exactly that owned root, nothing else.
    const m = /\[seeded-e2e\] run root: (\S+)/.exec(out);
    if (!m || !isOwnedRoot(m[1])) throw new Error(`no owned run root in --list output: ${out.slice(0, 200)}`);
    rmSync(m[1], { recursive: true, force: true });
  });
});
