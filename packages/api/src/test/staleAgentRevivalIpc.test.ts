/**
 * REC-06 — stale-agent sweep heartbeat-revival windows (cross-process,
 * real better-sqlite3 file DB, deterministic LOCKED barriers — no sleeps
 * deciding outcomes).
 *
 *   window A (revive BEFORE the offline CAS): the worker commits a FRESH
 *   agent heartbeat while holding the SQLite write lock; the parent sweep's
 *   offline CAS — which BLOCKED on the lock — re-checks the stale
 *   `last_heartbeat` in its WHERE and MISSES: no status flip, no SSE, no
 *   release (D2(a)).
 *
 *   window B (revive AFTER the CAS, BEFORE the authority tx): the candidate
 *   is ALREADY offline with a retained pointer (the budget-refusal
 *   retention shape), so the sweep skips the offline write entirely and its
 *   release act-tx is the first blocked write; the worker's fresh heartbeat
 *   commits first and the act-tx's IN-TX heartbeat guard refuses with zero
 *   writes (D2(b)).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/index.js";
import { agents, taskEvents, effectReceipts, tasks } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import { releaseStaleTasks } from "../services/agentService.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { logger } from "../lib/logger.js";

const WORKER = join(import.meta.dirname, "fixtures", "stale-sweep-worker.ts");
const STALE_MS = 31 * 60_000;

type Msg = Record<string, unknown> & { type?: string };

function forkWorker(args: string[]): {
  child: ChildProcess;
  ready: Promise<void>;
  locked: Promise<void>;
  result: Promise<Msg>;
  claimResult: Promise<Msg>;
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
  const locked = new Promise<void>((resolve) => {
    const onMessage = (msg: Msg): void => {
      if (msg?.type === "LOCKED") {
        child.off("message", onMessage);
        resolve();
      }
    };
    child.on("message", onMessage);
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
  const claimResult = new Promise<Msg>((resolve) => {
    const onMessage = (msg: Msg): void => {
      if (msg?.type === "CLAIM_RESULT") {
        child.off("message", onMessage);
        resolve(msg);
      }
    };
    child.on("message", onMessage);
  });
  return { child, ready, locked, result, claimResult, go: () => child.send({ type: "GO" }) };
}

let dbPath: string;
let tempDir: string;
let habitatId: string;
let agentId: string;
let taskId: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), `orcy-stale-revival-${process.pid}-`));
  dbPath = join(tempDir, "revival.db");
  await initDb(dbPath);
  const habitat = habitatRepo.createHabitat({ name: "Stale Revival IPC" });
  habitatId = habitat.id;
  const columnId = columnRepo.createColumn({
    habitatId,
    name: "T",
    order: 0,
    requiresClaim: false,
  }).id;
  agentId = agentRepo.createAgent({
    name: "revival-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  }).agent.id;
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: "revival-m",
    createdBy: "u",
  });
  taskId = taskRepo.createTask({ missionId: mission.id, title: "revival-t", createdBy: "u" }).id;
});

afterEach(async () => {
  await closeDb();
  await rm(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function claimAndGoSilent(): void {
  const claim = taskStateMachine.claimTask(taskId, agentId);
  expect(claim.success).toBe(true);
  const started = taskStateMachine.startTask(taskId, agentId);
  expect(started?.status).toBe("in_progress");
  agentRepo.heartbeat(agentId, taskId);
  getDb()
    .update(agents)
    .set({ lastHeartbeat: new Date(Date.now() - STALE_MS).toISOString() })
    .where(eq(agents.id, agentId))
    .run();
}

function agentHeartbeat(agentId2 = agentId): string | null {
  return (
    getDb().select().from(agents).where(eq(agents.id, agentId2)).get() as {
      lastHeartbeat: string | null;
    }
  ).lastHeartbeat;
}

describe("heartbeat revival windows (forked worker, held write lock)", () => {
  it("window A — revival before the offline CAS: no flip, no SSE, no release", async () => {
    claimAndGoSilent();
    const staleBeat = agentHeartbeat();
    const publish = vi.spyOn(sseBroadcaster, "publish");
    const errorSpy = vi.spyOn(logger, "error");

    const worker = forkWorker([dbPath, "revive", agentId, "400"]);
    await worker.ready;
    worker.go();
    await worker.locked; // worker holds the write lock; heartbeat not yet written
    const resultP = worker.result;

    releaseStaleTasks(30); // offline CAS blocks on the lock; fresh beat commits first

    const result = await resultP;
    expect(result.kind).toBe("ok");

    const row = getDb().select().from(agents).where(eq(agents.id, agentId)).get() as {
      status: string;
      currentTaskId: string | null;
    };
    expect(row.status).not.toBe("offline"); // CAS missed: never flipped
    expect(row.currentTaskId).toBe(taskId); // pointer untouched
    expect(agentHeartbeat()).not.toBe(staleBeat); // the revival landed
    const taskRow = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as {
      status: string;
    };
    expect(taskRow.status).toBe("in_progress"); // task untouched
    expect(
      getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all(),
    ).toHaveLength(0); // no events at all (claim/start via repo emit none)
    expect(
      getDb().select().from(effectReceipts).where(eq(effectReceipts.taskId, taskId)).all(),
    ).toHaveLength(0);
    const flips = publish.mock.calls.filter(
      (c) => c[0] === "global" && (c[1] as { type?: string })?.type === "agent.status_changed",
    ).length;
    expect(flips).toBe(0); // no SSE on a missed CAS
    expect(errorSpy).not.toHaveBeenCalled(); // F5: CAS re-evaluated, not catch-skipped
  }, 20_000);

  it("window B — revival between CAS and the authority tx: in-tx guard refuses, zero writes", async () => {
    claimAndGoSilent();
    // The budget-refusal retention shape: already offline, pointer retained.
    getDb().update(agents).set({ status: "offline" }).where(eq(agents.id, agentId)).run();
    const errorSpy = vi.spyOn(logger, "error");

    const worker = forkWorker([dbPath, "revive", agentId, "400"]);
    await worker.ready;
    worker.go();
    await worker.locked;
    const resultP = worker.result;

    releaseStaleTasks(30); // skips the offline write; the act-tx blocks on the lock

    const result = await resultP;
    expect(result.kind).toBe("ok");

    const taskRow = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as {
      status: string;
      assignedAgentId: string | null;
    };
    expect(taskRow.status).toBe("in_progress"); // refused: zero bundle writes
    expect(taskRow.assignedAgentId).toBe(agentId);
    const released = getDb()
      .select()
      .from(taskEvents)
      .where(eq(taskEvents.taskId, taskId))
      .all()
      .filter((e) => e.action === "released");
    expect(released).toHaveLength(0);
    expect(
      getDb().select().from(effectReceipts).where(eq(effectReceipts.taskId, taskId)).all(),
    ).toHaveLength(0);
    // Pointer retained: the (revived) agent keeps its claim context.
    const row = getDb().select().from(agents).where(eq(agents.id, agentId)).get() as {
      currentTaskId: string | null;
    };
    expect(row.currentTaskId).toBe(taskId);
    // F5: the blocked-write path re-evaluated and REFUSED — no per-candidate
    // catch ever skipped the work (no SQLITE_BUSY swallow).
    expect(logger.error).not.toHaveBeenCalled();
  }, 20_000);

  it("F1 claim window — re-claim lands between precheck and cleanup write: pointer retained, next sweep releases E2", async () => {
    claimAndGoSilent();
    // Crash-residue shape entering the cleanup branch: already offline with a
    // retained pointer, task pending-unowned (release committed elsewhere).
    getDb().update(agents).set({ status: "offline" }).where(eq(agents.id, agentId)).run();
    getDb()
      .update(tasks)
      .set({ status: "pending", assignedAgentId: null, executionToken: null })
      .where(eq(tasks.id, taskId))
      .run();
    const errorSpy = vi.spyOn(logger, "error");

    const worker = forkWorker([dbPath, "claim", agentId, taskId, "400"]);
    await worker.ready;
    worker.go();
    await worker.locked;
    const resultP = worker.result;
    const claimP = worker.claimResult;

    // The sweep's cleanup must take the write authority (BEGIN IMMEDIATE),
    // BLOCK on the held lock, then re-read the task IN-TX and see the live
    // re-claim → RETAIN the pointer (no clear, no release, no assignment).
    releaseStaleTasks(30);

    const claim = await claimP;
    expect(claim.changed).toBe(1); // the interleave actually happened
    const result = await resultP;
    expect(result.kind).toBe("ok");
    expect(result.claimed).toBe(true);

    const taskAfter = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as {
      status: string;
      assignedAgentId: string | null;
      executionToken: string | null;
    };
    expect(taskAfter.status).toBe("claimed"); // the E2 re-claim stands
    expect(taskAfter.assignedAgentId).toBe(agentId);
    expect(taskAfter.executionToken).not.toBeNull();
    const agentAfter = getDb().select().from(agents).where(eq(agents.id, agentId)).get() as {
      currentTaskId: string | null;
    };
    expect(agentAfter.currentTaskId).toBe(taskId); // RETAINED — never cleared
    expect(
      getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all(),
    ).toHaveLength(0);
    expect(
      getDb().select().from(effectReceipts).where(eq(effectReceipts.taskId, taskId)).all(),
    ).toHaveLength(0);
    expect(errorSpy).not.toHaveBeenCalled(); // no catch-skip

    // Next tick, still heartbeat-stale per the sweep's contract: the full
    // guard path releases E2 with effects.
    releaseStaleTasks(30);
    const released = getDb()
      .select()
      .from(taskEvents)
      .where(eq(taskEvents.taskId, taskId))
      .all()
      .filter((e) => e.action === "released");
    expect(released).toHaveLength(1);
    expect(released[0]!.executionToken).toBe(taskAfter.executionToken);
    expect(
      (
        getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as {
          status: string;
        }
      ).status,
    ).toBe("pending");
    const agentFinal = getDb().select().from(agents).where(eq(agents.id, agentId)).get() as {
      currentTaskId: string | null;
    };
    expect(agentFinal.currentTaskId).toBeNull();
  }, 20_000);

  it("F1 clear-first ordering — no re-claim: the blocked cleanup proceeds and clears the residue", async () => {
    claimAndGoSilent();
    getDb().update(agents).set({ status: "offline" }).where(eq(agents.id, agentId)).run();
    getDb()
      .update(tasks)
      .set({ status: "pending", assignedAgentId: null, executionToken: null })
      .where(eq(tasks.id, taskId))
      .run();
    const errorSpy = vi.spyOn(logger, "error");

    const worker = forkWorker([dbPath, "hold", agentId, "400"]);
    await worker.ready;
    worker.go();
    await worker.locked;
    const resultP = worker.result;

    releaseStaleTasks(30); // cleanup blocks on the lock; nothing intervenes

    const result = await resultP;
    expect(result.kind).toBe("ok");
    expect(
      (
        getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as {
          status: string;
        }
      ).status,
    ).toBe("pending");
    const agentAfter = getDb().select().from(agents).where(eq(agents.id, agentId)).get() as {
      currentTaskId: string | null;
    };
    expect(agentAfter.currentTaskId).toBeNull(); // cleared: pending-unowned residue
    expect(
      getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all(),
    ).toHaveLength(0);
    expect(errorSpy).not.toHaveBeenCalled();
  }, 20_000);
});
