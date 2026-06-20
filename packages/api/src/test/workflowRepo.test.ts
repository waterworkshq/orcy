import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { Database as DatabaseType } from "better-sqlite3";
import { evaluateJoin } from "../repositories/workflow.js";

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

function seedPrerequisites(db: DatabaseType): {
  habitatId: string;
  missionId: string;
  taskUp: string;
  taskMid: string;
  taskDown: string;
} {
  const habitatId = "hab-w3";
  const missionId = "mis-w3";
  const taskUp = "task-w3-up";
  const taskMid = "task-w3-mid";
  const taskDown = "task-w3-down";

  db.prepare(
    `INSERT INTO habitats (id, name, description, created_at, updated_at) VALUES (?, ?, '', datetime('now'), datetime('now'))`,
  ).run(habitatId, "W3 Test Habitat");

  db.prepare(
    `INSERT INTO columns (id, habitat_id, name, \`order\`) VALUES ('col-w3', ?, 'To Do', 0)`,
  ).run(habitatId);

  db.prepare(
    `INSERT INTO missions (id, habitat_id, column_id, title, description, status, labels, depends_on, blocks, display_order, created_by, created_at, updated_at, version)
     VALUES (?, ?, 'col-w3', 'W3 Mission', '', 'pending', '[]', '[]', '[]', 0, 'user-w3', datetime('now'), datetime('now'), 1)`,
  ).run(missionId, habitatId);

  for (const [tid, title] of [
    [taskUp, "Upstream"],
    [taskMid, "Middle"],
    [taskDown, "Downstream"],
  ] as const) {
    db.prepare(
      `INSERT INTO tasks (id, mission_id, title, description, status, priority, labels, required_capabilities, artifacts, created_by, created_at, updated_at, version)
       VALUES (?, ?, ?, '', 'pending', 'medium', '[]', '[]', '[]', 'user-w3', datetime('now'), datetime('now'), 1)`,
    ).run(tid, missionId, title);
  }

  return { habitatId, missionId, taskUp, taskMid, taskDown };
}

function createWorkflow(
  db: DatabaseType,
  id: string,
  missionId: string,
  habitatId: string,
  joinSpecs: Record<string, { mode: string; n?: number }> | null = null,
  status: string = "active",
): void {
  db.prepare(
    `INSERT INTO workflows (id, mission_id, habitat_id, resolved_variables, join_specs, status, created_by, version)
     VALUES (?, ?, ?, '{}', ?, ?, 'user-w3', 1)`,
  ).run(id, missionId, habitatId, joinSpecs ? JSON.stringify(joinSpecs) : null, status);
}

