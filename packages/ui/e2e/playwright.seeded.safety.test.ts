/**
 * Safety proof for the seeded Learning Loop harness (#147).
 *
 * The harness's dangerous surface is its run-root/DB-path selection and its
 * teardown deletion. This suite proves, on every run, that a HOSTILE ambient
 * environment (a preset `ORCY_SEEDED_E2E_RUN_ROOT`, a preset `DB_PATH`, a
 * fake `HOME`, `TEST_WORKER_INDEX=0`) cannot steer the config toward a
 * user-owned path, that every config evaluation allocates a fresh non-empty
 * mkdtemp root with the DB inside it, and that the teardown refuses any
 * target that is not exactly this harness's mkdtemp shape — leaving siblings
 * and the fake HOME untouched.
 *
 * Run: `corepack pnpm --filter @orcy/ui test:e2e:seeded:safety`
 * (vitest.config.ts excludes e2e/** on purpose — the Playwright specs are not
 * vitest tests; this safety suite runs under vitest.safety.config.ts instead.)
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { FullConfig } from "@playwright/test";

const RUN_ROOT_PREFIX = "orcy-seeded-e2e-";

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
 * Import the config module as a FRESH evaluation. `vi.resetModules()` clears
 * the module registry so the dynamic import re-runs all module side effects
 * (a second `mkdtempSync`) — exactly how a Playwright worker re-evaluates it.
 * The mkdtemp root each evaluation allocates is tracked for exact cleanup.
 */
async function importConfigFresh(): Promise<{ runRoot: string; dbPath: string }> {
  vi.resetModules();
  const mod = (await import("../playwright.seeded.config.ts")) as unknown as {
    default: { metadata?: { runRoot?: unknown; dbPath?: unknown } };
  };
  const meta = {
    runRoot: String(mod.default.metadata?.runRoot ?? ""),
    dbPath: String(mod.default.metadata?.dbPath ?? ""),
  };
  created.push(meta.runRoot); // config-owned mkdtemp root — clean it up too
  return meta;
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
});
