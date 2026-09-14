/**
 * Daemon worker contract — production boot smoke (acceptance items 6 + 12).
 *
 * Seeds a real file DB (better-sqlite3) with the EXACT durable state a crash
 * between the release act-tx commit and receipt delivery leaves — the
 * release write, pointer, `released` event, and two PENDING receipts for a
 * workflow with a live `on_fail` gate + failure handler — then launches the
 * REAL compiled production entry (`node dist/index.js`) and asserts DURABLE
 * OUTCOMES ONLY (receipt delivery, gate stamp, handoff consumption, recovery
 * spawn, failure-context capture): never event presence. The boot sweep's
 * ghost recovery (a stale-heartbeat ghost session whose drive never ran) is
 * asserted the same way. SIGTERM must exit 0 (bounded embedded drain + sweep
 * interval cleared before closeDb).
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
import {
  tasks,
  taskEvents,
  workflows,
  taskWorkflowGates,
  daemonSessions,
  daemonInstances,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as daemonInstanceRepo from "../repositories/daemonInstance.js";
import { createDaemonSessionWithClient } from "../repositories/daemonSession.js";
import { releaseTaskWithEffects } from "../services/effects/releaseEffects.js";
import { DAEMON_STALE_HEARTBEAT_MS } from "../services/daemonSessionRecovery.js";
import type { Task } from "../models/index.js";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const DIST_ENTRY = join(PACKAGE_ROOT, "dist", "index.js");
const STRONG_JWT = "daemon-recovery-boot-smoke-jwt-0123456789abcdef0123456789abcdef";

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

beforeAll(() => {
  expect(DIST_ENTRY).toBeTruthy();
});

describe("daemon recovery boot smoke (compiled entry)", () => {
  it("boot delivers the crashed release's gates/context (receipt-asserted), sweeps ghosts, and SIGTERM exits 0", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), `orcy-daemon-boot-${process.pid}-`));
    const dbPath = join(tempDir, "boot.db");
    const port = await getFreePort();

    try {
      // ── Seed through the REAL seams on a real file DB ────────────────────
      await initDb(dbPath);
      const habitat = habitatRepo.createHabitat({ name: "Daemon Boot Smoke" });
      const habitatId = habitat.id;
      const columnId = columnRepo.createColumn({
        habitatId,
        name: "T",
        order: 0,
        requiresClaim: false,
      }).id;
      const agentId = agentRepo.createAgent({
        name: "boot-agent",
        type: "claude-code",
        domain: "fullstack",
        capabilities: [],
      }).agent.id;
      const daemonId = daemonInstanceRepo.createDaemon({
        name: "boot-daemon",
        hostname: "test",
        maxConcurrent: 4,
        daemonVersion: "test",
        plainToken: "tok",
        metadata: {},
      }).id;

      // (1) The crashed release: workflow with a live on_fail gate + handler.
      const mission1 = missionRepo.createMission({
        habitatId,
        columnId,
        title: "rel-m",
        createdBy: "u",
      });
      const upstream = taskRepo.createTask({
        missionId: mission1.id,
        title: "rel-up",
        createdBy: "u",
      });
      const downstream = taskRepo.createTask({
        missionId: mission1.id,
        title: "rel-down",
        createdBy: "u",
      });
      getDb()
        .insert(workflows)
        .values({
          id: "wf-rel",
          missionId: mission1.id,
          habitatId,
          status: "active",
          createdBy: "u",
          failureHandler: {
            recoveryTaskTemplate: { title: "Recover: {{failedTaskTitle}}" },
          },
        })
        .run();
      getDb()
        .insert(taskWorkflowGates)
        .values({
          id: "gate-rel",
          workflowId: "wf-rel",
          missionId: mission1.id,
          habitatId,
          upstreamTaskId: upstream.id,
          downstreamTaskId: downstream.id,
          gateType: "on_fail",
          satisfied: false,
          recoveryDepth: 0,
        })
        .run();
      const claim1 = taskStateMachine.claimTask(upstream.id, agentId);
      expect(claim1.success).toBe(true);
      const preImage = { ...taskRepo.getTaskById(upstream.id)! } as Task;
      // The act-tx commits; the process "crashes" before any delivery.
      const released = releaseTaskWithEffects({
        taskId: upstream.id,
        actorId: "daemon-recovery",
        reason: "daemon_session_released",
        preImage,
      });
      expect(released).not.toBeNull();
      const releaseEventId = released!.eventId;

      // (2) The unswept ghost: stale daemon heartbeat, running session,
      // in_progress tokened task — exactly a crash between the session
      // write and any sweep/drive.
      const mission2 = missionRepo.createMission({
        habitatId,
        columnId,
        title: "ghost-m",
        createdBy: "u",
      });
      const ghostTask = taskRepo.createTask({
        missionId: mission2.id,
        title: "ghost-t",
        createdBy: "u",
      });
      const claim2 = taskStateMachine.claimTask(ghostTask.id, agentId);
      expect(claim2.success).toBe(true);
      const ghostStarted = taskStateMachine.startTask(ghostTask.id, agentId);
      expect(ghostStarted?.status).toBe("in_progress");
      const { id: ghostSessionId } = createDaemonSessionWithClient(
        getDb(),
        { daemonId, agentId, taskId: ghostTask.id, habitatId, workdir: "/tmp/wd" },
        ghostStarted!.executionToken!,
      );
      getDb()
        .update(daemonSessions)
        .set({ status: "running" })
        .where(eq(daemonSessions.id, ghostSessionId))
        .run();
      getDb()
        .update(daemonInstances)
        .set({
          lastHeartbeatAt: new Date(
            Date.now() - (DAEMON_STALE_HEARTBEAT_MS + 120_000),
          ).toISOString(),
        })
        .where(eq(daemonInstances.id, daemonId))
        .run();

      // Sanity: the release receipts are pending-and-eligible at seed time.
      const pending = new Database(dbPath, { readonly: true })
        .prepare(
          "SELECT COUNT(*) AS n FROM effect_receipts WHERE subject_id = ? AND state = 'pending'",
        )
        .get(releaseEventId) as { n: number };
      expect(pending.n).toBe(2);
      closeDb();

      // ── Launch the REAL compiled production entry ────────────────────────
      const child = spawn(process.execPath, [DIST_ENTRY], {
        env: {
          ...process.env,
          NODE_ENV: "production",
          DB_PATH: dbPath,
          PORT: String(port),
          HOST: "127.0.0.1",
          JWT_SECRET: STRONG_JWT,
          ORCY_REGISTRATION_TOKEN: "daemon-recovery-boot-smoke-token",
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
        // What actually runs before/around listen: the deliverer's boot
        // reconciliation pass (eager, once — delivers the release's
        // workflow_gates receipt), the daemon-recovery boot sweep (eager,
        // once — terminalizes + drives the ghost, whose act-tx arms another
        // eager pass), and behind them the deliverer's 5 s interval as
        // backstop. Receipt delivery is NOT synchronous: failure_context is
        // R-1 barrier-blocked behind workflow_gates and completes on one of
        // those LATER passes — this wait covers that cadence; it is not a
        // guarantee that delivery finished before listen.
        await new Promise((r) => setTimeout(r, 2_000));

        // ── DURABLE OUTCOMES from the DB file (never event presence) ──────
        const probe = new Database(dbPath, { readonly: true });
        try {
          // (1) Release effects: both receipts delivered by the boot pass.
          const receipts = probe
            .prepare(
              "SELECT consumer, state FROM effect_receipts WHERE subject_id = ? ORDER BY consumer",
            )
            .all(releaseEventId) as Array<{ consumer: string; state: string }>;
          expect(receipts).toEqual([
            { consumer: "failure_context", state: "delivered" },
            { consumer: "workflow_gates", state: "delivered" },
          ]);

          // The gate was satisfied BY the release event inside the
          // unclaimed-pending window (the spawn fence held at boot).
          const gate = probe
            .prepare(
              "SELECT satisfied, satisfied_by_event_id, recovery_task_id FROM task_workflow_gates WHERE id = 'gate-rel'",
            )
            .get() as {
            satisfied: number;
            satisfied_by_event_id: string | null;
            recovery_task_id: string | null;
          };
          expect(gate.satisfied).toBe(1);
          expect(gate.satisfied_by_event_id).toBe(releaseEventId);

          // The recovery task spawned through the receipt-path unit's
          // durable reconciliation — the rev-4 residual pin: the gates
          // consumer triggers the same recovery-coordinator pass the live
          // seam does (workflowService.ts:208). The spawn's durable markers
          // are the task row + the gate CAS link + the handoff row; the
          // handoff stays `expected` until the dispatch workers finish the
          // attempt checkpoint (consumption is their lifecycle, not the
          // spawn's).
          const handoff = probe
            .prepare("SELECT status FROM task_recovery_handoffs WHERE gate_id = 'gate-rel'")
            .get() as { status: string } | undefined;
          expect(["expected", "consumed"]).toContain(handoff?.status);
          const recoveryTask = probe
            .prepare("SELECT id, title FROM tasks WHERE title LIKE 'Recover: rel-up'")
            .get() as { id: string; title: string } | undefined;
          expect(recoveryTask).toBeTruthy();
          expect(gate.recovery_task_id).toBe(recoveryTask!.id);

          // Historical context survived: heartbeat_lost capture keyed to
          // the release event.
          const ctx = probe
            .prepare(
              "SELECT failure_kind, source_event_id FROM failure_contexts WHERE failed_task_id = ?",
            )
            .get(upstream.id) as { failure_kind: string; source_event_id: string } | undefined;
          expect(ctx?.failure_kind).toBe("heartbeat_lost");
          expect(ctx?.source_event_id).toBe(releaseEventId);

          // (2) Ghost sweep at boot: terminalized + driven (fail bundle).
          const ghost = probe
            .prepare("SELECT status FROM daemon_sessions WHERE id = ?")
            .get(ghostSessionId) as { status: string };
          expect(ghost.status).toBe("lost");
          const ghostTaskRow = probe
            .prepare("SELECT status, last_failure_event_id FROM tasks WHERE id = ?")
            .get(ghostTask.id) as { status: string; last_failure_event_id: string | null };
          expect(ghostTaskRow.status).toBe("failed");
          expect(ghostTaskRow.last_failure_event_id).not.toBeNull();
          const ghostFailReceipts = probe
            .prepare("SELECT COUNT(*) AS n FROM effect_receipts WHERE task_id = ?")
            .get(ghostTask.id) as { n: number };
          expect(ghostFailReceipts.n).toBe(5);
        } finally {
          probe.close();
        }

        // Drain-aware stop: SIGTERM exits 0 (sweep interval cleared + the
        // bounded embedded engine drain before closeDb; no hanging timers).
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