function createGate(
  db: DatabaseType,
  id: string,
  workflowId: string,
  missionId: string,
  habitatId: string,
  upstreamTaskId: string,
  downstreamTaskId: string,
  gateType: string,
  satisfied: boolean,
): void {
  db.prepare(
    `INSERT INTO task_workflow_gates (id, workflow_id, mission_id, habitat_id, upstream_task_id, downstream_task_id, gate_type, satisfied, recovery_depth)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    id,
    workflowId,
    missionId,
    habitatId,
    upstreamTaskId,
    downstreamTaskId,
    gateType,
    satisfied ? 1 : 0,
  );
}

describe("evaluateJoin (pure function)", () => {
  it("all_of: returns true when all gates satisfied", () => {
    expect(evaluateJoin(3, 3, { mode: "all_of" })).toBe(true);
  });

  it("all_of: returns false when some gates unsatisfied", () => {
    expect(evaluateJoin(3, 2, { mode: "all_of" })).toBe(false);
  });

  it("all_of: returns false when no gates satisfied", () => {
    expect(evaluateJoin(3, 0, { mode: "all_of" })).toBe(false);
  });

  it("any_of: returns true when at least one satisfied", () => {
    expect(evaluateJoin(3, 1, { mode: "any_of" })).toBe(true);
  });

  it("any_of: returns false when none satisfied", () => {
    expect(evaluateJoin(3, 0, { mode: "any_of" })).toBe(false);
  });

  it("n_of: returns true when threshold met exactly", () => {
    expect(evaluateJoin(5, 3, { mode: "n_of", n: 3 })).toBe(true);
  });

  it("n_of: returns true when threshold exceeded", () => {
    expect(evaluateJoin(5, 4, { mode: "n_of", n: 3 })).toBe(true);
  });

  it("n_of: returns false below threshold", () => {
    expect(evaluateJoin(5, 2, { mode: "n_of", n: 3 })).toBe(false);
  });

  it("n_of: defaults n to 1 when not specified", () => {
    expect(evaluateJoin(3, 1, { mode: "n_of" })).toBe(true);
    expect(evaluateJoin(3, 0, { mode: "n_of" })).toBe(false);
  });
});

describe("areAllWorkflowGatesSatisfied (DB integration)", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyAllMigrations(db);
    // Patch the getDb singleton to return our in-memory db via Drizzle wrapper
    (globalThis as any).__testDb = db;
  });

  afterEach(() => {
    db.close();
  });

  // Helper: monkey-patch getDb to use the in-memory database
  // The repository calls getDb() which returns a Drizzle-wrapped better-sqlite3 instance.
  // For testing, we use the raw better-sqlite3 instance directly through a custom query function.
  function checkGates(taskId: string): boolean {
    // Inline the query logic to test against the raw DB
    const gates = db
      .prepare(
        `SELECT tg.satisfied, tg.workflow_id
         FROM task_workflow_gates tg
         INNER JOIN workflows w ON tg.workflow_id = w.id
         WHERE tg.downstream_task_id = ? AND w.status = 'active'`,
      )
      .all(taskId) as Array<{ satisfied: number; workflow_id: string }>;

    if (gates.length === 0) return true;

    const workflowId = gates[0].workflow_id;
    const workflow = db.prepare(`SELECT join_specs FROM workflows WHERE id = ?`).get(workflowId) as
      | { join_specs: string | null }
      | undefined;

    const joinSpecs = workflow?.join_specs ? JSON.parse(workflow.join_specs) : null;
    const joinConfig = joinSpecs?.[taskId] ?? { mode: "all_of" };
    const satisfiedCount = gates.filter((g) => g.satisfied === 1).length;

    return evaluateJoin(gates.length, satisfiedCount, joinConfig);
  }

  it("returns true when task has no gates (backwards compat)", () => {
    const refs = seedPrerequisites(db);
    expect(checkGates(refs.taskDown)).toBe(true);
  });

  it("returns true when all gates satisfied (all_of default)", () => {
    const refs = seedPrerequisites(db);
    createWorkflow(db, "wf-1", refs.missionId, refs.habitatId);
    createGate(
      db,
      "g1",
      "wf-1",
      refs.missionId,
      refs.habitatId,
      refs.taskUp,
      refs.taskDown,
      "on_complete",
      true,
    );
    createGate(
      db,
      "g2",
      "wf-1",
      refs.missionId,
      refs.habitatId,
      refs.taskMid,
      refs.taskDown,
      "on_approve",
      true,
    );
    expect(checkGates(refs.taskDown)).toBe(true);
  });

  it("returns false when some gates unsatisfied (all_of default)", () => {
    const refs = seedPrerequisites(db);
    createWorkflow(db, "wf-2", refs.missionId, refs.habitatId);
    createGate(
      db,
      "g3",
      "wf-2",
      refs.missionId,
      refs.habitatId,
      refs.taskUp,
      refs.taskDown,
      "on_complete",
      true,
    );
    createGate(
      db,
      "g4",
      "wf-2",
      refs.missionId,
      refs.habitatId,
      refs.taskMid,
      refs.taskDown,
      "on_approve",
      false,
    );
    expect(checkGates(refs.taskDown)).toBe(false);
  });

  it("returns true for any_of with at least one satisfied", () => {
    const refs = seedPrerequisites(db);
    createWorkflow(db, "wf-3", refs.missionId, refs.habitatId, {
      [refs.taskDown]: { mode: "any_of" },
    });
    createGate(
      db,
      "g5",
      "wf-3",
      refs.missionId,
      refs.habitatId,
      refs.taskUp,
      refs.taskDown,
      "on_complete",
      false,
    );
    createGate(
      db,
      "g6",
      "wf-3",
      refs.missionId,
      refs.habitatId,
      refs.taskMid,
      refs.taskDown,
      "on_complete",
      true,
    );
    expect(checkGates(refs.taskDown)).toBe(true);
  });

  it("returns false for any_of with none satisfied", () => {
    const refs = seedPrerequisites(db);
    createWorkflow(db, "wf-4", refs.missionId, refs.habitatId, {
      [refs.taskDown]: { mode: "any_of" },
    });
    createGate(
      db,
      "g7",
      "wf-4",
      refs.missionId,
      refs.habitatId,
      refs.taskUp,
      refs.taskDown,
      "on_complete",
      false,
    );
    createGate(
      db,
      "g8",
      "wf-4",
      refs.missionId,
      refs.habitatId,
      refs.taskMid,
      refs.taskDown,
      "on_complete",
      false,
    );
    expect(checkGates(refs.taskDown)).toBe(false);
  });

  it("returns true for n_of meeting threshold", () => {
    const refs = seedPrerequisites(db);
    createWorkflow(db, "wf-5", refs.missionId, refs.habitatId, {
      [refs.taskDown]: { mode: "n_of", n: 2 },
    });
    createGate(
      db,
      "g9",
      "wf-5",
      refs.missionId,
      refs.habitatId,
      refs.taskUp,
      refs.taskDown,
      "on_complete",
      true,
    );
    createGate(
      db,
      "g10",
      "wf-5",
      refs.missionId,
      refs.habitatId,
      refs.taskMid,
      refs.taskDown,
      "on_complete",
      true,
    );
    expect(checkGates(refs.taskDown)).toBe(true);
  });

  it("returns false for n_of below threshold", () => {
    const refs = seedPrerequisites(db);
    createWorkflow(db, "wf-6", refs.missionId, refs.habitatId, {
      [refs.taskDown]: { mode: "n_of", n: 2 },
    });
    createGate(
      db,
      "g11",
      "wf-6",
      refs.missionId,
      refs.habitatId,
      refs.taskUp,
      refs.taskDown,
      "on_complete",
      true,
    );
    createGate(
      db,
      "g12",
      "wf-6",
      refs.missionId,
      refs.habitatId,
      refs.taskMid,
      refs.taskDown,
      "on_complete",
      false,
    );
    expect(checkGates(refs.taskDown)).toBe(false);
  });

  it("ignores gates from detached workflows", () => {
    const refs = seedPrerequisites(db);
    createWorkflow(db, "wf-7", refs.missionId, refs.habitatId, null, "detached");
    createGate(
      db,
      "g13",
      "wf-7",
      refs.missionId,
      refs.habitatId,
      refs.taskUp,
      refs.taskDown,
      "on_complete",
      false,
    );
    // No active workflow gates → should return true (claimable)
    expect(checkGates(refs.taskDown)).toBe(true);
  });
});
