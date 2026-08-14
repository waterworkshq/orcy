/**
 * Staged production migration runner + enforcement discriminators.
 *
 * Every test here uses the PRODUCTION better-sqlite3 driver through
 * `initDb()` on file-backed temp databases — `initTestDb()` (sql.js file
 * scanner, bounded at the additive watermark) cannot satisfy this gate.
 *
 * Coverage map:
 *   - Fresh install runs the full staged chain (watermark -> preflight
 *     attestation -> enforcement).
 *   - Direct skipped-version upgrade from BEFORE the additive watermark
 *     (journal state 0063): clean data enforces; blocking dirty data stops
 *     BEFORE enforcement with a persisted machine-readable report and a
 *     stable code, then enforces after remediation + restart.
 *   - Advisory pre-cutover anomalies (terminal rows without Resolution
 *     Records) do NOT block enforcement (preflight tolerance).
 *   - Interrupted stage-1 / post-attestation restarts complete safely under
 *     the normal Drizzle ledger; ledger rows are hash/timestamp-identical to
 *     what Drizzle migrate() writes.
 *   - Post-enforcement invariants: partial-unique active identity, partial-
 *     unique Finding Resolution, RESTRICT FKs — while Cluster Resolution and
 *     habitat CASCADE stay operational.
 *   - CHECK-guard / attestation discriminators applied DIRECTLY (bypassing
 *     the runner) abort the enforcement transaction.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Migration-chain tests build file-backed databases through the full journal
// (now including the staged preflight/enforcement protocol) — allow headroom
// under full-suite parallel contention.
vi.setConfig({ testTimeout: 60_000 });
import { closeDb, initDb } from "../db/index.js";
import { join } from "node:path";
import { existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import {
  ENFORCEMENT_MIGRATION_TAG,
  ADDITIVE_WATERMARK_TAG,
  TRIAGE_ENFORCEMENT_PREFLIGHT_DIRTY_CODE,
} from "../db/stagedMigrations.js";
import { PREFLIGHT_VERSION, ADDITIVE_SCHEMA_VERSION } from "../services/findingTriagePreflight.js";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const DRIZZLE_DIR = join(PACKAGE_ROOT, "drizzle");
const TEMP_DIR = join(PACKAGE_ROOT, ".test-staged-enforcement");

function ensureTempDir(): void {
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${dbPath}${suffix}`)) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        /* ignore */
      }
    }
  }
}

