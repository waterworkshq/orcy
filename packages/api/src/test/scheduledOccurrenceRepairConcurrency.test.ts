/**
 * T9B-05 — REAL cross-process concurrency for `repairScheduledOccurrence`.
 *
 * Mirrors the T9A-11 pattern (`scheduledOccurrenceReservationConcurrency.test.ts`):
 * two worker processes (`fixtures/t9b05-retry-worker.ts`) each open their OWN
 * better-sqlite3 file connection + each call `repairScheduledOccurrence` for
 * the SAME rejected occurrence at the SAME time.
 *
 * # The race under test
 *
 * Two operators concurrently retry the same occurrence. Both derive the same
 * `retryNumber` (retryHistory.length + 1). Pre-T9B-05 both proceeded to the
 * publish path + the loser's `publishTaskWithClient` hit the winner's committed
 * checkpoint → `PublicationCheckpointConsistencyError` (a 500, NOT a typed
 * outcome). Post-T9B-05 the coordination attempt's UNIQUE index defends: ONE
 * caller wins (`repaired`); the loser gets a TYPED outcome (`retry_in_progress`).
 * No duplicate retryNumbers in retryHistory.
 *
 * # Why a child process (not two connections on one event loop)
 *
 * better-sqlite3 is synchronous — two connections on one event loop serialize
 * by construction. Two OS processes genuinely race for the file-level write
 * lock (the T9A-11 precedent + the f4BusyTimeout guardrail).
 *
 * exfat caveat (per the ticket): real overlapping SQLite write tests are
 * sometimes slow / flaky on exfat. The workers' `busy_timeout = 5000` pragma
 * (set by `initDb`) handles transient SQLITE_BUSY.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initDb } from "../db/index.js";
import { scheduledOccurrences, scheduledTasks } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as scheduledTaskRepo from "../repositories/scheduledTask.js";
import * as templateRepo from "../repositories/template.js";
import { reserveScheduledOccurrence } from "../repositories/scheduledOccurrenceReservation.js";
import { markOccurrenceRejectedWithClient } from "../repositories/scheduledOccurrences.js";
import type { TaskPriority } from "@orcy/shared";

const WORKER = join(import.meta.dirname, "fixtures", "t9b05-retry-worker.ts");
const TEMP_DIR = join(import.meta.dirname, "..", "..", ".test-t9b05");

const NOW_ISO = "2026-07-19T12:00:00.000Z";
const NEXT_RUN_INTERVAL = "2026-07-19T13:00:00.000Z";

interface WorkerMessage {
  type: "READY" | "RESULT" | "ERROR";
  outcome?: string;
  retryNumber?: number | null;
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

describe("repairScheduledOccurrence — real cross-process concurrency (T9B-05)", () => {
  let dbPath: string;

  beforeEach(() => {
    if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
    dbPath = join(TEMP_DIR, `t9b05-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    cleanupDb(dbPath);
    closeDb();
  });

  afterEach(() => {
    closeDb();
    cleanupDb(dbPath);
  });

  it("two workers retrying the SAME rejected occurrence → ONE winner + the loser gets a TYPED outcome (NOT the 500)", async () => {
    // ----- PARENT SETUP: open the file DB + seed a rejected occurrence ----
    await initDb(dbPath);
    const db = getDb();

    const habitat = habitatRepo.createHabitat({ name: "T9B-05 Concurrency Habitat" });
    const tpl = templateRepo.createTemplate({
      habitatId: habitat.id,
      name: "T9B-05 Template",
      titlePattern: "Concurrent retry mission {{counter}}",
      descriptionPattern: "## Goal",
      priority: "medium" as TaskPriority,
      labels: ["concurrency"],
      requiredDomain: "backend",
      requiredCapabilities: ["typescript"],
      tasksTemplate: [
        { title: "First task", description: "desc", priority: "medium" as TaskPriority, order: 0 },
      ],
      createdBy: "test",
    });
    const schedule = scheduledTaskRepo.createScheduledTask({
      habitatId: habitat.id,
      templateId: tpl.id,
      name: "T9B-05 Schedule",
      scheduleType: "interval",
      intervalMinutes: 60,
      missionTitle: "Concurrent retry mission {{counter}}",
      missionDescription: "Auto-generated.",
      missionPriority: "medium" as TaskPriority,
      missionLabels: ["concurrency"],
      tasksTemplate: [],
      nextRunAt: NOW_ISO,
      createdBy: "test",
    });
    const scheduleId = schedule.id;

    // Reserve + reject the occurrence (the retry's input).
    const reserveResult = reserveScheduledOccurrence({
      scheduleId,
      nextRunAt: NEXT_RUN_INTERVAL,
      now: NOW_ISO,
      scheduledFor: NOW_ISO,
    });
    if (reserveResult.outcome !== "created")
      throw new Error(`fixture reserve failed: ${reserveResult.outcome}`);
    const occurrenceId = reserveResult.occurrence.id;
    const rejectResult = markOccurrenceRejectedWithClient(db, occurrenceId, {
      leaseOwner: null,
      result: { reason: "test_setup", message: "synthetic rejection for T9B-05 concurrency test" },
    });
    if (rejectResult.outcome !== "transitioned")
      throw new Error(`fixture reject failed: ${rejectResult.outcome}`);

    // Sanity: pre-race state — one rejected occurrence, empty retryHistory.
    expect(
      db.select().from(scheduledOccurrences).where(eq(scheduledOccurrences.id, occurrenceId)).get()!
        .state,
    ).toBe("rejected");

    // Close the PARENT's connection before forking.
    closeDb();

    // ----- FORK TWO WORKERS --------------------------------------------
    const forkWorker = (
      label: string,
    ): {
      child: ChildProcess;
      ready: Promise<void>;
      result: Promise<WorkerMessage>;
    } => {
      const child = fork(WORKER, [dbPath, occurrenceId, `operator-${label}`], {
        execArgv: ["--import", "tsx"],
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        console.warn(`[T9B-05 worker-${label} stderr]:`, chunk.toString());
      });
      const ready = new Promise<void>((resolve, reject) => {
        const onMessage = (msg: WorkerMessage): void => {
          if (msg?.type === "READY") {
            child.off("message", onMessage);
            resolve();
          }
        };
        child.on("message", onMessage);
        child.on("exit", (code, signal) => {
          reject(new Error(`worker exited (code=${code}, signal=${signal}) before READY`));
        });
      });
      const result = new Promise<WorkerMessage>((resolve) => {
        const onMessage = (msg: WorkerMessage): void => {
          if (msg?.type === "RESULT" || msg?.type === "ERROR") {
            child.off("message", onMessage);
            resolve(msg);
          }
        };
        child.on("message", onMessage);
      });
      return { child, ready, result };
    };

    const w1 = forkWorker("1");
    const w2 = forkWorker("2");

    try {
      await Promise.all([w1.ready, w2.ready]);

      // Fire BOTH as close to simultaneously as the event loop allows.
      w1.child.send({ type: "GO" });
      w2.child.send({ type: "GO" });

      const [r1, r2] = await Promise.all([w1.result, w2.result]);

      if (r1.type === "ERROR") console.warn("[T9B-05 worker-1 ERROR]:", r1.message);
      if (r2.type === "ERROR") console.warn("[T9B-05 worker-2 ERROR]:", r2.message);

      // Neither worker should error — the race outcomes are typed.
      expect(r1.type).toBe("RESULT");
      expect(r2.type).toBe("RESULT");

      // ----- THE LOAD-BEARING ASSERTION: one winner, one typed loser ---
      // Exactly ONE worker won (repaired / retry_failed_*). The other got a
      // TYPED concurrency outcome (retry_in_progress / retry_already_completed
      // / retry_concurrent_conflict) — NOT a thrown 500.
      const outcomes = [r1.outcome!, r2.outcome!];
      const winnerOutcomes = outcomes.filter(
        (o) => o === "repaired" || o.startsWith("retry_failed"),
      );
      const typedLoserOutcomes = outcomes.filter(
        (o) =>
          o === "retry_in_progress" ||
          o === "retry_already_completed" ||
          o === "retry_concurrent_conflict",
      );
      expect(winnerOutcomes).toHaveLength(1);
      expect(typedLoserOutcomes).toHaveLength(1);

      // **Failure mode (pre-T9B-05)**: both callers would proceed to the
      // publish path + the loser would throw `PublicationCheckpointConsistencyError`
      // (a 500, surfaced as an ERROR here). Post-T9B-05 the loser gets a
      // typed outcome.
    } finally {
      for (const w of [w1, w2]) {
        if (w.child.exitCode === null && !w.child.killed) w.child.kill("SIGKILL");
      }
    }

    // ----- PARENT POST-RACE ASSERTIONS: durable DB state ----------------
    await initDb(dbPath);
    const db2 = getDb();

    // THE LOAD-BEARING ASSERTION: no duplicate retryNumbers in retryHistory.
    // Pre-T9B-05 both callers stamped retryNumber 1 → duplicate entries.
    // Post-T9B-05 the coordination attempt's UNIQUE index guarantees one
    // winner stamps; the loser doesn't stamp.
    const occurrence = db2
      .select()
      .from(scheduledOccurrences)
      .where(eq(scheduledOccurrences.id, occurrenceId))
      .get();
    expect(occurrence).toBeTruthy();
    expect(occurrence!.state).toBe("rejected"); // one-way door holds.
    const resultJson = occurrence!.result as Record<string, unknown>;
    const retryHistory = (resultJson.retryHistory ?? []) as Array<Record<string, unknown>>;
    const retryNumbers = retryHistory.map((e) => e.retryNumber);
    const uniqueRetryNumbers = new Set(retryNumbers);
    expect(retryNumbers.length).toBe(uniqueRetryNumbers.size); // no duplicates.

    // The retryHistory has AT MOST ONE entry (the winner's). The loser did
    // not stamp (the coordination defense fired before the stamp).
    expect(retryHistory.length).toBeLessThanOrEqual(1);
    if (retryHistory.length === 1) {
      expect(retryHistory[0].retryNumber).toBe(1);
    }
  }, 30_000);
});
