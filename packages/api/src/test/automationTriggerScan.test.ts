import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as missionRepo from "../repositories/mission.js";
import * as sprintRepo from "../repositories/sprint.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as codeEvidenceGapRepo from "../repositories/codeEvidenceGapRepository.js";
import * as sprintService from "../services/sprintService.js";
import { ingestEvent } from "../services/automationEventService.js";
import { runAllScans } from "../services/automationScanService.js";
import { agents } from "../db/schema/agent.js";
import { missionDependencies } from "../db/schema/habitat.js";

function setupHabitat() {
  const h = boardRepo.createHabitat({ name: "Test Habitat" });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  return h;
}

/** Creates a mission + task owned by the given Habitat (the post-T4 ownership signal). */
function setupTask(habitatId: string) {
  const mission = missionRepo.createMission({
    habitatId,
    title: "Trigger scan mission",
    createdBy: "user-1",
  });
  return taskRepo.createTask({ missionId: mission.id, title: "Trigger scan task", createdBy: "user-1" });
}

function setupMission(habitatId: string) {
  return missionRepo.createMission({
    habitatId,
    title: "Trigger scan mission",
    createdBy: "user-1",
  });
}

function setupSprint(habitatId: string) {
  return sprintRepo.create(habitatId, {
    name: "Sprint",
    startDate: new Date().toISOString(),
    endDate: new Date(Date.now() + 7 * 86400_000).toISOString(),
    createdBy: "user-1",
  });
}

function setupPulse(habitatId: string) {
  const mission = setupMission(habitatId);
  return pulseRepo.createPulse({
    habitatId,
    missionId: mission.id,
    fromType: "system",
    fromId: "test",
    signalType: "context",
    subject: "Trigger scan pulse",
    body: "test",
  });
}

function createEnabledRule(
  habitatId: string,
  triggerType: string,
  overrides?: Partial<{ cooldownSeconds: number; maxRunsPerHour: number; name: string }>,
) {
  const isEvent =
    triggerType.startsWith("task.") ||
    triggerType.startsWith("mission.") ||
    triggerType.startsWith("pulse.") ||
    triggerType.startsWith("sprint.");
  const trigger = (
    isEvent ? { type: "event", eventType: triggerType } : { type: "scan", scanType: triggerType }
  ) as unknown;
  return ruleRepo.createAutomationRule({
    habitatId,
    name: overrides?.name ?? "Test Rule",
    priority: 0,
    trigger: trigger as any,
    enabled: true,
    cooldownSeconds: overrides?.cooldownSeconds ?? 0,
    maxRunsPerHour: overrides?.maxRunsPerHour ?? 100,
    actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "Test" }],
    createdBy: "system:test",
  });
}

/** Create a blocked Mission fixture (one blocker + one blocked source). */
function setupBlockedMissionFixture(habitatId: string) {
  const blocker = missionRepo.createMission({
    habitatId,
    title: "Blocker",
    createdBy: "user-1",
  });
  const blocked = missionRepo.createMission({
    habitatId,
    title: "Blocked",
    createdBy: "user-1",
  });
  getDb()
    .insert(missionDependencies)
    .values({ missionId: blocked.id, dependsOnId: blocker.id })
    .run();
  return { blocker, blocked };
}

