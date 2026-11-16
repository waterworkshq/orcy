/**
 * Journal/hash/timestamp-compatible staged production migration runner.
 *
 * Finding Triage enforcement (0068) keeps its additive watermark, versioned
 * preflight, and all-or-nothing enforcement gate. Documented enum CHECKs (0090)
 * use marked per-column sections: each clean section commits independently,
 * while a dirty section rolls back at its SQL guard, persists an attestation,
 * and leaves only that column unenforced. The 0090 ledger row is recorded only
 * after all seven checks exist, so remediation + restart retries dirty columns
 * without repeating completed swaps.
 *
 * Ledger rows retain Drizzle semantics (sha256(raw SQL), journal `when`), all
 * write reservations use BEGIN IMMEDIATE, current-schema startup is a no-op,
 * and later entries remain pending whenever an enforcement stage is deferred.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { logger } from "../lib/logger.js";

/** Instance type of the production better-sqlite3 driver. */
type SqliteDatabase = import("better-sqlite3").Database;
import {
  runPreflight,
  computeAnomalyQueryDigest,
  PREFLIGHT_VERSION,
  ADDITIVE_SCHEMA_VERSION,
  BLOCKING_ANOMALY_CODES,
} from "../services/findingTriagePreflight.js";

/**
 * The declared additive watermark: the LAST journal entry of the
 * additive-only lifecycle chain (0064 lifecycle storage, 0065 occurrences,
 * 0066 automation revisions/inbox, 0067 release projections/epochs).
 * Enforcement follows in a later entry and runs only after a clean versioned
 * preflight attestation against this watermark's schema.
 */
export const ADDITIVE_WATERMARK_TAG = "0067_release_projection_epochs";

/**
 * Finding Triage's preflight-gated tag, retained for its attestation and test
 * harnesses. ENFORCEMENT_MIGRATION_TAGS lists every guarded test exclusion.
 */
export const ENFORCEMENT_MIGRATION_TAG = "0068_finding_triage_lifecycle_enforcement";
export const ENUM_CHECK_MIGRATION_TAG = "0090_documented_enum_check_constraints";
export const ENFORCEMENT_MIGRATION_TAGS = [
  ENFORCEMENT_MIGRATION_TAG,
  ENUM_CHECK_MIGRATION_TAG,
] as const;

/** Stable operator-facing error code when blocking anomalies stop enforcement. */
export const TRIAGE_ENFORCEMENT_PREFLIGHT_DIRTY_CODE = "TRIAGE_ENFORCEMENT_PREFLIGHT_DIRTY";
export const ENUM_CHECK_ENFORCEMENT_DIRTY_CODE = "ENUM_CHECK_ENFORCEMENT_DIRTY";

const ENUM_CHECK_SCHEMA_VERSION = "0089";
const ENUM_CHECK_PREFLIGHT_VERSION = "001";
const ENUM_CHECK_QUERY_DIGEST = createHash("sha256")
  .update("per-column-restore-guard-v1")
  .digest("hex");

interface GuardedColumn {
  key: string;
  table: string;
  checkName: string;
  statements: string[];
}

interface MigrationEntry {
  tag: string;
  when: number;
  hash: string;
  statements: string[];
  guardedColumns?: GuardedColumn[];
}

/**
 * Read the journal and every migration file, computing the same
 * (hash, created_at, statement split) Drizzle's `readMigrationFiles` +
 * `migrate()` would use.
 */
function splitStatements(raw: string): string[] {
  return raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^(?:--[^\n]*(?:\n|$)|\s)+$/.test(s));
}

function readGuardedColumns(raw: string): GuardedColumn[] | undefined {
  const marker = /^-- orcy-guarded-column: ([a-z_]+)\.([a-z_]+) ([a-z0-9_]+)[\t ]*$/gm;
  const matches = [...raw.matchAll(marker)];
  if (matches.length === 0) return undefined;
  return matches.map((match, index) => {
    const start = match.index! + match[0].length;
    const end = matches[index + 1]?.index ?? raw.length;
    const statements = splitStatements(raw.slice(start, end));
    if (statements.length === 0) {
      throw new Error(`Guarded column '${match[1]}.${match[2]}' has no statements`);
    }
    return {
      key: `${match[1]}.${match[2]}`,
      table: match[1],
      checkName: match[3],
      statements,
    };
  });
}

function readMigrationEntries(migrationFolder: string): MigrationEntry[] {
  const journalPath = join(migrationFolder, "meta", "_journal.json");
  if (!existsSync(journalPath)) {
    throw new Error(`Can't find meta/_journal.json in ${migrationFolder}`);
  }
  const journal = JSON.parse(readFileSync(journalPath, "utf-8"));
  const entries: MigrationEntry[] = [];
  for (const journalEntry of journal.entries as { tag: string; when: number }[]) {
    const sqlPath = join(migrationFolder, `${journalEntry.tag}.sql`);
    if (!existsSync(sqlPath)) {
      throw new Error(`No file ${sqlPath} found in ${migrationFolder} folder`);
    }
    const raw = readFileSync(sqlPath, "utf-8");
    entries.push({
      tag: journalEntry.tag,
      when: Number(journalEntry.when),
      hash: createHash("sha256").update(raw).digest("hex"),
      statements: splitStatements(raw),
      guardedColumns: readGuardedColumns(raw),
    });
  }
  return entries;
}

