/**
 * T9B-01 — Recovery worker for the cross-process unique-identity fencing test.
 *
 * Forked ONCE (as a separate OS process) by
 * `scheduledOccurrenceRecoveryFencing.test.ts` to prove
 * `createRecoveryWorkerId()` generates a process-distinct id (the
 * multi-instance fencing fix). The worker:
 *
 *   1. Opens its OWN raw better-sqlite3 file connection (mirrors
 *      `t9a11-reservation-worker.ts` — NOT via `initDb`; the parent already
 *      applied migrations).
 *   2. Calls `createRecoveryWorkerId()` to mint its unique-per-process id.
 *   3. Calls `reacquireExpiredOccurrenceLeaseWithClient(db, occId, {
 *      leaseOwner: <worker id>, leaseExpiresAt: PAST })` — reclaims the
 *      expired-lease occurrence under the worker's id. The past expiry
 *      ensures the PARENT's subsequent reclaim (using the wall clock as
 *      `now`) sees the lease as expired again immediately (no wall-clock
 *      wait).
 *   4. Reports `{ id, pid, reclaimOutcome, leaseOwnerOnRow }` back.
 *
 * The parent then advances no time (the worker set a past expiry) +
 * reclaims under ITS OWN `createRecoveryWorkerId()` id (becomes the new
 * owner) + attempts `markOccurrenceRejectedWithClient` with the WORKER's
 * (now stale) id → `not_owner`. The fencing CAS distinguishes them via the
 * distinct ids.
 *
 * Run via `child_process.fork(..., { execArgv: ["--import", "tsx"] })` so
 * the TS source loads at runtime (mirrors `t9a11-reservation-worker.ts`).
 *
 * Usage: forked with argv `[dbPath, occurrenceId]`.
 */
import Database from "better-sqlite3";

const [dbPath, occurrenceId] = process.argv.slice(2);

const send = typeof process.send === "function" ? process.send.bind(process) : null;

interface ResultMessage {
  type: "RESULT";
  /** The worker's minted recovery-worker id (process-distinct). */
  id: string;
  /** The worker's OS pid (asserted distinct from the parent's). */
  pid: number;
  /** The reclaim primitive's outcome (`reclaimed` = this worker won the CAS). */
  reclaimOutcome: string;
  /** The occurrence's `leaseOwner` AFTER the worker's reclaim (verifies the id landed). */
  leaseOwnerOnRow: string | null;
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

  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const schemaModule = await import("../../db/schema/index.js");
  const { reacquireExpiredOccurrenceLeaseWithClient } =
    await import("../../repositories/scheduledOccurrences.js");
  const { createRecoveryWorkerId } = await import("../../services/scheduledOccurrenceRecovery.js");

  // Open the worker's OWN raw better-sqlite3 connection (mirrors
  // t9a11-reservation-worker.ts).
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema: schemaModule });

  try {
    // 1. Mint the worker's unique-per-process id (T9B-01).
    const workerId = createRecoveryWorkerId();

    // 2. Reclaim the expired-lease occurrence under the worker's id. The
    //    past `leaseExpiresAt` ensures the parent's subsequent reclaim
    //    (using wall-clock `now`) succeeds immediately.
    const result = reacquireExpiredOccurrenceLeaseWithClient(db, occurrenceId, {
      leaseOwner: workerId,
      leaseExpiresAt: "2020-01-01T00:00:00.000Z", // past — immediate re-expiry.
    });

    message = {
      type: "RESULT",
      id: workerId,
      pid: process.pid,
      reclaimOutcome: result.outcome,
      leaseOwnerOnRow:
        result.outcome === "reclaimed" || result.outcome === "not_expired"
          ? result.occurrence.leaseOwner
          : result.outcome === "illegal_source_state"
            ? result.occurrence.leaseOwner
            : null,
    };
  } catch (err) {
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
