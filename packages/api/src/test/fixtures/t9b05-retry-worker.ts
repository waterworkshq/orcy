/**
 * T9B-05 — Retry worker for the REAL cross-process concurrency test.
 *
 * Forked twice (as TWO separate OS processes) by
 * `scheduledOccurrenceRepairConcurrency.test.ts` to produce genuine
 * overlapping write-lock contention on `repairScheduledOccurrence` for the
 * SAME rejected occurrence. Two synchronous better-sqlite3 connections on
 * ONE event loop serialize by construction — that would be a serial
 * substitute, not real overlap (the f4BusyTimeout precedent + MEMORY.md §
 * Migration Plumbing + the T9A-11 pattern this mirrors). Each worker is its
 * OWN process here, opening its OWN better-sqlite3 file connection via
 * `initDb`; SQLite's file-level write lock serializes them at the OS level.
 *
 * # The race under test (T9B-05)
 *
 * Two operators concurrently retry the SAME rejected occurrence. Both read
 * `retryHistory.length = N` → both derive `retryNumber = N+1` → both try to
 * reserve the coordination attempt under the SAME retryNumber-scoped key
 * (`occurrence-retry-${retryNumber}-coordination`). The UNIQUE index on
 * `(source, sourceScopeKind, sourceScopeId, attemptKey)` guarantees ONE
 * winner (`created`) + ONE loser (`replayed`). Pre-T9B-05 the loser proceeded
 * to the publish path + hit `PublicationCheckpointConsistencyError` (a 500).
 * Post-T9B-05 the loser gets a TYPED outcome (`retry_in_progress` / etc.).
 *
 * # Protocol (IPC) — mirrors the T9A-11 worker
 *
 *   1. WORKER: dynamic-imports + calls `initDb(dbPath)` to set up ITS global
 *      DB connection (the retry uses `getDb()` internally).
 *   2. WORKER: emits `{ type: "READY" }`.
 *   3. PARENT: waits for BOTH workers' READY, then sends `{ type: "GO" }`.
 *   4. WORKER: on GO, calls `repairScheduledOccurrence({ occurrenceId, actorId })`.
 *   5. WORKER: emits the typed outcome (or `{ type: "ERROR" }`).
 *   6. WORKER: closes its connection in `finally` BEFORE the RESULT message.
 *
 * Usage: forked with argv `[dbPath, occurrenceId, actorId]`.
 */
const [dbPath, occurrenceId, actorId] = process.argv.slice(2);

const send = typeof process.send === "function" ? process.send.bind(process) : null;

interface ResultMessage {
  type: "RESULT";
  outcome: string;
  retryNumber: number | null;
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

  // Load the module graph BEFORE the race window (no import-time skew).
  const { initDb, closeDb } = await import("../../db/index.js");
  const { repairScheduledOccurrence } = await import("../../services/scheduledOccurrenceRepair.js");

  // Open the worker's OWN connection via initDb (the retry uses getDb()
  // internally — initDb sets the global connection). The parent already
  // applied migrations; re-running them is idempotent (drizzle tracks the
  // migration ledger).
  await initDb(dbPath);

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

    // 3. THE RACE: call repairScheduledOccurrence. The coordination attempt's
    //    UNIQUE index defends — one worker wins (`created`), the other gets
    //    `replayed` → a typed outcome (NOT the 500).
    const result = repairScheduledOccurrence({ occurrenceId, actorId });

    message = {
      type: "RESULT",
      outcome: result.outcome,
      retryNumber: "retryNumber" in result ? result.retryNumber : null,
    };
  } catch (err) {
    const e = err as Error & { code?: string };
    message = {
      type: "ERROR",
      message: `name=${e?.name} msg=${e?.message} code=${e?.code ?? "<none>"}`,
    };
  } finally {
    try {
      closeDb();
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