/**
 * Apply one committed stage: a single transaction running every entry's
 * statements and recording its ledger row — byte-identical ledger semantics
 * to Drizzle's `migrate()` (one transaction over the pending set, INSERT of
 * (hash, folderMillis) after each entry's statements).
 */
function applyStage(sqlite: SqliteDatabase, stage: MigrationEntry[]): void {
  if (stage.length === 0) return;
  if (stage.some((entry) => entry.guardedColumns !== undefined)) {
    throw new Error("Guarded column migrations require per-column transactions");
  }
  // BEGIN IMMEDIATE (not the default deferred transaction): the stage list
  // was read BEFORE any lock, so a concurrently-started process could have
  // committed these entries while we waited for the writer lock. Re-read the
  // ledger INSIDE the reservation and skip anything already applied — the
  // ledger has no unique constraint on hash, so a blind replay would
  // duplicate rows and re-run non-idempotent rebuilds.
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const stillPending = new Set(pendingEntries(sqlite, stage).map((e) => e.hash));
    for (const entry of stage) {
      if (!stillPending.has(entry.hash)) continue;
      for (const stmt of entry.statements) {
        sqlite.prepare(stmt).run();
      }
      sqlite
        .prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
        .run(entry.hash, entry.when);
    }
    sqlite.exec("COMMIT");
  } catch (err) {
    try {
      sqlite.exec("ROLLBACK");
    } catch {
      // already rolled back (defensive)
    }
    throw err;
  }
}

function ensureLedgerTable(sqlite: SqliteDatabase): void {
  sqlite
    .prepare(
      "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)",
    )
    .run();
}

/** Read the ledger once and return every journal entry still pending. */
function pendingEntries(sqlite: SqliteDatabase, entries: MigrationEntry[]): MigrationEntry[] {
  const latest = sqlite
    .prepare("SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1")
    .get() as { created_at: number | string } | undefined;
  const latestWhen = latest === undefined ? null : Number(latest.created_at);
  if (latestWhen === null) return entries;
  return entries.filter((e) => e.when > latestWhen);
}

function writeAttestation(
  sqlite: SqliteDatabase,
  att: {
    enforcementMigrationId: string;
    schemaVersion: string;
    preflightVersion: string;
    digest: string;
    clean: boolean;
    report: string;
  },
): void {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO migration_preflight_attestations
        (enforcement_migration_id, schema_version, preflight_version,
         anomaly_query_digest, clean, anomaly_report, attested_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      att.enforcementMigrationId,
      att.schemaVersion,
      att.preflightVersion,
      att.digest,
      att.clean ? 1 : 0,
      att.report,
    );
}

function writeEnumCheckAttestation(
  sqlite: SqliteDatabase,
  column: string,
  clean: boolean,
): void {
  writeAttestation(sqlite, {
    enforcementMigrationId: `${ENUM_CHECK_MIGRATION_TAG}:${column}`,
    schemaVersion: ENUM_CHECK_SCHEMA_VERSION,
    preflightVersion: ENUM_CHECK_PREFLIGHT_VERSION,
    digest: ENUM_CHECK_QUERY_DIGEST,
    clean,
    report: JSON.stringify({
      code: clean ? undefined : ENUM_CHECK_ENFORCEMENT_DIRTY_CODE,
      column,
    }),
  });
}

