import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { Database as DatabaseType } from "better-sqlite3";

let db: DatabaseType;

function applyMigrationFile(db: DatabaseType, filename: string): void {
  const sql = readFileSync(join(import.meta.dirname, "..", "..", "drizzle", filename), "utf-8");
  const statements = sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    try {
      db.exec(stmt);
    } catch (err: any) {
      const msg = String(err?.message ?? "");
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

function applyAllMigrations(db: DatabaseType): void {
  const migrationDir = join(import.meta.dirname, "..", "..", "drizzle");
  const files = readdirSync(migrationDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  for (const file of files) {
    applyMigrationFile(db, file);
  }
}

/** Creates the minimal prerequisite rows that the workflow FKs require (habitats, missions, tasks). */
function seedPrerequisites(db: DatabaseType): {
  habitatId: string;
  missionId: string;
  taskA: string;
  taskB: string;
} {
  const habitatId = "hab-test";
  const missionId = "mis-test";
  const taskA = "task-upstream";
  const taskB = "task-downstream";

  db.prepare(
    `INSERT INTO habitats (id, name, description, created_at, updated_at) VALUES (?, ?, '', datetime('now'), datetime('now'))`,
  ).run(habitatId, "Test Habitat");

  db.prepare(
    `INSERT INTO columns (id, habitat_id, name, \`order\`) VALUES ('col-1', ?, 'To Do', 0)`,
  ).run(habitatId);

  db.prepare(
    `INSERT INTO missions (id, habitat_id, column_id, title, description, status, labels, depends_on, blocks, display_order, created_by, created_at, updated_at, version)
     VALUES (?, ?, 'col-1', 'Test Mission', '', 'pending', '[]', '[]', '[]', 0, 'user-test', datetime('now'), datetime('now'), 1)`,
  ).run(missionId, habitatId);

  for (const [tid, title] of [
    [taskA, "Upstream"],
    [taskB, "Downstream"],
  ] as const) {
    db.prepare(
      `INSERT INTO tasks (id, mission_id, title, description, status, priority, labels, required_capabilities, artifacts, created_by, created_at, updated_at, version)
       VALUES (?, ?, ?, '', 'pending', 'medium', '[]', '[]', '[]', 'user-test', datetime('now'), datetime('now'), 1)`,
    ).run(tid, missionId, title);
  }

  return { habitatId, missionId, taskA, taskB };
}

describe("W1 migration: workflows, taskWorkflowGates, failureContexts", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyAllMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("table existence", () => {
    it("creates all 3 new tables", () => {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('workflows', 'task_workflow_gates', 'failure_contexts')",
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name).sort()).toEqual([
        "failure_contexts",
        "task_workflow_gates",
        "workflows",
      ]);
    });

    it("creates all expected indexes", () => {
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_work%' OR name LIKE 'idx_failure%' OR name LIKE 'idx_workflow_gates%'",
        )
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name).sort();
      expect(indexNames).toContain("idx_workflows_mission");
      expect(indexNames).toContain("idx_workflows_habitat");
      expect(indexNames).toContain("idx_workflows_status");
      expect(indexNames).toContain("idx_workflow_gates_workflow");
      expect(indexNames).toContain("idx_workflow_gates_downstream");
      expect(indexNames).toContain("idx_workflow_gates_upstream");
      expect(indexNames).toContain("idx_workflow_gates_satisfied");
      expect(indexNames).toContain("idx_workflow_gates_type");
      expect(indexNames).toContain("idx_failure_contexts_task");
      expect(indexNames).toContain("idx_failure_contexts_workflow");
      expect(indexNames).toContain("idx_failure_contexts_unresolved");
    });
  });

  describe("workflows CRUD", () => {
    it("inserts and selects a workflow row", () => {
      const refs = seedPrerequisites(db);
      db.prepare(
        `INSERT INTO workflows (id, mission_id, habitat_id, resolved_variables, status, created_by, version)
         VALUES ('wf-1', ?, ?, '{}', 'active', 'user-test', 1)`,
      ).run(refs.missionId, refs.habitatId);

      const row = db.prepare("SELECT * FROM workflows WHERE id = 'wf-1'").get() as Record<
        string,
        unknown
      >;
      expect(row.mission_id).toBe(refs.missionId);
      expect(row.status).toBe("active");
      expect(row.version).toBe(1);
    });

    it("deletes a workflow row", () => {
      const refs = seedPrerequisites(db);
      db.prepare(
        `INSERT INTO workflows (id, mission_id, habitat_id, resolved_variables, status, created_by, version)
         VALUES ('wf-del', ?, ?, '{}', 'active', 'user-test', 1)`,
      ).run(refs.missionId, refs.habitatId);

      db.prepare("DELETE FROM workflows WHERE id = 'wf-del'").run();
      const row = db.prepare("SELECT id FROM workflows WHERE id = 'wf-del'").get();
      expect(row).toBeUndefined();
    });

    it("cascades delete when mission is deleted", () => {
      const refs = seedPrerequisites(db);
      db.prepare(
        `INSERT INTO workflows (id, mission_id, habitat_id, resolved_variables, status, created_by, version)
         VALUES ('wf-cascade', ?, ?, '{}', 'active', 'user-test', 1)`,
      ).run(refs.missionId, refs.habitatId);

      db.prepare("DELETE FROM missions WHERE id = ?").run(refs.missionId);
      const row = db.prepare("SELECT id FROM workflows WHERE id = 'wf-cascade'").get();
      expect(row).toBeUndefined();
    });
  });

  describe("taskWorkflowGates CRUD", () => {
    it("inserts and selects a gate row with all fields", () => {
      const refs = seedPrerequisites(db);
      db.prepare(
        `INSERT INTO workflows (id, mission_id, habitat_id, resolved_variables, status, created_by, version)
         VALUES ('wf-g', ?, ?, '{}', 'active', 'user-test', 1)`,
      ).run(refs.missionId, refs.habitatId);

      db.prepare(
        `INSERT INTO task_workflow_gates (id, workflow_id, mission_id, habitat_id, upstream_task_id, downstream_task_id, gate_type, match_config, condition, satisfied, recovery_depth)
         VALUES ('gate-1', 'wf-g', ?, ?, ?, ?, 'on_complete', '{"signalType":"context"}', '{"type":"always"}', 0, 0)`,
      ).run(refs.missionId, refs.habitatId, refs.taskA, refs.taskB);

      const row = db
        .prepare("SELECT * FROM task_workflow_gates WHERE id = 'gate-1'")
        .get() as Record<string, unknown>;
      expect(row.gate_type).toBe("on_complete");
      expect(row.upstream_task_id).toBe(refs.taskA);
      expect(row.downstream_task_id).toBe(refs.taskB);
      expect(row.satisfied).toBe(0);
      expect(row.recovery_depth).toBe(0);
    });

    it("updates satisfied flag and selects it back", () => {
      const refs = seedPrerequisites(db);
      db.prepare(
        `INSERT INTO workflows (id, mission_id, habitat_id, resolved_variables, status, created_by, version)
         VALUES ('wf-g2', ?, ?, '{}', 'active', 'user-test', 1)`,
      ).run(refs.missionId, refs.habitatId);
      db.prepare(
        `INSERT INTO task_workflow_gates (id, workflow_id, mission_id, habitat_id, upstream_task_id, downstream_task_id, gate_type, satisfied)
         VALUES ('gate-2', 'wf-g2', ?, ?, ?, ?, 'on_approve', 0)`,
      ).run(refs.missionId, refs.habitatId, refs.taskA, refs.taskB);

      db.prepare(
        `UPDATE task_workflow_gates SET satisfied = 1, satisfied_at = datetime('now'), satisfied_by_event_id = 'evt-1' WHERE id = 'gate-2'`,
      ).run();

      const row = db
        .prepare("SELECT * FROM task_workflow_gates WHERE id = 'gate-2'")
        .get() as Record<string, unknown>;
      expect(row.satisfied).toBe(1);
      expect(row.satisfied_by_event_id).toBe("evt-1");
    });

    it("cascades delete when workflow is deleted (gates go too)", () => {
      const refs = seedPrerequisites(db);
      db.prepare(
        `INSERT INTO workflows (id, mission_id, habitat_id, resolved_variables, status, created_by, version)
         VALUES ('wf-cg', ?, ?, '{}', 'active', 'user-test', 1)`,
      ).run(refs.missionId, refs.habitatId);
      db.prepare(
        `INSERT INTO task_workflow_gates (id, workflow_id, mission_id, habitat_id, upstream_task_id, downstream_task_id, gate_type, satisfied)
         VALUES ('gate-cg', 'wf-cg', ?, ?, ?, ?, 'on_signal', 0)`,
      ).run(refs.missionId, refs.habitatId, refs.taskA, refs.taskB);

      db.prepare("DELETE FROM workflows WHERE id = 'wf-cg'").run();
      const row = db.prepare("SELECT id FROM task_workflow_gates WHERE id = 'gate-cg'").get();
      expect(row).toBeUndefined();
    });
  });

  describe("failureContexts CRUD", () => {
    it("inserts and selects a failure context row with bundle JSON", () => {
      const refs = seedPrerequisites(db);
      const bundle = JSON.stringify({
        artifacts: [],
        recentLifecycleEvents: [],
        experienceSignals: [],
        retryHistory: [],
        experienceCategorySummary: { stuck: 1 },
      });

      db.prepare(
        `INSERT INTO failure_contexts (id, failed_task_id, habitat_id, failure_kind, failure_reason, failed_by_agent_id, bundle, bundle_schema_version, recovery_depth)
         VALUES ('fc-1', ?, ?, 'lifecycle_failed', 'timeout', 'agent-1', ?, 1, 0)`,
      ).run(refs.taskA, refs.habitatId, bundle);

      const row = db.prepare("SELECT * FROM failure_contexts WHERE id = 'fc-1'").get() as Record<
        string,
        unknown
      >;
      expect(row.failure_kind).toBe("lifecycle_failed");
      expect(row.failed_by_agent_id).toBe("agent-1");
      expect(row.bundle_schema_version).toBe(1);
      const parsedBundle = JSON.parse(row.bundle as string);
      expect(parsedBundle.experienceCategorySummary.stuck).toBe(1);
    });

    it("resolves a failure context by setting resolvedAt and resolutionKind", () => {
      const refs = seedPrerequisites(db);
      db.prepare(
        `INSERT INTO failure_contexts (id, failed_task_id, habitat_id, failure_kind, bundle)
         VALUES ('fc-2', ?, ?, 'heartbeat_lost', '{}')`,
      ).run(refs.taskA, refs.habitatId);

      db.prepare(
        `UPDATE failure_contexts SET resolved_at = datetime('now'), resolution_kind = 'redeemed' WHERE id = 'fc-2'`,
      ).run();

      const row = db.prepare("SELECT * FROM failure_contexts WHERE id = 'fc-2'").get() as Record<
        string,
        unknown
      >;
      expect(row.resolution_kind).toBe("redeemed");
      expect(row.resolved_at).not.toBeNull();
    });

    it("sets recovery_task_id to NULL when linked task is deleted (onDelete set null)", () => {
      const refs = seedPrerequisites(db);
      const recoveryTaskId = "task-recovery";
      db.prepare(
        `INSERT INTO tasks (id, mission_id, title, description, status, priority, labels, required_capabilities, artifacts, created_by, created_at, updated_at, version)
         VALUES (?, ?, 'Recovery', '', 'pending', 'medium', '[]', '[]', '[]', 'user-test', datetime('now'), datetime('now'), 1)`,
      ).run(recoveryTaskId, refs.missionId);

      db.prepare(
        `INSERT INTO failure_contexts (id, failed_task_id, habitat_id, failure_kind, bundle, recovery_task_id)
         VALUES ('fc-3', ?, ?, 'manual', '{}', ?)`,
      ).run(refs.taskA, refs.habitatId, recoveryTaskId);

      db.prepare("DELETE FROM tasks WHERE id = ?").run(recoveryTaskId);
      const row = db
        .prepare("SELECT recovery_task_id FROM failure_contexts WHERE id = 'fc-3'")
        .get() as Record<string, unknown>;
      expect(row.recovery_task_id).toBeNull();
    });
  });
});
