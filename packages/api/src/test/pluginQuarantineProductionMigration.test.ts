/**
 * ADR-0039 R1 — Production quarantine reset migration test.
 *
 * Tests the production migration path (`initDb()` → `applyQuarantineReset()`)
 * using the production better-sqlite3 driver — NOT the test-only
 * `applyMigrations` file scanner used by `initTestDb()`. Proves that an
 * upgraded database with legacy `pluginId:contributionId` quarantine rows
 * has them cleared on the next boot, that the reset is idempotent, and that
 * new canonical rows survive.
 *
 * This test file is intentionally separate from `pluginQuarantineMigration.test.ts`
 * because it uses `initDb()` (better-sqlite3) rather than `initTestDb()` (sql.js).
 *
 * `seedGlobalTemplates` is mocked because the journal-tracked schema (0000–0002)
 * predates the `workflow_template` column on `mission_templates` (migration 0033).
 * Testing template seeding is out of scope — we are testing the quarantine reset.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { closeDb, initDb, getDb } from "../db/index.js";
import { pluginQuarantines } from "../db/schema/index.js";
import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";

vi.mock("../repositories/template.js", () => ({
  seedGlobalTemplates: vi.fn(),
}));

const TEMP_DB = join(import.meta.dirname, "..", "..", ".test-prod-quarantine-reset.db");

function cleanupTempDb(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${TEMP_DB}${suffix}`)) unlinkSync(`${TEMP_DB}${suffix}`);
  }
}

describe("ADR-0039 R1: Production quarantine reset via initDb()", () => {
  afterEach(() => {
    closeDb();
    cleanupTempDb();
  });

  /**
   * The core upgrade scenario: a database that already has `plugin_quarantines`
   * (from migration 0041 applied by a previous version) with legacy
   * `pluginId:contributionId` rows. On the next `initDb()` boot, the
   * `applyQuarantineReset()` production code path detects the table, sees the
   * 0053 hash is untracked, executes the DELETE, and records the hash.
   */
  it("clears legacy quarantine rows on upgrade via the production migration path", async () => {
    // --- Phase 1: Fresh install ---
    cleanupTempDb();
    await initDb(TEMP_DB);
    closeDb();

    // --- Phase 2: Simulate a pre-v0.30 database ---
    // Open the DB directly and seed legacy rows that a previous version left.
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

    // --- Phase 3: Upgrade boot ---
    await initDb(TEMP_DB);
    expect(getDb().select().from(pluginQuarantines).all()).toEqual([]);
    closeDb();

    // --- Phase 4: New canonical row survives subsequent boots ---
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

    // --- Phase 5: Idempotent next boot ---
    await initDb(TEMP_DB);
    const surviving = getDb().select().from(pluginQuarantines).all();
    expect(surviving).toHaveLength(1);
    expect(surviving[0].pluginKey).toBe('["signalDetector","new-plug","new-det"]');
  });

  /**
   * On a fresh install where the journal-based `migrate()` has not created
   * `plugin_quarantines` (it lives in migration 0041, outside the journal's
   * 0000–0002 range), `applyQuarantineReset()` must skip silently rather than
   * throw "no such table".
   */
  it("is a no-op on a fresh install where plugin_quarantines does not exist", async () => {
    cleanupTempDb();
    await initDb(TEMP_DB);

    const raw = new Database(TEMP_DB);
    const tableExists = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plugin_quarantines'")
      .get();
    raw.close();
    expect(tableExists).toBeUndefined();
  });
});
