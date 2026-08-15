/**
 * Drizzle-declaration ↔ physical-schema constraint parity.
 *
 * The hand-written migration SQL (0064–0070) is the migration source of
 * truth, but the Drizzle exports are the `drizzle-kit generate` baseline —
 * any constraint that exists in one and not the other is drift: generate
 * would either drop it or emit a spurious diff for it. This test builds a
 * PRODUCTION-shaped database (the full journal through the additive
 * watermark, the 0068 enforcement rebuild applied the way the staged runner
 * applies it, then 0069+) with better-sqlite3 and compares, per in-scope
 * table, the physical constraints (PRAGMA index_list / index_info /
 * table_info / foreign_key_list + CHECK constraints parsed from
 * sqlite_master) against the Drizzle table's declared keys.
 *
 * Fails in BOTH drift directions:
 *   - a SQL index/constraint with no Drizzle declaration (generate would
 *     drop it on the next full regen);
 *   - a Drizzle declaration with no SQL counterpart (generate would emit a
 *     spurious diff / CREATE for something the migrations never made).
 *
 * Index NAME parity is asserted only for named `CREATE INDEX` entries
 * (origin 'c'); inline SQL `UNIQUE (...)` constraints materialize as
 * anonymous `sqlite_autoindex_*` entries and are matched by
 * (columns, uniqueness, partial) against any Drizzle unique declaration
 * (named uniqueIndex, column-level .unique(), or unique() constraint).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import type { SQL } from "drizzle-orm";
import {
  findingTriage,
  triageResolutions,
  findingTriageEvidence,
  findingTriageLineageRepairs,
  findingTriageLineageBaselineEvidence,
  triagePublicationOccurrences,
  migrationPreflightAttestations,
} from "../db/schema/triage.js";
import {
  automationRuleRevisions,
  automationEventInbox,
  automationRuleDeliveries,
  automationDeliveryActionCheckpoints,
  automationDeliveryDispositions,
  automationRunCompletionOutbox,
} from "../db/schema/automation.js";
import {
  releaseProjectionDeliveries,
  releaseActivationEpochs,
  releaseActivationEpochGroups,
} from "../db/schema/release.js";
import {
  ENFORCEMENT_MIGRATION_TAG,
  ADDITIVE_WATERMARK_TAG,
} from "../db/stagedMigrations.js";
import {
  PREFLIGHT_VERSION,
  ADDITIVE_SCHEMA_VERSION,
  computeAnomalyQueryDigest,
} from "../services/findingTriagePreflight.js";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const DRIZZLE_DIR = join(PACKAGE_ROOT, "drizzle");

/** Tables created or rebuilt by migrations 0064–0070, with their exports. */
const SCOPED_TABLES: readonly { table: SQLiteTable; name: string }[] = [
  { table: findingTriage, name: "finding_triage" },
  { table: triageResolutions, name: "triage_resolutions" },
  { table: findingTriageEvidence, name: "finding_triage_evidence" },
  { table: findingTriageLineageRepairs, name: "finding_triage_lineage_repairs" },
  {
    table: findingTriageLineageBaselineEvidence,
    name: "finding_triage_lineage_baseline_evidence",
  },
  { table: triagePublicationOccurrences, name: "triage_publication_occurrences" },
  { table: migrationPreflightAttestations, name: "migration_preflight_attestations" },
  { table: automationRuleRevisions, name: "automation_rule_revisions" },
  { table: automationEventInbox, name: "automation_event_inbox" },
  { table: automationRuleDeliveries, name: "automation_rule_deliveries" },
  {
    table: automationDeliveryActionCheckpoints,
    name: "automation_delivery_action_checkpoints",
  },
  { table: automationDeliveryDispositions, name: "automation_delivery_dispositions" },
  { table: automationRunCompletionOutbox, name: "automation_run_completion_outbox" },
  { table: releaseProjectionDeliveries, name: "release_projection_deliveries" },
  { table: releaseActivationEpochs, name: "release_activation_epochs" },
  { table: releaseActivationEpochGroups, name: "release_activation_epoch_groups" },
];

// ---------------------------------------------------------------------------
// Production-shaped database construction
// ---------------------------------------------------------------------------

function applyMigrationSql(db: Database.Database, sqlText: string): void {
  const statements = sqlText
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) db.exec(stmt);
}

/**
 * Full journal through the additive watermark, then the enforcement
 * migration applied exactly as the staged runner would (clean attestation
 * with the LIVE preflight constants), then 0069+. Dataless: the anomaly
 * guards count anomalies, and an empty database is clean by definition.
 */
function buildProductionShapeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const journal = JSON.parse(
    readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf-8"),
  ) as { entries: { tag: string }[] };
  const watermarkIdx = journal.entries.findIndex((e) => e.tag === ADDITIVE_WATERMARK_TAG);
  if (watermarkIdx === -1) throw new Error(`unknown journal tag ${ADDITIVE_WATERMARK_TAG}`);

  for (const entry of journal.entries.slice(0, watermarkIdx + 1)) {
    const sqlPath = join(DRIZZLE_DIR, `${entry.tag}.sql`);
    if (!existsSync(sqlPath)) continue; // pre-consolidation orphans
    applyMigrationSql(db, readFileSync(sqlPath, "utf-8"));
  }

  db.prepare(
    `INSERT INTO migration_preflight_attestations
       (enforcement_migration_id, schema_version, preflight_version, anomaly_query_digest, clean, attested_at)
     VALUES (?, ?, ?, ?, 1, datetime('now'))`,
  ).run(ENFORCEMENT_MIGRATION_TAG, ADDITIVE_SCHEMA_VERSION, PREFLIGHT_VERSION, computeAnomalyQueryDigest());
  applyMigrationSql(db, readFileSync(join(DRIZZLE_DIR, `${ENFORCEMENT_MIGRATION_TAG}.sql`), "utf-8"));

  // Post-enforcement entries (0069+).
  for (const entry of journal.entries.slice(watermarkIdx + 1)) {
    const sqlPath = join(DRIZZLE_DIR, `${entry.tag}.sql`);
    if (!existsSync(sqlPath)) continue;
    if (entry.tag === ENFORCEMENT_MIGRATION_TAG) continue; // already applied above
    applyMigrationSql(db, readFileSync(sqlPath, "utf-8"));
  }
  return db;
}

// ---------------------------------------------------------------------------
// Normalization + extraction helpers
// ---------------------------------------------------------------------------

/** Collapse whitespace/punctuation so hand-written SQL texts compare equal. */
function normalizeExpr(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s*\(\s*/g, "(")
    .replace(/\s*\)\s*/g, ")")
    .replace(/\s*,\s*/g, ",");
}

/** Canonical identity string for a FK (used for set comparison). */
function foreignKeyIdentity(f: SqlFkShape): string {
  return `${f.from}->${f.table}(${f.to}):${f.onDelete}`;
}

/** Flatten a drizzle SQL template (pure string chunks) to its text. */
function sqlTemplateText(template: SQL | undefined): string | null {
  if (!template) return null;
  return template.queryChunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      const value = (chunk as { value?: string | string[] }).value;
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return value.join("");
      return "";
    })
    .join("");
}

/**
 * Extract every CHECK constraint body from a stored CREATE TABLE statement.
 * Balanced-paren scan that skips single-quoted string literals — handles
 * both column-level and table-level CHECKs.
 */
