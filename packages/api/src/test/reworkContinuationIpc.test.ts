/**
 * REC-10 rework continuation — cross-process races on a real file-backed
 * better-sqlite3 DB (forked workers, READY/GO IPC barriers).
 *
 *   1. Concurrent X starts on the same rejected task: exactly one Y
 *      (first-write-wins); the loser reads `in_progress` → refused.
 *   2. Reject vs rework start: both demand mutually exclusive statuses
 *      (reject requires `submitted`, start requires `rejected`) under
 *      BEGIN IMMEDIATE — exactly one outcome lands.
 *   3. Daemon terminal write vs the start tx: first-accepted serialization.
 *      A session that went terminal keeps X (never rebound to Y); a session
 *      the start rebound first may then go terminal under Y (its death is
 *      the current worker's legitimate signal). No laundering either way:
 *      a terminal row's token is always the epoch its death belongs to.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql as dsql } from "drizzle-orm";
import { initDb, getDb, closeDb } from "../db/index.js";
import { tasks, daemonSessions, daemonInstances } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as daemonRepo from "../repositories/daemon.js";
import * as taskService from "../services/tasks/index.js";

const WORKER = join(import.meta.dirname, "fixtures", "rework-race-worker.ts");

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
let agentId: string;

function seedTaskRow(title: string) {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: `m-${title}`,
    createdBy: "u",
  });
  return taskRepo.createTask({ missionId: mission.id, title, createdBy: "u" });
}

/** claim X → start → submit → reject; returns { taskId, X } on the FILE db. */
function seedRejectedOnFile(title: string): { taskId: string; X: string } {
  const task = seedTaskRow(title);
  const claim = taskStateMachine.claimTask(task.id, agentId);
  expect(claim.success).toBe(true);
  const X = (claim as { success: true; task: { executionToken: string } }).task.executionToken;
  expect(taskService.startTask(task.id, agentId, X)).not.toBeNull();
  const submitted = taskService.submitTask(task.id, agentId, "ipc r1", [], X);
  expect(submitted.task).not.toBeNull();
  const rejected = taskService.rejectTask(task.id, "human-ipc", "ipc rework", "human");
  expect(rejected).not.toBeNull();
  return { taskId: task.id, X };
}

function seedSessionOnFile(taskId: string, token: string): { sessionId: string; daemonId: string } {
  const daemon = daemonRepo.createDaemon({
    name: `ipc-daemon-${taskId.slice(0, 6)}`,
    hostname: "h",
    maxConcurrent: 4,
    daemonVersion: "test",
    plainToken: `pt-${taskId.slice(0, 6)}`,
    metadata: { habitatIds: [habitatId] },
  });
  const session = daemonRepo.createDaemonSession({
    daemonId: daemon.id,
    agentId,
    taskId,
    habitatId,
    workdir: "/w",
  });
  getDb()
    .update(daemonSessions)
    .set({ executionToken: token })
    .where(eq(daemonSessions.id, session.id))
    .run();
  // Fresh heartbeat: the rework start's dead-owner check must NOT terminalize
  // (this test races the terminal write, not the stale determination).
  getDb()
    .update(daemonInstances)
    .set({ lastHeartbeatAt: new Date().toISOString() })
    .where(eq(daemonInstances.id, daemon.id))
    .run();
  return { sessionId: session.id, daemonId: daemon.id };
}

function taskRow(taskId: string) {
  return getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as {
    status: string;
    executionToken: string | null;
    version: number;
  };
}

function sessionRowOnFile(sessionId: string) {
  return getDb().select().from(daemonSessions).where(eq(daemonSessions.id, sessionId)).get() as
    | { status: string; executionToken: string | null }
    | undefined;
}

