/**
 * Daemon worker contract — heartbeat-revival cross-process race
 * (acceptance item 8).
 *
 * Real better-sqlite3 FILE DB + forked worker holding the SQLite write lock
 * (`BEGIN IMMEDIATE` + IPC LOCKED barrier) while the parent runs the real
 * sweep. The discriminator is the in-tx freshness recheck:
 *
 *   ordering A (revive): the worker commits a FRESH heartbeat before
 *   releasing the lock → the parent's terminalization tx — which BLOCKED on
 *   the lock — re-reads the heartbeat fresh IN-TX and SPARES the session.
 *   Without the in-tx recheck (a stale-observation kill), the parent would
 *   have terminalized on its pre-lock observation.
 *
 *   ordering B (hold): the worker releases the lock without any heartbeat →
 *   the parent's in-tx re-read is still stale → the session is terminalized
 *   `lost`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/index.js";
import { daemonSessions, daemonInstances, tasks } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as daemonInstanceRepo from "../repositories/daemonInstance.js";
import { createDaemonSessionWithClient } from "../repositories/daemonSession.js";
import { eq as eqS } from "drizzle-orm";
import {
  sweepDaemonSessionOutcomes,
  DAEMON_STALE_HEARTBEAT_MS,
  setEngineLivenessProbe,
} from "../services/daemonSessionRecovery.js";

const WORKER = join(import.meta.dirname, "fixtures", "daemon-heartbeat-worker.ts");

type Msg = Record<string, unknown> & { type?: string };

function forkWorker(args: string[]): {
  child: ChildProcess;
  ready: Promise<void>;
  locked: Promise<void>;
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
  return { child, ready, locked, result, go: () => child.send({ type: "GO" }) };
}

let dbPath: string;
let tempDir: string;
let habitatId: string;
let columnId: string;
let agentId: string;
let daemonId: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), `orcy-daemon-revival-${process.pid}-`));
  dbPath = join(tempDir, "revival.db");
  await initDb(dbPath);
  const habitat = habitatRepo.createHabitat({ name: "Revival IPC" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({ habitatId, name: "T", order: 0, requiresClaim: false }).id;
  agentId = agentRepo.createAgent({
    name: "revival-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  }).agent.id;
  daemonId = daemonInstanceRepo.createDaemon({
    name: "revival-daemon",
    hostname: "test",
    maxConcurrent: 2,
    daemonVersion: "test",
    plainToken: "tok",
    metadata: {},
  }).id;
  setEngineLivenessProbe(() => false);
});

afterEach(async () => {
  setEngineLivenessProbe(() => false);
  await closeDb();
  await rm(tempDir, { recursive: true, force: true });
});

function seedGhostSession(): string {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: "revival-m",
    createdBy: "u",
  });
  const taskId = taskRepo.createTask({
    missionId: mission.id,
    title: "revival-t",
    createdBy: "u",
  }).id;
  const claim = taskStateMachine.claimTask(taskId, agentId);
  expect(claim.success).toBe(true);
  const started = taskStateMachine.startTask(taskId, agentId);
  expect(started?.status).toBe("in_progress");
  const { id } = createDaemonSessionWithClient(
    getDb(),
    { daemonId, agentId, taskId, habitatId, workdir: "/tmp/wd" },
    started!.executionToken!,
  );
  // The transport's normal `running` write (CLI spawned).
  getDb().update(daemonSessions).set({ status: "running" }).where(eqS(daemonSessions.id, id)).run();
  return id;
}

function ageHeartbeat(): void {
  getDb()
    .update(daemonInstances)
    .set({
      lastHeartbeatAt: new Date(Date.now() - (DAEMON_STALE_HEARTBEAT_MS + 60_000)).toISOString(),
    })
    .where(eq(daemonInstances.id, daemonId))
    .run();
}

function sessionStatus(sessionId: string): string {
  return (
    getDb().select().from(daemonSessions).where(eq(daemonSessions.id, sessionId)).get() as {
      status: string;
    }
  ).status;
}

describe("heartbeat revival race (forked worker, held write lock, both orderings)", () => {
  it("ordering A — heartbeat commits first: the in-tx recheck spares the session", async () => {
    const sessionId = seedGhostSession();
    ageHeartbeat();

    const worker = forkWorker([dbPath, "revive", daemonId, "400"]);
    await worker.ready;
    worker.go();
    await worker.locked; // worker holds the write lock; heartbeat not yet written
    const resultP = worker.result;

    // The parent sweep runs while the worker holds the lock: its
    // terminalization tx blocks, then the worker's fresh heartbeat commits
    // FIRST — the in-tx re-read must spare the session.
    sweepDaemonSessionOutcomes();

    const result = await resultP;
    expect(result.kind).toBe("ok");
    expect(sessionStatus(sessionId)).toBe("running");
    // And the task was never failed.
    const activeTasks = getDb().select().from(tasks).where(eq(tasks.status, "in_progress")).all();
    expect(activeTasks.length).toBe(1);
  }, 20_000);

  it("ordering B — no revival: the lock releases without a heartbeat and the session terminalizes", async () => {
    const sessionId = seedGhostSession();
    ageHeartbeat();

    const worker = forkWorker([dbPath, "hold", daemonId, "400"]);
    await worker.ready;
    worker.go();
    await worker.locked;
    const resultP = worker.result;

    sweepDaemonSessionOutcomes(); // blocks on the lock; nothing revives

    const result = await resultP;
    expect(result.kind).toBe("ok");
    expect(sessionStatus(sessionId)).toBe("lost");
    // The task-side leg followed the terminalization: failed with effects.
    const failed = getDb().select().from(tasks).where(eq(tasks.status, "failed")).all();
    expect(failed.length).toBe(1);
  }, 20_000);
});
