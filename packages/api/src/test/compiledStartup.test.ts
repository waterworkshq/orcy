/**
 * F1 — ESM-safe compiled API startup smoke test.
 *
 * Proves the compiled API binary (`dist/index.js`) launched by `node` — matching
 * the installer shim (`exec node "${ORCY_HOME}/node_modules/@orcy/api/dist/index.js" "$@"`)
 * and the systemd unit — starts cleanly on a supported Node runtime without
 * `ERR_AMBIGUOUS_MODULE_SYNTAX` or `ReferenceError: __dirname is not defined`.
 *
 * Two subprocess modes are exercised:
 *  1. **Workspace branch** — launches from inside the repo so `getWorkspaceRoot()`
 *     finds `pnpm-workspace.yaml` and `initDb()` uses the workspace drizzle folder.
 *  2. **Installed-package fallback** — launches from a disposable copied package
 *     outside any pnpm workspace, forcing `initDb()` to resolve
 *     `productionMigrationFolder` (the branch that used CommonJS `__dirname`).
 *
 * Uses a prepared current-schema database (all migration SQL files applied +
 * `__drizzle_migrations` pre-populated) to isolate module/path correctness from
 * the journal-baseline repair owned by F2.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execSync, spawn } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdirSync,
  cpSync,
  copyFileSync,
  symlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import net from "node:net";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..", "..");
const WORKSPACE_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const DIST_ENTRY = join(PACKAGE_ROOT, "dist", "index.js");
const DIST_DB_INDEX = join(PACKAGE_ROOT, "dist", "db", "index.js");
const DIST_DB_DIR = join(PACKAGE_ROOT, "dist", "db");
const DRIZZLE_DIR = join(PACKAGE_ROOT, "drizzle");

const STRONG_JWT = "f1-smoke-test-only-jwt-secret-0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFreePort(): Promise<number> {
  return new Promise((resolveFn, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolveFn(port));
      } else {
        srv.close();
        reject(new Error("Could not determine free port"));
      }
    });
    srv.on("error", reject);
  });
}

/**
 * Execute migration SQL on a better-sqlite3 connection, suppressing the same
 * benign error class as the test helper `runMigrationSql` in `db/index.ts`
 * (0000_schema.sql consolidates tables/columns that later migrations also touch).
 */
function applyMigrationSql(db: Database.Database, sqlText: string): void {
  const statements = sqlText
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    try {
      db.exec(stmt);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err ?? "");
      if (
        !msg.includes("already exists") &&
        !msg.includes("no such table") &&
        !msg.includes("no such column") &&
        !msg.includes("no such index") &&
        !msg.includes("duplicate column name")
      ) {
        throw err;
      }
    }
  }
}

/**
 * Create a database with the FULL current schema by applying every migration
 * SQL file, then seed `__drizzle_migrations` with the journal-listed hashes so
 * the Drizzle `migrate()` is a no-op when the compiled binary boots. This
 * isolates F1's module/path correctness from the journal-baseline gap (N2)
 * owned by F2.
 */
