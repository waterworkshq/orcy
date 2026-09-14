/**
 * Agent review decision race worker — REAL cross-process concurrency.
 *
 * Forked (as its own OS process, own better-sqlite3 file connection via the
 * production `initDb`) by `agentReviewDecisionRace.test.ts`. Two synchronous
 * better-sqlite3 connections on ONE event loop serialize by construction —
 * only separate processes produce genuine overlapping write-lock ownership
 * (f4BusyTimeout / lifecycle-route-worker precedents).
 *
 * Protocol (IPC):
 *   1. WORKER: dynamic-imports the service modules so the module graph loads
 *      BEFORE the race window (no import-time skew), then emits READY.
 *   2. PARENT: waits for every worker's READY, sends GO to each
 *      back-to-back.
 *   3. WORKER: on GO, runs `taskService.approveTask` / `rejectTask` for its
 *      reviewer and reports { ok, error }.
 *
 * Usage: forked with argv [dbPath, mode, taskId, reviewerId, reason?].
 */
import type { ChildProcess } from "node:child_process";

export interface RaceResultMessage {
  type: "RESULT";
  ok: boolean;
  error?: string;
}

async function main(): Promise<void> {
  const [dbPath, mode, taskId, reviewerId, reason = "race reject"] = process.argv.slice(2);
  if (!dbPath || !mode || !taskId || !reviewerId) {
    process.exitCode = 2;
    return;
  }

  // Load the module graph (and run idempotent migrations) before READY so the
  // race window contains only the decision call itself.
  const { initDb, closeDb } = await import("../../db/index.js");
  const taskService = await import("../../services/tasks/index.js");

  // Production init against the shared file: own better-sqlite3 connection,
  // migrations already applied by the seeding parent (idempotent no-op here).
  await initDb(dbPath);

  process.on("message", (msg: { type?: string }) => {
    if (msg?.type !== "GO") return;
    // Harness-cleanup hook: wedge mode swallows GO — no result, no exit.
    // Used by the bounded-cleanup tests to prove the parent kills wedged racers.
    if (process.env.ORCY_RACE_WORKER_HANG === "1") return;
    try {
      const result =
        mode === "reject"
          ? taskService.rejectTask(taskId, reviewerId, reason, "agent")
          : taskService.approveTask(taskId, reviewerId, "agent");
      report({ type: "RESULT", ok: result !== null }, closeDb);
    } catch (err) {
      report(
        { type: "RESULT", ok: false, error: err instanceof Error ? err.message : String(err) },
        closeDb,
      );
    }
  });

  process.send?.({ type: "READY" });
}

/** Sends the outcome and exits from the send callback — process.send is NOT
 *  guaranteed synchronous (platform-dependent IPC flush), so the exit rides
 *  the delivery confirmation. The boolean return value is BACKPRESSURE
 *  (message still queued), never a failure signal — only the callback's err
 *  is. Exit code stays 0 on every outcome path (failure semantics travel in
 *  the message; the racing parent never asserts the code) except a send
 *  error or synchronous throw (1). */
function report(m: RaceResultMessage, done: () => void): void {
  done();
  // The open IPC channel holds the event loop alive — the racing parent
  // awaits process exit — so exit explicitly once delivery is confirmed.
  if (process.send) {
    try {
      process.send(m, (err) => process.exit(err ? 1 : 0));
    } catch {
      process.exit(1);
    }
  } else {
    process.exit(0);
  }
}

void main();

// Type-only reference (kept for the protocol doc above).
export type { ChildProcess };
