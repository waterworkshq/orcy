/**
 * Structured-occurrence publication worker for the REAL cross-process
 * contention test.
 *
 * Forked TWICE (two OS processes) by `triageOccurrenceContention.test.ts` to
 * produce genuine overlapping write-lock contention on the SAME structured
 * occurrence. Two synchronous better-sqlite3 connections on ONE event loop
 * serialize by construction — that would be a serial substitute, not real
 * overlap (the f4BusyTimeout / t9a11 / lifecycle-route precedents). Each
 * worker is its OWN process and calls `initDb(dbPath)` so the production
 * `getDb()` singleton (used inside `prepareTemplateAggregate` /
 * `deriveClusterScope` / the freeze transaction) resolves to THIS process's
 * own connection.
 *
 * Run via `child_process.fork(..., { execArgv: ["--import", "tsx"] })`.
 *
 * # Protocol (IPC)
 *
 *   1. WORKER: dynamic-imports the intake modules BEFORE any DB work, then
 *      emits `{ type: "LOADED" }`.
 *   2. PARENT: staggers `INIT` (sequential `initDb` — the two connections
 *      must not run migration checks concurrently), awaiting each worker's
 *      `{ type: "READY" }`.
 *   3. PARENT: sends `OCCUR` to BOTH back-to-back — the REAL race. Both
 *      workers run the insert-or-read winner protocol (`BEGIN IMMEDIATE` +
 *      `INSERT ... ON CONFLICT DO NOTHING`) for the SAME occurrence.
 *      WORKER replies `{ type: "OCCURRED", fresh, occurrenceId, localMissionId,
 *      frozenMissionId }`.
 *   4. PARENT: sends `PUBLISH` to the LOSER first (it must publish the
 *      WINNER's frozen bytes), awaits its RESULT, then `PUBLISH` to the
 *      winner (expect attempt replay). WORKER replies
 *      `{ type: "RESULT", outcome, ... }`.
 *   5. `RACE` (alternative to 3+4): run the FULL intake immediately — used by
 *      the simultaneous-race test asserting one aggregate under real overlap.
 *
 * Usage: forked with argv `[dbPath, inputJson]` where inputJson is the
 * serialized `StructuredClusterIntakeInput` (habitatId/clusterKey/pulses/payload).
 */
import type { ClusterPayload } from "@orcy/shared";

const [dbPath, inputJson] = process.argv.slice(2);

const send = typeof process.send === "function" ? process.send.bind(process) : null;

interface Message {
  type: "LOADED" | "READY" | "OCCURRED" | "RESULT" | "ERROR";
  [key: string]: unknown;
}

async function main(): Promise<void> {
  let message: Message = {
    type: "ERROR",
    message: "worker: unreachable — main() did not produce a message",
  };

  // Load the module graph before the connection opens so import time doesn't
  // skew the race window.
  const { initDb, closeDb } = await import("../../db/index.js");
  const { intakeStructuredCluster, freezeOccurrenceForIntake } = await import(
    "../../services/triageOccurrencePublication.js"
  );
  const input = JSON.parse(inputJson) as {
    habitatId: string;
    clusterKey: string;
    pulses: Array<{ id: string; createdAt: string; findingKind: string }>;
    payload: ClusterPayload;
  };

  try {
    if (send) send({ type: "LOADED" });

    const awaitMessage = (...types: string[]): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        const onMessage = (msg: Record<string, unknown>): void => {
          if (types.includes(msg?.type as string)) {
            process.off("message", onMessage as never);
            resolve(msg);
          }
        };
        process.on("message", onMessage as never);
      });

    // Sequential init (parent staggers INIT between workers).
    await (awaitMessage("INIT") as Promise<{ type: string }>);
    await initDb(dbPath);
    if (send) send({ type: "READY" });

    // ---- Phase OCCUR: the insert-or-read winner race ----------------------
    const occurred = await awaitMessage("OCCUR", "RACE");
    if (occurred.type === "OCCUR") {
      const frozen = freezeOccurrenceForIntake(input);
      if (frozen.outcome !== "frozen") {
        message = { type: "ERROR", message: `freeze outcome: ${frozen.outcome}` };
        return;
      }
      if (send) send({ type: "OCCURRED", ...frozen.summary });

      // ---- Phase PUBLISH: full intake (freeze fast-path adopts the row) --
      await awaitMessage("PUBLISH");
      const result = intakeStructuredCluster(input);
      message = {
        type: "RESULT",
        ...result,
      } as Message;
      return;
    }

    // ---- Phase RACE: full intake immediately (simultaneous race) ----------
    const result = intakeStructuredCluster(input);
    message = { type: "RESULT", ...result } as Message;
  } catch (err) {
    // Diagnostic: capture the full error shape (drizzle wraps better-sqlite3;
    // the real code/message lives on `.cause`). Includes the known clean
    // race-rollback signatures (mission UNIQUE / checkpoint consistency).
    const e = err as Error & { code?: string; cause?: Error & { code?: string } };
    message = {
      type: "ERROR",
      message:
        `name=${e?.name} msg=${e?.message} code=${e?.code ?? "<none>"} | ` +
        `cause.name=${e?.cause?.name} cause.msg=${e?.cause?.message} cause.code=${e?.cause?.code ?? "<none>"}`,
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