describe("automationEventService", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("returns empty result for non-allowlisted event", async () => {
    const result = await ingestEvent("hab-1", { type: "unknown.event", data: {} });
    expect(result.eventType).toBe("unknown.event");
    expect(result.matched).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("returns empty when no matching enabled rules exist", async () => {
    const habitat = setupHabitat();
    const result = await ingestEvent(habitat.id, { type: "task.rejected", data: {} });
    expect(result.eventType).toBe("task.rejected");
    expect(result.matched).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("task.rejected event triggers a matching rule", async () => {
    const habitat = setupHabitat();
    const task = setupTask(habitat.id);
    createEnabledRule(habitat.id, "task.rejected");

    const result = await ingestEvent(habitat.id, {
      type: "task.rejected",
      data: { taskId: task.id, eventId: "evt-1" },
    });

    expect(result.matched).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("duplicate event within cooldown records skipped run", async () => {
    const habitat = setupHabitat();
    const task = setupTask(habitat.id);
    createEnabledRule(habitat.id, "task.rejected", { cooldownSeconds: 3600 });

    const data = { taskId: task.id, eventId: "evt-1" };

    const first = await ingestEvent(habitat.id, { type: "task.rejected", data });
    expect(first.matched).toBeGreaterThanOrEqual(1);

    const second = await ingestEvent(habitat.id, { type: "task.rejected", data });
    expect(second.skipped).toBeGreaterThanOrEqual(1);
  });

  it("skips when hourly cap is exceeded", async () => {
    const habitat = setupHabitat();
    const task1 = setupTask(habitat.id);
    const task2 = setupTask(habitat.id);
    createEnabledRule(habitat.id, "task.rejected", { maxRunsPerHour: 1 });

    const data = { taskId: task1.id, eventId: "evt-1" };

    const first = await ingestEvent(habitat.id, { type: "task.rejected", data });
    expect(first.matched).toBe(1);

    const second = await ingestEvent(habitat.id, {
      type: "task.rejected",
      data: { taskId: task2.id, eventId: "evt-2" },
    });
    expect(second.skipped).toBeGreaterThanOrEqual(1);
  });

  // Note: the CS-56 T4 cut-over scopes causal-cycle enforcement to trusted
  // `task.created` envelopes only (server-derived causal context per the
  // technical plan). Non-task.created events no longer carry causalContext
  // forward — the cycle guard lives inside the lifecycle and only sees what
  // task.created forwards. The task.created cycle/depth behavior is covered
  // comprehensively in automationEventService.test.ts.

  it("ingestion is non-throwing on bad data", async () => {
    const habitat = setupHabitat();
    createEnabledRule(habitat.id, "task.rejected");

    const result = await ingestEvent(habitat.id, { type: "task.rejected", data: null as any });
    expect(result.errors).toBeDefined();
  });

  it("event with task target resolves targetType correctly", async () => {
    const habitat = setupHabitat();
    const task = setupTask(habitat.id);
    createEnabledRule(habitat.id, "task.overdue");

    const result = await ingestEvent(habitat.id, {
      type: "task.overdue",
      data: { taskId: task.id, eventId: "evt-1" },
    });
    expect(result.matched).toBe(1);
  });

  it("mission event triggers matching rule", async () => {
    const habitat = setupHabitat();
    const mission = setupMission(habitat.id);
    createEnabledRule(habitat.id, "mission.status_changed");
    const result = await ingestEvent(habitat.id, {
      type: "mission.status_changed",
      data: { missionId: mission.id, eventId: "evt-1" },
    });
    expect(result.matched).toBe(1);
  });

  it("pulse event triggers matching rule", async () => {
    const habitat = setupHabitat();
    const pulse = setupPulse(habitat.id);
    createEnabledRule(habitat.id, "pulse.signal_posted");
    const result = await ingestEvent(habitat.id, {
      type: "pulse.signal_posted",
      data: { pulseId: pulse.id, eventId: "evt-1" },
    });
    expect(result.matched).toBe(1);
  });

  it("sprint event triggers matching rule", async () => {
    const habitat = setupHabitat();
    const sprint = setupSprint(habitat.id);
    createEnabledRule(habitat.id, "sprint.started");
    const result = await ingestEvent(habitat.id, {
      type: "sprint.started",
      data: { sprintId: sprint.id, eventId: "evt-1" },
    });
    expect(result.matched).toBe(1);
  });
});

describe("automationScanService", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("returns empty when no rules match scan types", async () => {
    const habitat = setupHabitat();
    const reports = await runAllScans();
    const habitatReports = reports.filter((r) => r.habitatId === habitat.id);
    for (const r of habitatReports) {
      expect(r.rulesMatched).toBe(0);
    }
  });

  it("mission_blocked scan fires once per actually-blocked Mission", async () => {
    const habitat = setupHabitat();
    setupBlockedMissionFixture(habitat.id);
    createEnabledRule(habitat.id, "mission_blocked");
    const reports = await runAllScans();
    const r = reports.find(
      (x) => x.habitatId === habitat.id && x.scanType === "mission_blocked",
    );
    expect(r!.rulesMatched).toBe(1);
  });

  it("mission_blocked scan does NOT fire when no Mission is blocked (only done/no deps)", async () => {
    const habitat = setupHabitat();
    // Two missions, no dependency edges → no blocked candidates.
    missionRepo.createMission({ habitatId: habitat.id, title: "M1", createdBy: "user-1" });
    missionRepo.createMission({ habitatId: habitat.id, title: "M2", createdBy: "user-1" });
    createEnabledRule(habitat.id, "mission_blocked");
    const reports = await runAllScans();
    const r = reports.find(
      (x) => x.habitatId === habitat.id && x.scanType === "mission_blocked",
    );
    expect(r).toBeDefined();
    expect(r!.rulesMatched).toBe(0);
  });

  it("agent_silent scan fires once per silent Agent with Habitat-scoped active work", async () => {
    const habitat = setupHabitat();
    // Create agent, claim a Task in a Habitat-owned Mission, then backdate
    // the agent's heartbeat to simulate staleness.
    const agent = agentRepo.createAgent({
      name: "silent-agent",
      type: "claude-code",
      domain: "backend",
    }).agent;
    const mission = setupMission(habitat.id);
    const task = taskRepo.createTask({
      missionId: mission.id,
      title: "Active task",
      createdBy: "user-1",
    });
    taskRepo.claimTask(task.id, agent.id);
    agentRepo.updateAgent(agent.id, {
      status: "working",
    });
    // Force heartbeat older than default 15-min threshold.
    const staleHeartbeat = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    getDb()
      .update(agents)
      .set({ lastHeartbeat: staleHeartbeat })
      .where(eq(agents.id, agent.id))
      .run();

    createEnabledRule(habitat.id, "agent_silent");
    const reports = await runAllScans();
    const r = reports.find(
      (x) => x.habitatId === habitat.id && x.scanType === "agent_silent",
    );
    expect(r!.rulesMatched).toBe(1);
  });

  it("evidence_gap_open scan fires once per active Habitat-scoped gap", async () => {
    const habitat = setupHabitat();
    const mission = setupMission(habitat.id);
    const task = taskRepo.createTask({
      missionId: mission.id,
      title: "Task with gap",
      createdBy: "user-1",
    });
    codeEvidenceGapRepo.create({
      targetType: "task",
      targetId: task.id,
      reasonCode: "no_link",
      reportedByType: "system",
      reportedById: "test",
    });

    createEnabledRule(habitat.id, "evidence_gap_open");
    const reports = await runAllScans();
    const r = reports.find(
      (x) => x.habitatId === habitat.id && x.scanType === "evidence_gap_open",
    );
    expect(r!.rulesMatched).toBe(1);
  });

  it("sprint_ending scan runs when sprint exists", async () => {
    const habitat = setupHabitat();
    // Sprint must be active
    sprintRepo.create(habitat.id, {
      name: "Active Sprint",
      startDate: "2025-01-01",
      endDate: "2025-01-14",
      createdBy: "user-1",
    });
    const sprint =
      sprintRepo.getActiveForHabitat(habitat.id) ?? sprintRepo.getByHabitatId(habitat.id)[0];
    if (sprint && sprint.status !== "active") {
      sprintService.startSprint(sprint.id);
    }
    createEnabledRule(habitat.id, "sprint_ending");
    const reports = await runAllScans();
    const r = reports.find(
      (x) => x.habitatId === habitat.id && x.scanType === "sprint_ending",
    );
    expect(r).toBeDefined();
    expect(r!.rulesMatched).toBeGreaterThanOrEqual(1);
  });

  it("scan events use deterministic per-candidate trigger_event_id", async () => {
    const habitat = setupHabitat();
    const { blocked } = setupBlockedMissionFixture(habitat.id);
    createEnabledRule(habitat.id, "mission_blocked");
    await runAllScans();
    const { runs } = runRepo.listRunsByHabitat(habitat.id, { limit: 5 });
    expect(runs.length).toBeGreaterThan(0);
    // Deterministic by scan type + candidate identity + habitat.
    expect(runs[0].triggerEventId).toBe(`scan:mission_blocked:${blocked.id}:${habitat.id}`);
  });

  it("disabled rules are not triggered by scans", async () => {
    const habitat = setupHabitat();
    setupBlockedMissionFixture(habitat.id);
    ruleRepo.createAutomationRule({
      habitatId: habitat.id,
      name: "Disabled Rule",
      priority: 0,
      trigger: { type: "scan", scanType: "mission_blocked" } as any,
      enabled: false,
      actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "Test" }],
      createdBy: "system:test",
    });
    const reports = await runAllScans();
    const r = reports.find(
      (x) => x.habitatId === habitat.id && x.scanType === "mission_blocked",
    );
    // Disabled rules produce no matches.
    expect(r!.rulesMatched).toBe(0);
  });

  it("scan respects cooldown", async () => {
    const habitat = setupHabitat();
    setupBlockedMissionFixture(habitat.id);
    createEnabledRule(habitat.id, "mission_blocked", { cooldownSeconds: 3600 });
    await runAllScans();
    const second = await runAllScans();
    const r = second.find(
      (x) => x.habitatId === habitat.id && x.scanType === "mission_blocked",
    );
    // With cooldown active, the second pass returns a skipped row but no
    // matched attempt.
    expect(r!.rulesMatched).toBe(0);
    expect(r!.rulesSkipped).toBeGreaterThanOrEqual(1);
  });
});