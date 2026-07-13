import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { join, dirname } from "path";
import { existsSync, readFileSync, mkdirSync, readdirSync } from "fs";
import { ORCY_PATHS } from "@orcy/shared";
import { createHash } from "crypto";
import { setDriver } from "./dialect-helpers.js";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { seedGlobalTemplates } from "../repositories/template.js";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";

type DrizzleDb = BetterSQLite3Database<typeof schema>;

function findWorkspaceRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export function getWorkspaceRoot(): string {
  return findWorkspaceRoot(import.meta.dirname);
}

export function getDefaultDbPath(): string {
  if (!existsSync(ORCY_PATHS.home)) {
    mkdirSync(ORCY_PATHS.home, { recursive: true });
  }
  return ORCY_PATHS.databaseFile;
}

let _drizzleDb: DrizzleDb | null = null;
let _sqlite: import("better-sqlite3").Database | null = null;

export function getDb(): DrizzleDb {
  if (_drizzleDb) return _drizzleDb;
  throw new Error("Database not initialized. Call initDb() first.");
}

/**
 * ADR-0039 Q9 — Apply the plugin quarantine kind-safe reset (migration 0053).
 *
 * The Drizzle journal-based `migrate()` only tracks a subset of historical
 * migrations (0000–0002 after the schema consolidation at commit 09d24f4).
 * The quarantine reset lives in migration 0053 and must be applied
 * independently so legacy `pluginId:contributionId` rows are cleared on
 * upgrade. This runs inside `initDb()` — the actual production migration
 * path — not the test-only file scanner.
 *
 * Idempotency: the migration hash is recorded in `__drizzle_migrations`
 * (the same table Drizzle's `migrate()` uses), so this executes exactly
 * once per database. On databases where `plugin_quarantines` does not exist
 * (fresh install via the journal path, which only applies 0000–0002), the
 * reset is silently skipped — there is nothing to clear.
 */
export function applyQuarantineReset(migrationFolder: string): void {
  if (!_sqlite) return;

  const tableExists = _sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plugin_quarantines'")
    .get();
  if (!tableExists) return;

  const migrationPath = join(migrationFolder, "0053_plugin_quarantine_kind_safe_reset.sql");
  if (!existsSync(migrationPath)) return;

  const migrationContent = readFileSync(migrationPath, "utf-8");
  const hash = createHash("sha256").update(migrationContent).digest("hex");

  _sqlite
    .prepare(
      "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)",
    )
    .run();

  const alreadyApplied = _sqlite
    .prepare("SELECT id FROM __drizzle_migrations WHERE hash = ?")
    .get(hash);
  if (alreadyApplied) return;

  const statements = migrationContent
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    _sqlite.exec(stmt);
  }

  _sqlite
    .prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
    .run(hash, Date.now());
}

