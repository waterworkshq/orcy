/**
 * Human task-metadata overlap worker for the REAL cross-process contention
 * test (`humanTaskMetadataConcurrency.test.ts`).
 *
 * ONE fixture, forked TWICE per case: a holder and a saver. better-sqlite3 is
 * synchronous — a save on the parent's event loop would block the parent for
 * the whole busy_timeout (db/index.ts:294), so the parent could never send
 * RELEASE; the waiting save must live in its own OS process
 * (the `findingTriageLifecycleConcurrency.test.ts` IPC pattern, WITHOUT its
 * TEST_ONLY_SKIP_IN_TX_AUTHORITY bypass — the saver exercises real persisted
 * authority).
 *
 * Run via `child_process.fork(..., { execArgv: ["--import", "tsx"] })`.
 *
 * # Protocol (IPC) — argv: [dbPath, taskId, userId]
 *
 *   1. WORKER: dynamic-imports the module graph BEFORE signaling READY (no
 *      import-time skew inside the overlap window).
 *   2. PARENT -> { type: "SHORT_TIMEOUT" }: flags `PRAGMA busy_timeout = 300`
 *      for this worker's connection (applied when the DB opens, before any
 *      HOLD/SAVE — case f's bounded-wait probe).
 *   3. HOLDER on { type: "HOLD" }: initDb(dbPath); BEGIN IMMEDIATE; sends
 *      { type: "HELD" } — a real held write reservation.
 *   4. PARENT: waits HELD, then sends SAVE to the SAVER; the SAVER sends
 *      { type: "SAVING" } BEFORE its BEGIN (pre-BEGIN ack: the save is
 *      launched against the open hold), runs the production core
 *      `saveTaskMetadataWithClient` on its OWN connection (its BEGIN
 *      IMMEDIATE blocks on the holder's reservation), and sends
 *      { type: "RESULT", result } with outcome codes only.
 *   5. PARENT: waits SAVING, then sends { type: "RELEASE", payload } to the
 *      HOLDER; the holder executes the payload's write INSIDE the still-open
 *      reservation, COMMITs, and sends { type: "RELEASED" } — never RELEASED
 *      before commit; on error ROLLBACK + { type: "WORKER_ERROR" }.
 *
 * The core cannot be called from the holder for the raw-SQL save-equivalent:
 * BEGIN IMMEDIATE inside the holder's open transaction throws "cannot start a
 * transaction within a transaction" — so the payload performs the same
 * UPDATE + `task_events` insert via `createEventWithClient` directly.
 */
import { eq, sql } from "drizzle-orm";

const [dbPath, taskId, userId] = process.argv.slice(2);

const send = typeof process.send === "function" ? process.send.bind(process) : null;

/** The write the holder commits inside its still-open reservation (per case). */
interface ReleasePayload {
  kind: "none" | "mission_title" | "raw_save" | "membership_revoke" | "claim" | "mission_archive";
  missionId?: string;
  teamId?: string;
  agentId?: string;
  title?: string;
}

interface SaveInput {
  expectedVersion: number;
  expectedTaskIdentity: string;
  title?: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "critical";
  expectedPriority?: "low" | "medium" | "high" | "critical";
}

interface WorkerMessage {
  type: "READY" | "SHORT_TIMEOUT" | "HOLD" | "SAVE" | "RELEASE";
  input?: SaveInput;
  payload?: ReleasePayload;
}

