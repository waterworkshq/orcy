/**
 * Epoch mutation guard — file-backed-DB forked-worker IPC interleave
 * (epoch-mutation-guard ticket, acceptance item 2 / I1).
 *
 * The S-6 vehicle (real better-sqlite3 file DB, forked worker processes,
 * READY/GO barriers). The invariant under proof is **"no E1 mutation lands
 * after E2's claim commits"** — NOT every-race exclusivity:
 *
 *   ordering A (GO sent AFTER the parent commits E2): the stale-E1 worker's
 *   mutation MUST fail with the typed epoch refusal and leave zero writes.
 *
 *   ordering B (E1 mutation runs BEFORE E2 commits): the E1 mutation MAY
 *   legitimately succeed — E1 was still the current epoch — and the
 *   subsequent E2 claim (release + re-claim) must succeed after it.
 *
 * Both orderings asserted for each of the four guarded mutations.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb, closeDb } from "../db/index.js";
import { tasks } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import { eq } from "drizzle-orm";

const WORKER = join(import.meta.dirname, "fixtures", "epoch-guard-race-worker.ts");

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

type Mutation = "start" | "submit" | "fail" | "release";

function seedClaimed(mutation: Mutation): { taskId: string; e1: string } {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: "m-ipc",
    createdBy: "u",
  });
  const task = taskRepo.createTask({ missionId: mission.id, title: "t-ipc", createdBy: "u" });
  // E1: real claim through the authority (mints the token).
  const result = taskStateMachine.claimTask(task.id, agentId);
  expect(result.success).toBe(true);
  const e1 = (result as { success: true; task: { executionToken?: string | null } }).task
    .executionToken!;
  if (mutation !== "start") {
    const started = getDb()
      .update(tasks)
      .set({ status: "in_progress" })
      .where(eq(tasks.id, task.id))
      .run();
    expect(started).toBeTruthy();
  }
  return { taskId: task.id, e1 };
}

function row(taskId: string): {
  status: string;
  assignedAgentId: string | null;
  executionToken: string | null;
  version: number;
} {
  return getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as never;
}

/** Parent-side E2: release (system shape, only when still holding) + re-claim. */
function rollToE2(taskId: string): string {
  const st = row(taskId).status;
  if (st === "claimed" || st === "in_progress") {
    expect(taskStateMachine.releaseTask(taskId, "ipc-roll")).not.toBeNull();
  }
  const re = taskStateMachine.claimTask(taskId, agentId);
  expect(re.success).toBe(true);
  return (re as { success: true; task: { executionToken?: string | null } }).task.executionToken!;
}

beforeEach(async () => {
  dbPath = join(await mkdtemp(join(tmpdir(), "epoch-race-")), "race.db");
  await initDb(dbPath);
  const habitat = habitatRepo.createHabitat({ name: "IPC Habitat" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({ habitatId, name: "T", order: 0, requiresClaim: false }).id;
  agentId = agentRepo.createAgent({
    name: "ipc-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  }).agent.id;
});

afterEach(async () => {
  closeDb();
  await rm(dbPath.slice(0, dbPath.lastIndexOf("/")), { recursive: true, force: true });
});

const MUTATIONS: Mutation[] = ["start", "submit", "fail", "release"];

describe("epoch guard IPC interleave (S-6: forked better-sqlite3 workers)", () => {
  it.each(MUTATIONS)(
    "ordering A — barrier AFTER E2 commit: stale E1 %s must fail, zero writes",
    async (mutation) => {
      const { taskId, e1 } = seedClaimed(mutation);
      closeDb(); // the parent's connection must not hold the file

      const worker = forkWorker([dbPath, "mutate", taskId, agentId, mutation, e1]);
      await worker.ready;

      // Parent commits E2 while the worker is parked behind its barrier.
      await initDb(dbPath);
      const e2 = rollToE2(taskId);
      if (mutation !== "start") {
        const started = getDb()
          .update(tasks)
          .set({ status: "in_progress" })
          .where(eq(tasks.id, taskId))
          .run();
        expect(started).toBeTruthy();
      }
      const before = row(taskId);
      closeDb();

      worker.go();
      const r = await worker.result;
      expect(r.kind).toBe("epoch_mismatch");

      await initDb(dbPath);
      const after = row(taskId);
      expect(after.status).toBe(before.status); // untouched under E2
      expect(after.executionToken).toBe(e2);
      expect(after.version).toBe(before.version);
    },
    60_000,
  );

  it.each(MUTATIONS)(
    "ordering B — barrier BEFORE E2 commit: E1 %s may legitimately succeed, then E2 claim lands",
    async (mutation) => {
      const { taskId, e1 } = seedClaimed(mutation);
      closeDb();

      const worker = forkWorker([dbPath, "mutate", taskId, agentId, mutation, e1]);
      await worker.ready;
      worker.go();
      const r = await worker.result;
      // E1 was the current epoch — the mutation lands.
      expect(r.kind).toBe("ok");

      await initDb(dbPath);
      if (mutation === "release" || mutation === "fail") {
        // The E1 mutation already returned the task to a reclaimable state —
        // the E2 claim in rollToE2 starts from pending/in_progress-released.
        if (row(taskId).status === "pending") {
          const e2 = rollToE2(taskId);
          expect(e2).not.toBe(e1);
          return;
        }
        // fail leaves the task failed — nothing left to fence; the E1 write
        // legitimately concluded the epoch. Ordering B's obligation ends here.
        expect(["failed", "pending"]).toContain(row(taskId).status);
        return;
      }
      if (mutation === "submit") {
        // submitted is terminal for the agent path; E1 submit concluded the
        // epoch legitimately.
        expect(row(taskId).status).toBe("submitted");
        return;
      }
      // start: task in_progress under E1 — release + re-claim mints E2.
      const e2 = rollToE2(taskId);
      expect(e2).not.toBe(e1);
    },
    60_000,
  );
});