function prepareCurrentSchemaDatabase(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");

  const schemaFile = join(DRIZZLE_DIR, "0000_schema.sql");
  if (existsSync(schemaFile)) {
    applyMigrationSql(db, readFileSync(schemaFile, "utf-8"));
  }
  const incremental = readdirSync(DRIZZLE_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && f !== "0000_schema.sql")
    .sort();
  for (const file of incremental) {
    applyMigrationSql(db, readFileSync(join(DRIZZLE_DIR, file), "utf-8"));
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at NUMERIC
    )
  `);
  const journalPath = join(DRIZZLE_DIR, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf-8"));
  const insertHash = db.prepare(
    "INSERT OR IGNORE INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
  );
  for (const entry of journal.entries) {
    const sqlPath = join(DRIZZLE_DIR, `${entry.tag}.sql`);
    if (existsSync(sqlPath)) {
      const content = readFileSync(sqlPath, "utf-8");
      const hash = createHash("sha256").update(content).digest("hex");
      insertHash.run(hash, entry.when);
    }
  }

  db.close();
}

/**
 * F6 — Prepare a GENUINE legacy-ledger database: the consolidated `0000_schema`
 * baseline applied directly (so every baseline table already exists), a real
 * `__migrations` legacy ledger with a sentinel row, sentinel user data in a
 * real schema table + a dedicated sentinel table, and NO `__drizzle_migrations`.
 *
 * This is the exact state of a legitimate old database that must upgrade
 * through the compiled installed-package startup path. Without the F6 bridge,
 * `migrate()` sees an empty Drizzle ledger, treats the latest applied
 * migration as "none", and re-runs the non-idempotent `0000_schema.sql`
 * (`CREATE TABLE` — no `IF NOT EXISTS`), failing on the first duplicate table.
 */
function prepareLegacyLedgerDatabase(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");

  // Consolidated baseline only — every table in 0000_schema now exists.
  applyMigrationSql(db, readFileSync(join(DRIZZLE_DIR, "0000_schema.sql"), "utf-8"));

  // Legacy pre-Drizzle ledger with a sentinel row.
  db.exec(`
    CREATE TABLE __migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  db.prepare("INSERT INTO __migrations (name, applied_at) VALUES (?, ?)").run(
    "legacy_baseline",
    "2025-01-01T00:00:00.000Z",
  );

  // Sentinel user data in a real 0000-schema table untouched by 0001–0053.
  db.prepare("INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)").run(
    "f6-sentinel-org",
    "F6 Sentinel Org",
    "f6-sentinel",
  );

  // Dedicated sentinel table — arbitrary user data that must survive the upgrade.
  db.exec(`
    CREATE TABLE __f6_sentinel (
      id INTEGER PRIMARY KEY,
      payload TEXT NOT NULL
    )
  `);
  db.prepare("INSERT INTO __f6_sentinel (id, payload) VALUES (?, ?)").run(
    1,
    "f6-preserved-payload",
  );

  // Deliberately do NOT create __drizzle_migrations — this is the legacy state.
  const hasDrizzle = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
    .get();
  expect(hasDrizzle).toBeUndefined();

  db.close();
}

/**
 * Launch a compiled API entrypoint with `node`, poll `/health` until ready,
 * then SIGTERM and assert exit code 0. Child is SIGKILLed in finally as a
 * safety net. The caller owns temp-file cleanup.
 */
async function launchAndWaitForHealth(entrypoint: string, env: NodeJS.ProcessEnv): Promise<void> {
  const port = parseInt(env.PORT!, 10);
  const child = spawn(process.execPath, [entrypoint], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });

  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  child.on("exit", (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
  });

  try {
    const HEALTH_TIMEOUT = 30_000;
    const deadline = Date.now() + HEALTH_TIMEOUT;
    let ready = false;

    while (Date.now() < deadline) {
      if (exited) {
        throw new Error(
          `Compiled API exited prematurely (code=${exitCode}, signal=${exitSignal}) ` +
            `before reaching readiness.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        );
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) {
          const body = (await res.json()) as { status?: string };
          if (body.status === "ok") {
            ready = true;
            break;
          }
        }
      } catch {
        // Server not ready yet — keep polling.
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!ready) {
      throw new Error(
        `Compiled API did not reach the /health readiness point within ` +
          `${HEALTH_TIMEOUT}ms.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }

    const cleanExitCode = await new Promise<number | null>((resolveExit) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolveExit(null);
      }, 10_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolveExit(code);
      });
      child.kill("SIGTERM");
    });

    expect(cleanExitCode).toBe(0);
  } finally {
    if (!exited) {
      child.kill("SIGKILL");
    }
  }
}

/**
 * Walk upward from `start` and assert no ancestor contains
 * `pnpm-workspace.yaml` — proving the workspace migration branch cannot fire.
 */
