/**
 * domain_expert assignment — REAL cross-process race on a file-backed
 * better-sqlite3 database (fixup for code-review LOW-1, coordinator-upgraded).
 *
 * Two forked OS processes with separate connections race
 * `assignReviewers` on the same task (`requiredReviews: 1`). Without the
 * BEGIN IMMEDIATE write-lock around the read(task/E/pool)+insert phase, the
 * racing pair can (a) read a stale E, (b) read fresh pending counts AFTER the
 * other's insert — the divergence source is the racing assigner's OWN insert
 * (a legitimate workload change: the inserted pending row bumps the winner's
 * pick in the pending-count ordering), no artificial hooks — and over-fill
 * the single slot with a second agent row, permanently adding an approval
 * requirement; or crash on the type-blind unique index with the same pick.
 *
 * With the guard, the outcome is deterministic regardless of interleaving:
 * the assigner that takes the write lock first fills the slot; the second
 * re-reads committed state (E=1) and skips — exactly one agent row, both
 * workers succeed.
 *
 * No pretend in-process Promise concurrency: better-sqlite3 connections are
 * synchronous and cannot interleave on one event loop — only real forked
 * processes produce the overlapping read/insert window this suite proves.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { initDb, closeDb } from "../db/index.js";
import * as agentRepo from "../repositories/agent.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as reviewRuleRepo from "../repositories/reviewRule.js";
import * as taskReviewerRepo from "../repositories/taskReviewer.js";

const WORKER = join(import.meta.dirname, "fixtures", "domainAssignmentRaceWorker.ts");

/** Wide pool: the pending-count compute phase between the rows-read and the insert widens the interleaving window. */
const POOL_SIZE = 80;
const ROUNDS = 3;

interface WorkerOutcome {
  ok: boolean;
  assignedCount?: number;
  skipped?: boolean;
  reason?: string;
  error?: string;
}

/** Terminal child status for diagnostics (null/running while alive). */
function childStatus(child: ChildProcess): string {
  if (child.exitCode !== null) return `exit=${child.exitCode}`;
  if (child.signalCode !== null) return `signal=${child.signalCode}`;
  return "running";
}

/** A wait that owns its listeners/timer and can be settled from outside (race teardown). */
interface WaitHandle<T> {
  readonly promise: Promise<T>;
  /** Settle now (reject) and detach this wait's own listeners/timer; never kills the child. */
  cancel(reason: string): void;
}

/** TDZ-safe placeholder for a wait's detach hook (reassigned inside the executor). */
const noopDetach = (): void => {};

function waitForMessage<T>(
  child: ChildProcess,
  match: (m: any) => T | null,
  timeoutMs = 60000,
): WaitHandle<T> {
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  let detach = noopDetach;
  let forceSettle: ((reason: string) => void) | null = null;
  const promise = new Promise<T>((resolve, reject) => {
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      detach();
      finish();
    };
    forceSettle = (reason: string) =>
      settle(() => reject(new Error(`assignment race worker wait cancelled: ${reason}`)));
    // A child that already exited never emits "exit"/"message" again — fail
    // fast instead of parking on the timer.
    if (child.exitCode !== null || child.signalCode !== null) {
      settle(() =>
        reject(new Error(`assignment race worker already exited (status=${childStatus(child)})`)),
      );
      return;
    }
    const onMessage = (m: any) => {
      const v = match(m);
      if (v !== null) settle(() => resolve(v));
    };
    const onExit = (code: number | null) =>
      settle(() =>
        reject(new Error(`assignment race worker exited before matching message (code=${code})`)),
      );
    // Spawn/runtime failures (fork ENOENT etc.) can end a child without an
    // "exit" after listeners attached — tracked so the wait cannot park.
    const onError = (err: Error) =>
      settle(() => reject(new Error(`assignment race worker error: ${err.message}`)));
    detach = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    timer = setTimeout(() => {
      const status = childStatus(child);
      child.kill("SIGKILL");
      settle(() =>
        reject(
          new Error(
            `assignment race worker timed out after ${timeoutMs}ms (status=${status}, pid=${child.pid})`,
          ),
        ),
      );
    }, timeoutMs);
    child.on("message", onMessage);
    child.on("exit", onExit);
    child.on("error", onError);
  });
  return { promise, cancel: (reason: string) => forceSettle?.(reason) };
}

