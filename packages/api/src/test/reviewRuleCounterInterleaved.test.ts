/**
 * Interleaved review-rule counter proof — REAL repository invocation under a
 * test-owned seam barrier (two-file counter grant, per storage-fixture-recheck).
 *
 * Schedule (forced, verifiable): the ORIGINAL writer runs the ACTUAL
 * reviewRule.update; a test-owned interception in the forked worker blocks
 * that invocation synchronously between its getById pre-read and its UPDATE
 * (filesystem gate — a genuinely wakeable barrier; no IPC callbacks needed
 * while blocked); the SECOND writer — another real process running the real
 * repository update on its own connection — commits while the original is
 * blocked; the gate releases and the SAME original invocation completes.
 *
 * Required discriminator: original's pre-read observes 1, second writer
 * persists 2, resumed SAME original call persists 3 (native SQL derives from
 * the row). The held read-derived implementation would persist 2 on this
 * identical schedule (it writes pre-read+1). No mutation replay is performed;
 * that counterfactual is documented, not executed.
 *
 * Harness hygiene: worker error/early-exit rejects promptly; every child is
 * killed and its exit awaited in a finally block, so an assertion failure
 * cannot hang until the outer timeout.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fork, type ChildProcess } from "node:child_process";
import { initDb, closeDb, getDb } from "../db/index.js";
import * as reviewRule from "../repositories/reviewRule.js";
import * as habitatRepo from "../repositories/habitat.js";
import { reviewRules } from "../db/schema/index.js";
import { eq } from "drizzle-orm";

const WORKER = join(import.meta.dirname, "fixtures", "rule-counter-race-worker.ts");

interface WorkerMsg {
  type?: string;
  kind?: string;
  version?: number | null;
  message?: string;
}

interface OwnedWorker {
  child: ChildProcess;
  /** Next non-READY message; rejects on abnormal early exit. */
  next: () => Promise<WorkerMsg>;
  send: (m: { type: string }) => void;
  /** Kill and await actual exit. Safe to call twice. */
  dispose: () => Promise<void>;
}

function forkWorker(dbPath: string, ruleId: string, mode: string, gateDir?: string, gateRelease?: string): OwnedWorker {
  const args = [dbPath, ruleId, mode];
  if (gateDir) args.push(gateDir, gateRelease!);
  const child = fork(WORKER, args, {
    execArgv: ["--import", "tsx"],
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const queue: WorkerMsg[] = [];
  const waiters: ((m: WorkerMsg | PromiseLike<WorkerMsg>) => void)[] = [];
  let exited = false;
  let exitInfo: { code: number | null } | null = null;
  child.on("message", (msg: WorkerMsg) => {
    if (msg.type === "READY") return; // banner, not a result
    if (waiters.length > 0) waiters.shift()!(msg);
    else queue.push(msg);
  });
  child.on("exit", (code) => {
    exited = true;
    exitInfo = { code };
    // A worker exiting WITHOUT delivering a result rejects pending waits
    // loudly instead of hanging to the outer timeout.
    while (waiters.length > 0) {
      waiters.shift()!(Promise.reject(new Error(`worker ${mode} exited early (code ${code}) with ${queue.length} queued result(s)`)));
    }
  });
  const exitedPromise = new Promise<void>((resolve) => {
    if (exited) resolve();
    else child.on("exit", () => resolve());
  });
  return {
    child,
    next: () =>
      new Promise<WorkerMsg>((resolve, reject) => {
        if (exitInfo && queue.length === 0) {
          reject(new Error(`worker ${mode} already exited (code ${exitInfo.code})`));
          return;
        }
        if (queue.length > 0) resolve(queue.shift()!);
        else waiters.push(resolve);
      }),
    send: (m) => void child.send(m),
    dispose: async () => {
      if (!exited) {
        child.kill("SIGTERM");
        await Promise.race([exitedPromise, new Promise<void>((r) => setTimeout(r, 3000))]);
        if (!exited) child.kill("SIGKILL");
      }
      await exitedPromise;
    },
  };
}

describe("review-rule counter — the ACTUAL repository update interleaved at its own seam", () => {
  let dbPath: string;
  let dir: string;
  let ruleId: string;

  beforeAll(async () => {
    await closeDb();
    dir = mkdtempSync(join(tmpdir(), "rf-counter3-"));
    dbPath = join(dir, "counter.db");
    await initDb(dbPath);
    const habitat = habitatRepo.createHabitat({ name: `rc-${Math.random()}` });
    const created = reviewRule.create(habitat.id, { name: "seed-rule" });
    ruleId = created.id;
  });

  afterAll(async () => {
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it("original reads 1; second real repository write persists 2; the SAME original invocation resumes and persists 3", async () => {
    const gateDir = join(dir, "gate");
    mkdirSync(gateDir, { recursive: true });
    const releaseName = `release-${Math.random()}`;

    const original = forkWorker(dbPath, ruleId, "preread", gateDir, releaseName);
    try {
      original.send({ type: "GO" });
      // Wait until the original invocation is BLOCKED at its seam (its
      // getById pre-read inside reviewRule.update has already completed).
      const deadline = Date.now() + 30_000;
      while (!existsSync(join(gateDir, "entered"))) {
        // Fail fast: a worker that dies before reaching its seam must not
        // burn the full 30s window — the failure is the worker's, not a hang.
        // exit OR signal: SIGTERM/SIGKILL leave exitCode null, so the exit
        // test alone would miss a killed worker and keep polling.
        if (original.child.exitCode !== null || original.child.signalCode !== null) {
          throw new Error(
            `original writer exited early (code ${original.child.exitCode}, signal ${original.child.signalCode}) before reaching its seam`,
          );
        }
        if (Date.now() > deadline) throw new Error("original writer never reached its seam");
        await new Promise((r) => setTimeout(r, 25));
      }

      // SECOND writer: the real repository update on its OWN connection,
      // while the original is blocked between its pre-read and UPDATE.
      const second = forkWorker(dbPath, ruleId, "update");
      try {
        second.send({ type: "GO" });
        const secondMsg = await second.next();
        expect(secondMsg.kind).toBe("ok");
        expect(secondMsg.version).toBe(2); // create=1 -> 2
      } finally {
        await second.dispose();
      }

      // Release the gate: the SAME original reviewRule.update call resumes.
      writeFileSync(join(gateDir, releaseName), "1");
      const originalMsg = await original.next();
      expect(originalMsg.kind).toBe("ok");
      // The repository's own return value: native SQL derived from the row
      // (2), NOT its stale pre-read (1). The held read-derived expression
      // would have returned/persisted 2 on this identical schedule.
      expect(originalMsg.version).toBe(3);

      // Persisted truth agrees.
      const row = getDb().select().from(reviewRules).where(eq(reviewRules.id, ruleId)).get();
      expect(row?.version).toBe(3);
    } finally {
      await original.dispose();
    }
  }, 60_000);
});
