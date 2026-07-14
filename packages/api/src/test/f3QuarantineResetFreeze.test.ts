/**
 * F3 — Freeze migration 0053 and prove one-shot quarantine reset semantics.
 *
 * Every test uses the production better-sqlite3 driver. The upgrade/reboot
 * tests go through the real `initDb()` → `reconcilePrereleaseMigrationMarker`
 * → `migrate()` → `restorePreservedQuarantineRows` path; the comment-mutation
 * test drives the real Drizzle `migrate()` against a copied migration folder.
 *
 * Acceptance criteria proven here:
 *  - Legacy ambiguous rows are cleared exactly once; canonical rows added after
 *    the first reset survive repeated boots.
 *  - A comment-only change in a copied, already-recorded 0053 file cannot
 *    retrigger the destructive statement.
 *  - A prerelease marker recorded with the pre-F3 0053 hash cannot suppress the
 *    repaired structural migration chain after the immutability banner lands.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { closeDb, initDb, getDb, PRERELEASE_0053_MARKER_HASH } from "../db/index.js";
import { pluginQuarantines } from "../db/schema/index.js";
import { join } from "node:path";
import {
  existsSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  cpSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const DRIZZLE_DIR = join(PACKAGE_ROOT, "drizzle");
const TEMP_DIR = join(PACKAGE_ROOT, ".test-f3-freeze");
const MARKER_TAG = "0053_plugin_quarantine_kind_safe_reset";
const MARKER_PATH = join(DRIZZLE_DIR, `${MARKER_TAG}.sql`);

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

function cleanupFolder(folderPath: string): void {
  try {
    rmSync(folderPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function hashMigration(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Current SHA-256 of the shipped 0053 file (post-F3 banner). */
function current0053Hash(): string {
  return hashMigration(readFileSync(MARKER_PATH, "utf-8"));
}

