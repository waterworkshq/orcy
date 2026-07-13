/**
 * ADR-0039 T2 — Quarantine reset migration (0053) test.
 *
 * The new kind-safe canonical key format is incompatible with legacy
 * `plugin_quarantines` rows. The migration deletes them deterministically
 * rather than guessing kind/phase/event mappings.
 *
 * This test seeds a fresh test DB with legacy rows, re-applies the migration
 * file directly, and asserts the deletion. `initTestDb()` already runs every
 * migration in `packages/api/drizzle/`, so by the time the test setup is done,
 * the table is empty — the legacy rows must be inserted AFTER setup and the
 * migration re-run inline to test its behavior on a populated table.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { pluginQuarantines } from "../db/schema/index.js";
import { resetPlugins } from "../plugins/pluginManager.js";

vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: vi.fn() },
}));

/**
 * Applies a single migration .sql file to the current test DB. Mirrors the
 * `runMigrationSql` helper in db/index.ts but is scoped to one named file
 * so we can re-run only the T2 reset.
 */
function applyMigrationFile(fileName: string): void {
  const migrationFolder = join(import.meta.dirname, "..", "..", "drizzle");
  const sql = readFileSync(join(migrationFolder, fileName), "utf-8");
  // Better-sqlite3 + drizzle: split on the statement-breakpoint marker the
  // same way `runMigrationSql` does for the test-DB migration runner.
  const statements = sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  const db = getDb();
  for (const stmt of statements) db.run(stmt);
}

describe("ADR-0039 T2: 0053 quarantine reset migration", () => {
  beforeEach(async () => {
    await initTestDb();
    resetPlugins();
  });

  afterEach(() => {
    resetPlugins();
    closeDb();
  });

  it("deletes legacy plugin_quarantines rows when applied to a populated table", () => {
    const db = getDb();
    // Seed three legacy rows using the ambiguous `pluginId:contributionId`
    // format. The new encoder cannot map these to kind-safe keys.
    const now = new Date().toISOString();
    db.insert(pluginQuarantines)
      .values([
        {
          pluginKey: "my-plugin:my-detector",
          pluginId: "my-plugin",
          quarantinedAt: now,
          reason: "legacy detector quarantine",
        },
        {
          pluginKey: "auto-plug:send-email",
          pluginId: "auto-plug",
          quarantinedAt: now,
          reason: "legacy action quarantine",
        },
        {
          pluginKey: "chan-plug:teams",
          pluginId: "chan-plug",
          quarantinedAt: now,
          reason: "legacy channel quarantine",
        },
      ])
      .run();
    expect(db.select().from(pluginQuarantines).all().length).toBe(3);

    // Re-apply the migration: it must deterministically delete every legacy row.
    applyMigrationFile("0053_plugin_quarantine_kind_safe_reset.sql");

    const remaining = db.select().from(pluginQuarantines).all();
    expect(remaining).toEqual([]);
  });

  it("is idempotent (re-running on an empty table is a no-op)", () => {
    applyMigrationFile("0053_plugin_quarantine_kind_safe_reset.sql");
    applyMigrationFile("0053_plugin_quarantine_kind_safe_reset.sql");
    expect(getDb().select().from(pluginQuarantines).all()).toEqual([]);
  });

  /**
   * Post-boot persistence of new-format rows is the responsibility of
   * `pluginQuarantine.test.ts` (clearQuarantine/loadQuarantinesFromDb). The
   * migration itself is a one-time destructive reset: its `DELETE FROM
   * plugin_quarantines;` has no WHERE clause and will wipe any row it sees.
   * Production never re-runs a migration after boot; this contract is enough.
   */
});
