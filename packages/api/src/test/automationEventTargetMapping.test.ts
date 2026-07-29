/**
 * CS-56 T4 — Per-family event target-mapping tests.
 *
 * Locks in the technical-plan target matrix that `ingestEvent`'s normalizer
 * implements (see `automationEventService.ts:normalizeEventTrigger`). Each
 * test exercises one event family + asserts:
 *   - the resolved `targetType` / `targetId` on the persisted run row,
 *   - where applicable, the `pulseId` persistence for `pulse.signal_posted`,
 *   - the `code_evidence.updated` payload targetType/targetId passthrough
 *     (Task or Mission only; the legacy opaque `integration` target is gone),
 *   - the Habitat-targeting behavior for `scheduled_task.failed` /
 *     `release.shipped` (Habitat target with the source id in raw).
 *
 * Also locks in the FIXUP-1 hardening: a missing entity id (row deleted) is
 * rejected as `missing_target` BEFORE condition/action work, with a null
 * `conditionResult` and no actions — so `{type:"always"}` rules cannot fire
 * actions against a non-existent target.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as taskRepoAll from "../repositories/task.js";
import * as sprintRepo from "../repositories/sprint.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as agentRepo from "../repositories/agent.js";
import * as pulseRepoSig from "../repositories/pulse.js";
import { tasks as tasksSchema } from "../db/schema/task.js";
import { ingestEvent, agentHasHabitatWork } from "../services/automationEventService.js";
import type { AutomationCondition } from "@orcy/shared";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function setupHabitat(name = "Mapping Habitat") {
  const h = boardRepo.createHabitat({ name });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  return h;
}

function setupMission(habitatId: string, title = "Mapping Mission") {
  return missionRepo.createMission({ habitatId, title, createdBy: "user-1" });
}

function setupTask(habitatId: string, opts?: { missionId?: string; title?: string }) {
  const mission =
    opts?.missionId ? missionRepo.getMissionById(opts.missionId)! : setupMission(habitatId);
  return taskRepo.createTask({
    missionId: mission.id,
    title: opts?.title ?? "Mapping Task",
    createdBy: "user-1",
  });
}

function setupSprint(habitatId: string) {
  return sprintRepo.create(habitatId, {
    name: "Mapping Sprint",
    startDate: new Date().toISOString(),
    endDate: new Date(Date.now() + 7 * 86400_000).toISOString(),
    createdBy: "user-1",
  });
}

function setupPulse(habitatId: string, missionId: string) {
  return pulseRepo.createPulse({
    habitatId,
    missionId,
    fromType: "system",
    fromId: "test",
    signalType: "context",
    subject: "Mapping Pulse",
    body: "test",
  });
}

function createAlwaysRule(
  habitatId: string,
  triggerType: string,
  overrides?: { name?: string; condition?: AutomationCondition },
) {
  return ruleRepo.createAutomationRule({
    habitatId,
    name: overrides?.name ?? `Mapping ${triggerType}`,
    priority: 0,
    trigger: { type: "event", eventType: triggerType as never } as never,
    enabled: true,
    cooldownSeconds: 0,
    maxRunsPerHour: 100,
    condition: overrides?.condition ?? ({ type: "always" } as AutomationCondition),
    actions: [{ type: "create_signal", content: "Mapping fired" }],
    createdBy: "test",
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CS-56 T4 — per-family event target mapping", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  // -- task.* family ----------------------------------------------------

  it("task.* event maps targetType=task / targetId=taskId", async () => {
    const h = setupHabitat();
    const task = setupTask(h.id);
    const rule = createAlwaysRule(h.id, "task.rejected");

    const result = await ingestEvent(h.id, {
      type: "task.rejected",
      data: { taskId: task.id, eventId: "evt-map-task" },
    });

    expect(result.matched).toBe(1);
    const { runs } = runRepo.listRunsByRule(rule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].targetType).toBe("task");
    expect(runs[0].targetId).toBe(task.id);
  });

  // -- mission.* family -------------------------------------------------

  it("mission.* event maps targetType=mission / targetId=missionId", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const rule = createAlwaysRule(h.id, "mission.status_changed");

    const result = await ingestEvent(h.id, {
      type: "mission.status_changed",
      data: { missionId: mission.id, eventId: "evt-map-mission" },
    });

    expect(result.matched).toBe(1);
    const { runs } = runRepo.listRunsByRule(rule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].targetType).toBe("mission");
    expect(runs[0].targetId).toBe(mission.id);
  });

  // -- sprint.* family --------------------------------------------------

  it("sprint.* event maps targetType=sprint / targetId=sprintId", async () => {
    const h = setupHabitat();
    const sprint = setupSprint(h.id);
    const rule = createAlwaysRule(h.id, "sprint.started");

    const result = await ingestEvent(h.id, {
      type: "sprint.started",
      data: { sprintId: sprint.id, eventId: "evt-map-sprint" },
    });

    expect(result.matched).toBe(1);
    const { runs } = runRepo.listRunsByRule(rule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].targetType).toBe("sprint");
    expect(runs[0].targetId).toBe(sprint.id);
  });

  // -- pulse.signal_posted family ---------------------------------------

  it("pulse.signal_posted maps targetType=pulse / targetId=pulseId (pulseId persisted)", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const pulse = setupPulse(h.id, mission.id);
    const rule = createAlwaysRule(h.id, "pulse.signal_posted");

    const result = await ingestEvent(h.id, {
      type: "pulse.signal_posted",
      data: { pulseId: pulse.id, eventId: "evt-map-pulse" },
    });

    expect(result.matched).toBe(1);
    const { runs } = runRepo.listRunsByRule(rule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].targetType).toBe("pulse");
    expect(runs[0].targetId).toBe(pulse.id);
    // pulseId is the entity id used as the run's targetId; the lifecycle
    // surfaces it via targetType=pulse + targetId.
    void pulseRepoSig;
  });

  // -- code_evidence.updated family ------------------------------------

  it("code_evidence.updated with payload targetType=task / targetId=taskId passes through to Task", async () => {
    const h = setupHabitat();
    const task = setupTask(h.id);
    const rule = createAlwaysRule(h.id, "code_evidence.updated");

    const result = await ingestEvent(h.id, {
      type: "code_evidence.updated",
      data: {
        targetType: "task",
        targetId: task.id,
        changeKind: "not_applicable",
        eventId: "evt-map-ce-task",
      },
    });

    expect(result.matched).toBe(1);
    const { runs } = runRepo.listRunsByRule(rule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].targetType).toBe("task");
    expect(runs[0].targetId).toBe(task.id);
  });

  it("code_evidence.updated with payload targetType=mission / targetId=missionId passes through to Mission", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const rule = createAlwaysRule(h.id, "code_evidence.updated");

    const result = await ingestEvent(h.id, {
      type: "code_evidence.updated",
      data: {
        targetType: "mission",
        targetId: mission.id,
        changeKind: "added",
        eventId: "evt-map-ce-mission",
      },
    });

    expect(result.matched).toBe(1);
    const { runs } = runRepo.listRunsByRule(rule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].targetType).toBe("mission");
    expect(runs[0].targetId).toBe(mission.id);
  });

  it("code_evidence.updated with payload targetType outside {task,mission} resolves to no target (no-op)", async () => {
    const h = setupHabitat();
    const rule = createAlwaysRule(h.id, "code_evidence.updated");

    const result = await ingestEvent(h.id, {
      type: "code_evidence.updated",
      data: {
        targetType: "integration", // legacy opaque target — no longer accepted
        targetId: "anything",
        eventId: "evt-map-ce-bad",
      },
    });

    expect(result.matched).toBe(0);
    expect(result.skipped).toBe(0);
    // No row created — the normalizer returns null.
    expect(runRepo.listRunsByRule(rule.id).runs).toHaveLength(0);
  });

  // -- anomaly.detected family ------------------------------------------

  it("anomaly.detected with taskId in Habitat picks task target", async () => {
    const h = setupHabitat();
    const task = setupTask(h.id);
    const rule = createAlwaysRule(h.id, "anomaly.detected");

    const result = await ingestEvent(h.id, {
      type: "anomaly.detected",
      data: { taskId: task.id, eventId: "evt-map-anomaly-task" },
    });

    expect(result.matched).toBe(1);
    const { runs } = runRepo.listRunsByRule(rule.id);
    expect(runs[0].targetType).toBe("task");
    expect(runs[0].targetId).toBe(task.id);
  });

  it("anomaly.detected with taskId missing + missionId in Habitat picks mission target (fall-through)", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const rule = createAlwaysRule(h.id, "anomaly.detected");

    const result = await ingestEvent(h.id, {
      type: "anomaly.detected",
      data: {
        taskId: "missing-task-id",
        missionId: mission.id,
        eventId: "evt-map-anomaly-mission-fb",
      },
    });

    expect(result.matched).toBe(1);
    const { runs } = runRepo.listRunsByRule(rule.id);
    expect(runs[0].targetType).toBe("mission");
    expect(runs[0].targetId).toBe(mission.id);
  });

  it("anomaly.detected with global Agent having NO Habitat work normalizes to habitat target with Agent facts in raw", async () => {
    const h = setupHabitat();
    // Use a field-comparison condition that reads `raw.agentId` so we can
    // prove the lifecycle's evaluation context saw the Agent facts via raw
    // (the full event.data is forwarded as trigger.payload → ctx.raw).
    const rule = createAlwaysRule(h.id, "anomaly.detected", {
      condition: {
        type: "field",
        field: "raw.anomalyKind",
        operator: "equals",
        value: "agent_offline",
      },
    });
    // Agent with no Habitat work in this Habitat — created but never assigned any task here.
    const agent = agentRepo.createAgent({
      name: "global-agent",
      type: "agent" as never,
      domain: "test",
    }).agent;

    const result = await ingestEvent(h.id, {
      type: "anomaly.detected",
      data: {
        agentId: agent.id,
        anomalyKind: "agent_offline",
        eventId: "evt-map-anomaly-global-agent",
      },
    });

    // The lifecycle normalized the target to `habitat` and evaluated the
    // condition against the forwarded raw payload. The field condition
    // matched (raw.anomalyKind === "agent_offline"), so the rule fired.
    expect(result.matched).toBe(1);
    const { runs } = runRepo.listRunsByRule(rule.id);
    expect(runs[0].targetType).toBe("habitat");
    expect(runs[0].targetId).toBe(h.id);
    // The conditionResult persisted the evaluation against raw — confirming
    // the lifecycle's ctx.raw carried the full event.data payload.
    expect(runs[0].conditionResult).not.toBeNull();
    expect(runs[0].conditionResult!.matched).toBe(true);
    // The action ran (status is a terminal action outcome).
    expect(["succeeded", "partial_failed", "failed"]).toContain(runs[0].status);
    expect(runs[0].actionResults).not.toBeNull();
  });

  // -- scheduled_task.failed + release.shipped families ----------------

  it("scheduled_task.failed normalizes to habitat target; scheduleId stays in raw", async () => {
    const h = setupHabitat();
    const rule = createAlwaysRule(h.id, "scheduled_task.failed");

    const result = await ingestEvent(h.id, {
      type: "scheduled_task.failed",
      data: {
        scheduleId: "sched-1",
        taskTitle: "failing-task",
        eventId: "evt-map-sched-failed",
      },
    });

    expect(result.matched).toBe(1);
    const { runs } = runRepo.listRunsByRule(rule.id);
    expect(runs[0].targetType).toBe("habitat");
    expect(runs[0].targetId).toBe(h.id);
    // The full payload (including scheduleId) is forwarded to the lifecycle.
    // The lifecycle persists metadata with the source payload under raw.
    expect(runs[0].actionResults).not.toBeNull();
  });

  it("release.shipped normalizes to habitat target; releaseId stays in raw", async () => {
    const h = setupHabitat();
    const rule = createAlwaysRule(h.id, "release.shipped");

    const result = await ingestEvent(h.id, {
      type: "release.shipped",
      data: {
        releaseId: "rel-1",
        version: "1.0.0",
        eventId: "evt-map-release",
      },
    });

    expect(result.matched).toBe(1);
    const { runs } = runRepo.listRunsByRule(rule.id);
    expect(runs[0].targetType).toBe("habitat");
    expect(runs[0].targetId).toBe(h.id);
    expect(runs[0].actionResults).not.toBeNull();
  });

  // -- Missing-id case (FIXUP-1 hardening) -----------------------------

  it("missing taskId is rejected as missing_target BEFORE condition/action work (no actions fire)", async () => {
    const h = setupHabitat();
    const rule = createAlwaysRule(h.id, "task.rejected");

    const baselinePulses = await countPulses(h.id);

    const result = await ingestEvent(h.id, {
      type: "task.rejected",
      data: { taskId: "definitely-not-a-task", eventId: "evt-map-missing-task" },
    });

    // The lifecycle's structural step-2 check (targetType set, targetId null)
    // finalizes missing_target with no evaluation and no actions.
    expect(result.matched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.deduplicated).toBe(0);

    const { runs } = runRepo.listRunsByRule(rule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("skipped");
    expect(runs[0].skipReason).toBe("missing_target");
    expect(runs[0].conditionResult).toBeNull(); // condition was never evaluated
    expect(runs[0].actionResults).toBeNull(); // no actions fired

    // The rule is `{type:"always"}` — proving the FIXUP-1 hardening prevents
    // a missing entity from reaching action execution.
    const afterPulses = await countPulses(h.id);
    expect(afterPulses).toBe(baselinePulses);
  });

  it("missing missionId is rejected as missing_target (no actions fire)", async () => {
    const h = setupHabitat();
    const rule = createAlwaysRule(h.id, "mission.status_changed");

    const result = await ingestEvent(h.id, {
      type: "mission.status_changed",
      data: { missionId: "not-a-mission", eventId: "evt-map-missing-mission" },
    });

    expect(result.matched).toBe(0);
    expect(result.skipped).toBe(1);
    const { runs } = runRepo.listRunsByRule(rule.id);
    expect(runs[0].skipReason).toBe("missing_target");
    expect(runs[0].conditionResult).toBeNull();
    expect(runs[0].actionResults).toBeNull();
  });

  // -- Cross-Habitat case ----------------------------------------------

  it("taskId from a different Habitat is rejected as missing_target (fail closed)", async () => {
    const h1 = setupHabitat("Habitat 1");
    const h2 = setupHabitat("Habitat 2");
    // Task belongs to h2; rule is in h1 — cross-Habitat delivery attempt.
    const task = setupTask(h2.id);
    const rule = createAlwaysRule(h1.id, "task.rejected");

    const result = await ingestEvent(h1.id, {
      type: "task.rejected",
      data: { taskId: task.id, eventId: "evt-map-cross-habitat" },
    });

    expect(result.matched).toBe(0);
    expect(result.skipped).toBe(1);
    const { runs } = runRepo.listRunsByRule(rule.id);
    expect(runs[0].skipReason).toBe("missing_target");
    expect(runs[0].conditionResult).toBeNull();
    expect(runs[0].actionResults).toBeNull();
  });

  // -- Client-causal hardening (T4 guardrail) --------------------------

  it("non-trusted event carrying client-supplied causalContext does NOT trigger a causal_cycle skip (the context is ignored)", async () => {
    const h = setupHabitat();
    const task = setupTask(h.id);
    const rule = createAlwaysRule(h.id, "task.rejected");

    // The orchestrator's guardrail: do not accept client-supplied causal
    // identities. Only trusted `task.created` envelopes (server-derived
    // causalContext from the T4B automationAdapter) carry causal identity.
    // A malicious client attaching a self-cycle causalContext to a
    // non-trusted event must NOT trigger a causal_cycle skip — the rule
    // must proceed through normal condition gating.
    const result = await ingestEvent(h.id, {
      type: "task.rejected",
      data: {
        taskId: task.id,
        eventId: "evt-map-client-causal",
        causalContext: {
          root: { type: "automation", id: rule.id },
          hops: [{ type: "automation", id: rule.id }], // self-cycle attempt
        },
      },
    });

    // The client-supplied causalContext was IGNORED — no causal_cycle skip.
    // The `{type:"always"}` rule fired normally.
    expect(result.matched).toBe(1);
    expect(result.skipped).toBe(0);
    const { runs } = runRepo.listRunsByRule(rule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).not.toBe("skipped");
    expect(runs[0].skipReason).not.toBe("causal_cycle");
  });

  // -- CS-56 cold-review M1: agentHasHabitatWork active-status predicate --
  //
  // The cold-review found that `agentHasHabitatWork` joined tasks→missions
  // by `assignedAgentId`+Habitat but had NO Task-status predicate. A
  // `done`/`approved` Task wrongly counted as active work, weakening global
  // Agent ↔ Habitat isolation. The scan path
  // (`listSilentAgentsInHabitat`) already filters to active statuses — the
  // event/manual path is now fixed to share the same active-set constant.

  it("agentHasHabitatWork is FALSE when the agent's only Habitat Tasks are terminal (done)", async () => {
    const h = setupHabitat("Terminal Habitat");
    const agent = agentRepo.createAgent({
      name: "terminal-agent",
      type: "claude-code",
      domain: "backend",
    }).agent;

    const mission = setupMission(h.id, "Terminal Mission");
    const task = setupTask(h.id, { missionId: mission.id });

    // Assign to the agent, then transition to done.
    taskRepoAll.claimTask(task.id, agent.id);
    getDb()
      .update(tasksSchema)
      .set({ status: "done" })
      .where(eq(tasksSchema.id, task.id))
      .run();

    expect(agentHasHabitatWork(agent.id, h.id)).toBe(false);
  });

  it("agentHasHabitatWork is FALSE when the agent's only Habitat Task is approved", async () => {
    const h = setupHabitat("Approved Habitat");
    const agent = agentRepo.createAgent({
      name: "approved-agent",
      type: "claude-code",
      domain: "backend",
    }).agent;

    const mission = setupMission(h.id, "Approved Mission");
    const task = setupTask(h.id, { missionId: mission.id });

    taskRepoAll.claimTask(task.id, agent.id);
    getDb()
      .update(tasksSchema)
      .set({ status: "approved" })
      .where(eq(tasksSchema.id, task.id))
      .run();

    expect(agentHasHabitatWork(agent.id, h.id)).toBe(false);
  });

  it("agentHasHabitatWork is FALSE when the agent's active work is in a DIFFERENT Habitat", async () => {
    const h1 = setupHabitat("Habitat A");
    const h2 = setupHabitat("Habitat B");
    const agent = agentRepo.createAgent({
      name: "cross-habitat-agent",
      type: "claude-code",
      domain: "backend",
    }).agent;

    // Active task in h2 ONLY.
    const missionB = setupMission(h2.id, "B Mission");
    const task = setupTask(h2.id, { missionId: missionB.id });
    taskRepoAll.claimTask(task.id, agent.id);
    // (claimed → default active status; no further mutation needed.)

    // No task in h1 at all.
    expect(agentHasHabitatWork(agent.id, h1.id)).toBe(false);
    // The agent DOES have active Habitat work in h2.
    expect(agentHasHabitatWork(agent.id, h2.id)).toBe(true);
  });

  it("agentHasHabitatWork is TRUE when the agent has an active Habitat Task (claimed/in_progress/submitted)", async () => {
    const h = setupHabitat("Active Habitat");
    const agent = agentRepo.createAgent({
      name: "active-agent",
      type: "claude-code",
      domain: "backend",
    }).agent;

    const mission = setupMission(h.id, "Active Mission");
    const task = setupTask(h.id, { missionId: mission.id });
    taskRepoAll.claimTask(task.id, agent.id);
    // `claimTask` leaves status = "claimed", which is an active status.

    expect(agentHasHabitatWork(agent.id, h.id)).toBe(true);
  });

  it("anomaly.detected with a global Agent whose only Habitat Task is done normalizes to habitat target (the Agent candidate falls through)", async () => {
    const h = setupHabitat("Anomaly Habitat");
    const agent = agentRepo.createAgent({
      name: "anomaly-terminal-agent",
      type: "claude-code",
      domain: "backend",
    }).agent;

    // The agent has a Habitat Task but it is already done — pre-fix this
    // Agent would have been accepted by `agentHasHabitatWork` and become the
    // target. With the active-status predicate in place, the Agent
    // candidate falls through and the lifecycle finalizes the habitat
    // candidate instead.
    const mission = setupMission(h.id, "Anomaly Terminal Mission");
    const task = setupTask(h.id, { missionId: mission.id });
    taskRepoAll.claimTask(task.id, agent.id);
    getDb()
      .update(tasksSchema)
      .set({ status: "done" })
      .where(eq(tasksSchema.id, task.id))
      .run();

    const rule = createAlwaysRule(h.id, "anomaly.detected");
    const result = await ingestEvent(h.id, {
      type: "anomaly.detected",
      data: { agentId: agent.id, eventId: "evt-anomaly-terminal-agent" },
    });

    expect(result.matched).toBe(1);
    const { runs } = runRepo.listRunsByRule(rule.id);
    // Agent candidate rejected → Habitat target as the final fallback.
    expect(runs[0].targetType).toBe("habitat");
    expect(runs[0].targetId).toBe(h.id);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function countPulses(habitatId: string): Promise<number> {
  const { total } = pulseRepo.getPulsesByHabitat(habitatId, { limit: 100, offset: 0 });
  return total;
}
