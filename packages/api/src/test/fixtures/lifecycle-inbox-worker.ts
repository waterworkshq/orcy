/**
 * Automation inbox consumer worker for the REAL cross-process lease/fence
 * contention test (`automationInboxFencing.test.ts`).
 *
 * Forked (one or two OS processes) with `initDb(dbPath)` so production
 * `getDb()` resolves to THIS process's own better-sqlite3 connection — two
 * connections on one event loop serialize by construction, which would be a
 * serial substitute, not a real race (the occurrence-worker /
 * lifecycle-route precedents).
 *
 * Run via `child_process.fork(..., { execArgv: ["--import", "tsx"] })`.
 *
 * # Protocol (IPC)
 *
 *   INIT              → initDb(dbPath)                       → READY
 *   DRAIN {now}       → drainAutomationInbox({now})          → DRAIN_REPORT {report}
 *   LEASE {deliveryId, ttlMs, now}
 *                     → leaseDelivery (owner "stale-worker")  → LEASED {acquired, fence}
 *   FINALIZE {deliveryId, fence, now}
 *                     → transitionLeasedDelivery(terminal)   → FINALIZED {ok}
 *   PROVE {deliveryId, fence, actionIndex, actionKey, now}
 *                     → ensureCheckpointRow + fenced outcome  → PROVED {ok}
 *
 * Usage: forked with argv `[dbPath]`.
 */
export {}; // module scope (top-level imports are deferred to main() by design)

const [dbPath] = process.argv.slice(2);

const send = typeof process.send === "function" ? process.send.bind(process) : null;

interface Message {
  type: "READY" | "DRAIN_REPORT" | "LEASED" | "FINALIZED" | "PROVED" | "ERROR";
  [key: string]: unknown;
}

async function main(): Promise<void> {
  let message: Message = {
    type: "ERROR",
    message: "worker: unreachable — main() did not produce a message",
  };

  const { initDb, closeDb } = await import("../../db/index.js");
  const { drainAutomationInbox } = await import("../../services/automationInboxService.js");
  const deliveryRepo = await import("../../repositories/automationRuleDelivery.js");

  try {
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

    await awaitMessage("INIT");
    await initDb(dbPath);
    if (send) send({ type: "READY" });

    for (;;) {
      const msg = (await awaitMessage("DRAIN", "LEASE", "FINALIZE", "PROVE", "DONE")) as {
        type: string;
        now?: string;
        leaseTtlMs?: number;
        deliveryId?: string;
        ttlMs?: number;
        fence?: string;
        actionIndex?: number;
        actionKey?: string;
      };

      if (msg.type === "DRAIN") {
        const report = await drainAutomationInbox({
          now: msg.now,
          leaseTtlMs: msg.leaseTtlMs,
          leaseOwner: `worker:${process.pid}`,
        });
        if (send) send({ type: "DRAIN_REPORT", report: JSON.parse(JSON.stringify(report)) });
        continue;
      }

      if (msg.type === "DONE") {
        message = { type: "READY", note: "done" };
        break;
      }

      if (msg.type === "LEASE") {
        const lease = deliveryRepo.leaseDelivery({
          deliveryId: msg.deliveryId!,
          leaseOwner: `stale-worker:${process.pid}`,
          now: msg.now!,
          ttlMs: msg.ttlMs ?? 60_000,
        });
        if (send) {
          send({
            type: "LEASED",
            acquired: lease.acquired,
            fence: lease.fence,
            deliveryId: msg.deliveryId,
          });
        }
        continue;
      }

      if (msg.type === "FINALIZE") {
        // A stale worker attempting to terminalize with its (superseded) fence.
        const ok = deliveryRepo.transitionLeasedDelivery({
          deliveryId: msg.deliveryId!,
          fence: msg.fence!,
          targetState: "terminal",
          terminalDisposition: "stale-worker-claim",
          now: msg.now!,
        });
        if (send) send({ type: "FINALIZED", ok });
        continue;
      }

      if (msg.type === "PROVE") {
        const checkpoint = deliveryRepo.ensureCheckpointRow({
          deliveryId: msg.deliveryId!,
          actionIndex: msg.actionIndex!,
          actionKey: msg.actionKey!,
          actionType: "notify",
          now: msg.now!,
        });
        const ok = deliveryRepo.recordCheckpointOutcome({
          checkpointId: checkpoint.id,
          deliveryId: msg.deliveryId!,
          fence: msg.fence!,
          state: "proved",
          receipt: { forged: true },
          now: msg.now!,
        });
        if (send) send({ type: "PROVED", ok });
        continue;
      }
    }
  } catch (err) {
    const e = err as Error & { cause?: Error };
    message = {
      type: "ERROR",
      message: `name=${e?.name} msg=${e?.message} | cause=${e?.cause?.message ?? "<none>"}`,
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
