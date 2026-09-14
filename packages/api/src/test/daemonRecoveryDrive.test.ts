/**
 * Daemon worker contract — `driveDaemonSessionOutcome` branch matrix +
 * release-effects seam (acceptance items 1-embedded-half, 2, 3, 4, 7, 11,
 * 14-attribution).
 *
 * Real seams on the in-memory test DB: real claim/start (token minting), real
 * session rows carrying the claim's token, the real act-txes
 * (failTaskWithEffects / releaseTaskWithEffects), real receipt consumers
 * (`processEffectReceipts`). The HTTP transport half of item 1 and the spoof
 * discriminator live in daemonRecoveryWire.test.ts; the cross-process races
 * live in daemonHeartbeatRevivalIpc.test.ts; the boot proof in
 * daemonRecoveryBootSmoke.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import {
  tasks,
  taskEvents,
  effectReceipts,
  habitats,
  pulses,
  daemonSessions,
  habitatSkillSignals,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as daemonInstanceRepo from "../repositories/daemonInstance.js";
import { createDaemonSessionWithClient } from "../repositories/daemonSession.js";
import { driveDaemonSessionOutcome } from "../services/daemonSessionRecovery.js";
import { processEffectReceipts } from "../services/effects/effectDeliverer.js";
import { releaseTaskWithEffects } from "../services/effects/releaseEffects.js";
import { failTask } from "../services/tasks/task-lifecycle.js";
import type { Task, EventAction } from "../models/index.js";

let habitatId: string;
let columnId: string;
let agentId: string;
let daemonId: string;

function seedAgent(name = "d-agent"): string {
  const created = agentRepo.createAgent({
    name,
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  return created.agent.id;
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

function claimStarted(taskId: string, by = agentId): Task {
  const claim = taskStateMachine.claimTask(taskId, by);
  expect(claim.success).toBe(true);
  const started = taskStateMachine.startTask(taskId, by);
  expect(started?.status).toBe("in_progress");
  return started!;
}

function claimOnly(taskId: string, by = agentId): Task {
  const claim = taskStateMachine.claimTask(taskId, by);
  expect(claim.success).toBe(true);
  return taskRepo.getTaskById(taskId)!;
}

function seedSession(taskId: string, token: string | null): string {
  const { id } = createDaemonSessionWithClient(
    getDb(),
    { daemonId, agentId, taskId, habitatId, workdir: "/tmp/wd" },
    token ?? "",
  );
  return id;
}

type SessionRowStatus = (typeof daemonSessions.$inferSelect)["status"];

function setSessionStatus(sessionId: string, status: SessionRowStatus): void {
  getDb().update(daemonSessions).set({ status }).where(eq(daemonSessions.id, sessionId)).run();
}

function receiptsFor(taskId: string) {
  return getDb().select().from(effectReceipts).where(eq(effectReceipts.taskId, taskId)).all();
}

function eventsFor(taskId: string, action: EventAction) {
  return getDb()
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.action, action)))
    .all();
}

/**
 * Seeds the meter exactly as a real claimed+started trail (the repo-level
 * claim/start paths used in this suite don't emit transition events; the
 * meter counts task_events rows, so write the two metered rows directly).
 */
function seedMeteredTrail(taskId: string, by = agentId): void {
  const now = new Date().toISOString();
  for (const action of ["claimed", "started"] as const) {
    getDb()
      .insert(taskEvents)
      .values({
        id: crypto.randomUUID(),
        taskId,
        actorType: "agent",
        actorId: by,
        action,
        toStatus: action === "claimed" ? "claimed" : "in_progress",
        timestamp: now,
        metadata: {},
      })
      .run();
  }
}

function taskRow(taskId: string): Record<string, any> {
  return getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as any;
}

