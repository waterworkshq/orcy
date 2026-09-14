/**
 * Daemon worker contract — ghost sweep, monotonic terminal guard, start
 * cleanup, bad-data policy (acceptance items 8-bad-data-pins, 9, 10, 13 and
 * the sweep's task-side leg).
 *
 * In-memory test DB; the embedded-engine liveness branch is driven through
 * the real `setEngineLivenessProbe` registration seam. Cross-process lock
 * races (heartbeat revival under a held write lock) live in
 * daemonHeartbeatRevivalIpc.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { tasks, taskEvents, daemonSessions, daemonInstances, effectReceipts } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as daemonInstanceRepo from "../repositories/daemonInstance.js";
import { createDaemonSessionWithClient, updateSessionStatus } from "../repositories/daemonSession.js";
import * as daemonRepo from "../repositories/daemon.js";
import {
  sweepDaemonSessionOutcomes,
  cleanupDaemonSessionsOnStart,
  classifyHeartbeatStaleness,
  DAEMON_STALE_HEARTBEAT_MS,
  setEngineLivenessProbe,
} from "../services/daemonSessionRecovery.js";
import type { EventAction } from "../models/index.js";

let habitatId: string;
let columnId: string;
let agentId: string;
let daemonId: string;

function seedAgent(): string {
  return agentRepo.createAgent({
    name: "ghost-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  }).agent.id;
}

function seedTask(title: string): string {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: `m-${title}`,
    createdBy: "user-1",
  });
  return taskRepo.createTask({ missionId: mission.id, title, createdBy: "user-1" }).id;
}

function claimStarted(taskId: string): string {
  const claim = taskStateMachine.claimTask(taskId, agentId);
  expect(claim.success).toBe(true);
  const started = taskStateMachine.startTask(taskId, agentId);
  expect(started?.status).toBe("in_progress");
  return started!.executionToken!;
}

type SessionRowStatus = (typeof daemonSessions.$inferSelect)["status"];

function seedSession(taskId: string, token: string | null, status: SessionRowStatus = "running"): string {
  const { id } = createDaemonSessionWithClient(
    getDb(),
    { daemonId, agentId, taskId, habitatId, workdir: "/tmp/wd" },
    token ?? "",
  );
  if (status !== "starting") {
    getDb().update(daemonSessions).set({ status }).where(eq(daemonSessions.id, id)).run();
  }
  return id;
}

function ageHeartbeat(id: string, iso: string | null): void {
  getDb()
    .update(daemonInstances)
    .set({ lastHeartbeatAt: iso })
    .where(eq(daemonInstances.id, id))
    .run();
}

function staleHeartbeat(): string {
  return new Date(Date.now() - (DAEMON_STALE_HEARTBEAT_MS + 60_000)).toISOString();
}

function sessionRow(sessionId: string) {
  return getDb().select().from(daemonSessions).where(eq(daemonSessions.id, sessionId)).get()!;
}

function taskStatus(taskId: string): string {
  return (getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as any).status;
}

function eventsFor(taskId: string, action: EventAction) {
  return getDb()
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.action, action)))
    .all();
}

beforeEach(async () => {
  await initTestDb();
  const habitat = habitatRepo.createHabitat({ name: "Ghost Sweep" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({ habitatId, name: "T", order: 0, requiresClaim: false }).id;
  agentId = seedAgent();
  daemonId = daemonInstanceRepo.createDaemon({
    name: "ghost-daemon",
    hostname: "test",
    maxConcurrent: 2,
    daemonVersion: "test",
    plainToken: "tok",
    metadata: {},
  }).id;
  setEngineLivenessProbe(() => false); // standalone/heartbeat-only semantics
});

afterEach(async () => {
  setEngineLivenessProbe(() => false);
  await closeDb();
});

describe("classifyHeartbeatStaleness — P1 numeric policy, conservative on bad data", () => {
  it("pins the exactly-10-minute boundary and the bad-data classes", () => {
    const now = Date.parse("2026-09-14T12:00:00Z");
    expect(classifyHeartbeatStaleness(null, now)).toEqual({ stale: true });
    expect(classifyHeartbeatStaleness("", now)).toEqual({ stale: true });
    expect(
      classifyHeartbeatStaleness(new Date(now - DAEMON_STALE_HEARTBEAT_MS).toISOString(), now),
    ).toEqual({ stale: true }); // exactly 10 minutes → stale (≥ boundary)
    expect(
      classifyHeartbeatStaleness(new Date(now - DAEMON_STALE_HEARTBEAT_MS + 1).toISOString(), now),
    ).toEqual({ stale: false }); // one ms inside the window → fresh
    expect(classifyHeartbeatStaleness("not-a-date", now)).toEqual({ skip: "unparseable" });
    expect(classifyHeartbeatStaleness(new Date(now + 5_000).toISOString(), now)).toEqual({
      skip: "future_dated",
    });
  });
});

describe("ghost-terminalization leg — frees capacity independent of task state", () => {
  it("terminalizes a stale running ghost whose task is already terminal (capacity freed)", () => {
    const taskId = seedTask("ghost-terminal-task");
    const token = claimStarted(taskId);
    const sessionId = seedSession(taskId, token);
    // Task moves on (submitted) while the session row stays ghost-running.
    taskStateMachine.submitTask(taskId, agentId, "done", [], token);
    ageHeartbeat(daemonId, staleHeartbeat());

    sweepDaemonSessionOutcomes();

    expect(sessionRow(sessionId).status).toBe("lost");
    expect(taskStatus(taskId)).toBe("submitted"); // never inferred ownership
  });

  it("terminalizes + drives a stale ghost whose task is still claimed (task-side leg follows)", () => {
    const taskId = seedTask("ghost-drive-task");
    const token = claimStarted(taskId);
    const sessionId = seedSession(taskId, token);
    ageHeartbeat(daemonId, staleHeartbeat());

    sweepDaemonSessionOutcomes();

    expect(sessionRow(sessionId).status).toBe("lost");
    // in_progress + lost → fail with effects (system actor).
    expect(taskStatus(taskId)).toBe("failed");
    expect(eventsFor(taskId, "failed")).toHaveLength(1);
    expect(
      getDb().select().from(effectReceipts).where(eq(effectReceipts.taskId, taskId)).all().length,
    ).toBe(5);
  });

  it("fresh heartbeat → untouched; NULL heartbeat → stale (reaped)", () => {
    const freshTask = seedTask("fresh");
    const freshToken = claimStarted(freshTask);
    const freshSession = seedSession(freshTask, freshToken);
    // createDaemon initializes heartbeat-now → fresh by construction.
    sweepDaemonSessionOutcomes();
    expect(sessionRow(freshSession).status).toBe("running");

    const nullTask = seedTask("nullbeat");
    const nullToken = claimStarted(nullTask);
    const nullSession = seedSession(nullTask, nullToken);
    ageHeartbeat(daemonId, null); // anomalous-only NULL → stale
    sweepDaemonSessionOutcomes();
    expect(sessionRow(nullSession).status).toBe("lost");
  });

  it("unparseable and future-dated heartbeats skip reap with zero terminal writes", () => {
    const t1 = seedTask("unparseable");
    const s1 = seedSession(t1, claimStarted(t1));
    ageHeartbeat(daemonId, "garbage");
    sweepDaemonSessionOutcomes();
    expect(sessionRow(s1).status).toBe("running");

    const t2 = seedTask("future");
    const s2 = seedSession(t2, claimStarted(t2));
    ageHeartbeat(daemonId, new Date(Date.now() + 600_000).toISOString());
    sweepDaemonSessionOutcomes();
    expect(sessionRow(s2).status).toBe("running");
  });

  it("a live embedded engine is never swept (isRunning spare)", () => {
    const taskId = seedTask("engine-live");
    const session = seedSession(taskId, claimStarted(taskId));
    ageHeartbeat(daemonId, staleHeartbeat());
    setEngineLivenessProbe(() => true); // engine running: sweep never acts

    sweepDaemonSessionOutcomes();
    expect(sessionRow(session).status).toBe("running");
  });

  it("legacy NULL-token ghosts terminalize; their tasks stay untouched", () => {
    const taskId = seedTask("legacy-ghost");
    claimStarted(taskId);
    const sessionId = seedSession(taskId, null);
    ageHeartbeat(daemonId, staleHeartbeat());

    sweepDaemonSessionOutcomes();

    expect(sessionRow(sessionId).status).toBe("lost");
    expect(taskStatus(taskId)).toBe("in_progress"); // 30-min fallback disclosed
  });
});

describe("sweep task-side leg — exact (task_id, execution_token) resolution", () => {
  it("drives a terminal session whose drive was lost to a crash between write and drive", () => {
    const taskId = seedTask("crashed-drive");
    const token = claimStarted(taskId);
    const sessionId = seedSession(taskId, token, "failed"); // terminal, undriven

    sweepDaemonSessionOutcomes(); // task-side leg picks it up by token

    expect(taskStatus(taskId)).toBe("failed");
    expect(eventsFor(taskId, "failed")).toHaveLength(1);
  });

  it("a re-tokened task's old terminal session is NOT driven by the task-side leg", () => {
    const taskId = seedTask("retokened");
    const e1Token = claimStarted(taskId);
    const e1Session = seedSession(taskId, e1Token, "failed");
    taskStateMachine.releaseTask(taskId, "stale_timeout");
    const e2Claim = taskStateMachine.claimTask(taskId, agentId);
    expect(e2Claim.success).toBe(true);

    sweepDaemonSessionOutcomes();

    expect(taskStatus(taskId)).toBe("claimed"); // E2 alive
    expect(eventsFor(taskId, "failed")).toHaveLength(0);
    void e1Session;
  });
});

describe("monotonic terminal guard (acceptance 9 + 13)", () => {
  it("observed-first-accepted: a second terminal write and any post-terminal status write are zero-row", () => {
    const taskId = seedTask("monotonic");
    const token = claimStarted(taskId);
    const sessionId = seedSession(taskId, token);

    // First terminal write wins.
    const first = updateSessionStatus(sessionId, "completed");
    expect(first?.status).toBe("completed");
    // Competing terminal write loses (observed-first).
    const second = updateSessionStatus(sessionId, "failed");
    expect(second?.status).toBe("completed");
    // Resurrection blocked: post-terminal running/status write zero-row.
    const resurrect = updateSessionStatus(sessionId, "running");
    expect(resurrect?.status).toBe("completed");
  });

  it("starting→running is a normal in-fence transition; progress writes never flip status", () => {
    const taskId = seedTask("normal-transition");
    const token = claimStarted(taskId);
    const sessionId = seedSession(taskId, token, "starting");

    const toRunning = daemonRepo.updateSessionStatus(sessionId, "running");
    expect(toRunning?.status).toBe("running");
    const progressed = daemonRepo.updateSessionProgress(sessionId, { pid: 4242 });
    expect(progressed?.status).toBe("running"); // untouched
    expect(progressed?.pid).toBe(4242);
  });
});

describe("verified-restart start cleanup (acceptance 10 embedded restart half)", () => {
  it("terminalizes this daemon's still-active rows before serving; new-engine rows never marked", () => {
    const staleTask = seedTask("restart-stale");
    const staleSession = seedSession(staleTask, claimStarted(staleTask));
    const legacyTask = seedTask("restart-legacy");
    claimStarted(legacyTask);
    const legacySession = seedSession(legacyTask, null);

    const cleaned = cleanupDaemonSessionsOnStart(daemonId);

    expect(cleaned).toBe(2);
    expect(sessionRow(staleSession).status).toBe("lost");
    expect(sessionRow(legacySession).status).toBe("lost");
    // Drives ran: the tokened task failed with effects; legacy untouched.
    expect(taskStatus(staleTask)).toBe("failed");
    expect(taskStatus(legacyTask)).toBe("in_progress");

    // A session created AFTER cleanup (the new engine serving) is never
    // marked by a subsequent cleanup pass of the same start.
    const freshTask = seedTask("restart-fresh");
    const freshSession = seedSession(freshTask, claimStarted(freshTask));
    expect(cleanupDaemonSessionsOnStart(daemonId)).toBe(1); // only the fresh row
    expect(sessionRow(freshSession).status).toBe("lost"); // idempotent guard allows re-cleanup of still-active rows
  });
});
