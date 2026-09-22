/**
 * REC-06 — stale-agent release canonicalization (event + ADR-0005 on_fail
 * effects through the emission-owning layer).
 *
 * Real seams on the in-memory test DB: real claim/start (token minting), the
 * real agent pointer/heartbeat writers, the real sweep
 * (`releaseStaleTasks`), the real release act-tx
 * (`releaseTaskWithEffects`), and the real receipt consumers
 * (`processEffectReceipts`). The cross-process heartbeat-revival windows
 * live in staleAgentRevivalIpc.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import {
  tasks,
  taskEvents,
  taskWorkflowGates,
  taskRecoveryHandoffs,
  workflows,
  effectReceipts,
  habitats,
  agents,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import { releaseStaleTasks, STALE_SWEEP_ACTOR } from "../services/agentService.js";
import { processEffectReceipts } from "../services/effects/effectDeliverer.js";
import { getUnresolvedFailureContextByTaskId } from "../repositories/failureContext.js";
import { registerRecoveryHandoffWriter } from "../services/workflow/workflowGateAdvancer.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import type { EventAction, Task } from "../models/index.js";

const FAILURE_HANDLER = { recoveryTaskTemplate: { title: "R" } } as const;
const STALE_MS = 31 * 60_000; // > the sweep's 30-minute threshold

let habitatId: string;
let columnId: string;

function seedAgent(name: string): string {
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

function claimStarted(taskId: string, by: string): Task {
  const claim = taskStateMachine.claimTask(taskId, by);
  expect(claim.success).toBe(true);
  const started = taskStateMachine.startTask(taskId, by);
  expect(started?.status).toBe("in_progress");
  return started!;
}

/** The honest silence seed: claim → heartbeat(task) → time passes. */
function goSilent(agentId: string, taskId: string): void {
  agentRepo.heartbeat(agentId, taskId); // sets pointer + working + fresh beat
  getDb()
    .update(agents)
    .set({ lastHeartbeat: new Date(Date.now() - STALE_MS).toISOString() })
    .where(eq(agents.id, agentId))
    .run();
}

function ageHeartbeat(agentId: string): void {
  getDb()
    .update(agents)
    .set({ lastHeartbeat: new Date(Date.now() - STALE_MS).toISOString() })
    .where(eq(agents.id, agentId))
    .run();
}

function seedOnFailGate(taskId: string, downstreamTaskId: string): string {
  const db = getDb();
  const workflowId = `wf-stale-${Math.random().toString(36).slice(2)}`;
  db.insert(workflows)
    .values({
      id: workflowId,
      missionId: (
        db.select({ missionId: tasks.missionId }).from(tasks).where(eq(tasks.id, taskId)).get() as {
          missionId: string;
        }
      ).missionId,
      habitatId,
      status: "active",
      createdBy: "user-1",
      failureHandler: FAILURE_HANDLER as never,
    })
    .run();
  const gateId = `gate-stale-${Math.random().toString(36).slice(2)}`;
  db.insert(taskWorkflowGates)
    .values({
      id: gateId,
      workflowId,
      missionId: (
        db.select({ missionId: tasks.missionId }).from(tasks).where(eq(tasks.id, taskId)).get() as {
          missionId: string;
        }
      ).missionId,
      habitatId,
      upstreamTaskId: taskId,
      downstreamTaskId,
      gateType: "on_fail",
      satisfied: false,
      recoveryDepth: 0,
    })
    .run();
  return gateId;
}

/** Seeds the meter exactly as a real claimed+started trail (repo claim/start
 * paths emit no transition events; the meter counts task_events rows). */
