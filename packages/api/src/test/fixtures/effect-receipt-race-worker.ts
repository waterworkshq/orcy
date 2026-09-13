/**
 * T2 — S-6 contention worker fixture (forked OS process).
 *
 * Modes (argv after dbPath):
 *   reserve <receiptId>       — READY, then on GO: one fenced reservation CAS.
 *   satisfy <gateId> <eventId> — READY, then on GO: guarded IMMEDIATE gate
 *                                satisfaction (advanceGates immediate:true).
 *   compose-stale             — READY, then on GO: dual-fenced composer with a
 *                                STALE attempt token against a re-driven run.
 *   owned-poll                — READY, then on GO: poll ownership vs event-row
 *                                existence (scanner-delegation serializability).
 *
 * Run via `child_process.fork(..., { execArgv: ["--import", "tsx"] })` — the
 * child imports live source against a real better-sqlite3 file DB (initDb).
 */
import { initDb, getDb, closeDb } from "../../db/index.js";
import * as receiptRepo from "../../repositories/effectReceipts.js";
import { advanceGates } from "../../services/workflow/workflowGateAdvancer.js";
import { taskEvents } from "../../db/schema/index.js";
import { eq } from "drizzle-orm";

const [dbPath, mode, ...args] = process.argv.slice(2);
const send = typeof process.send === "function" ? process.send.bind(process) : null;

function done(payload: Record<string, unknown>): void {
  send?.({ type: "RESULT", ...payload });
}

async function main(): Promise<void> {
  await initDb(dbPath);
  const go = new Promise<void>((resolve) => {
    const onMessage = (msg: unknown): void => {
      if ((msg as { type?: string })?.type === "GO") {
        process.off("message", onMessage);
        resolve();
      }
    };
    process.on("message", onMessage);
  });
  send?.({ type: "READY" });
  await go;

  try {
    switch (mode) {
      case "reserve": {
        const [receiptId] = args;
        const r = receiptRepo.reserveReceipt(receiptId!, "race-worker", new Date().toISOString());
        done({ acquired: r.acquired, fence: r.fence, attempt: r.attempt });
        break;
      }
      case "satisfy": {
        const [gateId, eventId] = args;
        const db = getDb();
        const gate = db.select().from(require_gates()).where(eq(require_gates().id, gateId!)).get();
        if (!gate) {
          done({ error: "gate-missing" });
          break;
        }
        const results = advanceGates(
          [{ status: "satisfy", gate: gate as never }],
          {
            kind: "lifecycle",
            eventId: eventId!,
            action: "failed",
            actorType: "agent",
            actorId: "race",
          },
          { immediate: true },
        );
        done({ status: results[0]!.status });
        break;
      }
      case "compose-stale": {
        // Drive the PRODUCTION composer with a STALE attempt token against a
        // re-driven run row: the dual fence must reject (abort) — no marker,
        // no signals, target untouched.
        const { composeDetectorOutput } = await import("../../services/effects/effectDeliverer.js");
        const db0 = getDb();
        const targetRow = db0
          .select()
          .from(require_targets())
          .where(eq(require_targets().id, args[1]!))
          .get();
        if (!targetRow) {
          done({ error: "target-missing" });
          break;
        }
        const outcome = await composeDetectorOutput({
          signals: [{ subject: "stale", signalType: "detected" }],
          runId: args[0]!,
          runLeaseToken: "stale-token",
          runLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          targetId: args[1]!,
          targetFence: args[2]!,
          target: targetRow,
          now: new Date().toISOString(),
        });
        done({ aborted: outcome === "abort" });
        break;
      }
      case "owned-poll": {
        // Scanner-delegation serializability: poll until the failed event row
        // exists; every observation with the event row MUST also see the
        // ownership receipt (no unowned instant).
        const [taskId] = args;
        const deadline = Date.now() + 10_000;
        let observations = 0;
        let unownedWithEvent = 0;
        while (Date.now() < deadline) {
          const db = getDb();
          const events = db
            .select({ id: taskEvents.id })
            .from(taskEvents)
            .where(eq(taskEvents.taskId, taskId!))
            .all();
          observations++;
          for (const row of events) {
            if (!receiptRepo.isTaskEventReceiptOwned(row.id)) unownedWithEvent++;
          }
          if (events.length > 0) break;
        }
        done({ observations, unownedWithEvent });
        break;
      }
      default:
        done({ error: `unknown-mode:${mode}` });
    }
  } catch (err) {
    done({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    closeDb();
    process.exit(0);
  }
}

// Local require-shaped helpers keep the fixture import surface minimal.
import {
  taskWorkflowGates as _gates,
  pluginRuns as _runs,
  effectReceiptTargets as _targets,
} from "../../db/schema/index.js";
import { and as drizzleAnd } from "drizzle-orm";
function require_gates() {
  return _gates;
}
function require_runs() {
  return _runs;
}
function require_targets() {
  return _targets;
}
function require_drizzle_and(...conds: Parameters<typeof drizzleAnd>) {
  return drizzleAnd(...conds);
}

void main();
