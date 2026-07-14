/**
 * F2 — Production Drizzle migration chain: fresh install, upgrade, legacy
 * bridge, prerelease marker reconciliation, and schema-parity evidence.
 *
 * Every test in this file uses the production better-sqlite3 driver via
 * `initDb()` — NOT the test-only `initTestDb()` sql.js file scanner. File-
 * backed temp databases are created and destroyed per test so each scenario
 * starts from a known state.
 *
 * Coverage map (ticket F2 acceptance criteria):
 *   - Fresh empty database completes production startup + template seeding.
 *   - v0.29-style journal database upgrades once, preserves sentinel data,
 *     and boots idempotently.
 *   - Legacy `__migrations` database crosses the consolidation bridge.
 *   - Prerelease database with the out-of-band 0053 marker still runs every
 *     missing structural migration.
 *   - Schema-parity / representative repository read-write across all
 *     post-consolidation domains.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { closeDb, initDb, getDb } from "../db/index.js";
import { join } from "node:path";
import { existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema/index.js";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const DRIZZLE_DIR = join(PACKAGE_ROOT, "drizzle");
const TEMP_DIR = join(PACKAGE_ROOT, ".test-f2-migration");

function ensureTempDir(): void {
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${dbPath}${suffix}`)) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore
      }
    }
  }
}

function hashMigration(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

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
 * Build a v0.29-era database: only 0000_schema + 0001 + 0002 applied, with
 * their hashes seeded into `__drizzle_migrations` at the journal `when`
 * timestamps. Simulates a database that booted under the pre-F2 journal.
 */
function prepareV029Database(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");

  for (const tag of ["0000_schema", "0001_green_shadowcat", "0002_purple_fallen_one"]) {
    const sqlPath = join(DRIZZLE_DIR, `${tag}.sql`);
    if (existsSync(sqlPath)) applyMigrationSql(db, readFileSync(sqlPath, "utf-8"));
  }

  const journal = JSON.parse(readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf-8"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC
    )
  `);
  const insertHash = db.prepare(
    "INSERT OR IGNORE INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
  );
  for (const entry of journal.entries.slice(0, 3)) {
    const sqlPath = join(DRIZZLE_DIR, `${entry.tag}.sql`);
    if (existsSync(sqlPath)) {
      insertHash.run(hashMigration(readFileSync(sqlPath, "utf-8")), entry.when);
    }
  }
  db.close();
}

/**
 * Build a legacy database that uses the pre-Drizzle `__migrations` table.
 * The consolidation bridge in `initDb()` detects `__migrations`, seeds the
 * 0000_schema hash, and then `migrate()` runs every journal entry after it.
 */
function prepareLegacyMigrationsDatabase(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  applyMigrationSql(db, readFileSync(join(DRIZZLE_DIR, "0000_schema.sql"), "utf-8"));
  db.exec(`
    CREATE TABLE __migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const insertLegacy = db.prepare("INSERT OR IGNORE INTO __migrations (filename) VALUES (?)");
  insertLegacy.run("0001_initial.sql");
  insertLegacy.run("0002_tasks.sql");
  db.close();
}

