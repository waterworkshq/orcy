/**
 * Production deliverer wiring guard (compiled boot smoke).
 *
 * Seeds a real file DB (better-sqlite3) through the REAL act-tx path with a
 * failed task whose retry_ladder receipt is pending-and-eligible (siblings
 * delivered), then launches the REAL compiled production entry
 * (`node dist/index.js`) against that DB and asserts the DURABLE OUTCOME —
 * the receipt reaches `delivered` and exactly one `retry_scheduled` event
 * exists — WITHOUT any direct `processEffectReceipts` call. This is the
 * operability proof that the boot-owned deliverer actually owns the pipeline
 * (removing `startEffectDeliverer()` + the boot reconciliation pass from
 * index.ts must turn this test RED). SIGTERM must exit 0 (drain-aware stop
 * before DB close).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { closeDb, initDb, getDb } from "../db/index.js";
import { tasks, effectReceipts } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import { failTask } from "../services/tasks/task-lifecycle.js";
import { processEffectReceipts } from "../services/effects/effectDeliverer.js";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const DIST_ENTRY = join(PACKAGE_ROOT, "dist", "index.js");
const STRONG_JWT = "t2-boot-smoke-only-jwt-secret-0123456789abcdef0123456789abcdef";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => resolve((addr as { port: number }).port));
    });
  });
}

describe("Effect deliverer production boot smoke (compiled entry)", () => {
  beforeAll(() => {
    expect(DIST_ENTRY).toBeTruthy();
  });

  it("boot owns the pipeline: pending eligible retry receipt reaches its durable outcome without any in-process drain call", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), `orcy-t2-boot-${process.pid}-`));
    const dbPath = join(tempDir, "boot.db");
    const port = await getFreePort();

    try {
      // ── Seed through the REAL act-tx on a real file DB ────────────────────
      await initDb(dbPath);
      const habitat = habitatRepo.createHabitat({ name: "T2 Boot Smoke" });
      const columnId = columnRepo.createColumn({
        habitatId: habitat.id,
        name: "T",
        order: 0,
        requiresClaim: false,
      }).id;
      const agent = agentRepo.createAgent({
        name: "boot-agent",
        type: "claude-code",
        domain: "fullstack",
        capabilities: [],
      }).agent;
      const mission = missionRepo.createMission({
        habitatId: habitat.id,
        columnId,
        title: "boot-m",
        createdBy: "u",
      });
      const task = taskRepo.createTask({ missionId: mission.id, title: "boot-t", createdBy: "u" });
      taskStateMachine.claimTask(task.id, agent.id);
      taskStateMachine.startTask(task.id, agent.id);
      getDb()
        .update((await import("../db/schema/index.js")).tasks)
        .set({
          retryPolicy: {
            maxRetries: 3,
            backoffBase: 60,
            backoffMultiplier: 2,
            maxBackoff: 3600,
            escalateToHuman: true,
            retryOnStatuses: ["all"],
          },
        })
        .where(
          (await import("drizzle-orm")).eq(
            (await import("../db/schema/index.js")).tasks.id,
            task.id,
          ),
        )
        .run();
      const failed = failTask(task.id, agent.id, "agent", "boot-smoke");
      expect(failed).not.toBeNull();

      // Seed the exact durable state a crash between sibling delivery and
      // retry delivery leaves: hold the gates receipt PENDING (R-1 barrier —
      // context/retry cannot deliver), deliver the independent sibling, then
      // flip the barrier on disk. The retry receipt stays PENDING and
      // ELIGIBLE — only the boot-owned deliverer can finish it.
      getDb()
        .update(effectReceipts)
        .set({ state: "pending" })
        .where(eq(effectReceipts.consumer, "workflow_gates"))
        .run();
      await processEffectReceipts(); // skill delivers; context/retry barrier-blocked
      const preRetry = getDb()
        .select({ state: effectReceipts.state })
        .from(effectReceipts)
        .where(eq(effectReceipts.consumer, "retry_ladder"))
        .get()!;
      expect(preRetry.state).toBe("pending"); // barrier held during seeding
      // Flip the barrier: siblings are now all terminal on disk (the exact
      // state a crash after sibling delivery leaves).
      getDb()
        .update(effectReceipts)
        .set({ state: "delivered", deliveredAt: new Date().toISOString() })
        .where(eq(effectReceipts.consumer, "workflow_gates"))
        .run();
      getDb()
        .update(effectReceipts)
        .set({ state: "delivered", deliveredAt: new Date().toISOString() })
        .where(eq(effectReceipts.consumer, "failure_context"))
        .run();
      closeDb();

      // ── Launch the REAL compiled production entry ─────────────────────────
      const child = spawn(process.execPath, [DIST_ENTRY], {
        env: {
          ...process.env,
          NODE_ENV: "production",
          DB_PATH: dbPath,
          PORT: String(port),
          HOST: "127.0.0.1",
          JWT_SECRET: STRONG_JWT,
          ORCY_REGISTRATION_TOKEN: "t2-boot-smoke-only-token",
          LOG_LEVEL: "error",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      let exited = false;
      let exitCode: number | null = null;
      child.on("exit", (code) => {
        exited = true;
        exitCode = code;
      });

      try {
        // Wait for readiness — the boot reconciliation pass runs before listen.
        const deadline = Date.now() + 30_000;
        let ready = false;
        while (Date.now() < deadline && !ready) {
          if (exited)
            throw new Error(`compiled API exited early (code=${exitCode})\n${stdout}\n${stderr}`);
          try {
            const res = await fetch(`http://127.0.0.1:${port}/health`);
            if (res.ok && ((await res.json()) as { status?: string }).status === "ok") ready = true;
          } catch {
            /* not ready yet */
          }
          if (!ready) await new Promise((r) => setTimeout(r, 400));
        }
        expect(ready).toBe(true);

        // Assert the DURABLE OUTCOME from the DB file (no in-process drain).
        const probe = new Database(dbPath, { readonly: true });
        try {
          const receipt = probe
            .prepare("SELECT state, attempts FROM effect_receipts WHERE consumer = 'retry_ladder'")
            .get() as { state: string; attempts: number };
          expect(receipt.state).toBe("delivered");
          expect(receipt.attempts).toBeGreaterThanOrEqual(1);
          const scheduled = probe
            .prepare(
              "SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND action = 'retry_scheduled'",
            )
            .get(task.id) as { n: number };
          expect(scheduled.n).toBe(1); // exactly one — no duplicate arming
          const next = probe
            .prepare("SELECT next_retry_at FROM tasks WHERE id = ?")
            .get(task.id) as { next_retry_at: string | null };
          expect(next.next_retry_at).not.toBeNull();
        } finally {
          probe.close();
        }

        // Drain-aware stop: SIGTERM exits 0 (deliverer stopped before closeDb).
        const cleanExit = await new Promise<number | null>((resolveExit) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolveExit(null);
          }, 15_000);
          child.on("exit", (code) => {
            clearTimeout(timer);
            resolveExit(code);
          });
          child.kill("SIGTERM");
        });
        expect(cleanExit).toBe(0);
      } finally {
        if (!exited) child.kill("SIGKILL");
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 120_000);
});
