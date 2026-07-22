/**
 * T9B-01 — REAL cross-process proof for `createRecoveryWorkerId`.
 *
 * The unit tests in `scheduledOccurrenceRecovery.test.ts` prove
 * `createRecoveryWorkerId()` generates distinct ids per CALL within one
 * process (the uuid suffix guarantees that). They do NOT prove the
 * PROCESS-DISTINCTNESS claim — that the id embeds the `pid` so two OS
 * processes generate DIFFERENT id prefixes. That's what this file closes.
 *
 * # The proof
 *
 *   1. PARENT opens a file DB + seeds a schedule + reserves an occurrence
 *      + simulates a crashed worker (expired lease).
 *   2. PARENT forks the worker fixture (`fixtures/t9b01-recovery-worker.ts`).
 *      The WORKER opens its OWN better-sqlite3 file connection + calls
 *      `createRecoveryWorkerId()` to mint its unique id + reclaims the
 *      expired-lease occurrence under that id (setting a past expiry so
 *      the lease re-expires immediately). It reports `{ id, pid }` back.
 *   3. PARENT asserts the WORKER's `pid` ≠ its own `pid` (true cross-
 *      process) AND the worker's `id` CONTAINS the worker's `pid` (the
 *      factory's process-distinctness).
 *   4. PARENT (now the "B" worker) calls `createRecoveryWorkerId()` to
 *      mint its OWN id (distinct from the worker's). PARENT reclaims the
 *      occurrence under its id (becomes the new owner — the lease the
 *      worker set was past).
 *   5. PARENT attempts `markOccurrenceRejectedWithClient` with the
 *      WORKER's (now stale) id → `not_owner`. The fenced CAS distinguishes
 *      them via the distinct ids — the T9B-01 fix's load-bearing claim.
 *
 * # Why a child process (not a unit test)
 *
 * `createRecoveryWorkerId()` is composed of `${hostname}-${pid}-${uuid}`.
 * Two calls in ONE process share `hostname` + `pid` — only the uuid
 * suffix differs (still unique, but the pid-difference claim is
 * unverified). A child PROCESS has a DIFFERENT pid, so the worker's id
 * prefix differs from the parent's at the pid position. This is the
 * structural guarantee that defeats the T9B-01 defect (multi-instance
 * deployments with a constant owner string → fencing collapse).
 *
 * # Why a separate file (mirrors the T9A-11 precedent)
 *
 * The other recovery tests use `initTestDb()` (sql.js, in-memory). THIS
 * test needs a REAL better-sqlite3 FILE DB shared between the parent +
 * the forked worker via SQLite's file-locking protocol. Mixing the two
 * (close/re-init dance with a file shared with sql.js tests) is fragile
 * — `scheduledOccurrenceReservationConcurrency.test.ts` (the T9A-11
 * precedent) + `f4BusyTimeout.test.ts` set the precedent of separating
 * file-DB concurrency tests into their own file.
 *
 * exfat caveat (per MEMORY.md § Migration Plumbing): real overlapping
 * SQLite write tests are sometimes slow / flaky on exfat (disk I/O
 * transient errors). The worker's `busy_timeout = 5000` pragma handles
 * transient contention cleanly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema/index.js";
import { closeDb, getDb, initDb } from "../db/index.js";
import { scheduledOccurrences, scheduledTasks } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as scheduledTaskRepo from "../repositories/scheduledTask.js";
import {
  reacquireExpiredOccurrenceLeaseWithClient,
  markOccurrenceRejectedWithClient,
} from "../repositories/scheduledOccurrences.js";
import { createRecoveryWorkerId } from "../services/scheduledOccurrenceRecovery.js";
import { reserveScheduledOccurrence } from "../repositories/scheduledOccurrenceReservation.js";
import type { TaskPriority } from "@orcy/shared";

const WORKER = join(import.meta.dirname, "fixtures", "t9b01-recovery-worker.ts");
const TEMP_DIR = join(import.meta.dirname, "..", "..", ".test-t9b01");

const NOW_ISO = "2026-07-19T12:00:00.000Z";
const NEXT_RUN_INTERVAL = "2026-07-19T13:00:00.000Z";
const LEASE_PAST = "2020-01-01T00:00:00.000Z";

interface WorkerMessage {
  type: "RESULT" | "ERROR";
  id?: string;
  pid?: number;
  reclaimOutcome?: string;
  leaseOwnerOnRow?: string | null;
  message?: string;
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${dbPath}${suffix}`)) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore — already gone
      }
    }
  }
}

describe("createRecoveryWorkerId — real cross-process fencing (T9B-01)", () => {
  let dbPath: string;

  beforeEach(() => {
    if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
    dbPath = join(TEMP_DIR, `t9b01-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    cleanupDb(dbPath);
    closeDb();
  });

  afterEach(() => {
    closeDb();
    cleanupDb(dbPath);
  });

  it("worker A reclaims under its unique default id → parent (B) reclaims → A's stale terminalization returns not_owner", async () => {
    // ----- PARENT SETUP: open the file DB + seed a schedule + reserve ---
    await initDb(dbPath);
    const db = getDb();

    const habitat = habitatRepo.createHabitat({ name: "T9B-01 Fencing Habitat" });
    const schedule = scheduledTaskRepo.createScheduledTask({
      habitatId: habitat.id,
      name: "Fenced Schedule",
      scheduleType: "interval",
      intervalMinutes: 60,
      missionTitle: "Fenced mission",
      missionDescription: "Auto-generated by the fencing test.",
      missionPriority: "medium" as TaskPriority,
      missionLabels: ["fencing"],
      tasksTemplate: [],
      nextRunAt: NOW_ISO,
      createdBy: "test",
    });
    const scheduleId = schedule.id;

    // Reserve an occurrence + simulate a crashed worker (publishing with
    // an expired lease).
    const reservation = reserveScheduledOccurrence({
      scheduleId,
      nextRunAt: NEXT_RUN_INTERVAL,
      now: NOW_ISO,
      scheduledFor: NOW_ISO,
    });
    if (reservation.outcome !== "created")
      throw new Error(`fixture reserve failed: ${reservation.outcome}`);
    const occurrenceId = reservation.occurrence.id;
    db.update(scheduledOccurrences)
      .set({
        state: "publishing",
        leaseOwner: "crashed-worker",
        leaseExpiresAt: LEASE_PAST,
      })
      .where(eq(scheduledOccurrences.id, occurrenceId))
      .run();

    // Sanity: pre-fork state — occurrence is publishing with an expired lease.
    expect(
      db.select().from(scheduledOccurrences).where(eq(scheduledOccurrences.id, occurrenceId)).get()!
        .leaseOwner,
    ).toBe("crashed-worker");

    // Close the PARENT's sql.js connection before forking so the worker
    // opens a clean better-sqlite3 file connection (no parent-held handle).
    closeDb();

    // ----- FORK WORKER A ----------------------------------------------
    const child: ChildProcess = fork(WORKER, [dbPath, occurrenceId], {
      execArgv: ["--import", "tsx"],
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      console.warn(`[T9B-01 worker-A stderr]:`, chunk.toString());
    });
    const workerMessage = await new Promise<WorkerMessage>((resolve) => {
      const onMessage = (msg: WorkerMessage): void => {
        if (msg?.type === "RESULT" || msg?.type === "ERROR") {
          child.off("message", onMessage);
          resolve(msg);
        }
      };
      child.on("message", onMessage);
      child.on("exit", (code, signal) => {
        // If the child exited without sending a message, resolve with an
        // error so the test fails cleanly instead of hanging.
        resolve({
          type: "ERROR",
          message: `worker exited (code=${code}, signal=${signal}) without sending a message`,
        });
      });
    });

    // ----- PARENT ASSERTS: worker A's id is process-distinct ----------
    expect(workerMessage.type).toBe("RESULT");
    if (workerMessage.type !== "RESULT") throw new Error(`worker error: ${workerMessage.message}`);
    expect(workerMessage.reclaimOutcome).toBe("reclaimed");
    expect(workerMessage.leaseOwnerOnRow).toBe(workerMessage.id);

    // The worker's pid is DIFFERENT from the parent's pid (true cross-
    // process — not two calls in one process).
    expect(workerMessage.pid).toBeDefined();
    expect(workerMessage.pid).not.toBe(process.pid);

    // The worker's id CONTAINS its pid (the load-bearing T9B-01 claim:
    // the id is process-distinct via the pid prefix). The parent's OWN id
    // would contain the parent's pid (different).
    expect(workerMessage.id).toContain(String(workerMessage.pid));
    const parentId = createRecoveryWorkerId();
    expect(parentId).toContain(String(process.pid));
    expect(parentId).not.toBe(workerMessage.id); // uuid suffix guarantees uniqueness too.
    expect(parentId).not.toContain(String(workerMessage.pid)); // distinct pid prefixes.

    // ----- PARENT (B) RECLAIMS under its OWN id -----------------------
    // Open a fresh better-sqlite3 connection (mirrors the worker's).
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    try {
      const bdb = drizzle(sqlite, { schema });

      // The worker set `leaseExpiresAt = "2020-01-01..."` (past) → the
      // parent's reclaim (using wall-clock `now`) succeeds immediately.
      const reclaimB = reacquireExpiredOccurrenceLeaseWithClient(bdb, occurrenceId, {
        leaseOwner: parentId,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z", // far-future (B's active lease).
      });
      expect(reclaimB.outcome).toBe("reclaimed");
      if (reclaimB.outcome !== "reclaimed") throw new Error("unreachable");
      expect(reclaimB.occurrence.leaseOwner).toBe(parentId);

      // ----- A's STALE TERMINALIZATION → not_owner ---------------------
      // The worker A's id is no longer the row's owner. The fenced CAS
      // (`leaseOwner = expected`) refuses the terminalization → `not_owner`.
      // The new owner's lease is preserved UNCHANGED.
      const staleTerminal = markOccurrenceRejectedWithClient(bdb, occurrenceId, {
        leaseOwner: workerMessage.id!, // A's stale id.
        result: { reason: "stale_worker_attempt" },
      });
      expect(staleTerminal.outcome).toBe("not_owner");
      if (staleTerminal.outcome !== "not_owner") throw new Error("unreachable");
      // The row is UNCHANGED — still `publishing` under B's lease.
      expect(staleTerminal.occurrence.state).toBe("publishing");
      expect(staleTerminal.occurrence.leaseOwner).toBe(parentId);

      // ----- B's terminalization succeeds (it's the current owner) -----
      const bTerminal = markOccurrenceRejectedWithClient(bdb, occurrenceId, {
        leaseOwner: parentId,
        result: { reason: "current_owner_succeeds" },
      });
      expect(bTerminal.outcome).toBe("transitioned");
      if (bTerminal.outcome !== "transitioned") throw new Error("unreachable");
      expect(bTerminal.occurrence.state).toBe("rejected");
      expect(bTerminal.occurrence.leaseOwner).toBeNull();
    } finally {
      try {
        sqlite.close();
      } catch {
        // ignore
      }
    }
  }, 30_000);
});