function hashMigration(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function readJournal(): { entries: { tag: string; when: number }[] } {
  return JSON.parse(readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf-8"));
}

function applyMigrationSql(db: Database.Database, sqlText: string): void {
  const statements = sqlText
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    db.exec(stmt);
  }
}

/**
 * Build a database whose Drizzle ledger is caught up through the journal
 * entry with `throughTag` — an installation booted by the one-shot era at
 * that release. Everything after it is pending.
 */
function prepareLedgerThrough(dbPath: string, throughTag: string): void {
  const journal = readJournal();
  const idx = journal.entries.findIndex((e) => e.tag === throughTag);
  if (idx === -1) throw new Error(`unknown journal tag ${throughTag}`);
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC
    )
  `);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
  );
  for (const entry of journal.entries.slice(0, idx + 1)) {
    const sqlPath = join(DRIZZLE_DIR, `${entry.tag}.sql`);
    if (!existsSync(sqlPath)) continue; // pre-consolidation orphans
    applyMigrationSql(db, readFileSync(sqlPath, "utf-8"));
    insert.run(hashMigration(readFileSync(sqlPath, "utf-8")), entry.when);
  }
  db.close();
}

interface TriageWorldIds {
  habitatId: string;
  pulseId: string;
  missionId: string;
}

/**
 * Seed a minimal clean triage world on a database that already has the
 * schema through 0064+ (finding_triage additive columns exist): one active
 * finding, one terminal finding WITH a Resolution Record, and one terminal
 * finding WITHOUT one (advisory pre-cutover anomaly — must not block).
 */
function seedCleanTriageWorld(dbPath: string, prefix: string): TriageWorldIds {
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  const habitatId = `${prefix}-hab`;
  const missionId = `${prefix}-mission`;
  const pulseBase = `${prefix}-pulse`;
  db.prepare(
    "INSERT OR IGNORE INTO habitats (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run(habitatId, `${prefix} Habitat`, now, now);
  db.prepare(
    `INSERT OR IGNORE INTO columns (id, habitat_id, name, "order") VALUES (?, ?, ?, ?)`,
  ).run(`${prefix}-col`, habitatId, "Todo", 0);
  db.prepare(
    `INSERT OR IGNORE INTO missions (id, habitat_id, column_id, title, labels, depends_on, blocks, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(missionId, habitatId, `${prefix}-col`, "Corrective", "[]", "[]", "[]", "system", now, now);

  const insertFinding = db.prepare(
    `INSERT INTO finding_triage
       (id, habitat_id, pulse_id, cluster_key, finding_kind, status, triage_mission_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertResolution = db.prepare(
    `INSERT INTO triage_resolutions
       (id, habitat_id, cluster_key, skill_category, source, source_id, resolved_at)
     VALUES (?, ?, ?, ?, 'finding_triage', ?, ?)`,
  );
  for (let i = 0; i < 3; i++) {
    const fid = `${prefix}-ft-${i}`;
    db.prepare(
      `INSERT OR IGNORE INTO pulses (id, habitat_id, from_type, from_id, signal_type, subject, metadata)
       VALUES (?, ?, 'agent', 'system', 'finding', ?, '{}')`,
    ).run(`${pulseBase}-${i}`, habitatId, fid);
    const status = i === 0 ? "open" : "resolved";
    insertFinding.run(
      fid,
      habitatId,
      `${pulseBase}-${i}`,
      `${prefix}-cluster`,
      "bug",
      status,
      i === 0 ? null : missionId,
      now,
      now,
    );
    if (i === 1) {
      // Terminal WITH Resolution Record — clean.
      insertResolution.run(
        `${prefix}-res-1`,
        habitatId,
        `${prefix}-cluster`,
        "convention",
        fid,
        now,
      );
    }
    // i === 2 stays terminal WITHOUT a Resolution Record — advisory anomaly
    // common in pre-cutover data; must NOT block enforcement.
  }
  db.close();
  return { habitatId, pulseId: `${pulseBase}-0`, missionId };
}

function openRaw(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  return db;
}

function ledgerRows(dbPath: string): { hash: string; created_at: number }[] {
  const db = openRaw(dbPath);
  const rows = db
    .prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at")
    .all() as { hash: string; created_at: number }[];
  db.close();
  return rows;
}

function hasEnforcement(dbPath: string): boolean {
  const db = openRaw(dbPath);
  const idx = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_finding_triage_active_identity'",
    )
    .get();
  db.close();
  return idx !== undefined;
}

function attestation(dbPath: string):
  | {
      preflight_version: string;
      schema_version: string;
      clean: number;
      anomaly_report: string | null;
      anomaly_query_digest: string;
    }
  | undefined {
  const db = openRaw(dbPath);
  const row = db
    .prepare(
      "SELECT preflight_version, schema_version, clean, anomaly_report, anomaly_query_digest FROM migration_preflight_attestations WHERE enforcement_migration_id = ?",
    )
    .get(ENFORCEMENT_MIGRATION_TAG) as any;
  db.close();
  return row;
}

describe("Staged enforcement — production initDb discriminators", () => {
  beforeEach(() => {
    ensureTempDir();
    closeDb();
  });
  afterEach(() => closeDb());

  // ------------------------------------------------------------------
  // Fresh install
  // ------------------------------------------------------------------
  describe("fresh install", () => {
    const dbPath = join(TEMP_DIR, "fresh.db");
    afterEach(() => cleanupDb(dbPath));

    it("runs the full staged chain: watermark, clean attestation, enforcement", async () => {
      cleanupDb(dbPath);
      await initDb(dbPath);

      expect(hasEnforcement(dbPath)).toBe(true);

      const att = attestation(dbPath);
      expect(att).toBeDefined();
      expect(att!.preflight_version).toBe(PREFLIGHT_VERSION);
      expect(att!.schema_version).toBe(ADDITIVE_SCHEMA_VERSION);
      expect(att!.clean).toBe(1);

      // Ledger parity with Drizzle migrate(): every journal entry recorded
      // with sha256(raw SQL) at the journal `when`.
      const journal = readJournal();
      const rows = ledgerRows(dbPath);
      expect(rows).toHaveLength(journal.entries.length);
      for (let i = 0; i < journal.entries.length; i++) {
        const raw = readFileSync(join(DRIZZLE_DIR, `${journal.entries[i].tag}.sql`), "utf-8");
        expect(rows[i].hash).toBe(hashMigration(raw));
        expect(Number(rows[i].created_at)).toBe(journal.entries[i].when);
      }
    });

    it("second boot is a no-op (no new ledger rows, no re-attestation churn)", async () => {
      cleanupDb(dbPath);
      await initDb(dbPath);
      const first = ledgerRows(dbPath);
      closeDb();
      await initDb(dbPath);
      expect(ledgerRows(dbPath)).toHaveLength(first.length);
    });
  });

  // ------------------------------------------------------------------
  // Direct skipped-version upgrade (from journal state 0063, before the
  // additive watermark) — clean
  // ------------------------------------------------------------------
  describe("direct clean upgrade from before the additive watermark", () => {
    const dbPath = join(TEMP_DIR, "direct-clean.db");
    afterEach(() => cleanupDb(dbPath));

    it("commits the watermark, attests clean, enforces, preserves data", async () => {
      cleanupDb(dbPath);
      prepareLedgerThrough(dbPath, "0063_learning_loop_ledger");
      const ids = seedCleanTriageWorld(dbPath, "dc");

      await initDb(dbPath);

      // All additive entries through 0067 committed BEFORE enforcement, and
      // enforcement itself applied.
      expect(hasEnforcement(dbPath)).toBe(true);
      const tags = new Set(ledgerRows(dbPath).map((r) => r.hash));
      const journal = readJournal();
      const watermarkEntry = journal.entries.find((e) => e.tag === ADDITIVE_WATERMARK_TAG)!;
      expect(
        tags.has(
          hashMigration(readFileSync(join(DRIZZLE_DIR, `${ADDITIVE_WATERMARK_TAG}.sql`), "utf-8")),
        ),
      ).toBe(true);
      expect(ledgerRows(dbPath)).toHaveLength(journal.entries.length);
      void watermarkEntry;

      // Attestation is clean despite the advisory terminal-without-resolution
      // anomaly seeded above (preflight tolerance for pre-cutover rows).
      const att = attestation(dbPath);
      expect(att!.clean).toBe(1);

      // Data preserved through the table rebuild.
      const raw = openRaw(dbPath);
      const findings = raw.prepare("SELECT id FROM finding_triage ORDER BY id").all() as {
        id: string;
      }[];
      expect(findings.map((f) => f.id)).toEqual(["dc-ft-0", "dc-ft-1", "dc-ft-2"]);
      expect(raw.prepare("SELECT COUNT(*) as n FROM triage_resolutions").get()).toMatchObject({
        n: 1,
      });

      // RESTRICT FKs are physical: deleting the referenced Pulse/Mission fails.
      expect(() => raw.prepare("DELETE FROM pulses WHERE id = ?").run(`${ids.pulseId}`)).toThrow(
        /FOREIGN KEY/i,
      );
      expect(() => raw.prepare("DELETE FROM missions WHERE id = ?").run(ids.missionId)).toThrow(
        /FOREIGN KEY/i,
      );
      raw.close();
    });
  });

  // ------------------------------------------------------------------
  // Direct skipped-version dirty upgrade — blocking anomalies stop BEFORE
  // enforcement, remediation + restart completes
  // ------------------------------------------------------------------
  describe("direct dirty upgrade stops before enforcement", () => {
    const dbPath = join(TEMP_DIR, "direct-dirty.db");
    afterEach(() => cleanupDb(dbPath));

    it("defers enforcement with a stable code + machine-readable report, then enforces after remediation", async () => {
      cleanupDb(dbPath);
      prepareLedgerThrough(dbPath, "0063_learning_loop_ledger");
      seedCleanTriageWorld(dbPath, "dd");
      // Blocking anomaly: duplicate ACTIVE identity.
      const seed = openRaw(dbPath);
      const now = new Date().toISOString();
      for (const fid of ["dd-dup-1", "dd-dup-2"]) {
        seed
          .prepare(
            `INSERT INTO pulses (id, habitat_id, from_type, from_id, signal_type, subject, metadata)
             VALUES (?, 'dd-hab', 'agent', 'system', 'finding', ?, '{}')`,
          )
          .run(`dd-dup-pulse-${fid}`, fid);
        seed
          .prepare(
            `INSERT INTO finding_triage (id, habitat_id, pulse_id, cluster_key, finding_kind, status, created_at, updated_at)
             VALUES (?, 'dd-hab', ?, 'dd-dup-cluster', 'bug', 'open', ?, ?)`,
          )
          .run(fid, `dd-dup-pulse-${fid}`, now, now);
      }
      seed.close();

      // Boot: enforcement deferred — NOT a crash. Additive schema + service
      // guards keep the installation usable for remediation.
      await initDb(dbPath);

      expect(hasEnforcement(dbPath)).toBe(false);
      const ledger = ledgerRows(dbPath);
      const journal = readJournal();
      const watermarkHash = hashMigration(
        readFileSync(join(DRIZZLE_DIR, `${ADDITIVE_WATERMARK_TAG}.sql`), "utf-8"),
      );
      const enforcementHash = hashMigration(
        readFileSync(join(DRIZZLE_DIR, `${ENFORCEMENT_MIGRATION_TAG}.sql`), "utf-8"),
      );
      // The watermark committed BEFORE the preflight gate...
      expect(ledger.some((r) => r.hash === watermarkHash)).toBe(true);
      // ...and enforcement did NOT run.
      expect(ledger.some((r) => r.hash === enforcementHash)).toBe(false);
      expect(ledger).toHaveLength(journal.entries.length - 1);
      void journal;

      // Stable code + machine-readable blocking report persisted.
      const att = attestation(dbPath);
      expect(att).toBeDefined();
      expect(att!.clean).toBe(0);
      expect(att!.preflight_version).toBe(PREFLIGHT_VERSION);
      const report = JSON.parse(att!.anomaly_report!);
      expect(report.code).toBe(TRIAGE_ENFORCEMENT_PREFLIGHT_DIRTY_CODE);
      expect(report.blockingAnomalies.length).toBeGreaterThanOrEqual(2);
      expect(
        report.blockingAnomalies.every((a: any) => a.code === "active_identity_duplicate"),
      ).toBe(true);

      // --- Remediation (offline): terminalize one duplicate with a full
      // Resolution Record, then restart: enforcement completes.
      closeDb();
      const fix = openRaw(dbPath);
      fix
        .prepare(
          `INSERT INTO triage_resolutions (id, habitat_id, cluster_key, skill_category, source, source_id, root_cause, resolution, resolved_at)
           VALUES ('dd-dup-res', 'dd-hab', 'dd-dup-cluster', 'convention', 'finding_triage', 'dd-dup-1', 'legacy duplicate', 'terminalized survivor pick', ?)`,
        )
        .run(now);
      fix.prepare(`UPDATE finding_triage SET status = 'wontfix' WHERE id = 'dd-dup-1'`).run();
      fix.close();

      await initDb(dbPath);
      expect(hasEnforcement(dbPath)).toBe(true);
      expect(attestation(dbPath)!.clean).toBe(1);

      // Post-enforcement uniqueness is physical now.
      const raw = openRaw(dbPath);
      expect(() =>
        raw
          .prepare(
            `INSERT INTO finding_triage (id, habitat_id, pulse_id, cluster_key, finding_kind, status, created_at, updated_at)
             VALUES ('dd-dup-3', 'dd-hab', 'dd-dup-pulse-dd-dup-1', 'dd-dup-cluster', 'bug', 'open', ?, ?)`,
          )
          .run(now, now),
      ).toThrow(/UNIQUE/i);
      raw.close();
    });

    it("defers enforcement on duplicate Finding-source Resolution Records", async () => {
      cleanupDb(dbPath);
      prepareLedgerThrough(dbPath, "0063_learning_loop_ledger");
      seedCleanTriageWorld(dbPath, "dr");
      const seed = openRaw(dbPath);
      const now = new Date().toISOString();
      for (const rid of ["dr-res-dup-1", "dr-res-dup-2"]) {
        seed
          .prepare(
            `INSERT INTO triage_resolutions (id, habitat_id, cluster_key, skill_category, source, source_id, resolved_at)
             VALUES (?, 'dr-hab', 'dr-cluster', 'convention', 'finding_triage', 'dr-ft-1', ?)`,
          )
          .run(rid, now);
      }
      seed.close();

      await initDb(dbPath);

      expect(hasEnforcement(dbPath)).toBe(false);
      const report = JSON.parse(attestation(dbPath)!.anomaly_report!);
      expect(
        report.blockingAnomalies.some((a: any) => a.code === "finding_resolution_duplicate"),
      ).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Interrupted stage restarts
  // ------------------------------------------------------------------
  describe("interrupted stages restart safely", () => {
    const dbPath = join(TEMP_DIR, "interrupted.db");
    afterEach(() => cleanupDb(dbPath));

    it("restarts after a crash between stage 1 (watermark committed) and the preflight", async () => {
      cleanupDb(dbPath);
      // Simulate: additive stage committed, no attestation, no enforcement.
      prepareLedgerThrough(dbPath, ADDITIVE_WATERMARK_TAG);
      seedCleanTriageWorld(dbPath, "cr");

      await initDb(dbPath);

      expect(hasEnforcement(dbPath)).toBe(true);
      expect(attestation(dbPath)!.clean).toBe(1);
      expect(ledgerRows(dbPath)).toHaveLength(readJournal().entries.length);
    });

    it("restarts after a crash between attestation and enforcement without re-running the additive stage", async () => {
      cleanupDb(dbPath);
      prepareLedgerThrough(dbPath, ADDITIVE_WATERMARK_TAG);
      seedCleanTriageWorld(dbPath, "ca");
      // Simulate the runner's own attestation write, then a crash.
      const seed = openRaw(dbPath);
      seed
        .prepare(
          `INSERT INTO migration_preflight_attestations
            (enforcement_migration_id, schema_version, preflight_version, anomaly_query_digest, clean, attested_at)
           VALUES (?, ?, ?, 'seed-digest', 1, datetime('now'))`,
        )
        .run(ENFORCEMENT_MIGRATION_TAG, ADDITIVE_SCHEMA_VERSION, PREFLIGHT_VERSION);
      seed.close();

      await initDb(dbPath);

      expect(hasEnforcement(dbPath)).toBe(true);
      // The attestation was refreshed by this boot (digest recomputed).
      expect(attestation(dbPath)!.anomaly_query_digest).not.toBe("seed-digest");
      const rows = ledgerRows(dbPath);
      expect(rows).toHaveLength(readJournal().entries.length);
      // Idempotent restart after completion.
      closeDb();
      await initDb(dbPath);
      expect(ledgerRows(dbPath)).toHaveLength(rows.length);
    });
  });

  // ------------------------------------------------------------------
  // Post-enforcement invariants
  // ------------------------------------------------------------------
  describe("post-enforcement invariants", () => {
    const dbPath = join(TEMP_DIR, "invariants.db");
    afterEach(() => cleanupDb(dbPath));

    async function enforced(prefix: string): Promise<TriageWorldIds> {
      cleanupDb(dbPath);
      prepareLedgerThrough(dbPath, "0063_learning_loop_ledger");
      const ids = seedCleanTriageWorld(dbPath, prefix);
      await initDb(dbPath);
      return ids;
    }

    it("rejects duplicate Finding Resolution while Cluster Resolution stays operational", async () => {
      await enforced("inv");
      const raw = openRaw(dbPath);
      const now = new Date().toISOString();
      // Duplicate Finding-source resolution (dr-ft-1 already has one).
      expect(() =>
        raw
          .prepare(
            `INSERT INTO triage_resolutions (id, habitat_id, cluster_key, skill_category, source, source_id, resolved_at)
             VALUES ('inv-fr-dup', 'inv-hab', 'inv-cluster', 'convention', 'finding_triage', 'inv-ft-1', ?)`,
          )
          .run(now),
      ).toThrow(/UNIQUE/i);
      // Cluster-source duplicates are deliberately allowed (unconverted).
      raw
        .prepare(
          `INSERT INTO triage_resolutions (id, habitat_id, cluster_key, skill_category, source, source_id, resolved_at)
           VALUES ('inv-cl-1', 'inv-hab', 'inv-cluster', 'convention', 'cluster_triage', 'cluster-mission-1', ?)`,
        )
        .run(now);
      raw
        .prepare(
          `INSERT INTO triage_resolutions (id, habitat_id, cluster_key, skill_category, source, source_id, resolved_at)
           VALUES ('inv-cl-2', 'inv-hab', 'inv-cluster', 'convention', 'cluster_triage', 'cluster-mission-1', ?)`,
        )
        .run(now);
      expect(
        (
          raw
            .prepare("SELECT COUNT(*) as n FROM triage_resolutions WHERE source='cluster_triage'")
            .get() as any
        ).n,
      ).toBe(2);
      raw.close();
    });

    it("rejects deleting evidence-referenced Pulses and referenced Missions; terminal history is not erasable", async () => {
      const ids = await enforced("fk");
      const raw = openRaw(dbPath);
      expect(() => raw.prepare("DELETE FROM pulses WHERE id = ?").run(ids.pulseId)).toThrow(
        /FOREIGN KEY/i,
      );
      expect(() => raw.prepare("DELETE FROM missions WHERE id = ?").run(ids.missionId)).toThrow(
        /FOREIGN KEY/i,
      );
      // Habitat CASCADE convention unchanged.
      raw.prepare("DELETE FROM habitats WHERE id = ?").run(ids.habitatId);
      expect((raw.prepare("SELECT COUNT(*) as n FROM finding_triage").get() as any).n).toBe(0);
      raw.close();
    });
  });

  // ------------------------------------------------------------------
  // CHECK-guard + attestation discriminators, applied DIRECTLY (bypassing
  // the runner) — proves the enforcement SQL itself aborts.
  // ------------------------------------------------------------------
  describe("enforcement SQL CHECK guard (direct apply, no runner)", () => {
    const dbPath = join(TEMP_DIR, "guard.db");

    function applyEnforcementDirectly(db: Database.Database): void {
      const sqlText = readFileSync(join(DRIZZLE_DIR, `${ENFORCEMENT_MIGRATION_TAG}.sql`), "utf-8");
      const statements = sqlText
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      db.exec("BEGIN");
      try {
        for (const stmt of statements) db.exec(stmt);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    }

    afterEach(() => cleanupDb(dbPath));

    it("aborts with NO attestation even when data is clean", () => {
      cleanupDb(dbPath);
      prepareLedgerThrough(dbPath, ADDITIVE_WATERMARK_TAG);
      seedCleanTriageWorld(dbPath, "ga");
      const raw = openRaw(dbPath);
      expect(() => applyEnforcementDirectly(raw)).toThrow(/CHECK constraint failed/i);
      // Aborted BEFORE any replacement: original tables intact, no enforcement index.
      expect(hasEnforcement(dbPath)).toBe(false);
      expect((raw.prepare("SELECT COUNT(*) as n FROM finding_triage").get() as any).n).toBe(3);
      raw.close();
    });

    it("aborts with a STALE-version attestation even when data is clean", () => {
      cleanupDb(dbPath);
      prepareLedgerThrough(dbPath, ADDITIVE_WATERMARK_TAG);
      seedCleanTriageWorld(dbPath, "gs");
      const seed = openRaw(dbPath);
      seed
        .prepare(
          `INSERT INTO migration_preflight_attestations
            (enforcement_migration_id, schema_version, preflight_version, anomaly_query_digest, clean, attested_at)
           VALUES (?, '0064', '001', 'stale', 1, datetime('now'))`,
        )
        .run(ENFORCEMENT_MIGRATION_TAG);
      seed.close();
      const raw = openRaw(dbPath);
      expect(() => applyEnforcementDirectly(raw)).toThrow(/CHECK constraint failed/i);
      expect(hasEnforcement(dbPath)).toBe(false);
      raw.close();
    });

    it("aborts INSIDE the transaction on anomalies introduced AFTER a clean attestation", () => {
      cleanupDb(dbPath);
      prepareLedgerThrough(dbPath, ADDITIVE_WATERMARK_TAG);
      seedCleanTriageWorld(dbPath, "gd");
      const seed = openRaw(dbPath);
      seed
        .prepare(
          `INSERT INTO migration_preflight_attestations
            (enforcement_migration_id, schema_version, preflight_version, anomaly_query_digest, clean, attested_at)
           VALUES (?, ?, ?, 'clean', 1, datetime('now'))`,
        )
        .run(ENFORCEMENT_MIGRATION_TAG, ADDITIVE_SCHEMA_VERSION, PREFLIGHT_VERSION);
      // Anomaly introduced AFTER the attestation: duplicate active identity.
      const now = new Date().toISOString();
      for (const fid of ["gd-dup-1", "gd-dup-2"]) {
        seed
          .prepare(
            `INSERT INTO pulses (id, habitat_id, from_type, from_id, signal_type, subject, metadata)
             VALUES (?, 'gd-hab', 'agent', 'system', 'finding', ?, '{}')`,
          )
          .run(`gd-pulse-${fid}`, fid);
        seed
          .prepare(
            `INSERT INTO finding_triage (id, habitat_id, pulse_id, cluster_key, finding_kind, status, created_at, updated_at)
             VALUES (?, 'gd-hab', ?, 'gd-dup-cluster', 'bug', 'open', ?, ?)`,
          )
          .run(fid, `gd-pulse-${fid}`, now, now);
      }
      seed.close();

      const raw = openRaw(dbPath);
      expect(() => applyEnforcementDirectly(raw)).toThrow(/CHECK constraint failed/i);
      expect(hasEnforcement(dbPath)).toBe(false);
      // The whole transaction rolled back — the duplicate rows survived (the
      // migration did not touch data), and no rebuild artifacts remain.
      const tables = (
        raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      ).map((t) => t.name);
      expect(tables).not.toContain("finding_triage_enforcement_backup");
      expect(
        (
          raw
            .prepare("SELECT COUNT(*) as n FROM finding_triage WHERE cluster_key='gd-dup-cluster'")
            .get() as any
        ).n,
      ).toBe(2);
      raw.close();
    });

    it("applies directly WITH a clean current-version attestation", () => {
      cleanupDb(dbPath);
      prepareLedgerThrough(dbPath, ADDITIVE_WATERMARK_TAG);
      seedCleanTriageWorld(dbPath, "gc");
      const seed = openRaw(dbPath);
      seed
        .prepare(
          `INSERT INTO migration_preflight_attestations
            (enforcement_migration_id, schema_version, preflight_version, anomaly_query_digest, clean, attested_at)
           VALUES (?, ?, ?, 'clean', 1, datetime('now'))`,
        )
        .run(ENFORCEMENT_MIGRATION_TAG, ADDITIVE_SCHEMA_VERSION, PREFLIGHT_VERSION);
      seed.close();
      const raw = openRaw(dbPath);
      expect(() => applyEnforcementDirectly(raw)).not.toThrow();
      expect(hasEnforcement(dbPath)).toBe(true);
      raw.close();
    });
  });

  // ------------------------------------------------------------------
  // Legacy bridge + prerelease marker compatibility through the staged path
  // ------------------------------------------------------------------
  describe("legacy databases upgrade through the staged path", () => {
    const dbPath = join(TEMP_DIR, "legacy.db");
    afterEach(() => cleanupDb(dbPath));

    it("legacy __migrations database crosses the bridge, enforces, and records the full journal", async () => {
      cleanupDb(dbPath);
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
      db.prepare("INSERT INTO __migrations (filename) VALUES ('0001_initial.sql')").run();
      db.close();

      await initDb(dbPath);

      expect(hasEnforcement(dbPath)).toBe(true);
      expect(attestation(dbPath)!.clean).toBe(1);
      expect(ledgerRows(dbPath)).toHaveLength(readJournal().entries.length);
    });
  });
});