export async function initDb(dbPath?: string) {
  const Database = (await import("better-sqlite3")).default;
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");

  const path = dbPath || process.env.DB_PATH || getDefaultDbPath();

  _sqlite = new Database(path);
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("foreign_keys = ON");

  _drizzleDb = drizzle(_sqlite, { schema });
  setDriver("sqlite");

  const migrationFolder = join(getWorkspaceRoot(), "packages", "api", "drizzle");
  const productionMigrationFolder = join(__dirname, "..", "..", "drizzle");

  if (existsSync(migrationFolder)) {
    const hasOldMigrations = _drizzleDb.get(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name='__migrations'`,
    );
    if (hasOldMigrations) {
      const journalPath = join(migrationFolder, "meta", "_journal.json");
      if (existsSync(journalPath)) {
        const journal = JSON.parse(readFileSync(journalPath, "utf-8"));
        const firstEntry = journal.entries[0];
        if (firstEntry) {
          const migrationFile = join(migrationFolder, `${firstEntry.tag}.sql`);
          if (existsSync(migrationFile)) {
            const migrationContent = readFileSync(migrationFile, "utf-8");
            const hash = createHash("sha256").update(migrationContent).digest("hex");
            _drizzleDb.run(
              sql`INSERT OR IGNORE INTO __drizzle_migrations (hash, created_at) VALUES (${hash}, ${firstEntry.when})`,
            );
          }
        }
      }
    }
    migrate(_drizzleDb, { migrationsFolder: migrationFolder });
    applyQuarantineReset(migrationFolder);
  } else if (existsSync(productionMigrationFolder)) {
    migrate(_drizzleDb, { migrationsFolder: productionMigrationFolder });
    applyQuarantineReset(productionMigrationFolder);
  }

  if (process.env.NODE_ENV !== "production") {
    await seedDefaultUser();
  }
  seedGlobalTemplates();

  return _drizzleDb;
}

// --- Test DB performance caches -------------------------------------------------------------
// initTestDb() is invoked per-test (beforeEach) across the whole @orcy/api suite.
// Doing a full WASM init + schema migration + bcrypt seed on every call made the suite
// ~10x slower than necessary (~97ms/call). These three caches collapse per-test cost to
// sub-millisecond after the first call in a process:
//   _sqlFactory  -> initialized sql.js module (avoids recompiling WASM each call)
//   _adminHash   -> bcrypt hash of the seed admin password (bcrypt.hash is the single
//                   biggest line item at ~46ms/call; the hash is only ever compared via
//                   bcrypt.compare, so a cached literal is safe)
//   _snapshot    -> bytes of a freshly built+seeded DB; restored via `new SQL.Database(bytes)`
//                   which copies the bytes, so per-test isolation is preserved.
// Vitest isolates the module registry per file, so the snapshot is naturally scoped per
// file (first test in a file pays the cold build, the rest restore from the snapshot).
// Do NOT remove these caches or call clearTestDbCache() in beforeEach/afterEach — that
// defeats the entire optimization and reintroduces the ~150s suite runtime.
let _sqlFactory: any = null;
let _adminHash: string | null = null;
let _snapshot: Uint8Array | null = null;

async function getSqlFactory(): Promise<any> {
  if (!_sqlFactory) {
    const initSqlJs = (await import("sql.js")).default;
    _sqlFactory = await initSqlJs();
  }
  return _sqlFactory;
}

async function getAdminHash(): Promise<string> {
  if (!_adminHash) {
    _adminHash = await bcrypt.hash("admin123", 10);
  }
  return _adminHash;
}

function applyMigrations(testSqlite: any, migrationFolder: string): void {
  const schemaFile = join(migrationFolder, "0000_schema.sql");
  if (existsSync(schemaFile)) {
    runMigrationSql(testSqlite, readFileSync(schemaFile, "utf-8"));
  }
  const incrementalMigrations = readdirSync(migrationFolder)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && f !== "0000_schema.sql")
    .sort();
  for (const migrationFile of incrementalMigrations) {
    runMigrationSql(testSqlite, readFileSync(join(migrationFolder, migrationFile), "utf-8"));
  }
}

function runMigrationSql(testSqlite: any, sqlText: string): void {
  let fts5Available = true;
  const statements = sqlText
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    if (!fts5Available && stmt.includes("wiki_pages_fts")) {
      continue;
    }
    try {
      testSqlite.run(stmt);
    } catch (err: any) {
      const msg = String(err?.message ?? err ?? "");
      if (/no such module.*fts5/i.test(msg)) {
        // Some SQLite builds, including sql.js in tests, omit FTS5. Base wiki tables still
        // migrate successfully; FTS-dependent statements are skipped and search uses LIKE.
        fts5Available = false;
        continue;
      }
      if (
        !msg.includes("already exists") &&
        !msg.includes("no such table") &&
        !msg.includes("no such column") &&
        !msg.includes("no such index") &&
        !msg.includes("duplicate column name")
      )
        throw err;
    }
  }
}

export async function initTestDb() {
  const { drizzle } = await import("drizzle-orm/sql-js");
  const migrationFolder = join(getWorkspaceRoot(), "packages", "api", "drizzle");

  // Fast path: restore a previously snapshotted schema+seed DB. `new SQL.Database(bytes)`
  // copies the bytes, so each test gets an isolated mutable copy.
  if (_snapshot) {
    const SQL = await getSqlFactory();
    const testSqlite = new SQL.Database(_snapshot);
    // foreign_keys is a connection-level pragma (NOT persisted in the DB file), so it must
    // be re-enabled on every restored connection — otherwise ON DELETE CASCADE rules silently
    // stop firing. The original migrations set it, but snapshot restore skips migrations.
    testSqlite.run("PRAGMA foreign_keys = ON");
    _sqlite = testSqlite as any;
    _drizzleDb = drizzle(testSqlite, { schema }) as any;
    setDriver("sqlite");
    return _drizzleDb;
  }

  // Cold path: build schema, seed, then snapshot for fast subsequent resets.
  const SQL = await getSqlFactory();
  const testSqlite = new SQL.Database();
  testSqlite.run("PRAGMA foreign_keys = ON");
  _sqlite = testSqlite as any;
  _drizzleDb = drizzle(testSqlite, { schema }) as any;
  setDriver("sqlite");

  applyMigrations(testSqlite, migrationFolder);

  await seedDefaultUser();
  seedGlobalTemplates();

  _snapshot = testSqlite.export();
  return _drizzleDb;
}

async function seedDefaultUser(): Promise<void> {
  const db = getDb();
  const result = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(schema.users)
    .get();
  if ((result?.count ?? 0) > 0) return;

  const passwordHash = await getAdminHash();
  const id = uuidv4();
  const now = new Date().toISOString();

  db.insert(schema.users)
    .values({
      id,
      username: "admin",
      passwordHash,
      displayName: "Administrator",
      role: "admin",
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

export function closeDb() {
  if (_sqlite) {
    try {
      _sqlite.close();
    } catch (err) {
      logger.error({ err }, "Failed to close database connection");
    }
  }
  _drizzleDb = null;
  _sqlite = null;
}
