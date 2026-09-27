/**
 * Review-safety legacy migration classifier — REAL production upgrade proof.
 *
 * Builds a legacy database through the full Drizzle journal on the production
 * better-sqlite3 driver (initDb), seeds pre-migration task shapes, re-applies
 * migration 0082 against them, and asserts the classifier gives EVERY task a
 * legal row without inventing review history — plus direct CHECK-matrix
 * enforcement and immediate baseline restoration proofs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { closeDb, initDb, getDb } from "../db/index.js";
import * as schema from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as missionRepo from "../repositories/mission.js";
import { getRequirementWithClient, endOwnershipWithClient } from "../repositories/reviewSafety.js";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const TEMP_DIR = join(PACKAGE_ROOT, ".test-rs-migration");

function tempDbPath(name: string): string {
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
  return join(TEMP_DIR, `${name}.db`);
}

function cleanup(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

/** Seeds legacy task shapes through repositories + direct task-row writes. */
function seedLegacyShapes(dbPath: string, missionId: string, agentId: string | null): void {
  const raw = new Database(dbPath);
  const now = new Date().toISOString();
  const insertTask = raw.prepare(
    `INSERT INTO tasks (id, mission_id, title, description, labels, required_capabilities, artifacts, priority, status, assigned_agent_id, claimed_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, '', '[]', '[]', '[]', 'medium', ?, ?, ?, 'u', ?, ?)`,
  );
  insertTask.run("t-done", missionId, "Done", "done", agentId, now, now, now);
  insertTask.run("t-approved", missionId, "Approved", "approved", agentId, now, now, now);
  insertTask.run("t-failed", missionId, "Failed", "failed", null, null, now, now);
  insertTask.run("t-active", missionId, "Active", "in_progress", agentId, now, now, now);
  insertTask.run("t-ambiguous", missionId, "Ambiguous", "pending", null, now, now, now);
  insertTask.run("t-never", missionId, "Never", "pending", null, null, now, now);
  insertTask.run("t-event-evidence", missionId, "EventEvidence", "pending", null, null, now, now);
  raw
    .prepare(
      `INSERT INTO task_events (id, task_id, actor_type, actor_id, action, metadata, timestamp)
       VALUES ('e1', 't-event-evidence', 'agent', 'a', 'claimed', '{}', ?)`,
    )
    .run(now);
  raw
    .prepare(
      `INSERT INTO task_reviewers (id, task_id, reviewer_type, reviewer_id, status, assigned_at, reviewed_at)
       VALUES ('r1', 't-approved', 'human', 'legacy-approver', 'approved', ?, ?)`,
    )
    .run(now, now);
  raw.close();
}

