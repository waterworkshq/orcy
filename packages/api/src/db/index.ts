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
 * F3 — SHA-256 of `0053_plugin_quarantine_kind_safe_reset.sql` AS IT SHIPPED
 * before the F3 immutability banner was prepended.
 *
 * The retired out-of-band `applyQuarantineReset()` runner recorded this exact
 * hash into `__drizzle_migrations` with `created_at = Date.now()`. F3 prepended
 * an immutability banner to the migration file, changing its bytes (and thus
 * its current SHA-256). Without recognizing this prior hash, a prerelease
 * database carrying the old high-timestamp marker would be invisible to
 * `reconcilePrereleaseMigrationMarker()` and the marker would keep suppressing
 * the entire 0027–0053 structural chain.
 *
 * Captured from the pre-F3 file bytes (unchanged since commit 7ac2a4a). This is
 * a historical constant and must never change.
 */
export const PRERELEASE_0053_MARKER_HASH =
  "92898f7a6e43fccd80baaf7ad3a7cdc506212fbf5363c45f3182378ca1f6408a";

/**
 * F2/F2a/F3 — Reconcile the known prerelease 0053 migration marker.
 *
 * Before the journal was repaired (F2), migration 0053 was applied
 * out-of-band by `applyQuarantineReset()`, which inserted the 0053 file
 * hash into `__drizzle_migrations` with `created_at = Date.now()`. Drizzle's
 * `migrate()` decides what to run by fetching only the single latest
 * `created_at` row (`ORDER BY created_at DESC LIMIT 1`) and running every
 * journal entry whose `when` (folderMillis) is strictly greater. A high
 * `Date.now()` marker therefore suppresses every structural migration
 * 0027–0053 even though their schema changes were never applied to the
 * database.
 *
 * Now that 0053 is part of the ordered journal, this function removes the
 * stale prerelease marker so `migrate()` can run the full post-consolidation
 * chain in sequence. It touches ONLY rows whose hash is a recognized 0053
 * hash AND whose `created_at` does not match the journal's canonical `when`
 * for 0053 — a legitimate `migrate()`-applied row (created_at === journal
 * when) is never disturbed.
 *
 * F3 — The recognized hash set contains the CURRENT 0053 file hash (canonical,
 * recorded by `migrate()` going forward) AND `PRERELEASE_0053_MARKER_HASH`
 * (recorded by the retired runner before the immutability banner changed the
 * bytes). This dual recognition is the bridge that lets the banner land without
 * stranding a prerelease marker.
 *
 * F2a — The stale marker is evidence that the destructive 0053 reset
 * ALREADY RAN. Removing it makes 0053 eligible to run again via `migrate()`.
 * But 0053 is `DELETE FROM plugin_quarantines` — a blanket wipe that cannot
 * distinguish legacy rows from canonical kind-aware rows added after the
 * first reset. To preserve those canonical rows, the existing contents of
 * `plugin_quarantines` are copied into a durable backup table
 * (`__f2_quarantine_preserve`) before the marker is deleted. After
 * `migrate()` completes, `restorePreservedQuarantineRows()` copies them
 * back and drops the backup. The backup is durable (stored in the database
 * file), so a crash between marker deletion and restore is recovered on the
 * next successful boot.
 */
