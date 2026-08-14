/**
 * Release epoch RECONCILIATION worker for the REAL cross-process frozen-cap
 * race test (`releaseEpochWorkerRace.test.ts`).
 *
 * Forked (two OS processes) with its OWN better-sqlite3 file connection —
 * two connections on one event loop serialize by construction, which would
 * be a serial substitute, not a real race (the lifecycle-activate-worker /
 * occurrence-worker precedents).
 *
 * Each worker is FORCED to select a different (overlapping) group subset via
 * `reconcileActivationGroups(releaseId, { onlyMissionIds })`, so neither is
 * a pure duplicate of the other and the shared group genuinely contends.
 * Every group transaction rereads the used capacity under `BEGIN IMMEDIATE`,
 * so the losers of the interleaving must defer against the frozen cap — the
 * cumulative activated Finding count can never exceed it.
 *
 * # Protocol (IPC)
 *
 *   1. WORKER: dynamic-imports the reconciler so the module graph is loaded
 *      BEFORE the race window; emits `{ type: "READY" }`.
 *   2. PARENT: waits for BOTH workers' READY, then sends `{ type: "GO" }` to
 *      each back-to-back.
 *   3. WORKER: on GO, reconciles its forced subset on its own client; the
 *      per-group wrapper owns BEGIN IMMEDIATE + COMMIT/ROLLBACK.
 *   4. WORKER: emits `{ type: "RESULT", outcomes }`, then waits for
 *      `{ type: "FINALIZE" }` to run the final locked completeness pass, and
 *      emits `{ type: "FINALIZED" }`.
 *   5. WORKER: closes its connection in `finally`.
 *
 * Usage: forked with argv `[dbPath, releaseId, missionIdsJson]`.
 */
import Database from "better-sqlite3";

const [dbPath, releaseId, missionIdsJson] = process.argv.slice(2);

const send = typeof process.send === "function" ? process.send.bind(process) : null;

interface ResultMessage {
  type: "RESULT" | "FINALIZED" | "ERROR";
  outcomes?: Array<{ missionId: string; disposition: string; detail: string | null }>;
  message?: string;
}

async function main(): Promise<void> {
  let message: ResultMessage = {
    type: "ERROR",
    message: "worker: unreachable — main() did not produce a message",
  };

  // Load the module graph before the connection opens so import time doesn't
  // skew the race window.
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const schemaModule = await import("../../db/schema/index.js");
  const { reconcileActivationGroups, finalizeActivationEpoch } =
    await import("../../services/releaseReconciliationService.js");

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

    // THE RACE — forced group subset on this process's own connection.
    const onlyMissionIds = JSON.parse(missionIdsJson) as string[];
    const outcomes = reconcileActivationGroups(releaseId, { onlyMissionIds }, db);
    if (send) send({ type: "RESULT", outcomes });

    await new Promise<void>((resolve) => {
      const onMessage = (msg: { type: string }): void => {
        if (msg?.type === "FINALIZE" || msg?.type === "DONE") {
          process.off("message", onMessage);
          resolve();
        }
      };
      process.on("message", onMessage);
    });

    finalizeActivationEpoch(releaseId, db);
    message = { type: "FINALIZED" };
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
