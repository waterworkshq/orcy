/**
 * Rework continuation — S-6 contention worker fixture (forked OS process).
 *
 * Modes (argv after dbPath):
 *   start <taskId> <agentId> <token|->
 *     — READY, then on GO: the REAL service-path rework start with the given
 *       expected execution token. Reports:
 *         { kind: "ok" }               — start landed (Task returned)
 *         { kind: "epoch_mismatch" }   — typed epoch refusal
 *         { kind: "refused" }          — any other null-refusal
 *         { kind: "error", message }   — unexpected throw
 *
 *   reject <taskId> <reviewerId> <reason>
 *     — READY, then on GO: the REAL service-path reject (human reviewer).
 *       Reports ok / refused identically.
 *
 *   terminal <sessionId> <failed|lost>
 *     — READY, then on GO: the REAL monotonic daemon session terminal write.
 *       Reports ok / refused (refused = still-active write refused by the
 *       fence — should not happen) / error.
 *
 * Run via `child_process.fork(..., { execArgv: ["--import", "tsx"] })` — the
 * child imports live source against a real better-sqlite3 file DB (initDb).
 */
import { initDb, closeDb } from "../../db/index.js";
import * as taskService from "../../services/tasks/index.js";
import * as daemonRepo from "../../repositories/daemon.js";
import type { SessionStatus } from "@orcy/shared/types";
import type { Task } from "../../models/index.js";

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
      case "start": {
        const [taskId, agentId, token] = args;
        const t = token === "-" ? null : token!;
        const task: Task | null = taskService.startTask(taskId!, agentId!, t);
        const out =
          task !== null && task !== undefined
            ? { kind: "ok", status: task.status, token: task.executionToken ?? null }
            : { kind: "refused" };
        done(out);
        break;
      }
      case "reject": {
        const [taskId, reviewerId, reason] = args;
        const task: Task | null = taskService.rejectTask(taskId!, reviewerId!, reason!);
        done(task ? { kind: "ok", status: task.status } : { kind: "refused" });
        break;
      }
      case "terminal": {
        const [sessionId, status] = args;
        const updated = daemonRepo.updateSessionStatus(sessionId!, status as SessionStatus);
        done(updated ? { kind: "ok", status: updated.status } : { kind: "refused" });
        break;
      }
      default:
        done({ kind: "error", message: `unknown-mode:${mode}` });
    }
  } catch (err) {
    const { ExecutionEpochMismatchError } = await import("../../errors.js");
    if (err instanceof ExecutionEpochMismatchError) {
      done({ kind: "epoch_mismatch" });
    } else {
      done({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    closeDb();
    process.exit(0);
  }
}

void main();
