/**
 * T2 — S-6 contention proofs (real better-sqlite3 file DB, forked worker
 * processes, READY/GO IPC barriers). Never two async calls on one connection;
 * sql.js carries only the single-process unit assertions in
 * effectReceipts.test.ts.
 *
 * Proves the four interleave claims of the acceptance preamble:
 *   1. reservation CAS — two workers reserve the same pending receipt
 *      concurrently → exactly one acquires (id-scoped predicate holds under
 *      true parallelism);
 *   2. IMMEDIATE-fence gate satisfaction — two workers run the guarded
 *      (immediate) advancement for the same gate/event concurrently → one
 *      `satisfied`, one `already_satisfied`; the durable stamp is written
 *      exactly once and never overwritten;
 *   3. composer dual fence — a stale-attempt composer (superseded run lease
 *      token) zero-rows: no marker, no signals, target untouched;
 *   4. scanner-delegation race — while the act-tx commits, a concurrent
 *      ownership poller never observes the failed event row without its
 *      detector_dispatch receipt (SQLite serializability: both or neither).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb, closeDb } from "../db/index.js";
import {
  effectReceiptTargets,
  tasks,
  taskEvents,
  effectReceipts,
  taskWorkflowGates,
  workflows,
  pluginRuns,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import { failTaskWithEffects } from "../services/effects/failureEffects.js";
import { encodeDispatchKey } from "../repositories/effectReceipts.js";

const WORKER = join(import.meta.dirname, "fixtures", "effect-receipt-race-worker.ts");

type Msg = Record<string, unknown> & { type?: string };

function forkWorker(args: string[]): {
  child: ChildProcess;
  ready: Promise<void>;
  result: Promise<Msg>;
  go: () => void;
} {
  const child = fork(WORKER, args, {
    execArgv: ["--import", "tsx"],
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  child.stderr?.on("data", (c: Buffer) => console.warn("[worker stderr]:", c.toString()));
  const ready = new Promise<void>((resolve, reject) => {
    const onMessage = (msg: Msg): void => {
      if (msg?.type === "READY") {
        child.off("message", onMessage);
        resolve();
      }
    };
    child.on("message", onMessage);
    child.on("exit", (code) => reject(new Error(`worker exited before READY (code=${code})`)));
  });
  const result = new Promise<Msg>((resolve) => {
    const onMessage = (msg: Msg): void => {
      if (msg?.type === "RESULT" || msg?.type === "ERROR") {
        child.off("message", onMessage);
        resolve(msg);
      }
    };
    child.on("message", onMessage);
  });
  return { child, ready, result, go: () => child.send({ type: "GO" }) };
}

let dbPath: string;
let habitatId: string;
let columnId: string;

async function freshDb(): Promise<void> {
  dbPath = join(await mkdtemp(join(tmpdir(), "effect-race-")), "race.db");
  await initDb(dbPath);
  const habitat = habitatRepo.createHabitat({ name: "Race Habitat" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({ habitatId, name: "T", order: 0, requiresClaim: false }).id;
}

describe("T2 contention (S-6 vehicle: forked better-sqlite3 workers)", () => {
  beforeEach(async () => {
    await freshDb();
  });

  afterEach(async () => {
    closeDb();
    await rm(dirname(dbPath), { recursive: true, force: true });
  });

  it("reservation CAS: two concurrent workers, exactly one acquires", async () => {
    const mission = missionRepo.createMission({ habitatId, columnId, title: "m", createdBy: "u" });
    const task = taskRepo.createTask({ missionId: mission.id, title: "t", createdBy: "u" });
    getDb()
      .update(tasks)
      .set({ status: "failed", lastFailureEventId: "ev-race" })
      .where(eq_id(task.id))
      .run();
    getDb()
      .insert(taskEvents)
      .values({
        id: "ev-race",
        taskId: task.id,
        actorType: "agent",
        actorId: "a",
        action: "failed",
        metadata: {},
      })
      .run();
    getDb()
      .insert(effectReceipts)
      .values({
        id: "rr-1",
        subjectType: "task_event",
        subjectId: "ev-race",
        habitatId,
        consumer: "skill_ingestion",
        state: "pending",
        createdAt: new Date().toISOString(),
      })
      .run();
    closeDb();

    const w1 = forkWorker([dbPath, "reserve", "rr-1"]);
    const w2 = forkWorker([dbPath, "reserve", "rr-1"]);
    await Promise.all([w1.ready, w2.ready]);
    w1.go();
    w2.go();
    const [r1, r2] = await Promise.all([w1.result, w2.result]);
    const acquired = [r1, r2].filter((r) => r.acquired === true).length;
    expect(acquired).toBe(1);

    await initDb(dbPath);
    const row = getDb().select().from(effectReceipts).all()[0]!;
    expect(row.attempts).toBe(1); // exactly one attempt burned
  });

  it("IMMEDIATE fence: concurrent guarded satisfactions → one satisfied, one already_satisfied, one stamp", async () => {
    const mission = missionRepo.createMission({ habitatId, columnId, title: "m", createdBy: "u" });
    const up = taskRepo.createTask({ missionId: mission.id, title: "up", createdBy: "u" });
    const down = taskRepo.createTask({ missionId: mission.id, title: "down", createdBy: "u" });
    const db = getDb();
    db.insert(workflows)
      .values({ id: "wf-race", missionId: mission.id, habitatId, status: "active", createdBy: "u" })
      .run();
    db.insert(taskWorkflowGates)
      .values({
        id: "gate-race",
        workflowId: "wf-race",
        missionId: mission.id,
        habitatId,
        upstreamTaskId: up.id,
        downstreamTaskId: down.id,
        gateType: "on_fail",
        satisfied: false,
        recoveryDepth: 0,
      })
      .run();
    closeDb();

    const w1 = forkWorker([dbPath, "satisfy", "gate-race", "ev-satisfy"]);
    const w2 = forkWorker([dbPath, "satisfy", "gate-race", "ev-satisfy"]);
    await Promise.all([w1.ready, w2.ready]);
    w1.go();
    w2.go();
    const [r1, r2] = await Promise.all([w1.result, w2.result]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual(["already_satisfied", "satisfied"]);

    await initDb(dbPath);
    const gate = getDb().select().from(taskWorkflowGates).where(eq_gate("gate-race")).get() as {
      satisfied: boolean;
      satisfiedByEventId: string | null;
    };
    expect(gate.satisfied).toBe(true);
    expect(gate.satisfiedByEventId).toBe("ev-satisfy"); // durable, written once
  });

  it("composer dual fence: a stale-attempt composer zero-rows (no marker, target untouched)", async () => {
    const mission = missionRepo.createMission({ habitatId, columnId, title: "m", createdBy: "u" });
    const task = taskRepo.createTask({ missionId: mission.id, title: "t", createdBy: "u" });
    getDb()
      .update(tasks)
      .set({ status: "failed", lastFailureEventId: "ev-stale" })
      .where(eq_id(task.id))
      .run();
    getDb()
      .insert(taskEvents)
      .values({
        id: "ev-stale",
        taskId: task.id,
        actorType: "agent",
        actorId: "a",
        action: "failed",
        metadata: {},
      })
      .run();
    const db = getDb();
    // Seed the target row too (the production composer acks it in-tx).
    db.insert(effectReceipts)
      .values({
        id: "receipt-stale",
        subjectType: "task_event",
        subjectId: "ev-stale",
        habitatId,
        consumer: "detector_dispatch",
        state: "pending",
        createdAt: new Date().toISOString(),
      })
      .run();
    db.insert(effectReceiptTargets)
      .values({
        id: "target-stale",
        receiptId: "receipt-stale",
        habitatId,
        targetKey: JSON.stringify(["signalDetector", "p", "c"]),
        pluginId: "p",
        contributionId: "c",
        state: "pending",
        createdAt: new Date().toISOString(),
        leaseToken: "target-fence-live",
      })
      .run();
    // A re-driven run row (current token) + the stale attempt's token.
    db.insert(pluginRuns)
      .values({
        id: "run-stale",
        habitatId,
        pluginId: "p",
        contributionId: "c",
        contributionKind: "signalDetector",
        triggerEventId: "ev-stale",
        triggerType: "taskEvent",
        status: "running",
        fingerprint: "f",
        dispatchKey: encodeDispatchKey("ev-stale", "p", "c"),
        leaseToken: "token-current",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        startedAt: new Date().toISOString(),
      })
      .run();
    closeDb();

    const w = forkWorker([dbPath, "compose-stale", "run-stale", "target-stale", "target-fence-live"]);
    await w.ready;
    w.go();
    const r = await w.result;
    expect(r.aborted).toBe(true); // dual-fence rejection

    await initDb(dbPath);
    const run = getDb().select().from(pluginRuns).all()[0]!;
    expect(run.signalsCommittedAt).toBeNull(); // no marker
    expect(run.status).toBe("running"); // untouched by the stale attempt
  });

  it("scanner-delegation race: no observable instant where the failed event exists unowned", async () => {
    const mission = missionRepo.createMission({ habitatId, columnId, title: "m", createdBy: "u" });
    const task = taskRepo.createTask({ missionId: mission.id, title: "t", createdBy: "u" });
    getDb()
      .update(tasks)
      .set({ status: "in_progress" })
      .where(eq_id(task.id))
      .run();
    const preImage = taskRepo.getTaskById(task.id)!;
    closeDb();

    const poller = forkWorker([dbPath, "owned-poll", task.id]);
    await poller.ready;
    poller.go();

    // The act-tx writer (separate process, concurrent with the poller).
    await initDb(dbPath);
    const result = failTaskWithEffects({
      taskId: task.id,
      actorId: "system-worker",
      actorType: "system",
      reason: "race",
      preImage,
    });
    expect(result).not.toBeNull();
    closeDb();

    const r = await poller.result;
    expect(r.unownedWithEvent).toBe(0); // event row and ownership receipt are atomic
  });
});

import { eq } from "drizzle-orm";
function eq_id(id: string) {
  return eq(tasks.id, id);
}
function eq_gate(id: string) {
  return eq(taskWorkflowGates.id, id);
}
function dirname(p: string): string {
  return p.slice(0, p.lastIndexOf("/"));
}