beforeEach(async () => {
  dbPath = join(await mkdtemp(join(tmpdir(), "rework-race-")), "race.db");
  await initDb(dbPath);
  getDb().run(dsql`PRAGMA foreign_keys = ON`);
  const habitat = habitatRepo.createHabitat({ name: "Rework IPC Habitat" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({ habitatId, name: "T", order: 0, requiresClaim: false }).id;
  agentId = agentRepo.createAgent({
    name: "ipc-rework-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  }).agent.id;
});

afterEach(async () => {
  closeDb();
  await rm(dbPath.slice(0, dbPath.lastIndexOf("/")), { recursive: true, force: true });
});

describe("rework continuation IPC races (file-backed better-sqlite3)", () => {
  it("concurrent X starts on the rejected task: exactly one Y, loser refused", async () => {
    const { taskId, X } = seedRejectedOnFile("concurrent-starts");
    closeDb(); // the parent's connection must not hold the file

    const a = forkWorker([dbPath, "start", taskId, agentId, X]);
    const b = forkWorker([dbPath, "start", taskId, agentId, X]);
    await Promise.all([a.ready, b.ready]);
    a.go();
    b.go();
    const [ra, rb] = await Promise.all([a.result, b.result]);
    const kinds = [ra.kind, rb.kind].sort();
    expect(kinds).toEqual(["ok", "refused"]); // exactly one winner

    await initDb(dbPath);
    const row = taskRow(taskId);
    expect(row.status).toBe("in_progress");
    expect(row.executionToken).toBeTruthy();
    expect(row.executionToken).not.toBe(X); // the winner minted Y
  }, 60_000);

  it("reject vs rework start: serialized on the status CAS — exactly one outcome", async () => {
    // Seed to submitted; park a reject worker and a start worker (with the
    // would-be X from the current claim), then race them.
    const task = seedTaskRow("reject-vs-start");
    const claim = taskStateMachine.claimTask(task.id, agentId);
    expect(claim.success).toBe(true);
    const X = (claim as { success: true; task: { executionToken: string } }).task.executionToken;
    expect(taskService.startTask(task.id, agentId, X)).not.toBeNull();
    const submitted = taskService.submitTask(task.id, agentId, "r1", [], X);
    expect(submitted.task).not.toBeNull();
    const versionBefore = taskRow(task.id).version;
    closeDb();

    const rej = forkWorker([dbPath, "reject", task.id, "human-ipc", "race reject"]);
    const start = forkWorker([dbPath, "start", task.id, agentId, X]);
    await Promise.all([rej.ready, start.ready]);
    rej.go();
    start.go();
    const [rr, rs] = await Promise.all([rej.result, start.result]);

    // The reject's pre-state (`submitted`) is exclusively its own — the start
    // worker can never take it — so the reject ALWAYS lands. The start worker
    // serialized either BEFORE the reject commit (read `submitted` → refused)
    // or AFTER (read `rejected` + X → legitimately admitted, mint Y).
    expect(rr.kind).toBe("ok");
    expect(["ok", "refused"]).toContain(rs.kind);

    await initDb(dbPath);
    const row = taskRow(task.id);
    if (rs.kind === "ok") {
      expect(row.status).toBe("in_progress");
      expect(row.executionToken).not.toBe(X);
      expect(row.executionToken).not.toBeNull();
    } else {
      expect(row.status).toBe("rejected");
      expect(row.executionToken).toBe(X); // preserved by the reject
    }
    expect(row.version).toBeGreaterThanOrEqual(versionBefore + 1); // reject landed
  }, 60_000);

  it("daemon terminal write racing the start tx: first-accepted; terminal keeps X when it won; no laundering", async () => {
    const { taskId, X } = seedRejectedOnFile("terminal-vs-start");
    const { sessionId } = seedSessionOnFile(taskId, X);
    closeDb();

    const term = forkWorker([dbPath, "terminal", sessionId, "failed"]);
    const start = forkWorker([dbPath, "start", taskId, agentId, X]);
    await Promise.all([term.ready, start.ready]);
    term.go();
    start.go();
    const [rt, rs] = await Promise.all([term.result, start.result]);
    expect(rt.kind).toBe("ok"); // the monotonic terminal write always lands
    // The start either won the rebind first (session then terminal UNDER Y —
    // the current worker's death) or lost it (session terminal keeps X).
    await initDb(dbPath);
    const s = sessionRowOnFile(sessionId)!;
    const row = taskRow(taskId);
    expect(rs.kind === "ok" || rs.kind === "refused").toBe(true);
    if (rs.kind === "ok") {
      expect(row.status).toBe("in_progress");
      const Y = row.executionToken!;
      // Terminal row's token is the epoch its death belongs to:
      // X when the terminal write serialized first, Y when the rebind did.
      expect([X, Y]).toContain(s.executionToken);
      expect(s.status).toBe("failed");
    } else {
      // Start refused — session terminal under X, task untouched.
      expect(row.status).toBe("rejected");
      expect(s.executionToken).toBe(X);
    }
  }, 60_000);
});
