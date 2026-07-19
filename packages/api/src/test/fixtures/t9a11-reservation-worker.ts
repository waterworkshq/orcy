/**
 * T9A-11 — Reservation worker for the REAL cross-process concurrency test.
 *
 * Forked twice (as TWO separate OS processes) by
 * `scheduledOccurrenceReservationConcurrency.test.ts` to produce genuine
 * overlapping write-lock contention on `reserveScheduledOccurrence` for the
 * SAME schedule. Two synchronous better-sqlite3 connections on ONE event
 * loop serialize by construction — that would be a serial substitute, not
 * real overlap (the f4BusyTimeout precedent + MEMORY.md § Migration
 * Plumbing). Each worker is its OWN process here, opening its OWN
 * better-sqlite3 file connection; SQLite's file-level write lock serializes
 * them at the OS level, exercising the real UNIQUE-race + schedule-advance-
 * CAS windows the function depends on.
 *
 * Run via `child_process.fork(..., { execArgv: ["--import", "tsx"] })` so
 * the TS source loads at runtime (the project's `dev` script uses tsx the
 * same way for the API server).
 *
 * # Why a TS worker (not a raw-SQL `.mjs` like f4-lock-holder)
 *
 * f4-lock-holder holds a raw write lock — it has no need of the app's TS
 * code. THIS test must exercise the REAL `reserveScheduledOccurrence`
 * function (the ticket: "each attempt reserveScheduledOccurrence for the
 * SAME schedule at the SAME time"). The function's race classification
 * (UNIQUE-collision → `already_exists`, CAS-loss → `lost_race`) is the
 * behavior under test, not just the underlying SQLite semantics. A TS
 * worker via tsx imports + calls the real wrapper.
 *
 * # Why the WRAPPER `reserveScheduledOccurrence` (not the `WithClient`
 * primitive + a manual BEGIN IMMEDIATE)
 *
 * Post-SQLITE-BUSY-fix the wrapper itself opens its tx via
 * `db.run(sql\`BEGIN IMMEDIATE\`)` (NOT drizzle's DEFERRED `db.transaction`).
 * Under WAL-mode concurrent write contention the loser's wrapper-side
 * `BEGIN IMMEDIATE` BLOCKS (with the connection's `busy_timeout = 5000`
 * pragma in effect) until the winner's tx commits, then proceeds — the two
 * reservations serialize behind the RESERVED lock, and within each tx the
 * occurrence UNIQUE index + the schedule-advance CAS resolve the typed
 * outcome (`already_exists` / `lost_race`). The loser NEVER propagates a
 * raw `SQLITE_BUSY`.
 *
 * This worker therefore calls the WRAPPER (passing its own drizzle client
 * as the optional `db` arg — the test-injection path) — the STRONGEST
 * proof that the SQLITE_BUSY bypass is fixed end-to-end on the production
 * path. (Pre-fix, the worker sidestepped the vulnerable wrapper by calling
 * the `WithClient` primitive inside its OWN manual `BEGIN IMMEDIATE`; that
 * sidestep is no longer needed and is dropped.)
 *
 * # Protocol (IPC)
 *
 *   1. WORKER: opens its own raw better-sqlite3 connection + drizzle
 *      wrapper (NOT via `initDb` — the parent already applied migrations;
 *      re-running them concurrently risks interference).
 *   2. WORKER: dynamic-imports `reserveScheduledOccurrence` so the module
 *      graph is loaded BEFORE the race window (no import-time skew).
 *   3. WORKER: emits `{ type: "READY" }`.
 *   4. PARENT: waits for BOTH workers' READY, then sends `{ type: "GO" }`
 *      to each back-to-back (as simultaneous as the event loop allows).
 *   5. WORKER: on GO, calls `reserveScheduledOccurrence(input, db)` —
 *      the wrapper owns BEGIN IMMEDIATE + COMMIT/ROLLBACK + the
 *      lost-race sentinel catch — and emits the typed outcome (or
 *      `{ type: "ERROR" }` on infrastructure failure).
 *   6. WORKER: closes its connection in `finally` BEFORE the RESULT message.
 *
 * Usage: forked with argv `[dbPath, scheduleId, nextRunAt, now, scheduledFor]`.
 */
