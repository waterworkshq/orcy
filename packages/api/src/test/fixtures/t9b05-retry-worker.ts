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
 * Each worker reports the retry number bound to its first real coordination
 * lookup and waits for a shared release file before executing that lookup.
 * This guarantees the contenders derived the same slot without replacing
 * any reads or writes or pausing inside a SQLite transaction.
 */
import { existsSync } from "node:fs";
import type { Database, Statement } from "better-sqlite3";

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

  const { initDb, closeDb, getDb } = await import("../../db/index.js");
  const { repairScheduledOccurrence } = await import("../../services/scheduledOccurrenceRepair.js");
  await initDb(dbPath);

  try {
    const sqlite = (getDb() as unknown as { $client: Database }).$client;
    const prepare = sqlite.prepare;
    let reachedBarrier = false;
    sqlite.prepare = ((source: string) => {
      const statement = prepare.call(sqlite, source) as Statement<unknown[]>;
      if (/^select\b/i.test(source) && source.includes('from "task_creation_attempts"') && source.includes('"attempt_key" = ?')) {
        const get = statement.get.bind(statement);
        statement.get = (...bindings: unknown[]) => {
          const key = bindings[3];
          const retry = typeof key === "string" ? /^occurrence-retry-(\d+)-coordination$/.exec(key) : null;
          if (!reachedBarrier && bindings[2] === occurrenceId && retry) {
            if (sqlite.inTransaction) throw new Error("Retry barrier must not hold a SQLite transaction");
            reachedBarrier = true;
            send?.({ type: "AT_RETRY", retryNumber: Number(retry[1]) });
            const deadline = Date.now() + 20_000;
            const sleeper = new Int32Array(new SharedArrayBuffer(4));
            while (!existsSync(`${dbPath}.retry-release`)) {
              if (Date.now() >= deadline) throw new Error("Timed out waiting for the retry barrier release");
              Atomics.wait(sleeper, 0, 0, 10);
            }
          }
          return get(...bindings);
        };
      }
      return statement;
    }) as typeof sqlite.prepare;

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