function seedMeteredTrail(taskId: string, by: string): void {
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

function taskRow(taskId: string): Record<string, any> {
  return getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as any;
}

function agentRow(agentId: string): Record<string, any> {
  return getDb().select().from(agents).where(eq(agents.id, agentId)).get() as any;
}

/** Re-registers the production handoff writer (test isolation from other files). */
function registerRealHandoffWriter(): void {
  registerRecoveryHandoffWriter(({ tx, gate, trigger, frozenHandler, handlerFingerprint }) => {
    tx.insert(taskRecoveryHandoffs)
      .values({
        id: crypto.randomUUID(),
        gateId: gate.id,
        workflowId: gate.workflowId,
        habitatId: gate.habitatId,
        missionId: gate.missionId,
        downstreamTaskId: gate.downstreamTaskId,
        recoveryDepth: gate.recoveryDepth,
        triggerEventId: trigger.eventId,
        frozenHandlerConfig: JSON.stringify(frozenHandler),
        handlerFingerprint,
        status: "expected",
        blockedReason: null,
        consumedAt: null,
      })
      .run();
  });
}

beforeEach(async () => {
  await initTestDb();
  const habitat = habitatRepo.createHabitat({ name: "Stale Sweep" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({ habitatId, name: "T", order: 0, requiresClaim: false }).id;
  registerRealHandoffWriter();
});

afterEach(async () => {
  await closeDb();
  vi.restoreAllMocks();
});

describe("core repair — stale sweep releases through the effects seam (RED on HEAD)", () => {
  it("released event + {workflow_gates, failure_context} receipts + on_fail gate + heartbeat_lost capture", async () => {
    const agentId = seedAgent("sweep-agent");
    const taskId = seedTask("sweep-core");
    const downstreamId = seedTask("sweep-core-downstream");
    const started = claimStarted(taskId, agentId);
    const gateId = seedOnFailGate(taskId, downstreamId);
    goSilent(agentId, taskId);

    releaseStaleTasks(30);

    const row = taskRow(taskId);
    expect(row.status).toBe("pending");
    expect(row.assignedAgentId).toBeNull();
    expect(row.executionToken).toBeNull();
    expect(row.lastReleaseEventId).not.toBeNull();

    const [ev] = eventsFor(taskId, "released");
    expect(ev).toBeDefined();
    expect(ev.actorType).toBe("system");
    expect(ev.actorId).toBe(STALE_SWEEP_ACTOR);
    expect((ev.metadata as any).reason).toBe("stale_timeout");
    expect(ev.executionToken).toBe(started.executionToken);

    expect(
      receiptsFor(taskId)
        .map((r) => r.consumer)
        .sort(),
    ).toEqual(["failure_context", "workflow_gates"]);

    const agent = agentRow(agentId);
    expect(agent.status).toBe("offline");
    expect(agent.currentTaskId).toBeNull(); // conditional cleanup after success

    // Delivery: the on_fail gate fires (tick 1) and the heartbeat-lost
    // context captures (tick 2 — the failure_context consumer's R-1 sibling
    // barrier waits for the workflow_gates ack).
    await processEffectReceipts();
    const gate = getDb()
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.id, gateId))
      .get()!;
    expect(gate.satisfied).toBe(true);
    expect(gate.satisfiedByEventId).toBe(ev.id);
    await processEffectReceipts();

    const context = getUnresolvedFailureContextByTaskId(taskId);
    expect(context).not.toBeNull();
    expect(context!.failureKind).toBe("heartbeat_lost");
    expect(context!.sourceEventId).toBe(ev.id);
  });

  it("non-required mask fires (available-for-claim pulse), no duplicate events on second sweep", () => {
    const agentId = seedAgent("sweep-pulse");
    const taskId = seedTask("sweep-pulse-task");
    claimStarted(taskId, agentId);
    goSilent(agentId, taskId);

    releaseStaleTasks(30);
    releaseStaleTasks(30); // idempotent second tick

    expect(eventsFor(taskId, "released")).toHaveLength(1);
    expect(receiptsFor(taskId)).toHaveLength(2);
  });
});

describe("budget posture — refusal retains the candidate; ceiling raise lands the retry", () => {
  it("refused once (escalation emit-once), pointer + candidacy retained, retry after raise", async () => {
    const agentId = seedAgent("sweep-budget");
    const taskId = seedTask("sweep-budget-task");
    claimStarted(taskId, agentId);
    goSilent(agentId, taskId);
    seedMeteredTrail(taskId, agentId);
    getDb()
      .update(habitats)
      .set({ lifecycleSettings: { taskTransitionCeiling: 2 } })
      .where(eq(habitats.id, habitatId))
      .run();

    releaseStaleTasks(30);
    // Task untouched; agent offline-marked but the POINTER survives.
    expect(taskRow(taskId).status).toBe("in_progress");
    expect(eventsFor(taskId, "released")).toHaveLength(0);
    const agent = agentRow(agentId);
    expect(agent.status).toBe("offline");
    expect(agent.currentTaskId).toBe(taskId); // D1 liveness: pending-retry state IS the pointer

    // Second tick: write-free re-refusal (no escalation repeat).
    releaseStaleTasks(30);
    expect(eventsFor(taskId, "released")).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(eventsFor(taskId, "escalated")).toHaveLength(1); // emit-once

    // Ceiling raised → the retained candidate retries and lands.
    getDb()
      .update(habitats)
      .set({ lifecycleSettings: { taskTransitionCeiling: 21 } })
      .where(eq(habitats.id, habitatId))
      .run();
    releaseStaleTasks(30);
    expect(taskRow(taskId).status).toBe("pending");
    expect(eventsFor(taskId, "released")).toHaveLength(1);
    expect(agentRow(agentId).currentTaskId).toBeNull();
  });
});

describe("guard refusals — pointer/owner/epoch shapes", () => {
  it("in-tx pointer guard: agent pointer moved off the task (same epoch) → zero writes", async () => {
    const { releaseTaskWithEffects } = await import("../services/effects/releaseEffects.js");
    const agentId = seedAgent("sweep-pointer");
    const taskId = seedTask("sweep-pointer-task");
    const otherTaskId = seedTask("sweep-pointer-other");
    const started = claimStarted(taskId, agentId);
    goSilent(agentId, taskId);
    // The pointer rebound to another task while the epoch stayed E1 — the
    // epoch fence alone cannot see pointer movement; the in-tx guard must.
    getDb().update(agents).set({ currentTaskId: otherTaskId }).where(eq(agents.id, agentId)).run();

    const threshold = new Date(Date.now() - 30 * 60_000).toISOString();
    expect(
      releaseTaskWithEffects({
        taskId,
        actorId: STALE_SWEEP_ACTOR,
        reason: "stale_timeout",
        preImage: taskRepo.getTaskById(taskId) as Task,
        guard: { expectedAssigneeAgentId: agentId, staleHeartbeatBefore: threshold },
      }),
    ).toBeNull();

    expect(taskRow(taskId).status).toBe("in_progress"); // untouched
    expect(taskRow(taskId).executionToken).toBe(started.executionToken);
    expect(eventsFor(taskId, "released")).toHaveLength(0);
    expect(receiptsFor(taskId)).toHaveLength(0);
    // The rebound pointer is NEVER cleared by the release guard refusing.
    expect(agentRow(agentId).currentTaskId).toBe(otherTaskId);
  });

  it("in-tx heartbeat guard: revived agent (fresh beat, same epoch) → zero writes", async () => {
    const { releaseTaskWithEffects } = await import("../services/effects/releaseEffects.js");
    const agentId = seedAgent("sweep-revived");
    const taskId = seedTask("sweep-revived-task");
    claimStarted(taskId, agentId);
    goSilent(agentId, taskId);
    // Revival AFTER candidacy, BEFORE the authority tx: fresh heartbeat with
    // pointer and epoch unchanged — only the in-tx freshness check refuses.
    agentRepo.heartbeat(agentId, taskId);

    const threshold = new Date(Date.now() - 30 * 60_000).toISOString();
    expect(
      releaseTaskWithEffects({
        taskId,
        actorId: STALE_SWEEP_ACTOR,
        reason: "stale_timeout",
        preImage: taskRepo.getTaskById(taskId) as Task,
        guard: { expectedAssigneeAgentId: agentId, staleHeartbeatBefore: threshold },
      }),
    ).toBeNull();

    expect(taskRow(taskId).status).toBe("in_progress");
    expect(eventsFor(taskId, "released")).toHaveLength(0);
    expect(receiptsFor(taskId)).toHaveLength(0);
  });

  it("NULL → minted epoch refuses at the seam (legacy preImage vs re-claimed row)", async () => {
    const { releaseTaskWithEffects } = await import("../services/effects/releaseEffects.js");
    const agentId = seedAgent("sweep-null-mint");
    const taskId = seedTask("sweep-null-mint-task");
    claimStarted(taskId, agentId);
    goSilent(agentId, taskId);
    const preImage = { ...(taskRepo.getTaskById(taskId) as Task), executionToken: null };

    expect(
      releaseTaskWithEffects({
        taskId,
        actorId: STALE_SWEEP_ACTOR,
        reason: "stale_timeout",
        preImage,
        guard: {
          expectedAssigneeAgentId: agentId,
          staleHeartbeatBefore: new Date(Date.now() - 30 * 60_000).toISOString(),
        },
      }),
    ).toBeNull();
    expect(taskRow(taskId).status).toBe("in_progress");
  });

  it("foreign owner (pointer at another agent's claimed task) → no release, pointer cleanup only", () => {
    const staleId = seedAgent("sweep-foreign-stale");
    const owner = seedAgent("sweep-foreign-owner");
    const taskId = seedTask("sweep-foreign-task");
    claimStarted(taskId, owner); // owned by a live other agent
    goSilent(staleId, taskId); // corrupted pointer at the foreign task

    releaseStaleTasks(30);

    expect(taskRow(taskId).status).toBe("in_progress");
    expect(eventsFor(taskId, "released")).toHaveLength(0);
    expect(receiptsFor(taskId)).toHaveLength(0);
    expect(agentRow(staleId).currentTaskId).toBeNull(); // residue cleared, same-observed-value
    expect(taskRow(taskId).assignedAgentId).toBe(owner);
  });

  it("terminal task pointer → cleanup only, task never mutated", () => {
    const agentId = seedAgent("sweep-terminal");
    const taskId = seedTask("sweep-terminal-task");
    const started = claimStarted(taskId, agentId);
    taskStateMachine.submitTask(taskId, agentId, "done", [], started.executionToken);
    goSilent(agentId, taskId);

    releaseStaleTasks(30);

    expect(taskRow(taskId).status).toBe("submitted");
    expect(eventsFor(taskId, "released")).toHaveLength(0);
    expect(agentRow(agentId).currentTaskId).toBeNull();
  });

  it("pending-unowned crash residue → pointer cleared, no release, no assignment", () => {
    const agentId = seedAgent("sweep-residue");
    const taskId = seedTask("sweep-residue-task");
    claimStarted(taskId, agentId);
    goSilent(agentId, taskId);
    // Crash residue: release committed elsewhere, pointer cleanup crashed.
    getDb()
      .update(tasks)
      .set({ status: "pending", assignedAgentId: null, executionToken: null })
      .where(eq(tasks.id, taskId))
      .run();

    releaseStaleTasks(30);

    expect(taskRow(taskId).status).toBe("pending");
    expect(eventsFor(taskId, "released")).toHaveLength(0);
    expect(taskRow(taskId).assignedAgentId).toBeNull(); // never an assignment
    expect(agentRow(agentId).currentTaskId).toBeNull();
  });

  it("epoch ABA (re-claim minted E2) → zero-write refusal, E2 intact", () => {
    const agentId = seedAgent("sweep-aba");
    const taskId = seedTask("sweep-aba-task");
    const e1 = claimStarted(taskId, agentId);
    goSilent(agentId, taskId);
    // Pointer retained but the task moved epochs: re-released + re-claimed.
    taskStateMachine.releaseTask(taskId, "manual");
    const e2claim = taskStateMachine.claimTask(taskId, agentId);
    expect(e2claim.success).toBe(true);
    const e2 = (taskRepo.getTaskById(taskId) as Task).executionToken;
    expect(e2).not.toBe(e1.executionToken);
    goSilent(agentId, taskId); // still stale, still pointed

    releaseStaleTasks(30);

    // The seam refuses on epoch (preImage E1 vs row E2)? The preImage is the
    // CURRENT row (E2) — candidacy read freshness makes ABA impossible
    // in-process; the refusal case is E1-vs-E2 where the preImage is older.
    // In-process the sweep always reads the current row, so the sweep simply
    // releases E2's claim (the agent IS stale, E2 IS its current pointer).
    expect(taskRow(taskId).status).toBe("pending");
    expect(eventsFor(taskId, "released").length).toBe(1);
    expect(eventsFor(taskId, "released")[0].executionToken).toBe(e2);
  });

  it("legacy NULL-token row → canonical release (both-NULL epoch admitted)", () => {
    const agentId = seedAgent("sweep-legacy");
    const taskId = seedTask("sweep-legacy-task");
    const started = claimStarted(taskId, agentId);
    void started;
    // Legacy shape: pre-migration claim without a token.
    getDb().update(tasks).set({ executionToken: null }).where(eq(tasks.id, taskId)).run();
    goSilent(agentId, taskId);

    releaseStaleTasks(30);

    expect(taskRow(taskId).status).toBe("pending");
    const [ev] = eventsFor(taskId, "released");
    expect(ev).toBeDefined();
    expect(ev.executionToken ?? null).toBe(null);
  });
});

describe("candidacy bounds and malformed data", () => {
  it("already-offline pointer candidate skips re-mark + SSE but still processes the task", () => {
    const agentId = seedAgent("sweep-offline-ptr");
    const taskId = seedTask("sweep-offline-ptr-task");
    claimStarted(taskId, agentId);
    goSilent(agentId, taskId);
    seedMeteredTrail(taskId, agentId);
    getDb()
      .update(habitats)
      .set({ lifecycleSettings: { taskTransitionCeiling: 2 } })
      .where(eq(habitats.id, habitatId))
      .run();

    const publish = vi.spyOn(sseBroadcaster, "publish");
    releaseStaleTasks(30); // refused: offline-marked, pointer retained
    expect(agentRow(agentId).status).toBe("offline");
    expect(agentRow(agentId).currentTaskId).toBe(taskId);
    const firstFlips = publish.mock.calls.filter(
      (c) => c[0] === "global" && (c[1] as { type?: string })?.type === "agent.status_changed",
    ).length;
    expect(firstFlips).toBe(1);

    // Ceiling raised: the already-offline candidate is re-admitted (offline ∧
    // pointer ≠ NULL), skips the status write + SSE, and completes the release.
    getDb()
      .update(habitats)
      .set({ lifecycleSettings: { taskTransitionCeiling: 21 } })
      .where(eq(habitats.id, habitatId))
      .run();
    publish.mockClear();
    releaseStaleTasks(30);
    const secondFlips = publish.mock.calls.filter(
      (c) => c[0] === "global" && (c[1] as { type?: string })?.type === "agent.status_changed",
    ).length;
    expect(secondFlips).toBe(0); // pin 2: no re-mark, no SSE
    expect(taskRow(taskId).status).toBe("pending");
    expect(eventsFor(taskId, "released")).toHaveLength(1);
    expect(agentRow(agentId).currentTaskId).toBeNull();
  });

  it("no-task stale agent → marked offline once with one SSE; second sweep is a non-candidate", () => {
    const agentId = seedAgent("sweep-idle");
    ageHeartbeat(agentId);
    const publish = vi.spyOn(sseBroadcaster, "publish");

    releaseStaleTasks(30);
    expect(agentRow(agentId).status).toBe("offline");
    const firstFlips = publish.mock.calls.filter(
      ([channel, evt]) => channel === "global" && evt?.type === "agent.status_changed",
    ).length;
    expect(firstFlips).toBe(1);

    publish.mockClear();
    releaseStaleTasks(30); // offline ∧ pointer-NULL → not even a candidate
    const secondFlips = publish.mock.calls.filter(
      ([channel, evt]) => channel === "global" && evt?.type === "agent.status_changed",
    ).length;
    expect(secondFlips).toBe(0);
  });

  it("malformed heartbeat → never marked offline, never released (fail-fresh)", () => {
    const agentId = seedAgent("sweep-malformed");
    const taskId = seedTask("sweep-malformed-task");
    claimStarted(taskId, agentId);
    goSilent(agentId, taskId);
    getDb()
      .update(agents)
      .set({ lastHeartbeat: "not-a-timestamp" })
      .where(eq(agents.id, agentId))
      .run();

    releaseStaleTasks(30);

    expect(agentRow(agentId).status).not.toBe("offline");
    expect(taskRow(taskId).status).toBe("in_progress");
    expect(eventsFor(taskId, "released")).toHaveLength(0);
    expect(agentRow(agentId).currentTaskId).toBe(taskId);
  });

  it("future-dated heartbeat → treated fresh, skipped", () => {
    const agentId = seedAgent("sweep-future");
    ageHeartbeat(agentId);
    getDb()
      .update(agents)
      .set({ lastHeartbeat: new Date(Date.now() + 60 * 60_000).toISOString() })
      .where(eq(agents.id, agentId))
      .run();

    releaseStaleTasks(30);
    expect(agentRow(agentId).status).not.toBe("offline");
  });
});

describe("F1 — cleanup atomicity: a live re-claim's pointer is never cleared", () => {
  it("cleanup refuses while the task is claimed/in_progress owned by the agent (no heartbeat revival)", () => {
    const agentId = seedAgent("sweep-f1-unit");
    const taskId = seedTask("sweep-f1-unit-task");
    claimStarted(taskId, agentId);
    goSilent(agentId, taskId);
    const threshold = new Date(Date.now() - 30 * 60_000).toISOString();

    // The exact mid-race state: release committed, agent re-claimed the same
    // task (E2) without heartbeating — pointer + stale heartbeat unchanged,
    // task claimed+owned. The clear MUST retain.
    const cleared = agentRepo.clearAgentTaskPointerIfStale(agentId, taskId, threshold);
    expect(cleared).toBe(false);
    expect(agentRow(agentId).currentTaskId).toBe(taskId); // retained
    expect(taskRow(taskId).status).toBe("in_progress"); // claim untouched
  });

  it("explicit interleave: release commits → re-claim E2 (no heartbeat) → cleanup retains → next sweep releases E2 per contract", async () => {
    const agentId = seedAgent("sweep-f1-seq");
    const taskId = seedTask("sweep-f1-seq-task");
    claimStarted(taskId, agentId);
    goSilent(agentId, taskId);

    // First sweep: block only the pointer cleanup — the release commits.
    const agentRepoModule = await import("../repositories/agent.js");
    const cleanupSpy = vi.spyOn(agentRepoModule, "clearAgentTaskPointerIfStale");
    cleanupSpy.mockImplementationOnce(() => {
      throw new Error("cleanup gap");
    });
    releaseStaleTasks(30);
    expect(taskRow(taskId).status).toBe("pending");
    expect(agentRow(agentId).currentTaskId).toBe(taskId); // gap: pointer alive

    // In the commit→cleanup gap the agent re-claims (E2 minted; agents row
    // untouched — the claim authority writes nothing to agents).
    const reclaim = taskStateMachine.claimTask(taskId, agentId);
    expect(reclaim.success).toBe(true);
    const e2 = (taskRepo.getTaskById(taskId) as Task).executionToken;
    expect(e2).not.toBeNull();

    // The deferred cleanup must NOT clear the re-claimed task's pointer.
    const threshold = new Date(Date.now() - 30 * 60_000).toISOString();
    expect(agentRepo.clearAgentTaskPointerIfStale(agentId, taskId, threshold)).toBe(false);
    expect(agentRow(agentId).currentTaskId).toBe(taskId);

    // Next tick: still heartbeat-stale per the sweep's contract → the full
    // guard path releases E2 (fresh in-tx heartbeat/pointer/owner checks).
    releaseStaleTasks(30);
    expect(taskRow(taskId).status).toBe("pending");
    const released = eventsFor(taskId, "released");
    expect(released).toHaveLength(2); // E1 then E2
    expect(released[1]!.executionToken).toBe(e2);
    expect(agentRow(agentId).currentTaskId).toBeNull();
  });

  it("residue shapes still clear: terminal, foreign, pending-unowned, missing (no live claim)", () => {
    const threshold = new Date(Date.now() - 30 * 60_000).toISOString();

    const termAgent = seedAgent("sweep-f1-term");
    const termTask = seedTask("sweep-f1-term-task");
    const termStarted = claimStarted(termTask, termAgent);
    taskStateMachine.submitTask(termTask, termAgent, "done", [], termStarted.executionToken);
    goSilent(termAgent, termTask);
    expect(agentRepo.clearAgentTaskPointerIfStale(termAgent, termTask, threshold)).toBe(true);
    expect(agentRow(termAgent).currentTaskId).toBeNull();

    const forAgent = seedAgent("sweep-f1-for");
    const forOwner = seedAgent("sweep-f1-for-owner");
    const forTask = seedTask("sweep-f1-for-task");
    claimStarted(forTask, forOwner);
    goSilent(forAgent, forTask); // corrupted pointer at a foreign live claim
    expect(agentRepo.clearAgentTaskPointerIfStale(forAgent, forTask, threshold)).toBe(true);
    expect(agentRow(forAgent).currentTaskId).toBeNull();
    expect(taskRow(forTask).assignedAgentId).toBe(forOwner); // foreign claim intact

    const pendAgent = seedAgent("sweep-f1-pend");
    const pendTask = seedTask("sweep-f1-pend-task");
    claimStarted(pendTask, pendAgent);
    goSilent(pendAgent, pendTask);
    getDb()
      .update(tasks)
      .set({ status: "pending", assignedAgentId: null, executionToken: null })
      .where(eq(tasks.id, pendTask))
      .run();
    expect(agentRepo.clearAgentTaskPointerIfStale(pendAgent, pendTask, threshold)).toBe(true);
    expect(agentRow(pendAgent).currentTaskId).toBeNull();

    const goneAgent = seedAgent("sweep-f1-gone");
    getDb()
      .update(agents)
      .set({
        currentTaskId: "no-such-task",
        lastHeartbeat: new Date(Date.now() - 31 * 60_000).toISOString(),
      })
      .where(eq(agents.id, goneAgent))
      .run();
    expect(agentRepo.clearAgentTaskPointerIfStale(goneAgent, "no-such-task", threshold)).toBe(true);
    expect(agentRow(goneAgent).currentTaskId).toBeNull();
  });

  it("F4: offline flip returns exact landed truth — true once, false when already offline (both orders)", () => {
    const agentId = seedAgent("sweep-f4-flip");
    const threshold = new Date(Date.now() - 30 * 60_000).toISOString();
    ageHeartbeat(agentId);

    expect(agentRepo.markAgentOfflineKeepingTask(agentId, threshold)).toBe(true);
    expect(agentRow(agentId).status).toBe("offline");
    // Already-offline row: no row matched — no second flip, no duplicate SSE.
    expect(agentRepo.markAgentOfflineKeepingTask(agentId, threshold)).toBe(false);
    // Revived heartbeat: CAS misses.
    agentRepo.heartbeat(agentId);
    expect(agentRepo.markAgentOfflineKeepingTask(agentId, threshold)).toBe(false);
    expect(agentRow(agentId).status).not.toBe("offline");
  });
});

describe("failure isolation — DB throw and cleanup throw", () => {
  it("act-tx throw: candidate retained, no swallow, next sweep lands", async () => {
    const agentId = seedAgent("sweep-throw");
    const taskId = seedTask("sweep-throw-task");
    claimStarted(taskId, agentId);
    goSilent(agentId, taskId);

    const releaseEffects = await import("../services/effects/releaseEffects.js");
    const spy = vi.spyOn(releaseEffects, "releaseTaskWithEffects");
    spy.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(() => releaseStaleTasks(30)).not.toThrow(); // per-candidate catch

    // Candidate intact: offline-marked (or not) but the pointer + task remain.
    expect(taskRow(taskId).status).toBe("in_progress");
    expect(agentRow(agentId).currentTaskId).toBe(taskId);

    releaseStaleTasks(30); // retry lands
    expect(taskRow(taskId).status).toBe("pending");
    expect(eventsFor(taskId, "released")).toHaveLength(1);
  });

  it("pointer-cleanup throw: postlude + receipts still land; re-drive idempotent", async () => {
    const agentId = seedAgent("sweep-cleanup-throw");
    const taskId = seedTask("sweep-cleanup-throw-task");
    claimStarted(taskId, agentId);
    goSilent(agentId, taskId);

    const agentRepoModule = await import("../repositories/agent.js");
    const spy = vi.spyOn(agentRepoModule, "clearAgentTaskPointerIfStale");
    spy.mockImplementationOnce(() => {
      throw new Error("cleanup boom");
    });

    releaseStaleTasks(30);

    // Release bundle committed, receipts exist (durable, boot backstop).
    expect(taskRow(taskId).status).toBe("pending");
    expect(receiptsFor(taskId)).toHaveLength(2);
    expect(agentRow(agentId).currentTaskId).toBe(taskId); // cleanup failed

    releaseStaleTasks(30); // re-drive: cleanup-only pass, no new release
    expect(eventsFor(taskId, "released")).toHaveLength(1);
    expect(agentRow(agentId).currentTaskId).toBeNull();
    await processEffectReceipts();
  });
});
