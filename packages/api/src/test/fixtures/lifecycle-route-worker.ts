/**
 * Lifecycle route worker for the REAL cross-process concurrency test.
 *
 * Forked TWICE (as two separate OS processes) by
 * `findingTriageLifecycleConcurrency.test.ts` to produce genuine overlapping
 * write-lock contention on `routeFinding` for the SAME finding. Two
 * synchronous better-sqlite3 connections on ONE event loop serialize by
 * construction — that would be a serial substitute, not real overlap
 * (the f4BusyTimeout + t9a11 precedents). Each worker is its OWN process,
 * opening its OWN better-sqlite3 file connection; SQLite's file-level write
 * lock serializes them at the OS level.
 *
 * Run via `child_process.fork(..., { execArgv: ["--import", "tsx"] })` so
 * the TS source loads at runtime.
 *
 * # Protocol (IPC)
 *
 *   1. WORKER: dynamic-imports `routeFinding` so the module graph is loaded
 *      BEFORE the race window (no import-time skew).
 *   2. WORKER: emits `{ type: "READY" }`.
 *   3. PARENT: waits for BOTH workers' READY, then sends `{ type: "GO" }` to
 *      each back-to-back (as simultaneous as the event loop allows).
 *   4. WORKER: on GO, calls `routeFinding(input, db)` — the wrapper owns
 *      BEGIN IMMEDIATE + COMMIT/ROLLBACK + the typed busy mapping. The
 *      loser's BEGIN IMMEDIATE BLOCKS (busy_timeout = 5000 in effect) until
 *      the winner commits, then proceeds and classifies against the winner's
 *      committed state (replayed via stored fingerprint, or conflict).
 *   5. WORKER: closes its connection in `finally` BEFORE the RESULT message.
 *
 * Usage: forked with argv `[dbPath, findingId, routeJson]`.
 */
import Database from "better-sqlite3";

const [dbPath, findingId, routeJson] = process.argv.slice(2);

const send = typeof process.send === "function" ? process.send.bind(process) : null;

interface ResultMessage {
  type: "RESULT";
  outcome: string;
  reason?: string;
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

  // Load the module graph before the connection opens so import time doesn't
  // skew the race window.
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const schemaModule = await import("../../db/schema/index.js");
  const { routeFinding } = await import("../../services/findingTriageLifecycle.js");

  // Open the worker's OWN raw better-sqlite3 connection (NOT via `initDb` —
  // the parent already applied migrations; re-running them concurrently
  // risks WAL-checkpoint interference).
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  // The production pragma (5000ms) — the wrapper's `BEGIN IMMEDIATE` waits
  // (bounded) for the concurrent writer's lock + proceeds on release instead
  // of surfacing SQLITE_BUSY immediately.
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

    // 3. THE RACE: call the production command. Both workers race the SAME
    //    finding with the SAME route intent (same fingerprint). One applies;
    //    the loser's BEGIN IMMEDIATE waits for the winner's COMMIT, then
    //    classifies against committed state: replayed (stored fingerprint
    //    matches) or conflict. NEVER an unclassified SQLITE_BUSY 500.
    const route = JSON.parse(routeJson);
    const result = routeFinding(
      {
        findingId,
        actor: { type: "human", id: "concurrency-worker" },
        route,
      },
      db,
    );

    message = {
      type: "RESULT",
      outcome: result.outcome,
      reason: result.outcome === "conflict" ? result.reason : undefined,
    };
  } catch (err) {
    // Diagnostic: capture the full error shape (drizzle wraps better-sqlite3;
    // the real code/message lives on `.cause`). Under normal contention this
    // branch is UNREACHABLE — the wrapper's BEGIN IMMEDIATE serializes via
    // busy_timeout, and exhausted contention maps to typed `busy` BEFORE an
    // error can escape. A genuine infrastructure failure still surfaces here.
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
