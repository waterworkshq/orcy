import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { writeSqliteFixture } from "./helpers/writeSqliteFixture.js";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, initDb } from "../db/index.js";
import {
  ENFORCEMENT_MIGRATION_TAG,
  hasNamedCheck,
  recordMigrationEntry,
} from "../db/stagedMigrations.js";
import {
  ADDITIVE_SCHEMA_VERSION,
  PREFLIGHT_VERSION,
  computeAnomalyQueryDigest,
} from "../services/findingTriagePreflight.js";

vi.setConfig({ testTimeout: 60_000 });

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const DRIZZLE_DIR = join(PACKAGE_ROOT, "drizzle");
const TEMP_DIR = mkdtempSync(join(tmpdir(), "orcy-enum-checks-"));
const ENUM_CHECK_MIGRATION_TAG = "0090_documented_enum_check_constraints";
const ENUM_CHECK_ENFORCEMENT_DIRTY_CODE = "ENUM_CHECK_ENFORCEMENT_DIRTY";

const CHECKS = {
  "tasks.priority": "tasks_priority_check",
  "tasks.status": "tasks_status_check",
  "agents.type": "agents_type_check",
  "agents.status": "agents_status_check",
  "team_members.role": "team_members_role_check",
  "users.role": "users_role_check",
  "task_events.actor_type": "task_events_actor_type_check",
} as const;

type ColumnKey = keyof typeof CHECKS;