function reconcilePrereleaseMigrationMarker(migrationFolder: string): void {
  if (!_sqlite) return;

  const markerTag = "0053_plugin_quarantine_kind_safe_reset";
  const markerPath = join(migrationFolder, `${markerTag}.sql`);
  if (!existsSync(markerPath)) return;

  const journalPath = join(migrationFolder, "meta", "_journal.json");
  if (!existsSync(journalPath)) return;
  const journal = JSON.parse(readFileSync(journalPath, "utf-8"));
  const markerEntry = journal.entries.find(
    (e: { tag: string; when: number }) => e.tag === markerTag,
  );
  if (!markerEntry) return;

  // F3 — Recognize both the CURRENT 0053 file hash (canonical, recorded by
  // migrate() going forward) and the legacy pre-F3 hash (recorded by the
  // retired out-of-band runner). Adding the immutability banner changed the
  // bytes; without the legacy hash the prerelease marker would be invisible.
  const markerContent = readFileSync(markerPath, "utf-8");
  const currentHash = createHash("sha256").update(markerContent).digest("hex");
  const recognizedHashes = [currentHash];
  if (PRERELEASE_0053_MARKER_HASH !== currentHash) {
    recognizedHashes.push(PRERELEASE_0053_MARKER_HASH);
  }

  _sqlite
    .prepare(
      "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)",
    )
    .run();

  // A prerelease marker is any recognized-0053-hash row whose created_at is NOT
  // the journal's canonical `when`. A legitimate migrate()-applied row always
  // has created_at === when and is never disturbed. Number() mirrors Drizzle's
  // NUMERIC created_at coercion on both sides.
  const placeholders = recognizedHashes.map(() => "?").join(",");
  const candidates = _sqlite
    .prepare(`SELECT hash, created_at FROM __drizzle_migrations WHERE hash IN (${placeholders})`)
    .all(...recognizedHashes) as { hash: string; created_at: number }[];
  const staleHashes = new Set(
    candidates.filter((r) => Number(r.created_at) !== Number(markerEntry.when)).map((r) => r.hash),
  );
  if (staleHashes.size === 0) return;

  // The stale marker proves the destructive 0053 reset ALREADY RAN. Removing it
  // makes 0053 eligible to run again via migrate(). But 0053 is a blanket
  // DELETE FROM plugin_quarantines that cannot distinguish legacy rows from
  // canonical kind-aware rows added after the first reset. Preserve the current
  // rows in a durable backup table before deleting any marker; restore happens
  // after migrate() completes (see restorePreservedQuarantineRows).
  const tableExists = _sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plugin_quarantines'")
    .get();
  if (tableExists) {
    const rowCount = (
      _sqlite.prepare("SELECT COUNT(*) as n FROM plugin_quarantines").get() as { n: number }
    ).n;
    if (rowCount > 0) {
      _sqlite.exec("DROP TABLE IF EXISTS __f2_quarantine_preserve");
      _sqlite.exec(
        "CREATE TABLE __f2_quarantine_preserve (plugin_key TEXT NOT NULL PRIMARY KEY, plugin_id TEXT NOT NULL, quarantined_at TEXT NOT NULL, reason TEXT)",
      );
      _sqlite.exec(
        "INSERT INTO __f2_quarantine_preserve (plugin_key, plugin_id, quarantined_at, reason) SELECT plugin_key, plugin_id, quarantined_at, reason FROM plugin_quarantines",
      );
    }
  }

  // Delete every stale recognized marker row. The `created_at != ?` guard
  // protects any legitimate migrate()-applied row from accidental deletion.
  for (const hash of staleHashes) {
    _sqlite
      .prepare("DELETE FROM __drizzle_migrations WHERE hash = ? AND created_at != ?")
      .run(hash, markerEntry.when);
  }
}

/**
 * F2a — Restore quarantine rows preserved by `reconcilePrereleaseMigrationMarker`.
 *
 * Called after `migrate()` on every boot. If a durable backup table exists
 * (created during prerelease marker reconciliation, or left over from a
 * crashed prior boot), copies the preserved rows back into
 * `plugin_quarantines` and drops the backup. Safe to call when no backup
 * exists (no-op).
 *
 * Uses `INSERT OR IGNORE` so new rows inserted by application code between
 * `migrate()` and this restore are not overwritten — only the backed-up
 * rows that were wiped by 0053's blanket DELETE are restored.
 */
function restorePreservedQuarantineRows(): void {
  if (!_sqlite) return;

  const backupExists = _sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='__f2_quarantine_preserve'",
    )
    .get();
  if (!backupExists) return;

  const targetExists = _sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plugin_quarantines'")
    .get();
  if (targetExists) {
    _sqlite.exec(
      "INSERT OR IGNORE INTO plugin_quarantines (plugin_key, plugin_id, quarantined_at, reason) SELECT plugin_key, plugin_id, quarantined_at, reason FROM __f2_quarantine_preserve",
    );
  }

  _sqlite.exec("DROP TABLE __f2_quarantine_preserve");
}