/** Insert sentinel application data into a v0.29-era database. */
function seedSentinelData(dbPath: string): {
  userId: string;
  habitatId: string;
  missionId: string;
} {
  const db = new Database(dbPath);
  const userId = "sentinel-user-f2";
  const habitatId = "sentinel-habitat-f2";
  const missionId = "sentinel-mission-f2";
  const colId = "sentinel-col-f2";
  const now = new Date().toISOString();

  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, "sentinel-user", "$2a$10$sentinelhash", "Sentinel User", "admin", now, now);

  db.prepare(
    `INSERT OR IGNORE INTO habitats (id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(habitatId, "Sentinel Habitat", now, now);

  db.prepare(
    `INSERT OR IGNORE INTO columns (id, habitat_id, name, "order")
     VALUES (?, ?, ?, ?)`,
  ).run(colId, habitatId, "Todo", 0);

  db.prepare(
    `INSERT OR IGNORE INTO missions
       (id, habitat_id, column_id, title, labels, depends_on, blocks, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(missionId, habitatId, colId, "Sentinel Mission", "[]", "[]", "[]", userId, now, now);

  db.prepare(
    `INSERT OR IGNORE INTO tasks
       (id, mission_id, title, labels, required_capabilities, artifacts, created_by, created_at, updated_at, "order")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("sentinel-task-f2", missionId, "Sentinel Task", "[]", "[]", "[]", userId, now, now, 0);

  db.close();
  return { userId, habitatId, missionId };
}

function countMigrations(dbPath: string): number {
  const db = new Database(dbPath);
  const n = (db.prepare("SELECT COUNT(*) as n FROM __drizzle_migrations").get() as { n: number }).n;
  db.close();
  return n;
}

function readJournal(): { entries: { tag: string; when: number }[] } {
  return JSON.parse(readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf-8"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("F2: Production Drizzle migration chain", () => {
  beforeEach(() => {
    ensureTempDir();
    closeDb();
  });
  afterEach(() => {
    closeDb();
  });

  // ------------------------------------------------------------------
  // Fresh install
  // ------------------------------------------------------------------
  describe("fresh install (empty database)", () => {
    const dbPath = join(TEMP_DIR, "fresh.db");

    afterEach(() => cleanupDb(dbPath));

    it("completes production startup and seeds global templates", async () => {
      cleanupDb(dbPath);
      expect(existsSync(dbPath)).toBe(false);

      await initDb(dbPath);

      const raw = new Database(dbPath);
      const tables = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      const tableNames = new Set(tables.map((t) => t.name));
      const templateCount = (
        raw.prepare("SELECT COUNT(*) as n FROM mission_templates").get() as { n: number }
      ).n;
      raw.close();

      // Core baseline tables.
      for (const t of ["users", "habitats", "missions", "tasks", "mission_templates"]) {
        expect(tableNames.has(t)).toBe(true);
      }
      // Post-consolidation tables across every domain.
      for (const t of [
        "notification_events",
        "automation_rules",
        "remote_pods",
        "remote_webhook_deliveries",
        "workflows",
        "wiki_pages",
        "wiki_pages_fts",
        "plugin_enrollments",
        "plugin_runs",
        "plugin_quarantines",
        "finding_triage",
        "triage_resolutions",
        "triage_cluster_missions",
        "releases",
      ]) {
        expect(tableNames.has(t)).toBe(true);
      }
      // seedGlobalTemplates ran (not mocked).
      expect(templateCount).toBeGreaterThan(0);
    });

    it("materializes workflow_template column on mission_templates", async () => {
      cleanupDb(dbPath);
      await initDb(dbPath);

      const raw = new Database(dbPath);
      const cols = raw.prepare("PRAGMA table_info(mission_templates)").all() as { name: string }[];
      raw.close();
      expect(cols.map((c) => c.name)).toContain("workflow_template");
    });

    it("records all journal entries in __drizzle_migrations", async () => {
      cleanupDb(dbPath);
      await initDb(dbPath);
      expect(countMigrations(dbPath)).toBe(readJournal().entries.length);
    });
  });

  // ------------------------------------------------------------------
  // v0.29 upgrade
  // ------------------------------------------------------------------
  describe("v0.29 upgrade (preserves sentinel data)", () => {
    const dbPath = join(TEMP_DIR, "v029-upgrade.db");

    afterEach(() => cleanupDb(dbPath));

    it("upgrades once, preserves sentinel data, and boots idempotently", async () => {
      cleanupDb(dbPath);
      prepareV029Database(dbPath);
      const sentinels = seedSentinelData(dbPath);

      // --- Upgrade boot ---
      await initDb(dbPath);
      const db = getDb();

      const user = db
        .select()
        .from(schema.users)
        .where(sql`id = ${sentinels.userId}`)
        .all();
      expect(user).toHaveLength(1);
      expect(user[0].username).toBe("sentinel-user");

      const habitat = db
        .select()
        .from(schema.habitats)
        .where(sql`id = ${sentinels.habitatId}`)
        .all();
      expect(habitat).toHaveLength(1);

      const mission = db
        .select()
        .from(schema.missions)
        .where(sql`id = ${sentinels.missionId}`)
        .all();
      expect(mission).toHaveLength(1);

      const tasks = db.select().from(schema.tasks).all();
      expect(tasks.some((t) => t.title === "Sentinel Task")).toBe(true);

      // Post-consolidation tables now exist.
      const raw = new Database(dbPath);
      const hasPluginTable = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plugin_quarantines'")
        .get();
      const hasWorkflowTemplate = (
        raw.prepare("PRAGMA table_info(mission_templates)").all() as { name: string }[]
      ).some((c) => c.name === "workflow_template");
      raw.close();
      expect(hasPluginTable).toBeDefined();
      expect(hasWorkflowTemplate).toBe(true);

      const migrationsAfterUpgrade = countMigrations(dbPath);
      closeDb();

      // --- Idempotent second boot (no new migrations run) ---
      await initDb(dbPath);
      expect(countMigrations(dbPath)).toBe(migrationsAfterUpgrade);

      const db2 = getDb();
      const user2 = db2
        .select()
        .from(schema.users)
        .where(sql`id = ${sentinels.userId}`)
        .all();
      expect(user2).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------
  // Legacy __migrations bridge
  // ------------------------------------------------------------------
  describe("legacy __migrations bridge", () => {
    const dbPath = join(TEMP_DIR, "legacy-migrations.db");

    afterEach(() => cleanupDb(dbPath));

    it("crosses the consolidation bridge without baseline replay or data loss", async () => {
      cleanupDb(dbPath);
      prepareLegacyMigrationsDatabase(dbPath);
      const sentinels = seedSentinelData(dbPath);

      await initDb(dbPath);
      const db = getDb();

      expect(countMigrations(dbPath)).toBe(readJournal().entries.length);

      const user = db
        .select()
        .from(schema.users)
        .where(sql`id = ${sentinels.userId}`)
        .all();
      expect(user).toHaveLength(1);

      const raw = new Database(dbPath);
      const tableExists = (name: string) =>
        raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
      expect(tableExists("plugin_quarantines")).toBeDefined();
      expect(tableExists("wiki_pages")).toBeDefined();
      expect(tableExists("workflows")).toBeDefined();
      raw.close();
    });
  });

  // ------------------------------------------------------------------
  // Prerelease marker reconciliation
  // ------------------------------------------------------------------
  describe("prerelease 0053 marker reconciliation", () => {
    const dbPath = join(TEMP_DIR, "prerelease-marker.db");

    afterEach(() => cleanupDb(dbPath));

    /**
     * Realistic prerelease sequence (matching what the old applyQuarantineReset
     * actually produced):
     * 1. v0.29 database (only 0000–0002 applied)
     * 2. plugin_quarantines table exists (created by the old code path)
     * 3. Legacy rows were cleared by the old reset (DELETE already executed)
     * 4. The 0053 hash is recorded with a high Date.now() timestamp
     * 5. A canonical kind-aware quarantine was added AFTER the reset
     *
     * F2a proves that the canonical row survives the F2 upgrade boot.
     */
    it("preserves post-reset canonical quarantine rows while running all structural migrations", async () => {
      cleanupDb(dbPath);
      prepareV029Database(dbPath);
      seedSentinelData(dbPath);

      // --- Simulate the real old-helper sequence ---
      const markerContent = readFileSync(
        join(DRIZZLE_DIR, "0053_plugin_quarantine_kind_safe_reset.sql"),
        "utf-8",
      );
      const markerHash = hashMigration(markerContent);

      const raw = new Database(dbPath);

      // plugin_quarantines existed (old applyQuarantineReset checked for it).
      raw.exec(`
        CREATE TABLE IF NOT EXISTS plugin_quarantines (
          plugin_key text PRIMARY KEY NOT NULL,
          plugin_id text NOT NULL,
          quarantined_at text NOT NULL,
          reason text
        )
      `);

      // The old reset already executed — legacy rows were deleted.
      // Record the marker with the high Date.now() timestamp.
      const highTimestamp = Date.now();
      raw
        .prepare("INSERT OR REPLACE INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
        .run(markerHash, highTimestamp);

      const latest = raw
        .prepare("SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1")
        .get() as { created_at: number };
      expect(Number(latest.created_at)).toBe(highTimestamp);

      // A canonical kind-aware quarantine was added AFTER the reset.
      const canonicalKey = '["signalDetector","real-plug","real-det"]';
      raw
        .prepare(
          "INSERT INTO plugin_quarantines (plugin_key, plugin_id, quarantined_at, reason) VALUES (?, ?, ?, ?)",
        )
        .run(canonicalKey, "real-plug", new Date().toISOString(), "live fault quarantine");
      expect(
        (raw.prepare("SELECT COUNT(*) as n FROM plugin_quarantines").get() as { n: number }).n,
      ).toBe(1);
      raw.close();

      // --- Boot F2 — reconciliation preserves rows, migrate() runs 0027–0053 ---
      await initDb(dbPath);

      const raw2 = new Database(dbPath);

      // Structural migrations ran despite the prerelease marker.
      const hasPluginQuarantines = raw2
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plugin_quarantines'")
        .get();
      const hasWorkflowTemplate = (
        raw2.prepare("PRAGMA table_info(mission_templates)").all() as { name: string }[]
      ).some((c) => c.name === "workflow_template");
      const hasWiki = raw2
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wiki_pages'")
        .get();

      expect(hasPluginQuarantines).toBeDefined();
      expect(hasWorkflowTemplate).toBe(true);
      expect(hasWiki).toBeDefined();

      // The 0053 hash is now recorded at the canonical journal `when`.
      const markerRow = raw2
        .prepare("SELECT created_at FROM __drizzle_migrations WHERE hash = ?")
        .get(markerHash) as { created_at: number } | undefined;
      expect(markerRow).toBeDefined();

      const journal = readJournal();
      const entry053 = journal.entries.find(
        (e) => e.tag === "0053_plugin_quarantine_kind_safe_reset",
      );
      expect(Number(markerRow!.created_at)).toBe(entry053!.when);

      // Sentinel data survived.
      expect(
        raw2.prepare("SELECT id FROM users WHERE id = ?").get("sentinel-user-f2"),
      ).toBeDefined();

      // All journal entries are now recorded.
      expect(countMigrations(dbPath)).toBe(journal.entries.length);

      // F2a — The canonical quarantine row SURVIVED the upgrade.
      // The blanket DELETE in 0053 ran, but the durable preservation
      // mechanism backed up and restored the canonical row.
      const survivingRows = raw2.prepare("SELECT plugin_key FROM plugin_quarantines").all() as {
        plugin_key: string;
      }[];
      expect(survivingRows).toHaveLength(1);
      expect(survivingRows[0].plugin_key).toBe(canonicalKey);

      // The backup table was cleaned up.
      const backupExists = raw2
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='__f2_quarantine_preserve'",
        )
        .get();
      expect(backupExists).toBeUndefined();

      raw2.close();

      // --- Idempotent second boot — 0053 does NOT re-run ---
      closeDb();
      await initDb(dbPath);
      const raw3 = new Database(dbPath);
      const rowsAfterReboot = raw3.prepare("SELECT plugin_key FROM plugin_quarantines").all() as {
        plugin_key: string;
      }[];
      expect(rowsAfterReboot).toHaveLength(1);
      expect(rowsAfterReboot[0].plugin_key).toBe(canonicalKey);
      raw3.close();
    });

    /**
     * F2a — Failure/retry safety. If the process crashes after marker
     * deletion but before restore completes, the durable backup table
     * survives in the DB file and is recovered on the next successful boot.
     */
    it("recovers preserved quarantine rows after a simulated crash between migrate and restore", async () => {
      cleanupDb(dbPath);
      prepareV029Database(dbPath);

      // Simulate the old-helper state: table + marker + canonical row.
      const markerContent = readFileSync(
        join(DRIZZLE_DIR, "0053_plugin_quarantine_kind_safe_reset.sql"),
        "utf-8",
      );
      const markerHash = hashMigration(markerContent);
      const canonicalKey = '["signalDetector","crash-plug","crash-det"]';

      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE IF NOT EXISTS plugin_quarantines (
          plugin_key text PRIMARY KEY NOT NULL,
          plugin_id text NOT NULL,
          quarantined_at text NOT NULL,
          reason text
        )
      `);
      raw
        .prepare("INSERT OR REPLACE INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
        .run(markerHash, Date.now());
      raw
        .prepare(
          "INSERT INTO plugin_quarantines (plugin_key, plugin_id, quarantined_at, reason) VALUES (?, ?, ?, ?)",
        )
        .run(canonicalKey, "crash-plug", new Date().toISOString(), "pre-crash quarantine");
      raw.close();

      // Boot — reconciliation creates backup, deletes marker, migrate() runs,
      // restore happens. All in one boot.
      await initDb(dbPath);
      closeDb();

      // Now simulate a crash: manually re-insert the marker at high timestamp
      // and wipe plugin_quarantines (as if 0053 ran but restore didn't).
      // Create a new backup as reconciliation would have.
      const raw2 = new Database(dbPath);
      raw2.prepare("DELETE FROM __drizzle_migrations WHERE hash = ?").run(markerHash);
      raw2
        .prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
        .run(markerHash, Date.now());
      raw2.exec("DELETE FROM plugin_quarantines");
      // Simulate: backup table left behind from a crashed prior boot.
      raw2.exec(`
        CREATE TABLE __f2_quarantine_preserve (
          plugin_key TEXT NOT NULL PRIMARY KEY,
          plugin_id TEXT NOT NULL,
          quarantined_at TEXT NOT NULL,
          reason TEXT
        )
      `);
      raw2
        .prepare(
          "INSERT INTO __f2_quarantine_preserve (plugin_key, plugin_id, quarantined_at, reason) VALUES (?, ?, ?, ?)",
        )
        .run(canonicalKey, "crash-plug", new Date().toISOString(), "crash-recovery quarantine");
      raw2.close();

      // Boot — reconciliation detects the re-inserted stale marker, but the
      // backup table already exists from the "crashed" boot. The existing
      // backup is dropped and recreated from current (empty) state. migrate()
      // runs, 0053 wipes the table, then restore runs from the new backup.
      // BUT since the table was empty when reconciliation ran, there's nothing
      // to back up. The crash-recovery scenario is: the backup from the FIRST
      // boot (which had the canonical row) was already restored successfully.
      //
      // The real crash-recovery test: boot with a leftover backup and NO marker.
      closeDb();
      // Remove the marker we just re-inserted to simulate a clean retry state.
      const raw3 = new Database(dbPath);
      raw3.prepare("DELETE FROM __drizzle_migrations WHERE hash = ?").run(markerHash);
      // Re-insert 0053 at canonical when (as migrate() would have).
      const journal = readJournal();
      const entry053 = journal.entries.find(
        (e: { tag: string; when: number }) => e.tag === "0053_plugin_quarantine_kind_safe_reset",
      )!;
      raw3
        .prepare("INSERT OR IGNORE INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
        .run(markerHash, entry053.when);
      // Ensure backup table has the canonical row.
      const backupCount = (
        raw3.prepare("SELECT COUNT(*) as n FROM __f2_quarantine_preserve").get() as { n: number }
      ).n;
      expect(backupCount).toBe(1);
      raw3.close();

      // Boot — restorePreservedQuarantineRows finds the leftover backup and
      // restores the row even though no marker reconciliation was needed.
      await initDb(dbPath);
      const raw4 = new Database(dbPath);
      const recovered = raw4.prepare("SELECT plugin_key FROM plugin_quarantines").all() as {
        plugin_key: string;
      }[];
      expect(recovered).toHaveLength(1);
      expect(recovered[0].plugin_key).toBe(canonicalKey);

      // Backup was cleaned up.
      const backupStillExists = raw4
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='__f2_quarantine_preserve'",
        )
        .get();
      expect(backupStillExists).toBeUndefined();
      raw4.close();
    });
  });

  // ------------------------------------------------------------------
  // Schema-parity / representative repository read-write
  // ------------------------------------------------------------------
  describe("schema parity across post-consolidation domains", () => {
    const dbPath = join(TEMP_DIR, "schema-parity.db");

    afterEach(() => cleanupDb(dbPath));

    it("supports representative read-write for plugin, workflow, wiki, triage, release, and remote/pod domains", async () => {
      cleanupDb(dbPath);
      await initDb(dbPath);

      const raw = new Database(dbPath);
      const now = new Date().toISOString();
      const exists = (id: string, table: string) =>
        raw.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);

      // Ensure a habitat + column + mission exist for FK references.
      raw
        .prepare(
          "INSERT OR IGNORE INTO habitats (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run("parity-hab", "Parity Habitat", now, now);
      raw
        .prepare(
          `INSERT OR IGNORE INTO columns (id, habitat_id, name, "order") VALUES (?, ?, ?, ?)`,
        )
        .run("parity-col", "parity-hab", "Todo", 0);
      raw
        .prepare(
          `INSERT OR IGNORE INTO missions (id, habitat_id, column_id, title, labels, depends_on, blocks, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "parity-mission",
          "parity-hab",
          "parity-col",
          "M",
          "[]",
          "[]",
          "[]",
          "system",
          now,
          now,
        );

      // --- Plugin domain (0038–0041) ---
      raw
        .prepare(
          `INSERT OR IGNORE INTO plugin_enrollments
          (id, habitat_id, plugin_id, contribution_id, contribution_kind, enabled,
           enrolled_by, enrolled_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "parity-enr",
          "parity-hab",
          "test-plugin",
          "test-det",
          "signalDetector",
          1,
          "system",
          now,
          now,
        );
      expect(exists("parity-enr", "plugin_enrollments")).toBeDefined();

      raw
        .prepare(
          `INSERT OR IGNORE INTO plugin_runs
          (id, habitat_id, plugin_id, contribution_id, contribution_kind,
           trigger_type, status, fingerprint, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "parity-run",
          "parity-hab",
          "test-plugin",
          "test-det",
          "signalDetector",
          "signal",
          "running",
          "fp-1",
          now,
        );
      expect(exists("parity-run", "plugin_runs")).toBeDefined();

      raw
        .prepare(
          `INSERT OR IGNORE INTO plugin_quarantines
          (plugin_key, plugin_id, quarantined_at, reason)
         VALUES (?, ?, ?, ?)`,
        )
        .run('["signalDetector","test-plugin","test"]', "test-plugin", now, "parity test");
      expect(
        raw
          .prepare("SELECT plugin_key FROM plugin_quarantines WHERE plugin_key = ?")
          .get('["signalDetector","test-plugin","test"]'),
      ).toBeDefined();

      // --- Workflow domain (0031–0033) ---
      raw
        .prepare(
          `INSERT OR IGNORE INTO workflows
          (id, mission_id, habitat_id, resolved_variables, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("parity-wf", "parity-mission", "parity-hab", "{}", "system", now);
      expect(exists("parity-wf", "workflows")).toBeDefined();

      // mission_templates.workflow_template (0033) is writable.
      raw
        .prepare(
          `INSERT OR IGNORE INTO mission_templates
          (id, habitat_id, name, labels, required_capabilities, is_default, usage_count,
           created_by, tasks_template, workflow_template)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "parity-tmpl",
          "parity-hab",
          "Parity Template",
          "[]",
          "[]",
          0,
          0,
          "system",
          "[]",
          "{}",
        );
      const tmplWt = raw
        .prepare("SELECT workflow_template FROM mission_templates WHERE id = ?")
        .get("parity-tmpl") as { workflow_template: string };
      expect(tmplWt.workflow_template).toBe("{}");

      // --- Wiki domain (0035) ---
      raw
        .prepare(
          `INSERT OR IGNORE INTO wiki_pages
          (id, habitat_id, slug, title, content, tags, created_by, last_updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "parity-wiki",
          "parity-hab",
          "parity",
          "Parity",
          "content",
          "[]",
          "system",
          "system",
          now,
          now,
        );
      expect(exists("parity-wiki", "wiki_pages")).toBeDefined();

      // --- Triage domain (0042–0044) ---
      // finding_triage requires a pulse FK — create one first.
      raw
        .prepare(
          `INSERT OR IGNORE INTO pulses (id, habitat_id, from_type, from_id, signal_type, subject, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("parity-pulse", "parity-hab", "agent", "system", "info", "test", "{}");
      raw
        .prepare(
          `INSERT OR IGNORE INTO finding_triage
          (id, habitat_id, pulse_id, cluster_key, finding_kind, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "parity-tri",
          "parity-hab",
          "parity-pulse",
          "parity-cluster",
          "anomaly",
          "open",
          now,
          now,
        );
      expect(exists("parity-tri", "finding_triage")).toBeDefined();

      // --- Release domain (0048) ---
      raw
        .prepare(
          `INSERT OR IGNORE INTO releases
          (id, habitat_id, version, release_type, detected_by)
         VALUES (?, ?, ?, ?, ?)`,
        )
        .run("parity-rel", "parity-hab", "1.0.0", "major", "manual");
      expect(exists("parity-rel", "releases")).toBeDefined();

      // --- Remote/pod domain (0027) ---
      raw
        .prepare(
          `INSERT OR IGNORE INTO remote_pods
          (id, habitat_id, name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("parity-pod", "parity-hab", "Pod", "active", now, now);
      expect(exists("parity-pod", "remote_pods")).toBeDefined();

      // --- Wiki FTS objects (0035) — direct assertion ---
      const ftsTable = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wiki_pages_fts'")
        .get();
      expect(ftsTable).toBeDefined();
      const triggers = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='wiki_pages'")
        .all() as { name: string }[];
      const triggerNames = new Set(triggers.map((t) => t.name));
      for (const t of ["wiki_pages_ai", "wiki_pages_ad", "wiki_pages_au"]) {
        expect(triggerNames.has(t)).toBe(true);
      }
      // The INSERT into wiki_pages above exercised the AI trigger.
      const ftsRow = raw.prepare("SELECT * FROM wiki_pages_fts WHERE title = 'Parity'").get();
      expect(ftsRow).toBeDefined();

      raw.close();
    });
  });
});
