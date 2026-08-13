/**
 * LL-TEST-1 — Multi-process fresh-rerun concurrency proof for the Learning Loop.
 *
 * Proves that two concurrent child processes requesting fresh-reruns on the same
 * policy allocate distinct, strictly monotonic generation numbers (e.g. Generation 1
 * and Generation 2) via `behavior: "immediate"` SQLite transactions without collisions,
 * deadlocks, or `SQLITE_BUSY` crashes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { eq, desc } from "drizzle-orm";
import { closeDb, getDb, initDb } from "../db/index.js";
import { extractionWorkItems } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import { createPolicyWithClient, updatePolicyWithClient } from "../repositories/extraction/index.js";

const WORKER = join(import.meta.dirname, "fixtures", "extraction-rerun-worker.ts");
const TEMP_DIR = join(import.meta.dirname, "..", "..", ".test-extraction-rerun");

interface WorkerMessage {
  type: "READY" | "RESULT" | "ERROR";
  outcome?: string;
  rerunGeneration?: number | null;
  workItemId?: string | null;
  supersedesWorkId?: string | null;
  message?: string;
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${dbPath}${suffix}`)) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore
      }
    }
  }
}

describe("Learning Loop fresh-rerun multi-process concurrency (LL-TEST-1)", () => {
  let dbPath: string;

  beforeEach(() => {
    process.env.ORCY_LEARNING_LOOP_ENABLED = "true";
    if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
    dbPath = join(TEMP_DIR, `rerun-conc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    cleanupDb(dbPath);
    closeDb();
  });

  afterEach(() => {
    closeDb();
    cleanupDb(dbPath);
  });

  it("two concurrent worker processes allocate distinct monotonic rerun generations", async () => {
    // 1. Parent setup: init file DB + create habitat + policy
    await initDb(dbPath);
    const db = getDb();

    const habitat = habitatRepo.createHabitat({ name: "LL Concurrency Habitat" });
    const policyResult = createPolicyWithClient(db, {
      habitatId: habitat.id,
      extractorKey: "builtin:pattern_v1",
      sourceTypes: ["task_lifecycle_audit"],
      schedule: "*/5 * * * *",
      windowSeconds: 3600,
      lookbackSeconds: 86400,
      minConfidence: 0.7,
      minSampleSize: 5,
    });

    if (policyResult.outcome !== "created") {
      throw new Error("Failed to create policy in test setup");
    }
    const policyId = policyResult.policy.id;

    // Enable the policy (policies default to enabled: false per ADR-0044)
    const updateResult = updatePolicyWithClient(db, {
      policyId,
      expectedVersion: 1,
      enabled: true,
    });
    if (updateResult.outcome !== "updated") {
      throw new Error("Failed to enable policy in test setup");
    }

    // Close parent DB before forking so child processes start clean
    closeDb();

    // 2. Helper to fork worker
    const forkWorker = (
      label: string,
      reason: string,
    ): {
      child: ChildProcess;
      ready: Promise<void>;
      result: Promise<WorkerMessage>;
    } => {
      const child = fork(WORKER, [dbPath, habitat.id, policyId, reason], {
        execArgv: ["--import", "tsx"],
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        console.warn(`[worker-${label} stderr]:`, chunk.toString());
      });

      const ready = new Promise<void>((resolve, reject) => {
        const onMessage = (msg: WorkerMessage): void => {
          if (msg?.type === "READY") {
            child.off("message", onMessage);
            resolve();
          }
        };
        child.on("message", onMessage);
        child.on("exit", (code, signal) => {
          reject(new Error(`worker ${label} exited (code=${code}, signal=${signal}) before READY`));
        });
      });

      const result = new Promise<WorkerMessage>((resolve) => {
        const onMessage = (msg: WorkerMessage): void => {
          if (msg?.type === "RESULT" || msg?.type === "ERROR") {
            child.off("message", onMessage);
            resolve(msg);
          }
        };
        child.on("message", onMessage);
      });

      return { child, ready, result };
    };

    const w1 = forkWorker("1", "rerun from worker 1");
    const w2 = forkWorker("2", "rerun from worker 2");

    try {
      // Wait for both workers to be ready
      await Promise.all([w1.ready, w2.ready]);

      // Trigger simultaneous execution
      w1.child.send({ type: "GO" });
      w2.child.send({ type: "GO" });

      // Collect results
      const [r1, r2] = await Promise.all([w1.result, w2.result]);

      if (r1.type === "ERROR") console.warn("[worker-1 ERROR]:", r1.message);
      if (r2.type === "ERROR") console.warn("[worker-2 ERROR]:", r2.message);

      expect(r1.type).toBe("RESULT");
      expect(r2.type).toBe("RESULT");

      // Verify outcomes are successful
      expect(["executed", "deduplicated"]).toContain(r1.outcome);
      expect(["executed", "deduplicated"]).toContain(r2.outcome);

      // Verify distinct monotonic rerun generation numbers
      const gen1 = r1.rerunGeneration;
      const gen2 = r2.rerunGeneration;

      expect(gen1).not.toBeNull();
      expect(gen2).not.toBeNull();
      expect(gen1).not.toEqual(gen2);

      const generations = [gen1!, gen2!].sort((a, b) => a - b);
      expect(generations).toEqual([1, 2]);

      // Re-open DB in parent to verify database state
      await initDb(dbPath);
      const verifyDb = getDb();

      const items = verifyDb
        .select()
        .from(extractionWorkItems)
        .where(eq(extractionWorkItems.policyId, policyId))
        .orderBy(desc(extractionWorkItems.rerunGeneration))
        .all();

      expect(items).toHaveLength(2);
      expect(items[0].rerunGeneration).toBe(2);
      expect(items[1].rerunGeneration).toBe(1);

      // Gen 2 supersedes Gen 1
      expect(items[0].supersedesWorkId).toBe(items[1].id);
    } finally {
      w1.child.kill();
      w2.child.kill();
    }
  });
});