describe("0082 legacy migration classifier (real production upgrade)", () => {
  let dbPath: string;
  let missionId: string;
  let agentId: string;

  beforeEach(async () => {
    await closeDb();
    dbPath = tempDbPath("legacy-upgrade");
    cleanup(dbPath);
    await initDb(dbPath);
    const habitat = habitatRepo.createHabitat({ name: `rs-legacy-${Math.random()}` });
    const column = (await import("../repositories/column.js")).createColumn({
      habitatId: habitat.id,
      name: "To Do",
    });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: column.id,
      title: "rs-legacy-mission",
      createdBy: "u",
    });
    missionId = mission.id;
    const { agent } = (await import("../repositories/agent.js")).createAgent({
      name: `rs-legacy-agent-${Math.random()}`,
      type: "claude-code",
      domain: "backend",
    });
    agentId = agent.id;
  });

  afterEach(async () => {
    await closeDb();
    cleanup(dbPath);
  });

  /**
   * Rolls the database back to a pre-0082 shape (drop the empty review-safety
   * tables + the migration marker, seed the legacy rows), then boots so
   * migration 0082 runs FOR REAL against them — the classifier under test.
   */
  async function reapply0082(): Promise<void> {
    await closeDb();
    const raw = new Database(dbPath);
    raw.pragma("foreign_keys = ON");
    for (const table of [
      "task_review_overrides",
      "task_review_decisions",
      "task_review_snapshots",
      "task_review_requirements",
    ]) {
      raw.prepare(`DROP TABLE IF EXISTS ${table}`).run();
    }
    const marker = raw
      .prepare(`SELECT id FROM __drizzle_migrations ORDER BY id DESC LIMIT 1`)
      .get() as { id: number } | undefined;
    expect(marker).toBeDefined();
    raw.prepare(`DELETE FROM __drizzle_migrations WHERE id = ?`).run(marker!.id);
    seedLegacyShapes(dbPath, missionId, agentId);
    raw.close();
    await initDb(dbPath);
  }

  it("classifies every legacy shape without inventing review history", async () => {
    await reapply0082();
    const db = getDb();
    const row = (id: string) => getRequirementWithClient(db as never, id);

    // Ordinary approved/done: sticky legacy_unknown, typed custody, NO proof —
    // the legacy approved reviewer row never becomes approval proof.
    for (const id of ["t-done", "t-approved"]) {
      const r = row(id)!;
      expect(r, id).not.toBeNull();
      expect(r.state).toBe("legacy_unknown");
      expect(r.origin).toBe("legacy_unverified");
      expect(r.nonOverriddenFloor).toBeNull();
      expect(r.effectiveCount).toBeNull();
      expect(r.approvedGeneration).toBeNull();
      expect(r.activeOverrideId).toBeNull();
      const t = db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
      expect(t?.status).toBe(id === "t-done" ? "done" : "approved"); // grandfathered display
    }
    expect(row("t-done")!.claimantType).toBe("local_agent");
    expect(row("t-done")!.claimantId).toBe(agentId);

    const failed = row("t-failed")!;
    expect(failed.state).toBe("legacy_unknown");
    expect(failed.claimantType).toBeNull(); // no surviving claimant → nothing fabricated

    const active = row("t-active")!;
    expect(active.state).toBe("legacy_unknown");
    expect(active.claimantType).toBe("local_agent"); // typed CUSTODY only

    expect(row("t-ambiguous")!.state).toBe("legacy_unknown"); // claimed_at residue
    expect(row("t-event-evidence")!.state).toBe("legacy_unknown"); // claimed-event evidence

    const never = row("t-never")!;
    expect(never.state).toBe("uncaptured");
    expect(never.claimantType).toBeNull();
    expect(never.nonOverriddenFloor).toBeNull();
    expect(never.effectiveCount).toBeNull();
  });

  it("the CHECK matrix refuses illegal rows on the real database", async () => {
    await reapply0082();
    const raw = new Database(dbPath);
    raw.pragma("foreign_keys = ON");
    const now = new Date().toISOString();
    const mkTask = (id: string) =>
      raw
        .prepare(
          `INSERT INTO tasks (id, mission_id, title, description, labels, required_capabilities, artifacts, priority, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, '', '[]', '[]', '[]', 'medium', 'pending', 'u', ?, ?)`,
        )
        .run(id, missionId, id, now, now);
    const insert = (id: string, state: string, floor: string, policy: string, effective: string, override: string) => {
      mkTask(id);
      raw
        .prepare(
          `INSERT INTO task_review_requirements (task_id, origin, state, non_overridden_floor, known_policy_floor, effective_count, active_override_id)
           VALUES (?, 'ordinary', ?, ${floor}, ${policy}, ${effective}, ${override})`,
        )
        .run(id, state);
    };

    expect(() => insert("chk-zero", "known_zero", "1", "0", "0", "NULL")).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => insert("chk-null", "required", "NULL", "2", "NULL", "NULL")).toThrow(
      /CHECK constraint failed/,
    );
    // Override-free zero below a positive baseline is CHECK-invalid.
    expect(() => insert("chk-ovr0", "required", "2", "0", "0", "NULL")).toThrow(
      /CHECK constraint failed/,
    );
    // The same row WITH an audited override is legal (still `required`).
    expect(() => insert("chk-ovr1", "required", "2", "0", "0", "'ovr-1'")).not.toThrow();
    // approved_generation may only equal the current generation.
    mkTask("chk-proof");
    raw
      .prepare(
        `INSERT INTO task_review_requirements (task_id, origin, state, non_overridden_floor, known_policy_floor, effective_count)
         VALUES ('chk-proof', 'ordinary', 'required', 1, 0, 1)`,
      )
      .run();
    expect(() =>
      raw
        .prepare(
          `UPDATE task_review_requirements SET approved_generation = 5 WHERE task_id = 'chk-proof'`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    raw.close();
  });

  it("ownership end on an overridden required row restores the baseline immediately (no next claim)", async () => {
    await reapply0082();
    const raw = new Database(dbPath);
    raw
      .prepare(
        `UPDATE task_review_requirements SET origin='ordinary', state='required', non_overridden_floor=2, known_policy_floor=0, effective_count=0, active_override_id='ovr-x' WHERE task_id='t-never'`,
      )
      .run();
    raw.close();
    const db = getDb();
    endOwnershipWithClient(db as never, "t-never");
    const after = getRequirementWithClient(db as never, "t-never")!;
    expect(after.state).toBe("required");
    expect(after.activeOverrideId).toBeNull();
    expect(after.effectiveCount).toBe(2); // baseline restored, no new claim
    expect(after.claimantType).toBeNull();
    expect(after.approvedGeneration).toBeNull();
    expect(after.reviewGeneration).toBe(1);
  });

  it("no raw terminal primitive exists at all (export-shape, runtime)", async () => {
    await reapply0082();
    const tsm = await import("../repositories/taskStateMachine.js");
    const facade = await import("../repositories/task.js");
    for (const ns of [tsm, facade]) {
      for (const sym of ["approveTask", "markTaskDone", "approveTaskWithProofClient", "markTaskDoneGuardedClient"]) {
        expect((ns as Record<string, unknown>)[sym]).toBeUndefined();
      }
    }
  });
});
