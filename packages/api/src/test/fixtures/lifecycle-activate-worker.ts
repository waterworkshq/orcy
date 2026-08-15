/**
 * Lifecycle ACTIVATION worker for the REAL cross-process manual-vs-Release
 * race test (`findingTriageActivationConcurrency.test.ts`).
 *
 * Forked by the parent as its OWN OS process with its OWN better-sqlite3 file
 * connection (two synchronous connections on one event loop serialize by
 * construction — see `lifecycle-route-worker.ts` for the full rationale and
 * the f4BusyTimeout/t9a11 precedents).
 *
 * One worker runs MANUAL activation (`activateCorrectiveMission`, human actor
 * + expected Mission version); the other runs the INTERNAL Release-mode entry
 * (`activateCorrectiveMissionForRelease`, persisted Release identity + gate
 * proof). Both race the SAME finding on the SAME gated corrective Mission.
 * The kernel's `BEGIN IMMEDIATE` serializes them; the loser must converge to
 * a TYPED outcome (replayed/conflict/busy) — never an unclassified error.
 *
 * # Protocol (IPC)
 *
 *   1. WORKER: dynamic-imports the kernel so the module graph is loaded
 *      BEFORE the race window.
 *   2. WORKER: emits `{ type: "READY" }`.
 *   3. PARENT: waits for BOTH workers' READY, then sends `{ type: "GO" }` to
 *      each back-to-back.
 *   4. WORKER: on GO, runs its activation command against its own drizzle
 *      client; the wrapper owns BEGIN IMMEDIATE + COMMIT/ROLLBACK + typed
 *      busy mapping.
 *   5. WORKER: closes its connection in `finally` BEFORE the RESULT message.
 *
 * Usage: forked with argv `[dbPath, findingId, modeJson]` where modeJson is
 * either `{"kind":"manual","expectedMissionVersion":N}` or
 * `{"kind":"release","releaseId":"...","releaseGateType":"patch","releaseGateVersion":"..."}`.
 */
import Database from "better-sqlite3";

const [dbPath, findingId, modeJson] = process.argv.slice(2);

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
  const { activateCorrectiveMission, activateCorrectiveMissionForRelease, TEST_ONLY_SKIP_IN_TX_AUTHORITY } = await import(
    "../../services/findingTriageLifecycle.js"
  );

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema: schemaModule });

  try {
    if (send) send({ type: "READY" });

    await new Promise<void>((resolve) => {
      const onMessage = (msg: { type: string }): void => {
        if (msg?.type === "GO") {
          process.off("message", onMessage);
          resolve();
        }
      };
      process.on("message", onMessage);
    });

    // THE RACE.
    const mode = JSON.parse(modeJson) as
      | { kind: "manual"; expectedMissionVersion: number }
      | {
          kind: "release";
          releaseId: string;
          releaseGateType: "patch" | "minor" | "major";
          releaseGateVersion: string;
        };

    const result =
      mode.kind === "manual"
        ? activateCorrectiveMission(
            {
              findingId,
              actor: { type: "human", id: "concurrency-manual-worker", authority: TEST_ONLY_SKIP_IN_TX_AUTHORITY },
              expectedMissionVersion: mode.expectedMissionVersion,
            },
            db,
          )
        : activateCorrectiveMissionForRelease(
            {
              findingId,
              releaseId: mode.releaseId,
              gateProof: {
                releaseGateType: mode.releaseGateType,
                releaseGateVersion: mode.releaseGateVersion,
              },
            },
            db,
          );

    message = {
      type: "RESULT",
      outcome: result.outcome,
      reason: result.outcome === "conflict" ? result.reason : undefined,
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