function readJournal(): { entries: { tag: string; when: number }[] } {
  return JSON.parse(readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf-8"));
}

function markerWhen(): number {
  const entry = readJournal().entries.find((e) => e.tag === MARKER_TAG);
  if (!entry) throw new Error("0053 journal entry not found");
  return entry.when;
}

function countMigrations(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) as n FROM __drizzle_migrations").get() as { n: number }).n;
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

describe("F3: Freeze migration 0053 and prove one-shot quarantine reset", () => {
  beforeEach(() => {
    ensureTempDir();
    closeDb();
  });
  afterEach(() => {
    closeDb();
  });

  // ------------------------------------------------------------------
  // Test A — one-shot reset; canonical rows survive repeated boots
  // ------------------------------------------------------------------
  describe("one-shot legacy reset", () => {
    const dbPath = join(TEMP_DIR, "one-shot.db");

    afterEach(() => cleanupDb(dbPath));

    it("clears legacy rows exactly once and keeps canonical rows across repeated boots", async () => {
      cleanupDb(dbPath);
      prepareV029Database(dbPath);

      // Seed ambiguous legacy quarantine rows (pre-canonical-key format).
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE IF NOT EXISTS plugin_quarantines (
          plugin_key text PRIMARY KEY NOT NULL,
          plugin_id text NOT NULL,
          quarantined_at text NOT NULL,
          reason text
        )
      `);
      const now = new Date().toISOString();
      const insertLegacy = raw.prepare(
        "INSERT INTO plugin_quarantines (plugin_key, plugin_id, quarantined_at, reason) VALUES (?, ?, ?, ?)",
      );
      insertLegacy.run("legacy-plug:legacy-det", "legacy-plug", now, "legacy detector");
      insertLegacy.run("legacy-auto:send-email", "legacy-auto", now, "legacy action");
      expect(
        (raw.prepare("SELECT COUNT(*) as n FROM plugin_quarantines").get() as { n: number }).n,
      ).toBe(2);
      raw.close();

      // --- Boot 1: 0053 runs for the first (and only) time. ---
      await initDb(dbPath);
      const db = getDb();
      expect(db.select().from(pluginQuarantines).all()).toEqual([]);

      const finalHash = current0053Hash();
      const when = markerWhen();
      const migrationCountAfterBoot1 = (
        db.get(sql`SELECT COUNT(*) as n FROM __drizzle_migrations`) as { n: number }
      ).n;
      const row0053 = db.get(
        sql`SELECT created_at FROM __drizzle_migrations WHERE hash = ${finalHash}`,
      ) as { created_at: number } | undefined;
      expect(row0053).toBeDefined();
      expect(Number(row0053!.created_at)).toBe(when);
      closeDb();

      // Insert a canonical kind-aware row AFTER the reset.
      const canonicalKey = '["signalDetector","canon-plug","canon-det"]';
      const raw2 = new Database(dbPath);
      raw2
        .prepare(
          "INSERT INTO plugin_quarantines (plugin_key, plugin_id, quarantined_at, reason) VALUES (?, ?, ?, ?)",
        )
        .run(canonicalKey, "canon-plug", new Date().toISOString(), "live fault quarantine");
      raw2.close();

      // --- Repeated boots: 0053 must NOT re-run. ---
      for (let boot = 2; boot <= 4; boot++) {
        await initDb(dbPath);
        const dbN = getDb();

        const surviving = dbN.select().from(pluginQuarantines).all();
        expect(surviving).toHaveLength(1);
        expect(surviving[0].pluginKey).toBe(canonicalKey);

        // Ledger unchanged across reboots (idempotent).
        const count = (
          dbN.get(sql`SELECT COUNT(*) as n FROM __drizzle_migrations`) as { n: number }
        ).n;
        expect(count).toBe(migrationCountAfterBoot1);

        // 0053 still recorded exactly once, at the canonical `when`.
        const r = dbN.get(
          sql`SELECT created_at FROM __drizzle_migrations WHERE hash = ${finalHash}`,
        ) as { created_at: number } | undefined;
        expect(r).toBeDefined();
        expect(Number(r!.created_at)).toBe(when);
        const dupes = (
          dbN.get(
            sql`SELECT COUNT(*) as n FROM __drizzle_migrations WHERE hash = ${finalHash}`,
          ) as {
            n: number;
          }
        ).n;
        expect(dupes).toBe(1);
        closeDb();
      }
    });
  });

  // ------------------------------------------------------------------
  // Test B — comment-only mutation of a recorded 0053 cannot retrigger
  // ------------------------------------------------------------------
  describe("comment-only mutation cannot retrigger", () => {
    const copiedFolder = join(TEMP_DIR, "drizzle-comment-mutation");
    const dbPath = join(TEMP_DIR, "comment-mutation.db");

    afterEach(() => {
      cleanupDb(dbPath);
      cleanupFolder(copiedFolder);
    });

    it("does not re-execute the destructive DELETE after a comment-only file edit", async () => {
      // Copy the real migration folder so we can mutate 0053 in isolation.
      cleanupFolder(copiedFolder);
      cpSync(DRIZZLE_DIR, copiedFolder, { recursive: true });
      cleanupDb(dbPath);

      const { drizzle } = await import("drizzle-orm/better-sqlite3");
      const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");

      // Boot 1: real Drizzle migrate() records the full chain, including 0053.
      const sqlite = new Database(dbPath);
      sqlite.pragma("foreign_keys = ON");
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: copiedFolder });

      const copiedMarkerPath = join(copiedFolder, `${MARKER_TAG}.sql`);
      const hashBeforeMutation = hashMigration(readFileSync(copiedMarkerPath, "utf-8"));

      // Insert a sentinel canonical row AFTER 0053 ran.
      const canonicalKey = '["signalDetector","mut-plug","mut-det"]';
      sqlite
        .prepare(
          "INSERT INTO plugin_quarantines (plugin_key, plugin_id, quarantined_at, reason) VALUES (?, ?, ?, ?)",
        )
        .run(canonicalKey, "mut-plug", new Date().toISOString(), "post-reset sentinel");
      const migrationsBefore = (
        sqlite.prepare("SELECT COUNT(*) as n FROM __drizzle_migrations").get() as { n: number }
      ).n;

      // Mutate the recorded 0053 with a comment-only edit (changes the hash,
      // leaves the journal `when` untouched). This is exactly the hazard the
      // immutability banner warns against; the test proves it is inert because
      // Drizzle selects by `when`, not by file hash.
      appendFileSync(
        copiedMarkerPath,
        "\n-- F3 mutation test: comment-only edit. Changes SHA-256, not journal.when.\n",
      );
      const hashAfterMutation = hashMigration(readFileSync(copiedMarkerPath, "utf-8"));
      expect(hashAfterMutation).not.toBe(hashBeforeMutation);

      // Boot 2: migrate() again over the mutated folder. Nothing should run.
      migrate(db, { migrationsFolder: copiedFolder });

      // The sentinel row SURVIVED -> 0053's blanket DELETE did NOT re-execute.
      const surviving = sqlite.prepare("SELECT plugin_key FROM plugin_quarantines").all() as {
        plugin_key: string;
      }[];
      expect(surviving).toHaveLength(1);
      expect(surviving[0].plugin_key).toBe(canonicalKey);

      // The migration ledger is unchanged.
      const migrationsAfter = (
        sqlite.prepare("SELECT COUNT(*) as n FROM __drizzle_migrations").get() as { n: number }
      ).n;
      expect(migrationsAfter).toBe(migrationsBefore);

      sqlite.close();
    });
  });

  // ------------------------------------------------------------------
  // Test C — prerelease marker recorded with the pre-F3 hash cannot suppress
  // ------------------------------------------------------------------
  describe("pre-F3 hash marker compatibility", () => {
    const dbPath = join(TEMP_DIR, "pref3-marker.db");

    afterEach(() => cleanupDb(dbPath));

    it("recognizes the legacy pre-F3 0053 hash and runs the full structural chain", async () => {
      // Independent pin: the exported constant must equal the hash measured
      // from the pre-F3 file bytes (unchanged since commit 7ac2a4a).
      expect(PRERELEASE_0053_MARKER_HASH).toBe(
        "92898f7a6e43fccd80baaf7ad3a7cdc506212fbf5363c45f3182378ca1f6408a",
      );
      // The banner changed the shipped bytes, so the pre-F3 hash must differ
      // from the current hash (otherwise this scenario is trivial).
      expect(PRERELEASE_0053_MARKER_HASH).not.toBe(current0053Hash());

      cleanupDb(dbPath);
      prepareV029Database(dbPath);

      const finalHash = current0053Hash();
      const when = markerWhen();
      const canonicalKey = '["signalDetector","pf3-plug","pf3-det"]';

      // Simulate the real old-helper state: plugin_quarantines exists, the
      // destructive reset already ran, and the pre-F3 hash was recorded with
      // the high Date.now() timestamp that suppresses 0027-0053.
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE IF NOT EXISTS plugin_quarantines (
          plugin_key text PRIMARY KEY NOT NULL,
          plugin_id text NOT NULL,
          quarantined_at text NOT NULL,
          reason text
        )
      `);
      const highTimestamp = Date.now();
      raw
        .prepare("INSERT OR REPLACE INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
        .run(PRERELEASE_0053_MARKER_HASH, highTimestamp);
      raw
        .prepare(
          "INSERT INTO plugin_quarantines (plugin_key, plugin_id, quarantined_at, reason) VALUES (?, ?, ?, ?)",
        )
        .run(canonicalKey, "pf3-plug", new Date().toISOString(), "post-reset canonical");
      const latest = raw
        .prepare("SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1")
        .get() as { created_at: number };
      expect(Number(latest.created_at)).toBe(highTimestamp);
      raw.close();

      // --- Boot F2/F3: reconciliation recognizes the pre-F3 hash, preserves
      // the canonical row, deletes the stale marker, migrate() runs the chain,
      // restore brings the canonical row back. ---
      await initDb(dbPath);
      const db = getDb();

      // Structural migrations ran despite the prerelease marker.
      const raw2 = new Database(dbPath);
      const hasWorkflowTemplate = (
        raw2.prepare("PRAGMA table_info(mission_templates)").all() as { name: string }[]
      ).some((c) => c.name === "workflow_template");
      const hasWiki = raw2
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wiki_pages'")
        .get();
      expect(hasWorkflowTemplate).toBe(true);
      expect(hasWiki).toBeDefined();

      // The pre-F3 marker is gone; 0053 is now recorded at the canonical when
      // under its current (final) hash.
      const legacyRow = raw2
        .prepare("SELECT hash FROM __drizzle_migrations WHERE hash = ?")
        .get(PRERELEASE_0053_MARKER_HASH);
      expect(legacyRow).toBeUndefined();
      const finalRow = raw2
        .prepare("SELECT created_at FROM __drizzle_migrations WHERE hash = ?")
        .get(finalHash) as { created_at: number } | undefined;
      expect(finalRow).toBeDefined();
      expect(Number(finalRow!.created_at)).toBe(when);
      expect(countMigrations(raw2)).toBe(readJournal().entries.length);
      raw2.close();

      // F2a — the canonical row survived (backup/restore).
      const surviving = db.select().from(pluginQuarantines).all();
      expect(surviving).toHaveLength(1);
      expect(surviving[0].pluginKey).toBe(canonicalKey);
      closeDb();

      // --- Reboot is idempotent: 0053 does not re-run, canonical survives. ---
      await initDb(dbPath);
      const db2 = getDb();
      const surviving2 = db2.select().from(pluginQuarantines).all();
      expect(surviving2).toHaveLength(1);
      expect(surviving2[0].pluginKey).toBe(canonicalKey);
    });
  });
});