/** Bounded exit wait: rejects (after SIGKILL) on timeout; resolves instantly for already-exited children. */
function waitForExit(child: ChildProcess, timeoutMs = 30000): WaitHandle<void> {
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  let detach = noopDetach;
  let forceSettle: ((reason: string) => void) | null = null;
  const promise = new Promise<void>((resolve, reject) => {
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      detach();
      finish();
    };
    forceSettle = (reason: string) =>
      settle(() => reject(new Error(`assignment race worker exit wait cancelled: ${reason}`)));
    // Lost-exit-event guard: an already-exited child never re-emits "exit".
    if (child.exitCode !== null || child.signalCode !== null) {
      settle(() => resolve());
      return;
    }
    const onExit = () => settle(() => resolve());
    const onError = (err: Error) =>
      settle(() => reject(new Error(`assignment race worker error: ${err.message}`)));
    detach = () => {
      child.off("exit", onExit);
      child.off("error", onError);
    };
    timer = setTimeout(() => {
      const status = childStatus(child);
      child.kill("SIGKILL");
      settle(() =>
        reject(
          new Error(
            `assignment race worker did not exit within ${timeoutMs}ms (status=${status}, pid=${child.pid}) — hang suspected; child killed`,
          ),
        ),
      );
    }, timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
  return { promise, cancel: (reason: string) => forceSettle?.(reason) };
}

function forkWorker(args: string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = fork(WORKER, args, {
    execArgv: ["--import", "tsx"],
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: { ...process.env, ...env },
  });
  child.stderr?.on("data", (d: Buffer) => {
    if (process.env.RACE_DEBUG) console.error("[worker]", String(d));
  });
  return child;
}

function resultMatcher(m: any): WorkerOutcome | null {
  return m?.type === "RESULT"
    ? {
        ok: m.ok === true,
        assignedCount: m.assignedCount,
        skipped: m.skipped,
        reason: m.reason,
        error: m.error,
      }
    : null;
}

/** Two processes race the same task's assignment; resolves when both reported and exited. */
async function raceAssignment(
  dbPath: string,
  taskId: string,
  habitatId: string,
  opts: { firstChildArgs?: string[] } = {},
): Promise<WorkerOutcome[]> {
  const children: ChildProcess[] = [];
  const pendingCancels: Array<(reason: string) => void> = [];
  const taps: Array<Promise<unknown>> = [];
  try {
    const readies: Array<Promise<true>> = [];
    const dones: Array<Promise<WorkerOutcome>> = [];
    for (let i = 0; i < 2; i++) {
      const args =
        i === 0 && opts.firstChildArgs ? opts.firstChildArgs : [dbPath, taskId, habitatId];
      const child = forkWorker(args);
      // Tracked BEFORE any await: a startup failure in the READY wait below
      // still reaches the finally kill/reap for this child.
      children.push(child);
      const ready = waitForMessage<true>(child, (m) => (m?.type === "READY" ? true : null));
      const done = waitForMessage<WorkerOutcome>(child, resultMatcher);
      pendingCancels.push(
        (r) => ready.cancel(r),
        (r) => done.cancel(r),
      );
      // Rejection taps attached at creation: an early READY/done failure can
      // never surface as an unhandled rejection while control is elsewhere.
      taps.push(
        ready.promise.catch(() => {}),
        done.promise.catch(() => {}),
      );
      readies.push(ready.promise);
      dones.push(done.promise);
    }
    await Promise.all(readies);
    for (const child of children) child.send?.({ type: "GO" });
    const outcomes = await Promise.all(dones);
    // Handles deliberately discarded here: the happy-path exit waits are
    // timer-bounded (30s, kill-settled) and are NOT registered as
    // cancel-owned in the finally's pendingCancels.
    const exits = children.map((child) => waitForExit(child).promise);
    for (const p of exits) taps.push(p.catch(() => {}));
    await Promise.all(exits);
    return outcomes;
  } finally {
    // 1) Settle/cancel every outstanding wait FIRST — each detaches only its
    //    own listeners and clears its own timer, so no pending wait's timer
    //    is stranded by teardown.
    for (const cancel of pendingCancels) cancel("race teardown");
    // 2) Kill every tracked child (kill on an already-dead child is a no-op).
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    // 3) Bounded reap attempt (5s exit waits; rejection errors swallowed so
    //    teardown never masks the original failure). Returning from the
    //    teardown proves the teardown is FINITE — it does NOT prove every
    //    child reached a terminal state (a rejected reap wait is swallowed);
    //    SIGKILL was requested and a bounded reap was attempted. Terminal
    //    statuses are asserted independently by the direct helper tests.
    await Promise.allSettled(children.map((child) => waitForExit(child, 5000).promise));
    // 4) Every wait is settled; the taps guarantee no unobserved rejection.
    await Promise.allSettled(taps);
    // No removeAllListeners here: each wait removed only its own listeners on
    // settle — wholesale removal would strand still-pending waits' timers.
  }
}

describe("domain_expert assignment race (cross-process, file-backed better-sqlite3)", () => {
  let dbPath: string;
  let habitatId: string;
  let poolIds: Set<string>;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `orcy-domain-assignment-race-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
  });

  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(dbPath + suffix, { force: true });
      } catch {
        // ignore — already gone
      }
    }
  });

  it("concurrent assigners fill each slot exactly once: no over-fill, no crash, deterministic single row", async () => {
    await initDb(dbPath);

    const habitat = habitatRepo.createHabitat({ name: "Assignment Race Habitat" });
    habitatId = habitat.id;
    const column = columnRepo.createColumn({ habitatId, name: "Backlog" });
    const mission = missionRepo.createMission({
      habitatId,
      columnId: column.id,
      title: "Assignment Race Mission",
      createdBy: "seed",
    });
    reviewRuleRepo.create(habitatId, {
      name: "domain rule",
      assignmentStrategy: "domain_expert",
      requiredReviews: 1,
    });

    // Assignee (excluded from the pool) + a wide live pool of exact-domain
    // matches + a decoy non-matching agent.
    const assignee = agentRepo.createAgent({
      name: "race-assignee",
      type: "codex",
      domain: "backend",
    });
    agentRepo.createAgent({ name: "race-decoy", type: "codex", domain: "frontend" });
    poolIds = new Set<string>();
    for (let i = 0; i < POOL_SIZE; i++) {
      const { agent } = agentRepo.createAgent({
        name: `race-pool-${i}`,
        type: "codex",
        domain: "backend",
      });
      poolIds.add(agent.id);
    }

    const taskIds: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: `Race Task ${round}`,
        createdBy: "seed",
        requiredDomain: "backend",
      });
      taskRepo.claimTask(task.id, assignee.agent.id);
      taskRepo.startTask(task.id, assignee.agent.id);
      if (!taskRepo.submitTask(task.id, assignee.agent.id, "race work", [])) {
        throw new Error("seed: submitTask failed");
      }
      taskIds.push(task.id);
    }
    closeDb();

    for (const taskId of taskIds) {
      const outcomes = await raceAssignment(dbPath, taskId, habitatId);

      // With the BEGIN IMMEDIATE guard the outcome is deterministic: the
      // lock winner fills the slot (assigned 1), the loser re-reads E=1 and
      // skips. Without the guard this same pair over-fills or throws.
      expect(outcomes).toHaveLength(2);
      for (const o of outcomes) {
        expect(o.ok, `worker failed: ${o.error ?? "unknown"}`).toBe(true);
      }
      const totalAssigned = outcomes.reduce((sum, o) => sum + (o.assignedCount ?? 0), 0);
      expect(totalAssigned).toBe(1);
    }

    await initDb(dbPath);
    try {
      for (const taskId of taskIds) {
        const rows = taskReviewerRepo.getByTaskId(taskId);
        expect(rows).toHaveLength(1);
        expect(rows[0].reviewerType).toBe("agent");
        expect(rows[0].status).toBe("pending");
        expect(poolIds.has(rows[0].reviewerId)).toBe(true);
      }
    } finally {
      closeDb();
    }
  }, 300000);

  it("harness cleanup: already-exited child fails the READY wait fast (no lost-exit hang), exit wait resolves", async () => {
    // Garbage argv → the worker exits immediately (code 2) without READY.
    // The READY wait must reject promptly via the already-exited fast path,
    // not park on its timer, and the exit wait must resolve instantly.
    const child = forkWorker(["not-a-db", "", ""]);

    const ready = waitForMessage<true>(child, (m) => (m?.type === "READY" ? true : null));
    await expect(ready.promise).rejects.toThrow(/already exited|exited before matching/);

    await expect(waitForExit(child).promise).resolves.toBeUndefined();
    expect([child.exitCode, child.signalCode]).not.toEqual([null, null]);
  }, 60000);

  it("harness cleanup: wedged child is bounded — exit wait times out, kills, and reports status", async () => {
    // Valid args + hang mode: the worker swallows GO and never exits. The
    // bounded exit wait must reject with a status-bearing message within its
    // (short) budget, SIGKILL the child, and a follow-up wait then resolves.
    await initDb(dbPath);
    const habitat = habitatRepo.createHabitat({ name: "Hang Habitat" });
    const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Backlog" });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: column.id,
      title: "Hang Mission",
      createdBy: "seed",
    });
    const task = taskRepo.createTask({
      missionId: mission.id,
      title: "Hang Task",
      createdBy: "seed",
    });
    closeDb();

    const child = forkWorker([dbPath, task.id, habitat.id], { ORCY_RACE_WORKER_HANG: "1" });

    const ready = waitForMessage<true>(child, (m) => (m?.type === "READY" ? true : null));
    try {
      await ready.promise;
      child.send?.({ type: "GO" });
      // Wedged: GO swallowed, no exit ever. The bounded exit wait must
      // reject within its (short) budget with a status-bearing message and
      // SIGKILL the child; a follow-up wait then resolves (child reaped).
      await expect(waitForExit(child, 1000).promise).rejects.toThrow(/did not exit within 1000ms/);
      await expect(waitForExit(child).promise).resolves.toBeUndefined();
      expect([child.exitCode, child.signalCode]).not.toEqual([null, null]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      ready.cancel("test teardown");
    }
  }, 60000);

  it("harness cleanup: startup failure before READY through raceAssignment — bounded reject, no unhandled rejection", async () => {
    // Covers the orchestration list bug: the first child exits BEFORE READY
    // (garbage argv), so its READY wait rejects while the second child is
    // alive and parked on GO — only the finally cancel/kill/reap can end it.
    // Completing this rejection proves the teardown returned FINITE
    // (bounded waits; SIGKILL requested and a bounded reap attempted) — NOT
    // that every child reached a terminal state. The unhandledRejection
    // listener proves the untapped-rejection bug is gone; terminal statuses
    // are asserted independently by the direct helper tests.
    await initDb(dbPath);
    const habitat = habitatRepo.createHabitat({ name: "Startup Fail Habitat" });
    const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Backlog" });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: column.id,
      title: "Startup Fail Mission",
      createdBy: "seed",
    });
    const task = taskRepo.createTask({
      missionId: mission.id,
      title: "Startup Fail Task",
      createdBy: "seed",
    });
    closeDb();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(
        raceAssignment(dbPath, task.id, habitat.id, { firstChildArgs: ["", "", ""] }),
      ).rejects.toThrow(/already exited|exited before matching message/);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  }, 60000);
});
