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

const WORKER = join(import.meta.dirname, "fixtures", "agentReviewDecisionRaceWorker.ts");

interface RaceSpec {
  mode: "approve" | "reject";
  reviewerId: string;
}

interface WorkerOutcome {
  ok: boolean;
  error?: string;
}

/** Resolves on the FIRST message matching `match` (other messages keep waiting). */
function waitForMessage<T>(child: ChildProcess, match: (m: any) => T | null): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("race worker timed out")), 200000);
    const handler = (m: any) => {
      const v = match(m);
      if (v !== null) {
        clearTimeout(timer);
        child.off("message", handler);
        child.off("exit", onExit);
        resolve(v);
      }
    };
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      reject(new Error(`race worker exited before matching message (code=${code})`));
    };
    child.on("message", handler);
    child.on("exit", onExit);
  });
}

function forkRacer(dbPath: string, spec: RaceSpec & { taskId: string }): { child: ChildProcess; done: Promise<WorkerOutcome> } {
  const child = fork(WORKER, [dbPath, spec.mode, spec.taskId, spec.reviewerId, "race reject"], {
    execArgv: ["--import", "tsx"],
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  child.stderr?.on("data", () => {
    /* worker noise must not fail the parent */
  });
  const done = waitForMessage<WorkerOutcome>(child, (m) =>
    m?.type === "RESULT" ? { ok: m.ok === true, error: m.error } : null,
  );
  return { child, done };
}

async function runRace(dbPath: string, specs: Array<RaceSpec & { taskId: string }>): Promise<WorkerOutcome[]> {
  // Stagger forks: each worker loads the module graph + connects before READY.
  // Serial startup keeps the two connection setups from contending; only the
  // DECISION calls race after GO.
  const racers: Array<{ child: ChildProcess; done: Promise<WorkerOutcome>; ready: Promise<true> }> = [];
  for (const spec of specs) {
    const { child, done } = forkRacer(dbPath, spec);
    const ready = waitForMessage<true>(child, (m) => (m?.type === "READY" ? true : null));
    await ready;
    racers.push({ child, done, ready });
  }
  for (const r of racers) r.child.send?.({ type: "GO" });
  const outcomes = await Promise.all(racers.map((r) => r.done));
  await Promise.all(
    racers.map((r) => new Promise<void>((resolve) => r.child.once("exit", () => resolve()))),
  );
  return outcomes;
}

describe("Agent review terminal races (cross-process, real connections)", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `orcy-agent-review-race-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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
    const worker = agentRepo.createAgent({ name: "race-worker", type: "codex", domain: "fullstack" });
    const a = agentRepo.createAgent({ name: "race-reviewer-a", type: "codex", domain: "fullstack" });
    const b = agentRepo.createAgent({ name: "race-reviewer-b", type: "codex", domain: "fullstack" });
    const habitat = habitatRepo.createHabitat({ name: "Race Habitat" });
    const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Backlog" });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: column.id,
      title: "Race Mission",
      createdBy: "seed",
    });
    const task = taskRepo.createTask({ missionId: mission.id, title: "Race Task", createdBy: "seed" });
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
    const loser = 1 - winner;
    if (!outcomes[loser].ok) {
      expect(outcomes[loser].error).toBeTruthy();
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
});