import Database from "better-sqlite3";

const [dbPath, scheduleId, nextRunAt, now, scheduledFor] = process.argv.slice(2);

const send = typeof process.send === "function" ? process.send.bind(process) : null;

interface ResultMessage {
  type: "RESULT";
  outcome: string;
  occurrenceId: string | null;
}
interface ErrorMessage {
  type: "ERROR";
  message: string;
}

async function main(): Promise<void> {
  let message: ResultMessage | ErrorMessage = {
    type: "ERROR",
    message: "worker: unreachable — main() did not produce a message",
  };

  // The drizzle schema is needed for the repository operations (table
  // resolution). Loaded before the connection opens so the import time
  // doesn't skew the race window.
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const schemaModule = await import("../../db/schema/index.js");
  const { reserveScheduledOccurrence } =
    await import("../../repositories/scheduledOccurrenceReservation.js");

  // Open the worker's OWN raw better-sqlite3 connection (mirrors f4-lock-
  // holder.mjs). NOT via `initDb` — the parent already applied migrations;
  // re-running them concurrently risks WAL-checkpoint interference.
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  // The production pragma (5000ms) — acquired here so the wrapper's
  // `BEGIN IMMEDIATE` waits (bounded) for a concurrent writer's lock +
  // succeeds on release instead of surfacing SQLITE_BUSY immediately.
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema: schemaModule });

  try {
    // 1. Signal READY. Parent waits for both workers before sending GO.
    if (send) send({ type: "READY" });

    // 2. Wait for GO.
    await new Promise<void>((resolve) => {
      const onMessage = (msg: { type: string }): void => {
        if (msg?.type === "GO") {
          process.off("message", onMessage);
          resolve();
        }
      };
      process.on("message", onMessage);
    });

    // 3. THE RACE: call the WRAPPER (the production path). The wrapper
    //    opens its own `BEGIN IMMEDIATE` (busy_timeout in effect) — both
    //    workers' BEGINs serialize via the pragma's bounded wait. Inside
    //    each tx the primitive runs: one worker wins the occurrence INSERT
    //    (UNIQUE); the loser surfaces `already_exists` via the primitive's
    //    UNIQUE-collision branch. A CAS-loss (different-scheduledFor
    //    concurrent winner) throws the `ScheduledOccurrenceAdvanceLostRace`
    //    sentinel inside the tx → the wrapper's catch rolls back + maps to
    //    `lost_race`. The worker never sees the sentinel directly.
    const result = reserveScheduledOccurrence({ scheduleId, nextRunAt, now, scheduledFor }, db);

    if (result.outcome === "created" || result.outcome === "already_exists") {
      message = {
        type: "RESULT",
        outcome: result.outcome,
        occurrenceId: result.occurrence.id,
      };
    } else {
      // lost_race | rejected — no occurrence row to report.
      message = {
        type: "RESULT",
        outcome: result.outcome,
        occurrenceId: null,
      };
    }
  } catch (err) {
    // Diagnostic: capture the full error shape (drizzle wraps better-sqlite3;
    // the real code/message lives on `.cause`). Post-fix this branch is
    // unreachable under normal SQLITE_BUSY contention — the wrapper's
    // `BEGIN IMMEDIATE` serializes via `busy_timeout`. A genuine
    // infrastructure failure (e.g. disk I/O on exfat) still surfaces here.
    const e = err as Error & { code?: string; cause?: Error & { code?: string } };
    message = {
      type: "ERROR",
      message:
        `name=${e?.name} msg=${e?.message} code=${e?.code ?? "<none>"} | ` +
        `cause.name=${e?.cause?.name} cause.msg=${e?.cause?.message} cause.code=${e?.cause?.code ?? "<none>"}`,
    };
  } finally {
    try {
      sqlite.close();
    } catch {
      // ignore — already closed
    }
    if (send) send(message);
  }
}

main().catch((err) => {
  if (send) send({ type: "ERROR", message: `worker top-level: ${String(err)}` });
  try {
    process.exit(1);
  } catch {
    // ignore
  }
});
