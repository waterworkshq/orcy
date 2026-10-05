/**
 * Agent review decisions — deterministic cross-process terminal races.
 *
 * Approve/reject (and approve/approve on the last two pending reviewers) run
 * in separate OS processes with separate better-sqlite3 connections against
 * one task. The contract invariants under real overlap:
 *
 *  - exactly ONE terminal task transition lands (CAS: the losing conditional
 *    UPDATE matches zero rows and surfaces null — never false success);
 *  - exactly ONE terminal task event row exists for the task (the loser
 *    emits no approved/rejected transition, metrics, or notifications);
 *  - both reviewer rows can still be recorded (the finality gate serializes
 *    the approval bookkeeping).
 *
 * Sequential stale-state behavior (release → reclaim → decide) is covered in
 * agentReviewDecision.test.ts — this suite is the interleaving evidence the
 * contract requires for the concurrent guarantees.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { initDb, closeDb, getDb } from "../db/index.js";
import * as agentRepo from "../repositories/agent.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as taskReviewerRepo from "../repositories/taskReviewer.js";
import { taskEvents } from "../db/schema/index.js";
import type { RaceOutcome } from "./fixtures/agentReviewDecisionRaceWorker.js";

const WORKER = join(import.meta.dirname, "fixtures", "agentReviewDecisionRaceWorker.ts");

interface RaceSpec {
  mode: "approve" | "reject";
  reviewerId: string;
}

/** `refused` is a legitimate normal return (production returns null, no throw); only `error` carries a cause. */
interface WorkerOutcome {
  outcome: RaceOutcome;
  mode: string;
  ok: boolean;
  error?: string;
}

/** A wait that owns its listeners/timer and can be settled from outside (teardown). */
interface WaitHandle<T> {
  readonly promise: Promise<T>;
  /** Settle now (reject) and detach this wait's own listeners/timer; never kills the child. */
  cancel(reason: string): void;
}

/** TDZ-safe placeholders reassigned inside each wait's executor. */
const noopDetach = (): void => {};
const noopForceSettle = (reason: string): void => {
  void reason;
};

/** Terminal child status for diagnostics (null/running while alive). */
function childStatus(child: ChildProcess): string {
  if (child.exitCode !== null) return `exit=${child.exitCode}`;
  if (child.signalCode !== null) return `signal=${child.signalCode}`;
  return "running";
}

function waitForMessage<T>(
  child: ChildProcess,
  match: (m: any) => T | null,
  label: string,
  timeoutMs = 200000,
): WaitHandle<T> {
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  let forceSettle = noopForceSettle;
  let detach = noopDetach;
  const startedAt = performance.now();
  const settleDiag = (outcome: string, detail: string): void => {
    console.error(
      `[race-harness] ${label} ${outcome} after ${Math.round(performance.now() - startedAt)}ms (status=${childStatus(child)}, pid=${child.pid}): ${detail}`,
    );
  };
  const promise = new Promise<T>((resolve, reject) => {
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      detach();
      finish();
    };
    forceSettle = (reason: string) => {
      // Silent on purpose: healthy-teardown cancels are routine; failure paths
      // (early exit, error, timeout) carry the diagnostics.
      settle(() => reject(new Error(`race wait cancelled: ${reason}`)));
    };
    // Lost-exit-event guard: an already-exited child never emits again — fail
    // fast instead of parking on the timer.
    if (child.exitCode !== null || child.signalCode !== null) {
      settleDiag("failed", "child already exited before wait attached");
      settle(() => reject(new Error(`race worker already exited (status=${childStatus(child)})`)));
      return;
    }
    const onMessage = (m: any) => {
      const v = match(m);
      if (v !== null) settle(() => resolve(v));
    };
    const onExit = (code: number | null) => {
      settleDiag("failed", `child exited before matching message (code=${code})`);
      settle(() => reject(new Error(`race worker exited before matching message (code=${code})`)));
    };
    const onError = (err: Error) => {
      settleDiag("failed", `spawn/runtime error: ${err.message}`);
      settle(() => reject(new Error(`race worker error: ${err.message}`)));
    };
    detach = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
    child.on("error", onError);
    timer = setTimeout(() => {
      const status = childStatus(child);
      child.kill("SIGKILL");
      settleDiag("failed", `timed out after ${timeoutMs}ms (status=${status}) — child SIGKILLed`);
      settle(() =>
        reject(
          new Error(
            `race worker timed out after ${timeoutMs}ms (status=${status}, pid=${child.pid})`,
          ),
        ),
      );
    }, timeoutMs);
  });
  return { promise, cancel: (reason: string) => forceSettle(reason) };
}

