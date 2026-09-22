/**
 * Stale-agent sweep — heartbeat-revival race worker (forked OS process).
 *
 * Modes (argv after dbPath):
 *   revive <agentId> <holdMs>
 *     READY → GO → open `BEGIN IMMEDIATE` on the file DB (takes the write
 *     lock), signal LOCKED, hold for holdMs, write a FRESH agent heartbeat
 *     (`agents.last_heartbeat` only — status and pointer untouched), COMMIT,
 *     RESULT ok.
 *   hold <agentId> <holdMs>
 *     Same lock protocol WITHOUT any write (the complementary ordering:
 *     nothing changes, the parent's blocked write proceeds once the lock
 *     releases).
 *   claim <agentId> <taskId> <holdMs>
 *     The F1 interleave: hold the lock, then RAW-claim the task for the
 *     agent inside the held tx (pending → claimed, assigned, E2 token —
 *     mirroring the claim authority's task writes while touching NOTHING in
 *     `agents`, exactly the commit→cleanup-gap re-claim shape), COMMIT.
 *
 * Run via `child_process.fork(..., { execArgv: ["--import", "tsx"] })` — the
 * child imports live source against a real better-sqlite3 file DB (initDb).
 */
import { sql } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../../db/index.js";

const [dbPath, mode, agentIdArg, thirdArg, holdMsArg] = process.argv.slice(2);
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
      db.run(
        sql`UPDATE agents SET last_heartbeat = ${new Date().toISOString()} WHERE id = ${agentIdArg}`,
      );
    }
    if (mode === "claim") {
      // F1 shape: the commit→cleanup-gap re-claim. Raw task writes inside
      // the held tx (claim-authority semantics for the columns the sweep
      // reads); the agents row is deliberately untouched.
      const now = new Date().toISOString();
      const res = db.run(
        sql`UPDATE tasks SET status = 'claimed', assigned_agent_id = ${agentIdArg}, execution_token = ${`e2-ipc-${now}`}, claimed_at = ${now}, updated_at = ${now}, version = version + 1 WHERE id = ${thirdArg} AND status = 'pending'`,
      );
      send?.({
        type: "CLAIM_RESULT",
        changed: (res as unknown as { changes?: number })?.changes ?? -1,
      });
    }
    db.run(sql`COMMIT`);
    done({ kind: "ok", wroteHeartbeat: mode === "revive", claimed: mode === "claim" });
  } catch (err) {
    done({ kind: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    closeDb();
    process.exit(0);
  }
}

void main();