export function hasNamedCheck(sqlite: SqliteDatabase, table: string, checkName: string): boolean {
  const row = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  if (!row) return false;
  const escapedName = checkName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bCONSTRAINT\\s+${escapedName}\\s+CHECK\\b`, "i").test(row.sql);
}

function isCheckConstraintError(err: unknown): boolean {
  const message = String((err as { message?: unknown } | null)?.message ?? err ?? "");
  return /CHECK constraint failed/i.test(message);
}

export function recordMigrationEntry(sqlite: SqliteDatabase, entry: MigrationEntry): void {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    if (pendingEntries(sqlite, [entry]).length > 0) {
      sqlite
        .prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
        .run(entry.hash, entry.when);
    }
    sqlite.exec("COMMIT");
  } catch (err) {
    try {
      sqlite.exec("ROLLBACK");
    } catch {
      // already rolled back (defensive)
    }
    throw err;
  }
}

function applyGuardedColumnEntry(sqlite: SqliteDatabase, entry: MigrationEntry): boolean {
  const columns = entry.guardedColumns;
  if (columns === undefined) throw new Error(`Migration '${entry.tag}' has no guarded columns`);

  for (const column of columns) {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      if (pendingEntries(sqlite, [entry]).length === 0) {
        sqlite.exec("COMMIT");
        return true;
      }
      if (hasNamedCheck(sqlite, column.table, column.checkName)) {
        sqlite.exec("COMMIT");
        continue;
      }
      for (const statement of column.statements) {
        sqlite.prepare(statement).run();
      }
      writeEnumCheckAttestation(sqlite, column.key, true);
      sqlite.exec("COMMIT");
    } catch (err) {
      try {
        sqlite.exec("ROLLBACK");
      } catch {
        // already rolled back (defensive)
      }
      if (!isCheckConstraintError(err)) throw err;
      writeEnumCheckAttestation(sqlite, column.key, false);
      logger.error(
        {
          code: ENUM_CHECK_ENFORCEMENT_DIRTY_CODE,
          column: column.key,
          enforcementMigrationId: ENUM_CHECK_MIGRATION_TAG,
        },
        "Enum CHECK enforcement deferred for a dirty legacy column. " +
          "Remediate the reported column and restart to retry; other columns remain enforced.",
      );
    } finally {
      sqlite.pragma("ignore_check_constraints = OFF");
    }
  }

  const complete = columns.every((column) =>
    hasNamedCheck(sqlite, column.table, column.checkName),
  );
  if (complete) recordMigrationEntry(sqlite, entry);
  return complete;
}

/**
 * Run the staged production migration protocol on the raw better-sqlite3
 * connection. See the module docblock for the stage boundaries.
 */
export function runStagedProductionMigrations(
  sqlite: SqliteDatabase,
  migrationFolder: string,
): void {
  const entries = readMigrationEntries(migrationFolder);
  const watermarkIdx = entries.findIndex((e) => e.tag === ADDITIVE_WATERMARK_TAG);
  const enforcementIdx = entries.findIndex((e) => e.tag === ENFORCEMENT_MIGRATION_TAG);
  const enumCheckIdx = entries.findIndex((e) => e.tag === ENUM_CHECK_MIGRATION_TAG);

  ensureLedgerTable(sqlite);

  const pending = pendingEntries(sqlite, entries);
  if (pending.length === 0) return;

  if (enforcementIdx === -1) {
    if (enumCheckIdx !== -1) {
      throw new Error("Enum CHECK enforcement requires the Finding Triage staged migration");
    }
    applyStage(sqlite, pending);
    return;
  }
  if (watermarkIdx === -1 || watermarkIdx > enforcementIdx) {
    throw new Error(
      `Staged migration misconfiguration: additive watermark '${ADDITIVE_WATERMARK_TAG}' ` +
        `must exist in the journal before enforcement '${ENFORCEMENT_MIGRATION_TAG}'`,
    );
  }
  if (enumCheckIdx !== -1 && enumCheckIdx < enforcementIdx) {
    throw new Error("Enum CHECK enforcement must follow Finding Triage enforcement");
  }

  if (pending.some((e) => e.tag === ENFORCEMENT_MIGRATION_TAG)) {
    const watermarkWhen = entries[watermarkIdx].when;
    applyStage(
      sqlite,
      pending.filter((e) => e.when <= watermarkWhen),
    );

    const result = runPreflight();
    const digest = computeAnomalyQueryDigest();
    const blocking = result.anomalies.filter((a) => BLOCKING_ANOMALY_CODES.has(a.code));
    const clean = blocking.length === 0;
    writeAttestation(sqlite, {
      enforcementMigrationId: ENFORCEMENT_MIGRATION_TAG,
      schemaVersion: ADDITIVE_SCHEMA_VERSION,
      preflightVersion: PREFLIGHT_VERSION,
      digest,
      clean,
      report: JSON.stringify({
        code: clean ? undefined : TRIAGE_ENFORCEMENT_PREFLIGHT_DIRTY_CODE,
        preflightVersion: result.version,
        schemaVersion: result.schemaVersion,
        anomalyCount: result.anomalyCount,
        anomaliesByCode: result.anomaliesByCode,
        blockingAnomalies: blocking,
        anomalies: result.anomalies,
      }),
    });

    if (!clean) {
      logger.error(
        {
          code: TRIAGE_ENFORCEMENT_PREFLIGHT_DIRTY_CODE,
          blockingCount: blocking.length,
          blockingByCode: blocking.reduce<Record<string, number>>((acc, a) => {
            acc[a.code] = (acc[a.code] ?? 0) + 1;
            return acc;
          }, {}),
          enforcementMigrationId: ENFORCEMENT_MIGRATION_TAG,
        },
        "Finding Triage enforcement deferred: blocking preflight anomalies present. " +
          "Remediate the reported anomalies (see migration_preflight_attestations.anomaly_report) " +
          "and restart to retry enforcement. The API continues on the additive schema.",
      );
      return;
    }
  }

  if (enumCheckIdx === -1) {
    applyStage(sqlite, pendingEntries(sqlite, entries));
    return;
  }

  const beforeEnumChecks = pendingEntries(sqlite, entries).filter(
    (entry) => entry.when < entries[enumCheckIdx].when,
  );
  applyStage(sqlite, beforeEnumChecks);

  const enumEntry = entries[enumCheckIdx];
  if (pendingEntries(sqlite, [enumEntry]).length > 0 && !applyGuardedColumnEntry(sqlite, enumEntry)) {
    return;
  }

  applyStage(sqlite, pendingEntries(sqlite, entries));
}
