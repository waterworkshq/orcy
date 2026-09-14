/**
 * Epoch mutation guard — S-6 contention worker fixture (forked OS process).
 *
 * Modes (argv after dbPath):
 *   mutate <taskId> <agentId> <start|submit|fail|release> <token>
 *     — READY, then on GO: run the REAL service-path mutation with the given
 *       expected execution token. Reports:
 *         { kind: "ok" }                     — the mutation landed
 *         { kind: "epoch_mismatch" }         — the typed epoch refusal
 *         { kind: "refused" }                — any other null-refusal
 *         { kind: "error", message }         — unexpected throw
 *
 * Run via `child_process.fork(..., { execArgv: ["--import", "tsx"] })` — the
 * child imports live source against a real better-sqlite3 file DB (initDb).
 */
import { initDb, closeDb } from "../../db/index.js";
import * as taskService from "../../services/tasks/index.js";
import type { Task } from "../../models/index.js";
import { ExecutionEpochMismatchError } from "../../errors.js";
import * as taskRepo from "../../repositories/taskCrud.js";

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
      case "mutate": {
        const [taskId, agentId, mutation, token] = args;
        const t = token === "-" ? null : token!;
        let outcome: Task | null | { task: Task | null } = null;
        switch (mutation) {
          case "start":
            outcome = taskService.startTask(taskId!, agentId!, t);
            break;
          case "submit":
            outcome = taskService.submitTask(taskId!, agentId!, "ipc worker result", [], t);
            break;
          case "fail":
            outcome = taskService.failTask(taskId!, agentId!, "agent", "ipc worker failure", t);
            break;
          case "release":
            outcome = taskService.releaseTask(taskId!, agentId!, "ipc worker release", t);
            break;
          default:
            done({ kind: "error", message: `unknown-mutation:${mutation}` });
            return;
        }
        const landed =
          outcome === null || outcome === undefined
            ? false
            : Array.isArray((outcome as { artifacts?: unknown }).artifacts)
              ? true // a Task came back
              : (outcome as { task: Task | null }).task !== null &&
                (outcome as { task: Task | null }).task !== undefined;
        done({ kind: landed ? "ok" : "refused" });
        break;
      }
      default:
        done({ kind: "error", message: `unknown-mode:${mode}` });
    }
  } catch (err) {
    if (err instanceof ExecutionEpochMismatchError) {
      done({ kind: "epoch_mismatch" });
    } else {
      done({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    void taskRepo; // keep the import graph explicit for tsx resolution
    closeDb();
    process.exit(0);
  }
}

void main();