function extractCheckBodies(createTableSql: string): string[] {
  const bodies: string[] = [];
  let i = 0;
  const text = createTableSql;
  while (i < text.length) {
    if (text[i] === "'") {
      const end = text.indexOf("'", i + 1);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (/^check\b/i.test(text.slice(i)) && /^\s*\(/.test(text.slice(i + 5))) {
      let depth = 0;
      let j = i + 5;
      while (text[j] !== undefined && !"(".includes(text[j])) j++;
      const start = j;
      while (j < text.length) {
        if (text[j] === "'") {
          const end = text.indexOf("'", j + 1);
          j = end === -1 ? text.length : end + 1;
          continue;
        }
        if (text[j] === "(") depth++;
        else if (text[j] === ")") {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      bodies.push(text.slice(start + 1, j));
      i = j + 1;
      continue;
    }
    i++;
  }
  return bodies;
}

interface SqlIndexShape {
  name: string;
  columns: string[];
  unique: boolean;
  partial: boolean;
  origin: string;
}

interface SqlFkShape {
  from: string;
  table: string;
  to: string;
  onDelete: string;
}

function sqlIndexShapes(db: Database.Database, table: string): SqlIndexShape[] {
  const rows = db.prepare(`PRAGMA index_list(${table})`).all() as {
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }[];
  return rows.map((row) => ({
    name: row.name,
    unique: row.unique === 1,
    partial: row.partial === 1,
    origin: row.origin,
    columns: (
      db.prepare(`PRAGMA index_info(${row.name})`).all() as { name: string | null }[]
    )
      .map((c) => c.name ?? "")
      .filter((n) => n.length > 0),
  }));
}

function sqlPrimaryKey(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
    pk: number;
  }[];
  return rows
    .filter((r) => r.pk > 0)
    .toSorted((a, b) => a.pk - b.pk)
    .map((r) => r.name);
}

function sqlForeignKeys(db: Database.Database, table: string): SqlFkShape[] {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
    id: number;
    table: string;
    from: string;
    to: string | null;
    on_delete: string;
  }[];
  // A COMPOSITE foreign key appears as one row per column sharing an `id`
  // (in `seq` order). Merge each group into a single comma-joined shape so
  // composite constraints compare against Drizzle's comma-joined
  // declaration.
  const groups = new Map<number, typeof rows>();
  for (const r of rows) {
    const group = groups.get(r.id);
    if (group) group.push(r);
    else groups.set(r.id, [r]);
  }
  return [...groups.values()].map((group) => ({
    from: group.map((r) => r.from).join(","),
    table: group[0].table,
    to: group.map((r) => r.to ?? "").join(","),
    onDelete: group[0].on_delete.toLowerCase(),
  }));
}

function sqlCheckBodies(db: Database.Database, table: string): string[] {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  if (!row) return [];
  return extractCheckBodies(row.sql).map(normalizeExpr);
}

// ---------------------------------------------------------------------------
// Drizzle-side extraction
// ---------------------------------------------------------------------------

interface DrizzleIndexShape {
  name: string;
  columns: string[];
  unique: boolean;
  hasWhere: boolean;
}

function drizzleIndexShapes(table: SQLiteTable): DrizzleIndexShape[] {
  const cfg = getTableConfig(table as any);
  return cfg.indexes.map((ix) => ({
    name: ix.config.name,
    columns: ix.config.columns.map((c: any) => c.name),
    unique: ix.config.unique,
    hasWhere: ix.config.where !== undefined,
  }));
}

function drizzlePrimaryKey(table: SQLiteTable): string[] {
  const cfg = getTableConfig(table as any);
  if (cfg.primaryKeys.length > 0) {
    return cfg.primaryKeys[0].columns.map((c: any) => c.name);
  }
  return cfg.columns
    .filter((c: any) => c.primary)
    .map((c: any) => c.name);
}

function drizzleUniqueColumnSets(table: SQLiteTable): string[][] {
  const cfg = getTableConfig(table as any);
  const sets: string[][] = [];
  for (const ix of cfg.indexes) {
    if (ix.config.unique) sets.push(ix.config.columns.map((c: any) => c.name));
  }
  for (const c of cfg.columns) {
    if (c.isUnique) sets.push([c.name]);
  }
  for (const uc of cfg.uniqueConstraints) {
    sets.push(uc.columns.map((c: any) => c.name));
  }
  return sets;
}

function drizzleForeignKeys(table: SQLiteTable): SqlFkShape[] {
  const cfg = getTableConfig(table as any);
  return cfg.foreignKeys.map((fk: any) => {
    const ref = fk.reference();
    const refTable = ref.foreignTable as any;
    return {
      from: ref.columns.map((c: any) => c.name).join(","),
      table: refTable[Symbol.for("drizzle:Name")] as string,
      to: ref.foreignColumns.map((c: any) => c.name).join(","),
      onDelete: (fk.onDelete ?? "no action").toLowerCase(),
    };
  });
}

function drizzleCheckBodies(table: SQLiteTable): string[] {
  const cfg = getTableConfig(table as any);
  return cfg.checks
    .map((c: any) => sqlTemplateText(c.value))
    .filter((t): t is string => t !== null)
    .map(normalizeExpr);
}

// ---------------------------------------------------------------------------
// The parity assertions
// ---------------------------------------------------------------------------

describe("Drizzle ↔ migration SQL constraint parity (0064–0070 tables)", () => {
  const db = buildProductionShapeDb();

  it("built a production-shaped database with enforcement applied", () => {
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_finding_triage_active_identity'",
      )
      .get();
    expect(idx).toBeDefined();
  });

  for (const { table, name } of SCOPED_TABLES) {
    it(`declares every physical constraint of ${name} in Drizzle (and nothing extra)`, () => {
      const sqlIndexes = sqlIndexShapes(db, name);
      const drizzleIndexes = drizzleIndexShapes(table);
      const errors: string[] = [];

      // --- Named CREATE INDEX entries: exact name + shape match. ---
      for (const sqlIdx of sqlIndexes.filter((i) => i.origin === "c")) {
        const match = drizzleIndexes.find((d) => d.name === sqlIdx.name);
        if (!match) {
          errors.push(
            `SQL index ${sqlIdx.name} (${sqlIdx.columns.join(",")}) has no Drizzle declaration`,
          );
          continue;
        }
        if (match.columns.join(",") !== sqlIdx.columns.join(",")) {
          errors.push(
            `index ${sqlIdx.name}: columns [${match.columns.join(",")}] != SQL [${sqlIdx.columns.join(",")}]`,
          );
        }
        if (match.unique !== sqlIdx.unique) {
          errors.push(`index ${sqlIdx.name}: unique ${match.unique} != SQL ${sqlIdx.unique}`);
        }
        if (match.hasWhere !== sqlIdx.partial) {
          errors.push(
            `index ${sqlIdx.name}: partial declaration ${match.hasWhere} != SQL ${sqlIdx.partial}`,
          );
        }
      }

      // --- Every Drizzle index must exist physically. Non-unique indexes
      // match by name; unique indexes may match EITHER a physical named
      // index OR an inline SQL UNIQUE constraint (anonymous autoindex) on
      // the same columns — both represent the same uniqueness.
      const namedSql = new Map(
        sqlIndexes.filter((i) => i.origin === "c").map((i) => [i.name, i]),
      );
      const uniqueAutoindexes = sqlIndexes.filter((i) => i.origin === "u");
      for (const d of drizzleIndexes) {
        const namedMatch = namedSql.has(d.name);
        const uniqueMatch =
          d.unique &&
          !namedMatch &&
          uniqueAutoindexes.some((i) => i.columns.join(",") === d.columns.join(","));
        if (!namedMatch && !uniqueMatch) {
          errors.push(
            `Drizzle index ${d.name} (${d.columns.join(",")}) has no SQL counterpart — generate would emit a spurious CREATE`,
          );
        }
      }

      // --- Inline UNIQUE constraints ↔ any Drizzle unique declaration. ---
      const uniqueSets = drizzleUniqueColumnSets(table);
      for (const sqlIdx of sqlIndexes.filter((i) => i.origin === "u")) {
        if (!uniqueSets.some((cols) => cols.join(",") === sqlIdx.columns.join(","))) {
          errors.push(
            `SQL UNIQUE constraint (${sqlIdx.columns.join(",")}) has no Drizzle unique declaration`,
          );
        }
      }
      for (const cols of uniqueSets) {
        const exists = sqlIndexes
          .filter((i) => i.origin === "u")
          .some((i) => i.columns.join(",") === cols.join(","));
        const asNamedIndex = drizzleIndexes.some(
          (d) => d.unique && d.columns.join(",") === cols.join(",") && namedSql.has(d.name),
        );
        if (!exists && !asNamedIndex) {
          errors.push(
            `Drizzle unique declaration (${cols.join(",")}) has no SQL UNIQUE constraint/index`,
          );
        }
      }

      // --- Primary keys. ---
      const sqlPk = sqlPrimaryKey(db, name);
      const drizzlePk = drizzlePrimaryKey(table);
      if (sqlPk.join(",") !== drizzlePk.join(",")) {
        errors.push(
          `primary key: Drizzle [${drizzlePk.join(",")}] != SQL [${sqlPk.join(",")}]`,
        );
      }

      // --- Foreign keys (columns, target, ON DELETE action). ---
      const sqlFks = new Set(sqlForeignKeys(db, name).map(foreignKeyIdentity));
      const drizzleFks = new Set(drizzleForeignKeys(table).map(foreignKeyIdentity));
      for (const k of sqlFks) {
        if (!drizzleFks.has(k)) errors.push(`SQL FK ${k} has no Drizzle declaration`);
      }
      for (const k of drizzleFks) {
        if (!sqlFks.has(k)) errors.push(`Drizzle FK ${k} has no SQL counterpart`);
      }

      // --- CHECK constraints (normalized text multiset). ---
      const sqlChecks = sqlCheckBodies(db, name).toSorted();
      const drizzleChecks = drizzleCheckBodies(table).toSorted();
      if (JSON.stringify(sqlChecks) !== JSON.stringify(drizzleChecks)) {
        errors.push(
          `CHECK constraints: Drizzle ${JSON.stringify(drizzleChecks)} != SQL ${JSON.stringify(sqlChecks)}`,
        );
      }

      expect(errors, errors.join("\n")).toEqual([]);
    });
  }
});