async function main(): Promise<void> {
  // Load the module graph before the connection opens so import time cannot
  // skew the overlap window.
  const dbModule = await import("../../db/index.js");
  const schema = await import("../../db/schema/index.js");
  const { saveTaskMetadataWithClient } = await import("../../services/tasks/humanTaskMetadata.js");
  const { createEventWithClient } = await import("../../repositories/events/event-crud.js");
  const { removeMember } = await import("../../repositories/teamMember.js");

  let opened = false;
  let shortTimeout = false;

  const ensureDb = async () => {
    if (opened) return;
    await dbModule.initDb(dbPath); // migrations already applied by the parent — read-only boot
    if (shortTimeout) dbModule.getDb().run(sql`PRAGMA busy_timeout = 300`);
    opened = true;
  };

  /** Executes the case's write on the holder's connection, inside the open reservation. */
  const applyPayload = (payload: ReleasePayload): void => {
    const db = dbModule.getDb();
    if (payload.kind === "none") return;
    if (payload.kind === "mission_title") {
      // A non-Task write: must not affect the waiting save's fences.
      db.update(schema.missions)
        .set({ title: payload.title! })
        .where(eq(schema.missions.id, payload.missionId!))
        .run();
      return;
    }
    if (payload.kind === "raw_save") {
      // Save-equivalent the core cannot express from inside a transaction:
      // the same UPDATE the core issues plus the same `task_events` insert
      // createEventWithClient performs (human actor, pending->pending,
      // changedFields).
      const now = new Date().toISOString();
      db.update(schema.tasks)
        .set({ title: payload.title!, updatedAt: now, version: sql`${schema.tasks.version} + 1` })
        .where(eq(schema.tasks.id, taskId))
        .run();
      createEventWithClient(db, {
        taskId,
        actorType: "human",
        actorId: userId,
        action: "updated",
        fromStatus: "pending",
        toStatus: "pending",
        metadata: { changedFields: ["title"] },
      });
      return;
    }
    if (payload.kind === "membership_revoke") {
      removeMember(payload.teamId!, userId, db); // authority write; task row untouched
      return;
    }
    if (payload.kind === "claim") {
      db.update(schema.tasks)
        .set({ assignedAgentId: payload.agentId!, status: "claimed" })
        .where(eq(schema.tasks.id, taskId))
        .run();
      return;
    }
    // mission_archive
    db.update(schema.missions)
      .set({ isArchived: true })
      .where(eq(schema.missions.id, payload.missionId!))
      .run();
  };

  const fail = (stage: string, err: unknown): void => {
    const e = err as Error & { code?: string; cause?: Error & { code?: string } };
    if (send) {
      send({
        type: "WORKER_ERROR",
        message:
          `stage=${stage} name=${e?.name} msg=${e?.message} code=${e?.code ?? "<none>"} | ` +
          `cause.msg=${e?.cause?.message} cause.code=${e?.cause?.code ?? "<none>"}`,
      });
    }
  };

  process.on("message", (msg: WorkerMessage) => {
    if (msg?.type === "SHORT_TIMEOUT") {
      shortTimeout = true;
      return;
    }
    if (msg?.type === "HOLD") {
      void (async () => {
        try {
          await ensureDb();
          dbModule.getDb().run(sql`BEGIN IMMEDIATE`); // REAL held write reservation
          if (send) send({ type: "HELD" });
        } catch (err) {
          try {
            dbModule.getDb().run(sql`ROLLBACK`);
          } catch {
            // nothing was held
          }
          fail("HOLD", err);
        }
      })();
      return;
    }
    if (msg?.type === "RELEASE") {
      try {
        applyPayload(msg.payload!);
        dbModule.getDb().run(sql`COMMIT`); // RELEASED only after a successful commit
        if (send) send({ type: "RELEASED" });
      } catch (err) {
        try {
          dbModule.getDb().run(sql`ROLLBACK`);
        } catch {
          // already rolled back
        }
        fail("RELEASE", err);
      }
      return;
    }
    if (msg?.type === "SAVE") {
      void (async () => {
        try {
          await ensureDb();
          if (send) send({ type: "SAVING" }); // pre-BEGIN ack: the save is launched against the open hold
          const result = saveTaskMetadataWithClient(dbModule.getDb(), {
            taskId,
            userId,
            ...msg.input!,
          });
          // Outcome codes only — the Task row is not needed over IPC.
          const projected = result.ok
            ? { ok: true as const, changed: result.changed }
            : { ok: false as const, code: result.code, currentVersion: "currentVersion" in result ? result.currentVersion : undefined };
          if (send) send({ type: "RESULT", result: projected });
        } catch (err) {
          fail("SAVE", err);
        }
      })();
      return;
    }
  });

  if (send) send({ type: "READY" });
}

main().catch((err) => {
  if (send) send({ type: "WORKER_ERROR", message: `worker top-level: ${String(err)}` });
  try {
    process.exit(1);
  } catch {
    // ignore
  }
});