function assertNoWorkspaceAncestor(start: string): void {
  let dir = start;
  while (true) {
    expect(
      existsSync(join(dir, "pnpm-workspace.yaml")),
      `Unexpected pnpm-workspace.yaml at ${dir}`,
    ).toBe(false);
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("F1 — ESM-safe compiled API startup", () => {
  beforeAll(() => {
    execSync("pnpm --filter @orcy/api build", {
      cwd: WORKSPACE_ROOT,
      stdio: "pipe",
      timeout: 120_000,
    });
  }, 120_000);

  describe("compiled build output", () => {
    it("emits no CommonJS __dirname reference in the compiled db module", () => {
      const compiled = readFileSync(DIST_DB_INDEX, "utf-8");
      expect(compiled).not.toContain("__dirname");
    });

    it("productionMigrationFolder resolves to the existing drizzle/ directory", () => {
      const resolved = resolve(DIST_DB_DIR, "..", "..", "drizzle");
      expect(existsSync(resolved)).toBe(true);
      expect(existsSync(join(resolved, "0000_schema.sql"))).toBe(true);
    });
  });

  describe("workspace migration branch", () => {
    it("launches from the repo dist/ and reaches /health via the workspace drizzle folder", async () => {
      const tempDir = join(tmpdir(), `orcy-f1-ws-${process.pid}-${Date.now()}`);
      mkdirSync(tempDir, { recursive: true });

      try {
        const dbPath = join(tempDir, "smoke.db");
        const port = await getFreePort();
        prepareCurrentSchemaDatabase(dbPath);

        await launchAndWaitForHealth(DIST_ENTRY, {
          ...process.env,
          NODE_ENV: "production",
          DB_PATH: dbPath,
          PORT: String(port),
          HOST: "127.0.0.1",
          JWT_SECRET: STRONG_JWT,
          ORCY_REGISTRATION_TOKEN: "f1-smoke-test-only-token",
          HOME: tempDir,
          LOG_LEVEL: "error",
        });
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }, 120_000);
  });

  describe("installed-package migration fallback", () => {
    it("launches from a copied package outside the workspace and reaches /health via productionMigrationFolder", async () => {
      const tempRoot = join(tmpdir(), `orcy-f1-inst-${process.pid}-${Date.now()}`);
      const pkgDir = join(tempRoot, "package");
      mkdirSync(pkgDir, { recursive: true });

      try {
        // Real copies (not symlinks) for dist/ and drizzle/ — Node ESM
        // resolves symlinks to their real path, so import.meta.dirname must
        // land inside the temp package to force the production fallback.
        cpSync(join(PACKAGE_ROOT, "dist"), join(pkgDir, "dist"), {
          recursive: true,
        });
        cpSync(DRIZZLE_DIR, join(pkgDir, "drizzle"), { recursive: true });
        copyFileSync(join(PACKAGE_ROOT, "package.json"), join(pkgDir, "package.json"));

        // Symlink node_modules so runtime dependencies resolve without
        // copying the entire pnpm store.
        symlinkSync(join(PACKAGE_ROOT, "node_modules"), join(pkgDir, "node_modules"), "dir");

        // Prove the workspace migration branch cannot fire from here.
        assertNoWorkspaceAncestor(tempRoot);

        // Prove the production drizzle folder exists in the copied layout.
        const installedDrizzle = join(pkgDir, "drizzle");
        expect(existsSync(installedDrizzle)).toBe(true);
        expect(existsSync(join(installedDrizzle, "0000_schema.sql"))).toBe(true);

        const dbPath = join(tempRoot, "smoke.db");
        const port = await getFreePort();
        prepareCurrentSchemaDatabase(dbPath);

        await launchAndWaitForHealth(join(pkgDir, "dist", "index.js"), {
          ...process.env,
          NODE_ENV: "production",
          DB_PATH: dbPath,
          PORT: String(port),
          HOST: "127.0.0.1",
          JWT_SECRET: STRONG_JWT,
          ORCY_REGISTRATION_TOKEN: "f1-smoke-test-only-token",
          HOME: tempRoot,
          LOG_LEVEL: "error",
        });
      } finally {
        // rmSync unlinks symlinks without recursing into their targets
        // (Node uses lstat), so the real node_modules/ is never touched.
        rmSync(tempRoot, { recursive: true, force: true });
      }
    }, 120_000);
  });

  // ------------------------------------------------------------------
  // F2a — Compiled installed-package with a GENUINELY EMPTY database
  // ------------------------------------------------------------------
  describe("compiled installed-package empty-database migration", () => {
    it("migrates an empty DB to readiness via the compiled binary, seeds templates, and leaves current schema", async () => {
      const tempRoot = join(tmpdir(), `orcy-f2a-empty-${process.pid}-${Date.now()}`);
      const pkgDir = join(tempRoot, "package");
      mkdirSync(pkgDir, { recursive: true });

      try {
        cpSync(join(PACKAGE_ROOT, "dist"), join(pkgDir, "dist"), { recursive: true });
        cpSync(DRIZZLE_DIR, join(pkgDir, "drizzle"), { recursive: true });
        copyFileSync(join(PACKAGE_ROOT, "package.json"), join(pkgDir, "package.json"));
        symlinkSync(join(PACKAGE_ROOT, "node_modules"), join(pkgDir, "node_modules"), "dir");

        assertNoWorkspaceAncestor(tempRoot);

        const dbPath = join(tempRoot, "empty.db");
        // Deliberately do NOT call prepareCurrentSchemaDatabase.
        expect(existsSync(dbPath)).toBe(false);

        const port = await getFreePort();
        await launchAndWaitForHealth(join(pkgDir, "dist", "index.js"), {
          ...process.env,
          NODE_ENV: "production",
          DB_PATH: dbPath,
          PORT: String(port),
          HOST: "127.0.0.1",
          JWT_SECRET: STRONG_JWT,
          ORCY_REGISTRATION_TOKEN: "f2a-empty-test-token",
          HOME: tempRoot,
          LOG_LEVEL: "error",
        });

        // The DB file now exists with the full migrated schema.
        expect(existsSync(dbPath)).toBe(true);
        const db = new Database(dbPath);

        // All journal entries recorded.
        const journal = JSON.parse(
          readFileSync(join(pkgDir, "drizzle", "meta", "_journal.json"), "utf-8"),
        );
        const migrationCount = (
          db.prepare("SELECT COUNT(*) as n FROM __drizzle_migrations").get() as { n: number }
        ).n;
        expect(migrationCount).toBe(journal.entries.length);

        // Representative post-consolidation tables exist.
        const tableExists = (name: string) =>
          db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
        for (const t of [
          "plugin_enrollments",
          "plugin_runs",
          "plugin_quarantines",
          "wiki_pages",
          "wiki_pages_fts",
          "workflows",
          "finding_triage",
          "releases",
        ]) {
          expect(tableExists(t)).toBeDefined();
        }

        // workflow_template column exists.
        const cols = db.prepare("PRAGMA table_info(mission_templates)").all() as { name: string }[];
        expect(cols.map((c) => c.name)).toContain("workflow_template");

        // Global templates were seeded.
        const templateCount = (
          db.prepare("SELECT COUNT(*) as n FROM mission_templates").get() as { n: number }
        ).n;
        expect(templateCount).toBeGreaterThan(0);

        db.close();
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    }, 120_000);
  });

  // ------------------------------------------------------------------
  // F6 — Compiled installed-package legacy-ledger upgrade + idempotency
  // ------------------------------------------------------------------
  describe("compiled installed-package legacy-ledger upgrade", () => {
    it("upgrades a legacy __migrations database via the compiled binary, preserves sentinel data, records the bridged baseline, and is idempotent on reboot", async () => {
      const tempRoot = join(tmpdir(), `orcy-f6-legacy-${process.pid}-${Date.now()}`);
      const pkgDir = join(tempRoot, "package");
      mkdirSync(pkgDir, { recursive: true });

      try {
        cpSync(join(PACKAGE_ROOT, "dist"), join(pkgDir, "dist"), { recursive: true });
        cpSync(DRIZZLE_DIR, join(pkgDir, "drizzle"), { recursive: true });
        copyFileSync(join(PACKAGE_ROOT, "package.json"), join(pkgDir, "package.json"));
        symlinkSync(join(PACKAGE_ROOT, "node_modules"), join(pkgDir, "node_modules"), "dir");

        // The copied package must be physically outside any pnpm workspace so
        // the workspace migration branch cannot fire.
        assertNoWorkspaceAncestor(tempRoot);

        const installedDrizzle = join(pkgDir, "drizzle");
        expect(existsSync(join(installedDrizzle, "0000_schema.sql"))).toBe(true);

        const journal = JSON.parse(
          readFileSync(join(installedDrizzle, "meta", "_journal.json"), "utf-8"),
        );
        const expectedMigrationCount = journal.entries.length;
        const baselineWhen = journal.entries[0].when;
        const baselineHash = createHash("sha256")
          .update(readFileSync(join(installedDrizzle, "0000_schema.sql"), "utf-8"))
          .digest("hex");

        const dbPath = join(tempRoot, "legacy.db");
        prepareLegacyLedgerDatabase(dbPath);

        const baseEnv = {
          ...process.env,
          NODE_ENV: "production",
          DB_PATH: dbPath,
          HOST: "127.0.0.1",
          JWT_SECRET: STRONG_JWT,
          ORCY_REGISTRATION_TOKEN: "f6-legacy-upgrade-token",
          HOME: tempRoot,
          LOG_LEVEL: "error",
        };

        // --- Boot 1: legacy -> upgraded ---------------------------------
        // Reaching /health proves the duplicate-CREATE-TABLE failure is gone:
        // without the bridge, migrate() re-runs 0000_schema.sql and throws on
        // the first already-existing table before the server becomes ready.
        const port1 = await getFreePort();
        await launchAndWaitForHealth(join(pkgDir, "dist", "index.js"), {
          ...baseEnv,
          PORT: String(port1),
        });

        const db = new Database(dbPath);

        // Sentinel user data in a real schema table survived the upgrade.
        const org = db
          .prepare("SELECT id, name, slug FROM organizations WHERE id = ?")
          .get("f6-sentinel-org") as { name: string; slug: string } | undefined;
        expect(org?.slug).toBe("f6-sentinel");

        // Dedicated sentinel table + payload survived.
        const sentinel = db.prepare("SELECT payload FROM __f6_sentinel WHERE id = 1").get() as
          | { payload: string }
          | undefined;
        expect(sentinel?.payload).toBe("f6-preserved-payload");

        // Legacy ledger table is untouched by the bridge.
        const legacyLedger = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__migrations'")
          .get();
        expect(legacyLedger).toBeDefined();
        const legacyRows = db.prepare("SELECT COUNT(*) as n FROM __migrations").get() as {
          n: number;
        };
        expect(legacyRows.n).toBe(1);

        // Drizzle ledger now records every journal entry: the bridged 0000
        // baseline plus every active entry applied by migrate().
        const migrationCount = db
          .prepare("SELECT COUNT(*) as n FROM __drizzle_migrations")
          .get() as { n: number };
        expect(migrationCount.n).toBe(expectedMigrationCount);

        // The BRIDGE (not migrate) recorded the 0000 baseline: migrate never
        // ran 0000, so its row can only exist because the bridge inserted it.
        const baselineRow = db
          .prepare("SELECT created_at FROM __drizzle_migrations WHERE hash = ? AND created_at = ?")
          .get(baselineHash, baselineWhen) as { created_at: number } | undefined;
        expect(baselineRow).toBeDefined();

        // Post-consolidation tables exist (migrate ran the 0027–0053 chain).
        const tableExists = (name: string) =>
          db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
        for (const t of ["plugin_enrollments", "plugin_quarantines", "wiki_pages", "releases"]) {
          expect(tableExists(t)).toBeDefined();
        }

        db.close();

        // --- Boot 2: idempotent reboot ----------------------------------
        const port2 = await getFreePort();
        await launchAndWaitForHealth(join(pkgDir, "dist", "index.js"), {
          ...baseEnv,
          PORT: String(port2),
        });

        const db2 = new Database(dbPath);

        // Ledger did not grow — bridge INSERT OR IGNORE + migrate no-op.
        const migrationCount2 = db2
          .prepare("SELECT COUNT(*) as n FROM __drizzle_migrations")
          .get() as { n: number };
        expect(migrationCount2.n).toBe(expectedMigrationCount);

        // Sentinels still present after the second boot.
        const org2 = db2
          .prepare("SELECT slug FROM organizations WHERE id = ?")
          .get("f6-sentinel-org") as { slug: string } | undefined;
        expect(org2?.slug).toBe("f6-sentinel");
        const sentinel2 = db2.prepare("SELECT payload FROM __f6_sentinel WHERE id = 1").get() as
          | { payload: string }
          | undefined;
        expect(sentinel2?.payload).toBe("f6-preserved-payload");

        db2.close();
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    }, 180_000);
  });
});