/** Bounded exit wait: kills and rejects on timeout; resolves instantly for already-exited children. */
function waitForExit(child: ChildProcess, timeoutMs = 30000): WaitHandle<void> {
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  let forceSettle = noopForceSettle;
  let detach = noopDetach;
  const promise = new Promise<void>((resolve, reject) => {
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      detach();
      finish();
    };
    forceSettle = (reason: string) =>
      settle(() => reject(new Error(`race worker exit wait cancelled: ${reason}`)));
    if (child.exitCode !== null || child.signalCode !== null) {
      settle(() => resolve());
      return;
    }
    const onExit = () => settle(() => resolve());
    const onError = () => settle(() => resolve());
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
            `race worker did not exit within ${timeoutMs}ms (status=${status}, pid=${child.pid}) — hang suspected; child killed`,
          ),
        ),
      );
    }, timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
  return { promise, cancel: (reason: string) => forceSettle(reason) };
}

function forkRacer(
  dbPath: string,
  spec: RaceSpec & { taskId: string },
  env: NodeJS.ProcessEnv = {},
): { child: ChildProcess; done: WaitHandle<WorkerOutcome> } {
  const child = fork(WORKER, [dbPath, spec.mode, spec.taskId, spec.reviewerId, "race reject"], {
    execArgv: ["--import", "tsx"],
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: { ...process.env, ...env },
  });
  child.stderr?.on("data", () => {
    /* worker noise must not fail the parent */
  });
  const done = waitForMessage<WorkerOutcome>(
    child,
    (m) =>
      m?.type === "RESULT"
        ? { outcome: m.outcome, mode: m.mode, ok: m.ok === true, error: m.error }
        : null,
    "result-wait",
  );
  return { child, done };
}

async function runRace(
  dbPath: string,
  specs: Array<RaceSpec & { taskId: string }>,
  env: NodeJS.ProcessEnv = {},
): Promise<WorkerOutcome[]> {
  // Stagger forks: each worker loads the module graph + connects before READY.
  // Serial startup keeps the two connection setups from contending; only the
  // DECISION calls race after GO.
  const children: ChildProcess[] = [];
  const pendingCancels: Array<(reason: string) => void> = [];
  const taps: Array<Promise<unknown>> = [];
  try {
    const racers: Array<{ child: ChildProcess; done: WaitHandle<WorkerOutcome> }> = [];
    for (const spec of specs) {
      const { child, done } = forkRacer(dbPath, spec, env);
      // Tracked BEFORE any await: a startup failure in the READY wait below
      // still reaches the finally kill/reap for this child.
      children.push(child);
      pendingCancels.push((r) => done.cancel(r));
      taps.push(done.promise.catch(() => {}));
      const ready = waitForMessage<true>(
        child,
        (m) => (m?.type === "READY" ? true : null),
        "ready-wait",
      );
      pendingCancels.push((r) => ready.cancel(r));
      taps.push(ready.promise.catch(() => {}));
      await ready.promise;
      racers.push({ child, done });
    }
    for (const r of racers) r.child.send?.({ type: "GO" });
    const outcomes = await Promise.all(racers.map((r) => r.done.promise));
    // Bind each reported mode to the spec its racer was forked with, so racer
    // identity survives IPC rather than resting on array position.
    outcomes.forEach((o, i) => {
      expect(o.mode).toBe(specs[i].mode);
    });
    const exits = children.map((child) => waitForExit(child).promise);
    for (const p of exits) taps.push(p.catch(() => {}));
    await Promise.all(exits);
    return outcomes;
  } finally {
    // 1) Settle/cancel every outstanding wait first — each detaches only its
    //    own listeners and clears its own timer.
    for (const cancel of pendingCancels) cancel("race teardown");
    // 2) Kill every tracked child (kill on an already-dead child is a no-op).
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    // 3) Bounded reap (5s); rejection errors swallowed so teardown never masks
    //    the original failure. Terminal statuses are asserted by the cleanup tests.
    await Promise.allSettled(children.map((child) => waitForExit(child, 5000).promise));
    // 4) Every wait is settled; the taps guarantee no unobserved rejection.
    await Promise.allSettled(taps);
  }
}

