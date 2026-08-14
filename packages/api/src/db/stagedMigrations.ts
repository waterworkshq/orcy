/**
 * Staged production migration runner for the Finding Triage lifecycle
 * enforcement (canonical plan: "Preflight and later enforcement", step 3).
 *
 * Replaces the one-shot production call to Drizzle `migrate()` with a
 * journal/hash/timestamp-compatible staged runner:
 *
 *   Stage 1 — apply + commit every pending journal entry through the declared
 *   additive watermark (0067). Ledger rows are written exactly like Drizzle
 *   does: (hash = sha256(raw SQL file), created_at = journal `when`).
 *
 *   Preflight gate — run the versioned preflight against the now-present
 *   schema and write a database-local attestation (preflight version +
 *   deterministic SHA-256 anomaly-query digest). Blocking anomalies (the
 *   uniqueness-collision classes the enforcement constraints cannot be
 *   created over) STOP before enforcement: the failure is logged with the
 *   stable code TRIAGE_ENFORCEMENT_PREFLIGHT_DIRTY, the full machine-readable
 *   anomaly report is persisted in the attestation row, the server keeps
 *   booting on the additive schema (service-level guards remain the first
 *   line), and enforcement is retried on the next startup after remediation.
 *   Advisory diagnostics never block.
 *
 *   Stage 2 — apply + commit the enforcement entry and every later entry.
 *
 * Preserved semantics (same as the previous one-shot path):
 *   - legacy `__migrations` ledger bridging and prerelease marker
 *     reconciliation happen before the stages (owned by initDb);
 *   - strictly increasing journal `when` timestamps recorded as created_at;
 *   - `sha256(raw SQL)` ledger hashes — a database migrated by this runner is
 *     indistinguishable from one migrated by Drizzle `migrate()`;
 *   - each committed stage is one transaction, so an interrupted stage leaves
 *     the ledger at the previous committed boundary and restarts cleanly;
 *   - current-schema startup is a no-op (nothing pending);
 *   - the same workspace / compiled migration folder resolution as before.
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
 * The enforcement migration this runner gates. Also the attestation key in
 * `migration_preflight_attestations.enforcement_migration_id`.
 */
export const ENFORCEMENT_MIGRATION_TAG = "0068_finding_triage_lifecycle_enforcement";

/** Stable operator-facing error code when blocking anomalies stop enforcement. */
export const TRIAGE_ENFORCEMENT_PREFLIGHT_DIRTY_CODE = "TRIAGE_ENFORCEMENT_PREFLIGHT_DIRTY";

interface MigrationEntry {
  tag: string;
  when: number;
  hash: string;
  statements: string[];
}

/**
 * Read the journal and every migration file, computing the same
 * (hash, created_at, statement split) Drizzle's `readMigrationFiles` +
 * `migrate()` would use.
 */
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
      statements: raw
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
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
  const tx = sqlite.transaction((list: MigrationEntry[]) => {
    for (const entry of list) {
      for (const stmt of entry.statements) {
        sqlite.prepare(stmt).run();
      }
      sqlite
        .prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
        .run(entry.hash, entry.when);
    }
  });
  tx(stage);
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

  ensureLedgerTable(sqlite);

  const pending = pendingEntries(sqlite, entries);
  if (pending.length === 0) return; // current-schema startup no-op

  if (enforcementIdx === -1) {
    // The resolved journal predates the staged pair (older compiled package).
    // Preserve the historical one-shot semantics for every pending entry.
    applyStage(sqlite, pending);
    return;
  }
  if (watermarkIdx === -1 || watermarkIdx > enforcementIdx) {
    // Misconfigured constants must never silently fall back to one-shot —
    // that would apply enforcement without the preflight gate.
    throw new Error(
      `Staged migration misconfiguration: additive watermark '${ADDITIVE_WATERMARK_TAG}' ` +
        `must exist in the journal before enforcement '${ENFORCEMENT_MIGRATION_TAG}'`,
    );
  }

  const enforcementPending = pending.some((e) => e.tag === ENFORCEMENT_MIGRATION_TAG);
  if (!enforcementPending) {
    // Enforcement already applied; later entries run with one-shot semantics.
    applyStage(sqlite, pending);
    return;
  }

  // --- STAGE 1: additive entries through the declared watermark, committed
  // alone so the preflight runs against a durable, restart-safe schema state.
  const watermarkWhen = entries[watermarkIdx].when;
  const stage1 = pending.filter((e) => e.when <= watermarkWhen);
  applyStage(sqlite, stage1);

  // --- Preflight gate: versioned preflight + database-local attestation.
  const result = runPreflight();
  const digest = computeAnomalyQueryDigest(result);
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
    // STOP before enforcement. Keep booting on the additive schema; the
    // service-level guards remain the first line. Retry on next startup.
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

  // --- STAGE 2: enforcement entry and every later entry, one transaction.
  const pending2 = pendingEntries(sqlite, entries);
  applyStage(sqlite, pending2);
}
