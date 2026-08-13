/**
 * Worker fixture for the Learning Loop fresh-rerun concurrency test (LL-TEST-1).
 *
 * Forked twice as separate OS processes to prove that concurrent fresh-reruns
 * against the same habitat + policy allocate distinct, monotonically increasing
 * `rerun_generation` numbers via `behavior: "immediate"` transactions without
 * collisions, deadlocks, or `SQLITE_BUSY` crashes.
 *
 * Run via `child_process.fork(..., { execArgv: ["--import", "tsx"] })`.
 */
import { closeDb, getDb, initDb } from "../../db/index.js";
import { runExtraction } from "../../services/extractionRunLifecycle.js";
import { getPolicyByIdWithClient } from "../../repositories/extraction/index.js";

const [dbPath, habitatId, policyId, freshReason] = process.argv.slice(2);

const send = typeof process.send === "function" ? process.send.bind(process) : null;

interface ExtractionRerunResultMessage {
  type: "RESULT";
  outcome: string;
  rerunGeneration: number | null;
  workItemId: string | null;
  supersedesWorkId: string | null;
}

interface ExtractionRerunErrorMessage {
  type: "ERROR";
  message: string;
}

type WorkerMessage = ExtractionRerunResultMessage | ExtractionRerunErrorMessage;

async function runWorker(): Promise<void> {
  let message: WorkerMessage = {
    type: "ERROR",
    message: "worker: unreachable — main() did not produce a message",
  };

  process.env.ORCY_LEARNING_LOOP_ENABLED = "true";

  await initDb(dbPath);
  const db = getDb();
  const policy = getPolicyByIdWithClient(db, policyId);
  if (!policy) {
    throw new Error(`Worker could not find policy ${policyId}`);
  }

  try {
    // 1. Signal READY
    if (send) send({ type: "READY" });

    // 2. Wait for GO from parent
    await new Promise<void>((resolve) => {
      const onMessage = (msg: { type: string }): void => {
        if (msg?.type === "GO") {
          process.off("message", onMessage);
          resolve();
        }
      };
      process.on("message", onMessage);
    });

    // 3. Execute fresh-rerun
    const result = runExtraction({
      habitatId,
      policy,
      deliveryMode: "manual",
      actorType: "human",
      actorId: "u1",
      isFreshRerun: true,
      freshReason: freshReason || "concurrency test",
    });

    const workItem = "workItem" in result ? result.workItem : null;

    message = {
      type: "RESULT",
      outcome: result.kind,
      rerunGeneration: workItem?.rerunGeneration ?? null,
      workItemId: workItem?.id ?? null,
      supersedesWorkId: workItem?.supersedesWorkId ?? null,
    };
  } catch (err) {
    message = {
      type: "ERROR",
      message: (err as Error).stack ?? (err as Error).message,
    };
  } finally {
    closeDb();
    if (send) send(message);
  }
}

runWorker().catch((err) => {
  if (send) {
    send({
      type: "ERROR",
      message: `worker unhandled: ${(err as Error).stack ?? (err as Error).message}`,
    });
  }
  process.exit(1);
});

export {};
