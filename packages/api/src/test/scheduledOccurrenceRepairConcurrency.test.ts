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
import { fork } from "node:child_process";
import { join } from "node:path";
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from "node:fs";
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
  type: "AT_RETRY" | "RESULT" | "ERROR";
  outcome?: string;
  retryNumber?: number | null;
  message?: string;
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm", ".retry-release"]) {
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

    const forkWorker = (label: string) => {
      const child = fork(WORKER, [dbPath, occurrenceId, `operator-${label}`], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      const ready = Promise.withResolvers<number>();
      const result = Promise.withResolvers<WorkerMessage>();
      const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.stderr?.on("data", (chunk: Buffer) => {
        console.warn(`[T9B-05 worker-${label} stderr]:`, chunk.toString());
      });
      child.on("message", (message: WorkerMessage) => {
        if (message.type === "AT_RETRY") {
          ready.resolve(message.retryNumber!);
        } else {
          ready.reject(new Error(`worker ${label} did not reach the retry barrier: ${JSON.stringify(message)}`));
          result.resolve(message);
        }
      });
      const fail = (error: Error) => {
        ready.reject(error);
        result.reject(error);
      };
      child.once("error", fail);
      child.once("exit", (code, signal) => {
        fail(new Error(`worker ${label} exited before reporting (code=${code}, signal=${signal})`));
      });
      return { child, ready: ready.promise, result: result.promise, exited };
    };

    const workers = [forkWorker("1"), forkWorker("2")];
    try {
      const release = Promise.all(workers.map((worker) => worker.ready)).then((retryNumbers) => {
        expect(retryNumbers, "both workers must reach the reservation for retry 1").toEqual([1, 1]);
        writeFileSync(`${dbPath}.retry-release`, "", { flag: "wx" });
      });
      const [[r1, r2]] = await Promise.all([
        Promise.all(workers.map((worker) => worker.result)),
        release,
      ]);

      expect([r1.type, r2.type], JSON.stringify([r1, r2])).toEqual(["RESULT", "RESULT"]);
      expect([r1.retryNumber, r2.retryNumber], "both workers must contend for retry 1").toEqual([1, 1]);

      const outcomes = [r1.outcome!, r2.outcome!];
      const winnerOutcomes = outcomes.filter((o) => o === "repaired" || o.startsWith("retry_failed"));
      const typedLoserOutcomes = outcomes.filter(
        (o) => o === "retry_in_progress" || o === "retry_already_completed" || o === "retry_concurrent_conflict",
      );
      expect(winnerOutcomes).toHaveLength(1);
      expect(typedLoserOutcomes).toHaveLength(1);
    } finally {
      for (const { child } of workers) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      await Promise.all(workers.map((worker) => worker.exited));
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