describe("Agent review terminal races (cross-process, real connections)", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `orcy-agent-review-race-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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

  interface Seed {
    taskId: string;
    reviewerA: string;
    reviewerB: string;
  }

  /** Builds a submitted task with two pending agent reviewer rows on the file DB. */
  function seedTask(): Seed {
    const worker = agentRepo.createAgent({
      name: "race-worker",
      type: "codex",
      domain: "fullstack",
    });
    const a = agentRepo.createAgent({
      name: "race-reviewer-a",
      type: "codex",
      domain: "fullstack",
    });
    const b = agentRepo.createAgent({
      name: "race-reviewer-b",
      type: "codex",
      domain: "fullstack",
    });
    const habitat = habitatRepo.createHabitat({ name: "Race Habitat" });
    const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Backlog" });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: column.id,
      title: "Race Mission",
      createdBy: "seed",
    });
    const task = taskRepo.createTask({
      missionId: mission.id,
      title: "Race Task",
      createdBy: "seed",
    });
    taskRepo.claimTask(task.id, worker.agent.id);
    taskRepo.startTask(task.id, worker.agent.id);
    const submitted = taskRepo.submitTask(task.id, worker.agent.id, "race work", []);
    if (!submitted) throw new Error("seed: submitTask failed");
    taskReviewerRepo.create(task.id, "agent", a.agent.id);
    taskReviewerRepo.create(task.id, "agent", b.agent.id);
    return { taskId: task.id, reviewerA: a.agent.id, reviewerB: b.agent.id };
  }

  function terminalEventRows(taskId: string): Array<{ action: string }> {
    return (getDb().select().from(taskEvents).all() as any[]).filter(
      (r) => r.taskId === taskId && (r.action === "approved" || r.action === "rejected"),
    );
  }

  it("approve ∥ reject on the same task: exactly one terminal transition and one terminal event", async () => {
    await initDb(dbPath);
    const seed = seedTask();
    closeDb();

    const outcomes = await runRace(dbPath, [
      { mode: "approve", taskId: seed.taskId, reviewerId: seed.reviewerA },
      { mode: "reject", taskId: seed.taskId, reviewerId: seed.reviewerB },
    ]);

    await initDb(dbPath);
    const task = taskRepo.getTaskById(seed.taskId)!;
    const terminals = terminalEventRows(seed.taskId);

    expect(["approved", "rejected"]).toContain(task.status);
    expect(terminals).toHaveLength(1);
    expect(terminals[0].action).toBe(task.status);
    expect(outcomes).toHaveLength(2);
    // The racer whose terminal LANDED reports success. The other either
    // failed cleanly (no false terminal success) or — approve side only —
    // recorded a legitimate non-terminal partial approval (the rejector's
    // row stays pending; de facto rejector-must-re-approve).
    const winner = task.status === "approved" ? 0 : 1;
    expect(outcomes[winner].ok).toBe(true);
    expect(outcomes[winner].outcome).toBe("ok");
    const loser = 1 - winner;
    if (!outcomes[loser].ok) {
      // A non-ok racer must classify WHY: "refused" (production returned null
      // without throwing) or "error" (a real throw, which owes a message).
      // The old unconditional `error` truthy assertion demanded an exception
      // where a normal null return is the correct production behaviour.
      expect(["refused", "error"]).toContain(outcomes[loser].outcome);
      if (outcomes[loser].outcome === "refused") {
        expect(outcomes[loser].error).toBeUndefined();
      } else {
        expect(outcomes[loser].error).toBeTruthy();
      }
    }
    closeDb();
  }, 300000);

  it("approve ∥ approve on the last two pending reviewers: one transition, both rows recorded", async () => {
    await initDb(dbPath);
    const seed = seedTask();
    closeDb();

    const outcomes = await runRace(dbPath, [
      { mode: "approve", taskId: seed.taskId, reviewerId: seed.reviewerA },
      { mode: "approve", taskId: seed.taskId, reviewerId: seed.reviewerB },
    ]);

    await initDb(dbPath);
    const task = taskRepo.getTaskById(seed.taskId)!;
    const terminals = terminalEventRows(seed.taskId);
    const rowA = taskReviewerRepo.findByTaskAndReviewer(seed.taskId, seed.reviewerA);
    const rowB = taskReviewerRepo.findByTaskAndReviewer(seed.taskId, seed.reviewerB);

    expect(task.status).toBe("approved");
    expect(terminals).toHaveLength(1);
    // The finality gate serializes bookkeeping: both approvals are durable
    // even though only one process performs the terminal transition.
    expect(rowA?.status).toBe("approved");
    expect(rowB?.status).toBe("approved");
    // At most one racer reports failure (the terminal-write loser); the
    // reviewer-row state above is the durable truth either way.
    expect(outcomes.filter((o) => o.ok).length).toBeGreaterThanOrEqual(1);
    closeDb();
  }, 300000);

  it("harness cleanup: already-exited child fails the READY wait fast; runRace teardown is bounded with no unhandled rejection", async () => {
    // First racer's garbage argv → the worker exits (code 2) before READY while
    // the second racer would park on GO forever — only the finally cancel/kill/
    // reap ends it. Bounded completion + zero unhandled rejections is the proof.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(
        runRace(dbPath, [
          { mode: "approve", taskId: "", reviewerId: "" },
          { mode: "approve", taskId: "t", reviewerId: "r" },
        ]),
      ).rejects.toThrow(/already exited|exited before matching message/);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  }, 60000);

  it("harness cleanup: wedged child is bounded — message wait SIGKILLs with status, exit wait then resolves", async () => {
    // HANG mode: worker READYs (own fresh db) then swallows GO — no RESULT, no
    // exit. A short-budget message wait must kill the child and reject with a
    // status-bearing message; the follow-up exit wait resolves (reaped).
    const { child, done } = forkRacer(
      dbPath,
      { mode: "approve", taskId: "t", reviewerId: "r" },
      { ORCY_RACE_WORKER_HANG: "1" },
    );
    // Tap at creation: the long-budget RESULT wait is superseded by the short
    // probe below — its eventual settle must never surface as unhandled.
    done.promise.catch(() => {});
    try {
      const ready = waitForMessage<true>(
        child,
        (m) => (m?.type === "READY" ? true : null),
        "ready-wait",
      );
      await ready.promise;
      child.send?.({ type: "GO" });
      await expect(
        waitForMessage<Pick<WorkerOutcome, "ok">>(
          child,
          (m) => (m?.type === "RESULT" ? { ok: m.ok === true } : null),
          "result-wait",
          2000,
        ).promise,
      ).rejects.toThrow(/timed out after 2000ms/);
      await expect(waitForExit(child, 5000).promise).resolves.toBeUndefined();
      expect([child.exitCode, child.signalCode]).not.toEqual([null, null]);
    } finally {
      done.cancel("test teardown");
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 60000);
});
