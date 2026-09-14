/**
 * Daemon worker contract — heartbeat-revival race worker (forked OS process).
 *
 * Modes (argv after dbPath):
 *   revive <daemonId> <holdMs>
 *     READY → GO → open `BEGIN IMMEDIATE` on the file DB (takes the write
 *     lock), signal LOCKED, hold for holdMs, write a FRESH daemon heartbeat,
 *     COMMIT, RESULT ok. The parent's sweep runs while this worker holds the
 *     lock: its terminalization tx blocks, and — once the worker's heartbeat
 *     commits first — the in-tx freshness recheck must SPARE the session.
 *   hold <daemonId> <holdMs>
 *     Same lock protocol WITHOUT the heartbeat write (the complementary
 *     ordering: nothing revives, the parent terminalizes after the lock
 *     releases).
 *
 * Run via `child_process.fork(..., { execArgv: ["--import", "tsx"] })` — the
 * child imports live source against a real better-sqlite3 file DB (initDb).
 */
import { sql } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../../db/index.js";
import * as daemonRepo from "../../repositories/daemonInstance.js";

const [dbPath, mode, daemonIdArg, holdMsArg] = process.argv.slice(2);
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

  const holdMs = Number(holdMsArg ?? 500);
  try {
    const db = getDb();
    db.run(sql`BEGIN IMMEDIATE`);
    send?.({ type: "LOCKED" });
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    if (mode === "revive") {
      daemonRepo.updateDaemonHeartbeat(daemonIdArg!); // fresh in-tx heartbeat
    }
    db.run(sql`COMMIT`);
    done({ kind: "ok", wroteHeartbeat: mode === "revive" });
  } catch (err) {
    done({ kind: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    closeDb();
    process.exit(0);
  }
}

void main();
