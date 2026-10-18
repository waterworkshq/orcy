/**
 * Review-safety legacy migration classifier — REAL production upgrade proof.
 *
 * Builds a legacy database through the journal preceding migration 0082 on the
 * production better-sqlite3 driver (initDb), seeds task shapes, then applies
 * migration 0082 against them, and asserts the classifier gives EVERY task a
 * legal row without inventing review history — plus direct CHECK-matrix
 * enforcement and immediate baseline restoration proofs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { closeDb, initDb, getDb } from "../db/index.js";
import * as schema from "../db/schema/index.js";
import { useCompiledApi } from "./compiledApiFixture.js";
import { getRequirementWithClient, endOwnershipWithClient } from "../repositories/reviewSafety.js";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const compiled = useCompiledApi();
const DRIZZLE_DIR = join(PACKAGE_ROOT, "drizzle");
const TARGET_TAG = "0082_task_review_safety";
const journal = JSON.parse(readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as {
  entries: { tag: string; when: number }[];
};
const targetIndex = journal.entries.findIndex(entry => entry.tag === TARGET_TAG);

/** Seeds legacy task shapes directly before the classifier migration. */
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

  let ownedDirectory: string;
  beforeEach(async () => {
    closeDb();
    expect(targetIndex).toBeGreaterThan(0);
    ownedDirectory = mkdtempSync(join(tmpdir(), "orcy-review-safety-upgrade-"));
    dbPath = join(ownedDirectory, "legacy.db");
    const installed = join(ownedDirectory, "installed");
    // Real copies outside workspace lookup select this owned legacy journal.
    // No current-schema DDL is dropped and no migration ledger is rewound.
    cpSync(compiled.distDir, join(installed, "dist"), { recursive: true });
    cpSync(DRIZZLE_DIR, join(installed, "drizzle"), { recursive: true });
    cpSync(join(PACKAGE_ROOT, "package.json"), join(installed, "package.json"));
    symlinkSync(join(PACKAGE_ROOT, "node_modules"), join(installed, "node_modules"), "dir");
    writeFileSync(join(installed, "drizzle/meta/_journal.json"), JSON.stringify({
      ...journal, entries: journal.entries.slice(0, targetIndex),
    }));
    execFileSync(process.execPath, [join(import.meta.dirname, "fixtures/review-safety-legacy-bootstrap.mjs"),
      installed, dbPath], { cwd: ownedDirectory, timeout: 10_000, stdio: "pipe", env: { ...process.env, JWT_SECRET: randomBytes(32).toString("hex") } });
    const raw = new Database(dbPath);
    try {
      raw.pragma("foreign_keys = ON");
      raw.pragma("busy_timeout = 5000");
      const prior = journal.entries[targetIndex - 1];
      expect(raw.prepare("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1").get()).toEqual({
        hash: createHash("sha256").update(readFileSync(join(DRIZZLE_DIR, `${prior.tag}.sql`))).digest("hex"), created_at: prior.when,
      });
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE name='task_review_requirements'").get()).toBeUndefined();
      const now = new Date().toISOString();
      raw.prepare("INSERT INTO habitats(id,name,created_at,updated_at) VALUES ('rs-habitat','Review migration',?,?)").run(now, now);
      raw.prepare(`INSERT INTO columns(id,habitat_id,name,"order") VALUES ('rs-column','rs-habitat','To Do',0)`).run();
      missionId = "rs-mission";
      agentId = "rs-agent";
      raw.prepare(`INSERT INTO missions(id,habitat_id,column_id,title,labels,depends_on,blocks,created_by)
        VALUES (?,'rs-habitat','rs-column','Legacy mission','[]','[]','[]','u')`).run(missionId);
      raw.prepare(`INSERT INTO agents(id,name,type,domain,capabilities,api_key,metadata,created_at,last_heartbeat)
        VALUES (?,'Legacy agent','claude-code','backend','[]',?,'{}',?,?)`).run(agentId, randomBytes(32).toString("hex"), now, now);
    } finally { raw.close(); }
  });

  afterEach(() => {
    closeDb();
    if (ownedDirectory) rmSync(ownedDirectory, { recursive: true, force: true });
  });

  /** Upgrade a genuine pre-0082 database through the actual full production journal. */
  async function reapply0082(): Promise<void> {
    seedLegacyShapes(dbPath, missionId, agentId);
    await initDb(dbPath);
    const raw = new Database(dbPath, { readonly: true });
    try {
      const target = journal.entries[targetIndex];
      const hash = createHash("sha256").update(readFileSync(join(DRIZZLE_DIR, `${target.tag}.sql`))).digest("hex");
      expect(raw.prepare("SELECT count(*) AS n FROM __drizzle_migrations WHERE hash=? AND created_at=?").get(hash, target.when)).toEqual({ n: 1 });
    } finally { raw.close(); }
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
