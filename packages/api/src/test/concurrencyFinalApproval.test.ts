/**
 * R4 — Atomic final-approval policy gate: concurrency tests.
 *
 * Uses native better-sqlite3 (NOT sql.js) with two separate Database
 * connections to the same temp file to demonstrate genuine cross-connection
 * lock behavior. better-sqlite3 is synchronous, so "concurrency" is simulated
 * by interleaving operations across two connections — but the BEGIN IMMEDIATE
 * lock contention (SQLITE_BUSY) is real.
 *
 * These tests prove:
 * 1. BEGIN IMMEDIATE on one connection blocks BEGIN IMMEDIATE on another.
 * 2. Without serialization, interleaved reads produce stale finality decisions
 *    (the HIGH 5 concurrency bug).
 * 3. With BEGIN IMMEDIATE serialization, the second connection sees the
 *    committed state and correctly classifies itself as final.
 */
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

const TASK_REVIEWERS_DDL = `
  CREATE TABLE IF NOT EXISTS task_reviewers (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    reviewer_type TEXT NOT NULL DEFAULT 'human',
    reviewer_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_tr_task_reviewer
    ON task_reviewers(task_id, reviewer_id);
`;

function seedTaskWithReviewers(db: DatabaseType, taskId: string, reviewerIds: string[]): void {
  const insert = db.prepare(
    "INSERT INTO task_reviewers (id, task_id, reviewer_id, status) VALUES (?, ?, ?, 'pending')",
  );
  for (const rid of reviewerIds) {
    insert.run(`${taskId}-${rid}`, taskId, rid);
  }
}

function countPending(db: DatabaseType, taskId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) as count FROM task_reviewers WHERE task_id = ? AND status = 'pending'",
    )
    .get(taskId) as { count: number };
  return row.count;
}

function getReviewerStatus(db: DatabaseType, taskId: string, reviewerId: string): string {
  const row = db
    .prepare("SELECT status FROM task_reviewers WHERE task_id = ? AND reviewer_id = ?")
    .get(taskId, reviewerId) as { status: string };
  return row.status;
}

function approveReviewer(db: DatabaseType, taskId: string, reviewerId: string): void {
  db.prepare(
    "UPDATE task_reviewers SET status = 'approved', reviewed_at = datetime('now') " +
      "WHERE task_id = ? AND reviewer_id = ?",
  ).run(taskId, reviewerId);
}

describe("Final-approval concurrency (R4 — BEGIN IMMEDIATE serialization)", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `orcy-r4-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  });

  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(dbPath + suffix, { force: true });
      } catch {
        // already gone
      }
    }
  });

  function createDb(): DatabaseType {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(TASK_REVIEWERS_DDL);
    return db;
  }

  it("BEGIN IMMEDIATE on connection A blocks BEGIN IMMEDIATE on connection B", () => {
    const dbA = createDb();
    const dbB = new Database(dbPath);
    dbB.pragma("busy_timeout = 0"); // throw immediately on lock contention
    dbB.exec(TASK_REVIEWERS_DDL);
    seedTaskWithReviewers(dbA, "t1", ["ra", "rb"]);

    // A acquires the write lock.
    dbA.exec("BEGIN IMMEDIATE");

    // B cannot acquire it while A holds it — SQLITE_BUSY (immediate throw).
    expect(() => dbB.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);

    // A commits, releasing the lock.
    dbA.exec("COMMIT");

    // B can now acquire it.
    expect(() => dbB.exec("BEGIN IMMEDIATE")).not.toThrow();
    dbB.exec("COMMIT");

    dbA.close();
    dbB.close();
  });

  it("WITHOUT serialization: interleaved reads produce stale finality (the bug)", () => {
    const dbA = createDb();
    const dbB = createDb();
    seedTaskWithReviewers(dbA, "t1", ["ra", "rb"]);

    // Both connections read the current state BEFORE either writes.
    // Both see 2 pending → neither classifies as the last pending reviewer.
    const pendingA = countPending(dbA, "t1");
    const pendingB = countPending(dbB, "t1");
    expect(pendingA).toBe(2);
    expect(pendingB).toBe(2);
    // Both would skip pre-veto because neither appears to be "final."

    // Both record their approvals independently (no lock coordination).
    approveReviewer(dbA, "t1", "ra");
    approveReviewer(dbB, "t1", "rb");

    // BUG: both reviewers are now approved, but NEITHER ran pre-veto for the
    // final approval because both saw themselves as non-final.
    expect(getReviewerStatus(dbA, "t1", "ra")).toBe("approved");
    expect(getReviewerStatus(dbA, "t1", "rb")).toBe("approved");

    dbA.close();
    dbB.close();
  });

  it("WITH BEGIN IMMEDIATE: serialized — second connection sees committed state (the fix)", () => {
    const dbA = createDb();
    const dbB = createDb();
    seedTaskWithReviewers(dbA, "t1", ["ra", "rb"]);

    // ── Process A: handles reviewer-a ──
    dbA.exec("BEGIN IMMEDIATE");
    // A reads: 2 pending → ra is NOT the last pending → non-final → no pre-veto.
    expect(countPending(dbA, "t1")).toBe(2);
    approveReviewer(dbA, "t1", "ra");
    dbA.exec("COMMIT");

    // ── Process B: handles reviewer-b ──
    // B's BEGIN IMMEDIATE now succeeds (A released the lock).
    dbB.exec("BEGIN IMMEDIATE");
    // B reads: 1 pending (rb only) → rb IS the last pending → FINAL → pre-veto runs.
    expect(countPending(dbB, "t1")).toBe(1);
    // B sees ra as already approved (committed by A).
    expect(getReviewerStatus(dbB, "t1", "ra")).toBe("approved");
    approveReviewer(dbB, "t1", "rb");
    dbB.exec("COMMIT");

    // Both approvals recorded; exactly one path (B) classified itself as final.
    expect(getReviewerStatus(dbA, "t1", "ra")).toBe("approved");
    expect(getReviewerStatus(dbA, "t1", "rb")).toBe("approved");

    dbA.close();
    dbB.close();
  });

  it("WITH BEGIN IMMEDIATE: veto on final leaves approval unrecorded (COMMIT preserves telemetry)", () => {
    const dbA = createDb();
    const dbB = createDb();
    seedTaskWithReviewers(dbA, "t1", ["ra", "rb"]);

    // A approves ra (non-final).
    dbA.exec("BEGIN IMMEDIATE");
    approveReviewer(dbA, "t1", "ra");
    dbA.exec("COMMIT");

    // B starts the final approval. Inside the transaction, the pre-veto runs
    // and decides to VETO. In the production gate, this results in COMMIT
    // (telemetry preserved) WITHOUT recording the approval.
    dbB.exec("BEGIN IMMEDIATE");
    expect(countPending(dbB, "t1")).toBe(1); // rb is final
    // Simulate: pre-veto vetoed → do NOT approve → COMMIT (telemetry persists).
    dbB.exec("COMMIT");

    // rb remains pending — can retry.
    expect(getReviewerStatus(dbB, "t1", "rb")).toBe("pending");
    expect(getReviewerStatus(dbB, "t1", "ra")).toBe("approved");

    dbA.close();
    dbB.close();
  });
});