beforeEach(async () => {
  await initTestDb();
  const habitat = habitatRepo.createHabitat({ name: "Daemon Recovery Drive" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({ habitatId, name: "T", order: 0, requiresClaim: false }).id;
  agentId = seedAgent();
  daemonId = daemonInstanceRepo.createDaemon({
    name: "drive-daemon",
    hostname: "test",
    maxConcurrent: 4,
    daemonVersion: "test",
    plainToken: "tok",
    metadata: {},
  }).id;
});

afterEach(async () => {
  await closeDb();
  vi.restoreAllMocks();
});

describe("acceptance 1 (embedded seam half) — failed session on in_progress drives the full fail bundle", () => {
  it("fails with 5-consumer receipts, system actor, non-required mask, posture-(ii) cause stamp", async () => {
    const taskId = seedTask("fail-drive");
    const started = claimStarted(taskId);
    const sessionId = seedSession(taskId, started.executionToken!);
    setSessionStatus(sessionId, "failed");

    expect(driveDaemonSessionOutcome(sessionId)).toBe("ok_failed");

    const row = taskRow(taskId);
    expect(row.status).toBe("failed");
    expect(row.assignedAgentId).toBeNull();
    expect(row.executionToken).toBeNull();
    expect(row.lastFailureEventId).not.toBeNull();
    expect(row.lastReleaseEventId).toBeNull(); // fail never touches the release pointer

    expect(
      receiptsFor(taskId)
        .map((r) => r.consumer)
        .sort(),
    ).toEqual([
      "detector_dispatch",
      "failure_context",
      "retry_ladder",
      "skill_ingestion",
      "workflow_gates",
    ]);

    const [ev] = eventsFor(taskId, "failed");
    expect(ev.actorType).toBe("system");
    expect(ev.actorId).toBe("daemon-recovery");
    expect((ev.metadata as any).reason).toBe("daemon_session_failed");
    expect(ev.executionToken).toBe(started.executionToken);

    // Non-required mask: the `task.failed` warning pulse fired post-commit.
    const pulseRows = getDb().select().from(pulses).where(eq(pulses.taskId, taskId)).all();
    expect(pulseRows.some((p) => p.subject.includes("failed"))).toBe(true);

    expect(eventsFor(taskId, "retry_scheduled")).toHaveLength(0);
    await processEffectReceipts();
    const [rs] = eventsFor(taskId, "retry_scheduled");
    if (rs) {
      // Posture (ii): retry follow-up metadata stamps the server-written cause.
      expect((rs.metadata as any).cause).toBe("daemon_session_failed");
      expect((rs.metadata as any).causeActorType).toBe("system");
    }
  });

  it("lost session on in_progress fails with reason daemon_session_lost", () => {
    const taskId = seedTask("lost-drive");
    const started = claimStarted(taskId);
    const sessionId = seedSession(taskId, started.executionToken!);
    setSessionStatus(sessionId, "lost");

    expect(driveDaemonSessionOutcome(sessionId)).toBe("ok_failed");
    const [ev] = eventsFor(taskId, "failed");
    expect((ev.metadata as any).reason).toBe("daemon_session_lost");
  });
});

describe("acceptance 2 — epoch ABA: E1 death after same-agent re-claim E2", () => {
  it("E2 untouched, zero E1 bundle", () => {
    const taskId = seedTask("aba");
    const e1 = claimOnly(taskId);
    const e1Session = seedSession(taskId, e1.executionToken!);
    // The legacy stale release frees the task; the same agent re-claims → E2.
    expect(taskStateMachine.releaseTask(taskId, "stale_timeout")).not.toBeNull();
    const e2 = claimOnly(taskId);
    expect(e2.executionToken).not.toBe(e1.executionToken);

    // E1's terminal write lands late (after E2 was already minted).
    setSessionStatus(e1Session, "failed");
    expect(driveDaemonSessionOutcome(e1Session)).toBe("no_op_epoch_mismatch");

    const row = taskRow(taskId);
    expect(row.status).toBe("claimed"); // E2 untouched
    expect(row.executionToken).toBe(e2.executionToken);
    expect(row.assignedAgentId).toBe(agentId);
    expect(eventsFor(taskId, "failed")).toHaveLength(0);
    expect(eventsFor(taskId, "released")).toHaveLength(0);
    expect(receiptsFor(taskId)).toHaveLength(0);
  });
});

describe("acceptance 3 — claimed-never-started release with effects", () => {
  it("releases with exactly {workflow_gates, failure_context} receipts and the release pointer", async () => {
    const taskId = seedTask("claimed-release");
    const claimed = claimOnly(taskId);
    const sessionId = seedSession(taskId, claimed.executionToken!);
    setSessionStatus(sessionId, "failed");

    expect(driveDaemonSessionOutcome(sessionId)).toBe("ok_released");

    const row = taskRow(taskId);
    expect(row.status).toBe("pending");
    expect(row.assignedAgentId).toBeNull();
    expect(row.executionToken).toBeNull();
    expect(row.lastReleaseEventId).not.toBeNull();
    expect(row.lastFailureEventId).toBeNull();

    expect(
      receiptsFor(taskId)
        .map((r) => r.consumer)
        .sort(),
    ).toEqual(["failure_context", "workflow_gates"]);

    const [ev] = eventsFor(taskId, "released");
    expect(ev.actorType).toBe("system");
    expect((ev.metadata as any).reason).toBe("daemon_session_failed_never_started");

    // Non-required mask: the `available for claim` context pulse fired.
    const pulseRows = getDb().select().from(pulses).where(eq(pulses.taskId, taskId)).all();
    expect(pulseRows.some((p) => p.subject.includes("available for claim"))).toBe(true);

    // Zero retry-ladder receipts → no budget burn on the release path.
    await processEffectReceipts();
    expect(eventsFor(taskId, "retry_scheduled")).toHaveLength(0);
    expect(eventsFor(taskId, "escalated")).toHaveLength(0);
  });
});

describe("acceptance 4 — clean exit unsubmitted vs submitted", () => {
  it("completed unsubmitted → release with daemon_session_completed_no_submit", () => {
    const taskId = seedTask("completed-unsubmitted");
    const started = claimStarted(taskId);
    const sessionId = seedSession(taskId, started.executionToken!);
    setSessionStatus(sessionId, "completed");

    expect(driveDaemonSessionOutcome(sessionId)).toBe("ok_released");
    const [ev] = eventsFor(taskId, "released");
    expect((ev.metadata as any).reason).toBe("daemon_session_completed_no_submit");
    expect(taskRow(taskId).status).toBe("pending");
  });

  it("task already submitted → no-op (guards reject)", () => {
    const taskId = seedTask("completed-submitted");
    const started = claimStarted(taskId);
    const sessionId = seedSession(taskId, started.executionToken!);
    taskStateMachine.submitTask(taskId, agentId, "done", [], started.executionToken);
    setSessionStatus(sessionId, "completed");

    expect(driveDaemonSessionOutcome(sessionId)).toBe("no_op_task_terminal");
    expect(taskRow(taskId).status).toBe("submitted");
    expect(eventsFor(taskId, "released")).toHaveLength(0);
    expect(receiptsFor(taskId)).toHaveLength(0);
  });
});

describe("release seam refusals (explicit, no null-fallthrough)", () => {
  it("pre-image epoch mismatch → null, zero writes", () => {
    const taskId = seedTask("release-aba");
    const started = claimStarted(taskId);
    setSessionStatus(seedSession(taskId, started.executionToken!), "released");

    const wrongEpoch = { ...taskRepo.getTaskById(taskId)!, executionToken: "other-epoch" } as Task;
    expect(
      releaseTaskWithEffects({
        taskId,
        actorId: "daemon-recovery",
        reason: "daemon_session_released",
        preImage: wrongEpoch,
      }),
    ).toBeNull();
    expect(taskRow(taskId).status).toBe("in_progress");
    expect(eventsFor(taskId, "released")).toHaveLength(0);
    expect(receiptsFor(taskId)).toHaveLength(0);
  });

  it("status moved off claimed/in_progress → null, zero writes", () => {
    const taskId = seedTask("release-moved");
    const started = claimStarted(taskId);
    taskStateMachine.submitTask(taskId, agentId, "done", [], started.executionToken);
    const preImage = { ...taskRepo.getTaskById(taskId)!, executionToken: null } as Task;

    expect(
      releaseTaskWithEffects({
        taskId,
        actorId: "daemon-recovery",
        reason: "daemon_session_released",
        preImage,
      }),
    ).toBeNull();
    expect(taskRow(taskId).status).toBe("submitted");
  });
});

describe("acceptance 7 — budget refusal: write-free, terminal row survives, escalation once", () => {
  it("refused fail AND refused release leave zero task writes; re-drives stay write-free", async () => {
    const failTaskId = seedTask("budget-fail");
    const failStarted = claimStarted(failTaskId);
    const failSession = seedSession(failTaskId, failStarted.executionToken!);
    setSessionStatus(failSession, "failed");

    seedMeteredTrail(failTaskId);

    // Ceiling 1: the metered trail already spent it.
    getDb()
      .update(habitats)
      .set({ lifecycleSettings: { taskTransitionCeiling: 1 } })
      .where(eq(habitats.id, habitatId))
      .run();

    const before =
      eventsFor(failTaskId, "failed").length + eventsFor(failTaskId, "released").length;
    expect(driveDaemonSessionOutcome(failSession)).toBe("budget_refused");
    let row = taskRow(failTaskId);
    expect(row.status).toBe("in_progress"); // zero task writes
    expect(receiptsFor(failTaskId)).toHaveLength(0);

    // Terminal session row SURVIVES budget refusal.
    const sess = getDb()
      .select()
      .from(daemonSessions)
      .where(eq(daemonSessions.id, failSession))
      .get()!;
    expect(sess.status).toBe("failed");

    // Repeated drives: no new meter events, escalation exactly once (the
    // breach escalation is scheduled on a microtask + dynamic import).
    expect(driveDaemonSessionOutcome(failSession)).toBe("budget_refused");
    expect(driveDaemonSessionOutcome(failSession)).toBe("budget_refused");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(eventsFor(failTaskId, "escalated")).toHaveLength(1);
    expect(before).toBe(0);

    // Same for the release branch (claimed-never-started under the ceiling).
    const relTaskId = seedTask("budget-release");
    const relClaimed = claimOnly(relTaskId);
    const relSession = seedSession(relTaskId, relClaimed.executionToken!);
    setSessionStatus(relSession, "failed");
    seedMeteredTrail(relTaskId);
    expect(driveDaemonSessionOutcome(relSession)).toBe("budget_refused");
    expect(taskRow(relTaskId).status).toBe("claimed");
    expect(eventsFor(relTaskId, "released")).toHaveLength(0);
  });
});

describe("legacy sessions (token NULL/'') — task-side no-op", () => {
  it("drive no-ops with legacy_no_epoch even on a terminal session", () => {
    const taskId = seedTask("legacy");
    const started = claimStarted(taskId);
    const sessionId = seedSession(taskId, null); // pre-migration shape
    setSessionStatus(sessionId, "lost");

    expect(driveDaemonSessionOutcome(sessionId)).toBe("legacy_no_epoch");
    expect(taskRow(taskId).status).toBe("in_progress"); // untouched
    expect(receiptsFor(taskId)).toHaveLength(0);
    void started;
  });
});

describe("acceptance 11 — DB-write failure: throw, no null-fallthrough, sweep retries land", () => {
  it("a seeded act-tx throw propagates; the next drive lands", async () => {
    const { failTaskWithEffects } = await import("../services/effects/failureEffects.js");
    const taskId = seedTask("dbwrite");
    const started = claimStarted(taskId);
    const sessionId = seedSession(taskId, started.executionToken!);
    setSessionStatus(sessionId, "failed");

    const original = failTaskWithEffects;
    const spy = vi.spyOn(
      await import("../services/effects/failureEffects.js"),
      "failTaskWithEffects",
    );
    spy.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(() => driveDaemonSessionOutcome(sessionId)).toThrow("boom");

    spy.mockImplementation(original);
    expect(driveDaemonSessionOutcome(sessionId)).toBe("ok_failed");
    expect(taskRow(taskId).status).toBe("failed");
  });
});

describe("acceptance 14 — actorType-keyed attribution (no-blame for system)", () => {
  it("drive-origin fail ingests the blocker signal WITHOUT agent binding; agent /fail keeps it", async () => {
    const sysTaskId = seedTask("attr-system");
    const sysStarted = claimStarted(sysTaskId);
    const sysSession = seedSession(sysTaskId, sysStarted.executionToken!);
    setSessionStatus(sysSession, "failed");
    expect(driveDaemonSessionOutcome(sysSession)).toBe("ok_failed");

    const agentTaskId = seedTask("attr-agent");
    const agentStarted = claimStarted(agentTaskId);
    expect(failTask(agentTaskId, agentId, "agent", "agent-reported failure")).not.toBeNull();

    await processEffectReceipts();

    const sysSignals = getDb()
      .select()
      .from(habitatSkillSignals)
      .where(eq(habitatSkillSignals.habitatId, habitatId))
      .all()
      .filter((r) => (r.sourceTaskIds ?? "").includes(sysTaskId));
    expect(sysSignals.length).toBeGreaterThan(0); // task-bound incident signal present
    expect(
      sysSignals.every((r) => (r.corroboratingAgentIds ?? "null") === "null"),
    ).toBe(true); // ...WITHOUT agent binding (the no-blame guard)

    const agentSignals = getDb()
      .select()
      .from(habitatSkillSignals)
      .where(eq(habitatSkillSignals.habitatId, habitatId))
      .all()
      .filter((r) => (r.sourceTaskIds ?? "").includes(agentTaskId));
    expect(agentSignals.length).toBeGreaterThan(0);
    expect(agentSignals.some((r) => (r.corroboratingAgentIds ?? "").includes(agentId))).toBe(true);
  });
});