/**
 * F6 — Bridge a legacy `__migrations`-ledger database into the Drizzle world.
 *
 * A legitimate old database carries the pre-Drizzle `__migrations` ledger and
 * already owns every table defined by the consolidated `0000_schema` baseline
 * (it was created back when that schema WAS the full baseline). Without this
 * bridge, `migrate()` sees an empty `__drizzle_migrations` table, treats the
 * latest applied migration as "none", and re-runs the non-idempotent
 * `0000_schema.sql` (`CREATE TABLE` — no `IF NOT EXISTS`), which fails on the
 * first duplicate table.
 *
 * The bridge detects the legacy ledger, ensures `__drizzle_migrations` exists,
 * and records ONLY the consolidated `0000_schema` baseline hash (at the
 * journal's canonical `when`) as already applied. Normal Drizzle `migrate()`
 * then applies the remaining active entries (0001, 0002, 0027–0053) in order.
 *
 * Idempotency: `__drizzle_migrations` has no UNIQUE constraint on `hash` (only
 * `id PRIMARY KEY`), so `INSERT OR IGNORE` cannot deduplicate on hash — it only
 * ignores PRIMARY KEY collisions, which AUTOINCREMENT never produces. The
 * insert is therefore guarded by an explicit existence check so a second boot
 * finds the baseline row already recorded and skips, keeping the ledger stable
 * across reboots.
 *
 * Shared by BOTH migration-folder branches in `initDb()` (workspace source and
 * compiled installed-package) so the compiled startup path upgrades a legacy
 * database as cleanly as the source path. The legacy table's PRESENCE is the
 * compatibility signal — never special-case on release/version strings.
 */
function bridgeLegacyMigrationsLedger(migrationFolder: string): void {
  if (!_drizzleDb || !_sqlite) return;

  const hasOldMigrations = _drizzleDb.get(
    sql`SELECT name FROM sqlite_master WHERE type='table' AND name='__migrations'`,
  );
  if (!hasOldMigrations) return;

  _sqlite
    .prepare(
      "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)",
    )
    .run();
  const journalPath = join(migrationFolder, "meta", "_journal.json");
  if (!existsSync(journalPath)) return;
  const journal = JSON.parse(readFileSync(journalPath, "utf-8"));
  const firstEntry = journal.entries[0];
  if (!firstEntry) return;
  const migrationFile = join(migrationFolder, `${firstEntry.tag}.sql`);
  if (!existsSync(migrationFile)) return;
  const migrationContent = readFileSync(migrationFile, "utf-8");
  const hash = createHash("sha256").update(migrationContent).digest("hex");
  // Guard the insert: no UNIQUE on `hash` means INSERT OR IGNORE cannot
  // deduplicate, so check explicitly to stay idempotent across reboots.
  const alreadyRecorded = _sqlite
    .prepare("SELECT 1 FROM __drizzle_migrations WHERE hash = ? AND created_at = ?")
    .get(hash, firstEntry.when);
  if (alreadyRecorded) return;
  _drizzleDb.run(
    sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${hash}, ${firstEntry.when})`,
  );
}

export async function initDb(dbPath?: string) {
  const Database = (await import("better-sqlite3")).default;
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");

  const path = dbPath || process.env.DB_PATH || getDefaultDbPath();

  _sqlite = new Database(path);
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("foreign_keys = ON");
  // F4 — Bound SQLite write-lock contention. A transient external/process write
  // lock (e.g. a backup tool, a second connection mid-commit, or another process
  // holding the database's single write lock) would otherwise surface SQLITE_BUSY
  // immediately on the first contended write. With busy_timeout = 5000, the
  // connection waits up to five seconds for such a transient lock to clear before
  // surfacing SQLITE_BUSY. This is a bounded wait for transient contention only:
  // it is NOT cancellation of the pending write, deadlock recovery, automatic
  // retry after the timeout expires, or a claim of full multi-process support.
  // Set before migrations or application writes so startup itself benefits.
  _sqlite.pragma("busy_timeout = 5000");

  _drizzleDb = drizzle(_sqlite, { schema });
  setDriver("sqlite");

  const migrationFolder = join(getWorkspaceRoot(), "packages", "api", "drizzle");
  const productionMigrationFolder = join(import.meta.dirname, "..", "..", "drizzle");

  if (existsSync(migrationFolder)) {
    // F6 — legacy `__migrations` -> `__drizzle_migrations` baseline bridge is
    // shared by both branches so the compiled installed-package path upgrades
    // a legacy-ledger database as cleanly as the workspace source path.
    bridgeLegacyMigrationsLedger(migrationFolder);
    reconcilePrereleaseMigrationMarker(migrationFolder);
    migrate(_drizzleDb, { migrationsFolder: migrationFolder });
    restorePreservedQuarantineRows();
  } else if (existsSync(productionMigrationFolder)) {
    bridgeLegacyMigrationsLedger(productionMigrationFolder);
    reconcilePrereleaseMigrationMarker(productionMigrationFolder);
    migrate(_drizzleDb, { migrationsFolder: productionMigrationFolder });
    restorePreservedQuarantineRows();
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
