/**
 * ADR-0039 R1 / F2/F2a — Production quarantine reset via the Drizzle journal.
 *
 * Tests the production migration path (`initDb()` → `migrate()`) using the
 * production better-sqlite3 driver — NOT the test-only `applyMigrations` file
 * scanner used by `initTestDb()`. After F2, migration 0053 is part of the
 * ordered Drizzle journal and is applied by `migrate()` itself — the
 * out-of-band `applyQuarantineReset()` runner has been retired.
 *
 * Proves that an upgraded database with legacy `pluginId:contributionId`
 * quarantine rows has them cleared when 0053 runs for the first time, that
 * 0053 does not re-run on subsequent boots (the journal hash prevents it),
 * and that canonical rows added after the first reset survive via the F2a
 * durable preservation mechanism.
 *
 * `seedGlobalTemplates` is NOT mocked: the repaired journal includes
 * migration 0033 (which adds `workflow_template`), so template seeding
 * succeeds on both fresh and upgraded databases.
 */
import { describe, it, expect, afterEach } from "vitest";
import { closeDb, initDb, getDb } from "../db/index.js";
import { pluginQuarantines } from "../db/schema/index.js";
import { join } from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const DRIZZLE_DIR = join(PACKAGE_ROOT, "drizzle");
const TEMP_DB = join(PACKAGE_ROOT, ".test-prod-quarantine-reset.db");

function cleanupTempDb(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${TEMP_DB}${suffix}`)) unlinkSync(`${TEMP_DB}${suffix}`);
  }
}

function hashMigration(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Apply migration SQL on a better-sqlite3 connection, suppressing the benign
 * "already exists" errors that arise when a later migration touches the same
 * object as the consolidated baseline.
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
 * Build a v0.29-era database: only 0000_schema + 0001 + 0002 applied, with
 * their hashes seeded into `__drizzle_migrations` at the journal `when`
 * timestamps. This simulates a database that booted under the pre-F2 journal
 * (which listed only three entries). When `initDb()` boots this database, it
 * will run every post-consolidation migration 0027–0053 for the first time.
 */
function prepareV029Database(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");

  for (const tag of ["0000_schema", "0001_green_shadowcat", "0002_purple_fallen_one"]) {
    const sqlPath = join(DRIZZLE_DIR, `${tag}.sql`);
    if (existsSync(sqlPath)) {
      applyMigrationSql(db, readFileSync(sqlPath, "utf-8"));
    }
  }

  const journal = JSON.parse(readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf-8"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at NUMERIC
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

describe("ADR-0039 R1 / F2: Production quarantine reset via Drizzle migrate()", () => {
  afterEach(() => {
    closeDb();
    cleanupTempDb();
  });

  /**
   * The core upgrade scenario: a v0.29-era database that already has
   * `plugin_quarantines` with legacy `pluginId:contributionId` rows from a
   * pre-v0.30 version. On the first boot with the repaired journal,
   * `migrate()` runs 0041 (table already exists, IF NOT EXISTS) and then
   * 0053, which executes `DELETE FROM plugin_quarantines` and records the
   * hash. Legacy rows are cleared; the hash prevents re-execution on
   * subsequent boots.
   */
  it("clears legacy quarantine rows on upgrade via the production migration path", async () => {
    // --- Phase 1: Prepare a v0.29-era database ---
    cleanupTempDb();
    prepareV029Database(TEMP_DB);

    // --- Phase 2: Simulate legacy quarantine rows ---
    const raw = new Database(TEMP_DB);
    raw.exec(`
      CREATE TABLE IF NOT EXISTS plugin_quarantines (
        plugin_key text PRIMARY KEY NOT NULL,
        plugin_id text NOT NULL,
        quarantined_at text NOT NULL,
        reason text
      )
    `);
    const now = new Date().toISOString();
    const insert = raw.prepare(
      "INSERT INTO plugin_quarantines (plugin_key, plugin_id, quarantined_at, reason) VALUES (?, ?, ?, ?)",
    );
    insert.run("my-plug:my-det", "my-plug", now, "legacy detector quarantine");
    insert.run("auto-plug:send-email", "auto-plug", now, "legacy action quarantine");
    expect(
      (raw.prepare("SELECT COUNT(*) as n FROM plugin_quarantines").get() as { n: number }).n,
    ).toBe(2);
    raw.close();

    // --- Phase 3: First boot with repaired journal — 0053 runs and clears ---
    await initDb(TEMP_DB);
    expect(getDb().select().from(pluginQuarantines).all()).toEqual([]);
    closeDb();

    // --- Phase 4: New canonical row added after the reset ---
    const raw2 = new Database(TEMP_DB);
    raw2
      .prepare(
        "INSERT INTO plugin_quarantines (plugin_key, plugin_id, quarantined_at, reason) VALUES (?, ?, ?, ?)",
      )
      .run(
        '["signalDetector","new-plug","new-det"]',
        "new-plug",
        new Date().toISOString(),
        "new canonical quarantine",
      );
    expect(
      (raw2.prepare("SELECT COUNT(*) as n FROM plugin_quarantines").get() as { n: number }).n,
    ).toBe(1);
    raw2.close();

    // --- Phase 5: Idempotent next boot — 0053 does NOT re-run ---
    await initDb(TEMP_DB);
    const surviving = getDb().select().from(pluginQuarantines).all();
    expect(surviving).toHaveLength(1);
    expect(surviving[0].pluginKey).toBe('["signalDetector","new-plug","new-det"]');
  });

  /**
   * F2 — On a fresh install, the repaired journal creates `plugin_quarantines`
   * via migration 0041 and immediately runs 0053 (a no-op on an empty table).
   * The table exists and is empty — the old expectation that it would be
   * absent is no longer valid.
   */
  it("creates plugin_quarantines on fresh install and seeds templates without mocking", async () => {
    cleanupTempDb();
    await initDb(TEMP_DB);

    const raw = new Database(TEMP_DB);
    const tableExists = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plugin_quarantines'")
      .get();
    const templateCount = (
      raw.prepare("SELECT COUNT(*) as n FROM mission_templates").get() as { n: number }
    ).n;
    const hasWorkflowTemplate = (
      raw.prepare("PRAGMA table_info(mission_templates)").all() as { name: string }[]
    ).some((c) => c.name === "workflow_template");
    raw.close();

    expect(tableExists).toBeDefined();
    expect(hasWorkflowTemplate).toBe(true);
    expect(templateCount).toBeGreaterThan(0);
  });
});