function readJournal(): { entries: { tag: string; when: number }[] } {
  return JSON.parse(readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf-8"));
}

function applyMigrationSql(db: Database.Database, sqlText: string): void {
  for (const statement of sqlText
    .split("--> statement-breakpoint")
    .map((value) => value.trim())
    .filter(Boolean)) {
    db.exec(statement);
  }
}

function prepareLedgerThrough0089(db: Database.Database): void {
  const journal = readJournal();
  const through = journal.entries.findIndex(({ tag }) => tag === "0089_user_role_default_editor");
  expect(through).toBeGreaterThan(0);
  db.pragma("foreign_keys = ON");
  db.exec(
    "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)",
  );
  const record = db.prepare(
    "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
  );
  for (const entry of journal.entries.slice(0, through + 1)) {
    const sqlText = readFileSync(join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf-8");
    if (entry.tag === ENFORCEMENT_MIGRATION_TAG) {
      db.prepare(
        `INSERT INTO migration_preflight_attestations
          (enforcement_migration_id, schema_version, preflight_version,
           anomaly_query_digest, clean, attested_at)
         VALUES (?, ?, ?, ?, 1, datetime('now'))`,
      ).run(
        ENFORCEMENT_MIGRATION_TAG,
        ADDITIVE_SCHEMA_VERSION,
        PREFLIGHT_VERSION,
        computeAnomalyQueryDigest(),
      );
    }
    applyMigrationSql(db, sqlText);
    record.run(createHash("sha256").update(sqlText).digest("hex"), entry.when);
  }
}

function openRaw(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  return db;
}

function hasCheck(db: Database.Database, key: ColumnKey): boolean {
  const [table] = key.split(".");
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  return row?.sql.includes(CHECKS[key]) ?? false;
}

function seedTaskWorld(db: Database.Database, dirtyPriority: boolean): void {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO habitats (id, name, created_at, updated_at) VALUES ('enum-hab', 'Enum Habitat', ?, ?)").run(now, now);
  db.prepare("INSERT INTO columns (id, habitat_id, name, \"order\") VALUES ('enum-col', 'enum-hab', 'Todo', 0)").run();
  db.prepare(
    `INSERT INTO missions
      (id, habitat_id, column_id, title, labels, depends_on, blocks, created_by, created_at, updated_at)
     VALUES ('enum-mission', 'enum-hab', 'enum-col', 'Enum Mission', '[]', '[]', '[]', 'system', ?, ?)`,
  ).run(now, now);
  const insertTask = db.prepare(
    `INSERT INTO tasks
      (id, mission_id, title, labels, priority, status, required_capabilities, artifacts, created_by)
     VALUES (?, 'enum-mission', ?, '[]', ?, 'pending', '[]', '[]', 'system')`,
  );
  insertTask.run("enum-task-dirty", "Dirty priority", dirtyPriority ? "urgent" : "high");
  insertTask.run("enum-task-clean", "Clean priority", "high");
  db.prepare(
    `INSERT INTO agents (id, name, type, domain, capabilities, status, api_key, metadata)
     VALUES ('seed-agent', 'Seed Agent', 'codex', 'backend', '[]', 'idle', 'seed-agent-key', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO daemon_instances (id, name, hostname, token_hash, daemon_version, metadata)
     VALUES ('seed-daemon', 'Seed Daemon', 'localhost', 'unused', 'test', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO daemon_agents (id, daemon_id, agent_id, cli_type, cli_path, created_at, updated_at)
     VALUES ('seed-daemon-agent', 'seed-daemon', 'seed-agent', 'codex', '/unused', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO task_events (id, task_id, actor_type, actor_id, action, metadata)
     VALUES ('enum-event', 'enum-task-dirty', 'system', 'system', 'created', '{}')`,
  ).run();
  db.prepare(
    "INSERT INTO task_dependencies (task_id, depends_on_id) VALUES ('enum-task-dirty', 'enum-task-clean')",
  ).run();
  db.prepare(
    `INSERT INTO task_comments (id, task_id, author_type, author_id, content)
     VALUES ('enum-comment', 'enum-task-dirty', 'human', 'enum-user', 'preserve me')`,
  ).run();
}

function childCounts(db: Database.Database): Record<string, number> {
  return Object.fromEntries(
    ["task_events", "task_dependencies", "task_comments", "daemon_agents"].map((table) => [
      table,
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
    ]),
  );
}

afterEach(() => closeDb());
afterAll(() => {
  closeDb();
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

describe("documented enum CHECK constraints", () => {
  it("reproduces the copy abort when an unguarded restore meets a dirty row", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE sample (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO sample VALUES ('dirty', 'outside');
      CREATE TABLE sample_backup AS SELECT id, value FROM sample;
      ALTER TABLE sample DROP COLUMN value;
      ALTER TABLE sample ADD COLUMN value TEXT DEFAULT 'inside' NOT NULL CHECK (value IN ('inside'));
    `);

    expect(() =>
      db.exec("INSERT INTO sample SELECT id, value FROM sample_backup"),
    ).toThrow(/CHECK constraint failed/i);
    db.close();
  });

  it("matches a named CHECK as a delimited constraint token", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        verification_status TEXT,
        status TEXT CONSTRAINT tasks_status_check_aux CHECK (status IN ('pending'))
      )
    `);
    expect(hasNamedCheck(db, "tasks", "tasks_status_check")).toBe(false);
    expect(hasNamedCheck(db, "tasks", "status")).toBe(false);

    db.exec(
      "ALTER TABLE tasks ADD COLUMN priority TEXT CONSTRAINT tasks_status_check CHECK (priority IN ('low'))",
    );
    expect(hasNamedCheck(db, "tasks", "tasks_status_check")).toBe(true);
    db.close();
  });

  it("preserves the ledger write failure when rollback also fails", () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)",
    );
    const exec = db.exec.bind(db);
    (db as any).exec = (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("simulated rollback failure");
      return exec(sql);
    };

    try {
      expect(() =>
        recordMigrationEntry(db, {
          tag: "0099_write_failure",
          when: 1,
          hash: null as unknown as string,
          statements: [],
        }),
      ).toThrow(/NOT NULL constraint failed/i);
      expect(db.inTransaction).toBe(true);
    } finally {
      (db as any).exec = exec;
      if (db.inTransaction) db.exec("ROLLBACK");
      db.close();
    }
  });

  it("archives orphaned task events, defers their actor CHECK, and keeps booting", async () => {
    const dbPath = join(TEMP_DIR, "orphaned-task-event.db");
    writeSqliteFixture(dbPath, prepareLedgerThrough0089);
    const seed = new Database(dbPath);
    seed.pragma("foreign_keys = OFF");
    seedTaskWorld(seed, false);
    seed.prepare(
      `INSERT INTO task_events (id, task_id, actor_type, actor_id, action, metadata)
       VALUES ('orphan-event', 'missing-task', 'system', 'system', 'created', '{}')`,
    ).run();
    seed.close();

    await expect(initDb(dbPath)).resolves.toBeDefined();

    const raw = openRaw(dbPath);
    expect(hasCheck(raw, "task_events.actor_type")).toBe(false);
    expect(hasCheck(raw, "tasks.priority")).toBe(true);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM task_events").get()).toEqual({ n: 2 });
    expect(
      raw.prepare("SELECT task_id FROM task_events_orphans_0090 WHERE id = 'orphan-event'").get(),
    ).toEqual({ task_id: "missing-task" });
    const attestation = raw
      .prepare(
        `SELECT clean, anomaly_report FROM migration_preflight_attestations
         WHERE enforcement_migration_id = ? AND schema_version = '0089'`,
      )
      .get(`${ENUM_CHECK_MIGRATION_TAG}:task_events.actor_type`) as {
      clean: number;
      anomaly_report: string;
    };
    expect(attestation.clean).toBe(0);
    expect(JSON.parse(attestation.anomaly_report)).toMatchObject({
      code: ENUM_CHECK_ENFORCEMENT_DIRTY_CODE,
      column: "task_events.actor_type",
      orphanCount: 1,
      orphanTable: "task_events_orphans_0090",
    });
    raw.close();

    closeDb();
    const remediate = new Database(dbPath);
    remediate.pragma("foreign_keys = OFF");
    remediate.prepare("DELETE FROM task_events WHERE id = 'orphan-event'").run();
    remediate.close();
    await initDb(dbPath);

    const enforced = openRaw(dbPath);
    expect(hasCheck(enforced, "task_events.actor_type")).toBe(true);
    expect(enforced.prepare("SELECT COUNT(*) AS n FROM task_events").get()).toEqual({ n: 1 });
    expect(enforced.prepare("SELECT COUNT(*) AS n FROM task_events_orphans_0090").get()).toEqual({
      n: 1,
    });
    const cleanAttestation = enforced
      .prepare(
        `SELECT clean, anomaly_report FROM migration_preflight_attestations
         WHERE enforcement_migration_id = ? AND schema_version = '0089'`,
      )
      .get(`${ENUM_CHECK_MIGRATION_TAG}:task_events.actor_type`) as {
      clean: number;
      anomaly_report: string;
    };
    expect(cleanAttestation.clean).toBe(1);
    expect(JSON.parse(cleanAttestation.anomaly_report).orphanCount).toBe(1);
    enforced.close();
  });

  it("defers only the dirty column, preserves child rows, and enforces after remediation", async () => {
    const dbPath = join(TEMP_DIR, "dirty-upgrade.db");
    writeSqliteFixture(dbPath, prepareLedgerThrough0089);
    const seed = openRaw(dbPath);
    seedTaskWorld(seed, true);
    const beforeChildren = childCounts(seed);
    seed.close();

    await initDb(dbPath);

    const raw = openRaw(dbPath);
    expect(hasCheck(raw, "tasks.priority")).toBe(false);
    for (const key of Object.keys(CHECKS).filter((key) => key !== "tasks.priority") as ColumnKey[]) {
      expect(hasCheck(raw, key), `${key} should be enforced independently`).toBe(true);
    }
    expect(childCounts(raw)).toEqual(beforeChildren);
    expect(raw.prepare("SELECT priority FROM tasks WHERE id = 'enum-task-dirty'").get()).toEqual({
      priority: "urgent",
    });
    expect(raw.pragma("foreign_key_check")).toEqual([]);
    expect(() =>
      raw.prepare("UPDATE tasks SET status = 'outside' WHERE id = 'enum-task-clean'").run(),
    ).toThrow(/CHECK constraint failed/i);

    const attestation = raw
      .prepare(
        `SELECT clean, anomaly_report FROM migration_preflight_attestations
         WHERE enforcement_migration_id = ? AND schema_version = '0089'`,
      )
      .get(`${ENUM_CHECK_MIGRATION_TAG}:tasks.priority`) as {
      clean: number;
      anomaly_report: string;
    };
    expect(attestation.clean).toBe(0);
    expect(JSON.parse(attestation.anomaly_report)).toMatchObject({
      code: ENUM_CHECK_ENFORCEMENT_DIRTY_CODE,
      column: "tasks.priority",
    });
    const migrationHash = createHash("sha256")
      .update(readFileSync(join(DRIZZLE_DIR, `${ENUM_CHECK_MIGRATION_TAG}.sql`), "utf-8"))
      .digest("hex");
    expect(
      raw.prepare("SELECT 1 FROM __drizzle_migrations WHERE hash = ?").get(migrationHash),
    ).toBeUndefined();
    raw.close();

    closeDb();
    const remediate = openRaw(dbPath);
    remediate.prepare("UPDATE tasks SET priority = 'high' WHERE id = 'enum-task-dirty'").run();
    remediate.close();
    await initDb(dbPath);

    const enforced = openRaw(dbPath);
    expect(hasCheck(enforced, "tasks.priority")).toBe(true);
    expect(childCounts(enforced)).toEqual(beforeChildren);
    expect(
      enforced.prepare("SELECT 1 FROM __drizzle_migrations WHERE hash = ?").get(migrationHash),
    ).toBeDefined();
    expect(() =>
      enforced.prepare("UPDATE tasks SET priority = 'urgent' WHERE id = 'enum-task-dirty'").run(),
    ).toThrow(/CHECK constraint failed/i);
    enforced.close();
  });

  it("rejects out-of-domain INSERT and UPDATE statements on every enforced column", async () => {
    const dbPath = join(TEMP_DIR, "fresh-enforcement.db");
    await initDb(dbPath);
    const db = openRaw(dbPath);
    seedTaskWorld(db, false);
    db.prepare(
      "INSERT INTO agents (id, name, type, domain, capabilities, status, api_key, metadata) VALUES ('enum-agent', 'Enum Agent', 'codex', 'backend', '[]', 'idle', 'enum-agent-key', '{}')",
    ).run();
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('enum-user', 'enum-user', 'unused', 'editor')").run();
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('enum-user-2', 'enum-user-2', 'unused', 'editor')").run();
    db.prepare("INSERT INTO organizations (id, name, slug) VALUES ('enum-org', 'Enum Org', 'enum-org')").run();
    db.prepare("INSERT INTO teams (id, organization_id, name, slug) VALUES ('enum-team', 'enum-org', 'Enum Team', 'enum-team')").run();
    db.prepare("INSERT INTO team_members (id, team_id, user_id, role) VALUES ('enum-member', 'enum-team', 'enum-user', 'member')").run();

    const cases: { key: ColumnKey; insert: string; update: string }[] = [
      {
        key: "tasks.priority",
        insert: "INSERT INTO tasks (id, mission_id, title, labels, priority, required_capabilities, artifacts, created_by) VALUES ('bad-task-priority', 'enum-mission', 'Bad', '[]', 'urgent', '[]', '[]', 'system')",
        update: "UPDATE tasks SET priority = 'urgent' WHERE id = 'enum-task-clean'",
      },
      {
        key: "tasks.status",
        insert: "INSERT INTO tasks (id, mission_id, title, labels, status, required_capabilities, artifacts, created_by) VALUES ('bad-task-status', 'enum-mission', 'Bad', '[]', 'outside', '[]', '[]', 'system')",
        update: "UPDATE tasks SET status = 'outside' WHERE id = 'enum-task-clean'",
      },
      {
        key: "agents.type",
        insert: "INSERT INTO agents (id, name, type, domain, capabilities, api_key, metadata) VALUES ('bad-agent-type', 'Bad Agent Type', 'unknown-cli', 'backend', '[]', 'bad-agent-type-key', '{}')",
        update: "UPDATE agents SET type = 'unknown-cli' WHERE id = 'enum-agent'",
      },
      {
        key: "agents.status",
        insert: "INSERT INTO agents (id, name, type, domain, capabilities, status, api_key, metadata) VALUES ('bad-agent-status', 'Bad Agent Status', 'codex', 'backend', '[]', 'busy', 'bad-agent-status-key', '{}')",
        update: "UPDATE agents SET status = 'busy' WHERE id = 'enum-agent'",
      },
      {
        key: "team_members.role",
        insert: "INSERT INTO team_members (id, team_id, user_id, role) VALUES ('bad-member-role', 'enum-team', 'enum-user-2', 'superuser')",
        update: "UPDATE team_members SET role = 'superuser' WHERE id = 'enum-member'",
      },
      {
        key: "users.role",
        insert: "INSERT INTO users (id, username, password_hash, role) VALUES ('bad-user-role', 'bad-user-role', 'unused', 'superuser')",
        update: "UPDATE users SET role = 'superuser' WHERE id = 'enum-user'",
      },
      {
        key: "task_events.actor_type",
        insert: "INSERT INTO task_events (id, task_id, actor_type, actor_id, action, metadata) VALUES ('bad-event-actor', 'enum-task-clean', 'robot', 'robot', 'created', '{}')",
        update: "UPDATE task_events SET actor_type = 'robot' WHERE id = 'enum-event'",
      },
    ];

    for (const testCase of cases) {
      expect(hasCheck(db, testCase.key)).toBe(true);
      expect(() => db.exec(testCase.insert), `${testCase.key} INSERT`).toThrow(
        /CHECK constraint failed/i,
      );
      expect(() => db.exec(testCase.update), `${testCase.key} UPDATE`).toThrow(
        /CHECK constraint failed/i,
      );
    }

    expect(() =>
      db
        .prepare(
          `INSERT INTO agents (id, name, type, domain, capabilities, api_key, metadata)
           VALUES ('null-agent-type', 'Null Agent Type', NULL, 'backend', '[]', 'null-agent-key', '{}')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);
    const agentType = (db.prepare("PRAGMA table_info(agents)").all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[]).find((column) => column.name === "type");
    expect(agentType).toMatchObject({ notnull: 0, dflt_value: null });
    const eventActorType = (db.prepare("PRAGMA table_info(task_events)").all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[]).find((column) => column.name === "actor_type");
    expect(eventActorType).toMatchObject({ notnull: 1, dflt_value: null });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});
