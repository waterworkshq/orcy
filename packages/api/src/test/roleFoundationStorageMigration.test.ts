/**
 * Migration 0083 storage proofs on the PRODUCTION better-sqlite3 driver.
 *
 * Author-lane focused migration test (distinct filename from the independent
 * lane's roleFoundationMigration.test.ts): applies the real Drizzle journal
 * to a fresh file-backed database the way the staged runner does (clean
 * attestation before 0068), then proves the migration-level guarantees:
 * seeded fixed-ID built-ins, column additions, revision immutability
 * triggers, one-active-incarnation partial unique, retire→new-incarnation
 * acceptance, owner/team exclusivity triggers, the composite
 * (definition_id, revision_id) FK and the active-grant-tuple unique.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const DRIZZLE_DIR = join(PACKAGE_ROOT, "drizzle");
const ENFORCEMENT_TAG = "0068_finding_triage_lifecycle_enforcement";
// Pinned by 0068's guard; asserted equal to the live constant so drift fails here, not in production.
const PINNED_DIGEST = "9d1492e92d766e2d45db782502ce734fc34e09c0fb90eb047359fc8b013735b9";
const PINNED_PREFLIGHT = "003";
const PINNED_SCHEMA = "0067";

let db: Database.Database;
let dir: string;

function applyTag(tag: string): void {
  const sqlText = readFileSync(join(DRIZZLE_DIR, `${tag}.sql`), "utf-8");
  for (const stmt of sqlText
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean)) {
    db.exec(stmt);
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rf-mig-"));
  db = new Database(join(dir, "fresh.db"));
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");

  const journal = JSON.parse(
    readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf-8"),
  ) as { entries: { tag: string }[] };
  const last = journal.entries.at(-1)!.tag;
  expect(last).toBe("0083_role_foundation_governance");

  for (const entry of journal.entries) {
    if (entry.tag === ENFORCEMENT_TAG) {
      db.prepare(
        `INSERT OR REPLACE INTO migration_preflight_attestations
          (enforcement_migration_id, schema_version, preflight_version, anomaly_query_digest, clean, anomaly_report, attested_at)
         VALUES (?, ?, ?, ?, 1, '{"clean":true}', datetime('now'))`,
      ).run(ENFORCEMENT_TAG, PINNED_SCHEMA, PINNED_PREFLIGHT, PINNED_DIGEST);
    }
    applyTag(entry.tag);
  }
});

afterAll(() => {
  db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("0083 role foundation migration (production driver)", () => {
  it("creates the five governance tables and seeds fixed-ID built-ins idempotently", () => {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN
         ('governance_scopes','role_definitions','role_revisions','role_assignments','governance_audit') ORDER BY name`,
      )
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual([
      "governance_audit",
      "governance_scopes",
      "role_assignments",
      "role_definitions",
      "role_revisions",
    ]);

    const defs = db
      .prepare("SELECT id, name, is_builtin, latest_revision FROM role_definitions ORDER BY id")
      .all();
    expect(defs).toEqual([
      { id: "builtin-role-coordinator", name: "Coordinator", is_builtin: 1, latest_revision: 1 },
      {
        id: "builtin-role-review-coordinator",
        name: "Review Coordinator",
        is_builtin: 1,
        latest_revision: 1,
      },
    ]);

    const revs = db
      .prepare(
        "SELECT id, definition_id, ordinal, permissions, catalogue_version FROM role_revisions ORDER BY id",
      )
      .all();
    expect(revs).toEqual([
      {
        id: "builtin-role-coordinator-rev-1",
        definition_id: "builtin-role-coordinator",
        ordinal: 1,
        permissions: '["review.configure","review.assign"]',
        catalogue_version: 1,
      },
      {
        id: "builtin-role-review-coordinator-rev-1",
        definition_id: "builtin-role-review-coordinator",
        ordinal: 1,
        permissions: '["review.assign"]',
        catalogue_version: 1,
      },
    ]);

    // Idempotent seed: re-running the seed INSERT..SELECT block inserts nothing.
    const before = db.prepare("SELECT COUNT(*) c FROM role_definitions").get() as { c: number };
    const sqlText = readFileSync(join(DRIZZLE_DIR, "0083_role_foundation_governance.sql"), "utf-8");
    for (const stmt of sqlText
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("INSERT"))) {
      db.exec(stmt);
    }
    const after = db.prepare("SELECT COUNT(*) c FROM role_definitions").get() as { c: number };
    expect(after.c).toBe(before.c);
  });

  it("adds habitats.owner_user_id (nullable, no backfill) and review_rules.version NOT NULL DEFAULT 1", () => {
    const owner = db
      .prepare("PRAGMA table_info(habitats)")
      .all()
      .find((c) => (c as { name: string }).name === "owner_user_id") as
      | { type: string; notnull: number; dflt_value: string | null }
      | undefined;
    expect(owner?.type).toBe("TEXT");
    expect(owner?.notnull).toBe(0);
    const nullOwners = db
      .prepare("SELECT COUNT(*) c FROM habitats WHERE owner_user_id IS NOT NULL")
      .get() as { c: number };
    expect(nullOwners.c).toBe(0);

    const version = db
      .prepare("PRAGMA table_info(review_rules)")
      .all()
      .find((c) => (c as { name: string }).name === "version") as
      | { type: string; notnull: number; dflt_value: string }
      | undefined;
    expect(version).toMatchObject({ type: "INTEGER", notnull: 1, dflt_value: "1" });
  });

  it("rejects any UPDATE or DELETE on role_revisions via the named triggers", () => {
    expect(() =>
      db.exec("UPDATE role_revisions SET permissions = '[]' WHERE id = 'builtin-role-coordinator-rev-1'"),
    ).toThrowError(/role revisions are immutable/);
    expect(() =>
      db.exec("DELETE FROM role_revisions WHERE id = 'builtin-role-coordinator-rev-1'"),
    ).toThrowError(/role revisions are immutable/);
  });

  it("keeps exactly one active incarnation and allows retire→new-incarnation", () => {
    db.exec(
      "INSERT INTO governance_scopes (scope_kind, scope_id, incarnation, version) VALUES ('team','rf-t1',1,1)",
    );
    expect(() =>
      db.exec(
        "INSERT INTO governance_scopes (scope_kind, scope_id, incarnation, version) VALUES ('team','rf-t1',2,1)",
      ),
    ).toThrowError(/UNIQUE/);
    db.exec(
      "UPDATE governance_scopes SET retired_at = datetime('now'), version = version + 1 WHERE scope_kind='team' AND scope_id='rf-t1' AND incarnation=1",
    );
    db.exec(
      "INSERT INTO governance_scopes (scope_kind, scope_id, incarnation, version) VALUES ('team','rf-t1',2,1)",
    );
    const active = db
      .prepare(
        "SELECT incarnation FROM governance_scopes WHERE scope_kind='team' AND scope_id='rf-t1' AND retired_at IS NULL",
      )
      .all();
    expect(active).toEqual([{ incarnation: 2 }]);
  });

  it("keeps a team habitat from carrying a personal owner on insert and update", () => {
    db.exec("INSERT INTO users (id, username, password_hash, role) VALUES ('rf-u1','rf-u1','x','admin')");
    db.exec("INSERT INTO organizations (id, name, slug) VALUES ('rf-o1','O','rf-o1')");
    db.exec("INSERT INTO teams (id, organization_id, name, slug) VALUES ('rf-tm1','rf-o1','T','rf-tm1')");
    db.exec("INSERT INTO habitats (id, name, team_id) VALUES ('rf-h-team','HT','rf-tm1')");
    expect(() =>
      db.exec("UPDATE habitats SET owner_user_id = 'rf-u1' WHERE id = 'rf-h-team'"),
    ).toThrowError(/personal owner/);
    expect(() =>
      db.exec(
        "INSERT INTO habitats (id, name, team_id, owner_user_id) VALUES ('rf-h-x','HX','rf-tm1','rf-u1')",
      ),
    ).toThrowError(/personal owner/);
    // Personal habitat may carry an owner.
    db.exec(
      "INSERT INTO habitats (id, name, owner_user_id) VALUES ('rf-h-personal','HP','rf-u1')",
    );
  });

  it("enforces the composite (definition_id, revision_id) FK and the active-grant-tuple unique", () => {
    expect(() =>
      db.exec(
        `INSERT INTO role_assignments
           (id, principal_type, principal_id, definition_id, revision_id, scope_kind, scope_id, scope_incarnation, state, version, issuer_user_id)
         VALUES ('rf-x1','human','rf-u1','builtin-role-review-coordinator','builtin-role-coordinator-rev-1','team','rf-t1',2,'active',1,'rf-u1')`,
      ),
    ).toThrowError(/FOREIGN KEY/);

    const ins = db.prepare(
      `INSERT INTO role_assignments
         (id, principal_type, principal_id, definition_id, revision_id, scope_kind, scope_id, scope_incarnation, state, version, issuer_user_id)
       VALUES (?,'human','rf-u1','builtin-role-coordinator','builtin-role-coordinator-rev-1','team','rf-t1',2,'active',1,'rf-u1')`,
    );
    ins.run("rf-a1");
    expect(() => ins.run("rf-a2")).toThrowError(/UNIQUE/);
    // Revoked rows do not occupy the active tuple.
    db.exec(
      "UPDATE role_assignments SET state = 'revoked', revoked_at = datetime('now'), version = version + 1 WHERE id = 'rf-a1'",
    );
    ins.run("rf-a3");
  });
});
