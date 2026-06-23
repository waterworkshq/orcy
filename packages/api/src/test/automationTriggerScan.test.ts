import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as missionRepo from "../repositories/feature.js";
import * as sprintRepo from "../repositories/sprint.js";
import * as sprintService from "../services/sprintService.js";
import { ingestEvent } from "../services/automationEventService.js";
import { runAllScans } from "../services/automationScanService.js";

function setupHabitat() {
  const h = boardRepo.createHabitat({ name: "Test Habitat" });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  return h;
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
    createEnabledRule(habitat.id, "task.rejected");

    const result = await ingestEvent(habitat.id, {
      type: "task.rejected",
      data: { taskId: "task-1", eventId: "evt-1" },
    });

    expect(result.matched).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("duplicate event within cooldown records skipped run", async () => {
    const habitat = setupHabitat();
    createEnabledRule(habitat.id, "task.rejected", { cooldownSeconds: 3600 });

    const data = { taskId: "task-1", eventId: "evt-1" };

    const first = await ingestEvent(habitat.id, { type: "task.rejected", data });
    expect(first.matched).toBeGreaterThanOrEqual(1);

    const second = await ingestEvent(habitat.id, { type: "task.rejected", data });
    expect(second.skipped).toBeGreaterThanOrEqual(1);
  });

  it("skips when hourly cap is exceeded", async () => {
    const habitat = setupHabitat();
    createEnabledRule(habitat.id, "task.rejected", { maxRunsPerHour: 1 });

    const data = { taskId: "task-1", eventId: "evt-1" };

    const first = await ingestEvent(habitat.id, { type: "task.rejected", data });
    expect(first.matched).toBe(1);

    const second = await ingestEvent(habitat.id, {
      type: "task.rejected",
      data: { taskId: "task-2", eventId: "evt-2" },
    });
    expect(second.skipped).toBeGreaterThanOrEqual(1);
  });

  it("automation event with self-loop provenance is skipped", async () => {
    const habitat = setupHabitat();
    const rule = createEnabledRule(habitat.id, "task.rejected");

    const result = await ingestEvent(habitat.id, {
      type: "task.rejected",
      data: {
        taskId: "task-1",
        eventId: "evt-auto",
        provenanceType: "automation",
        provenanceRuleId: rule.id,
      },
    });

    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.matched).toBe(0);
  });

  it("ingestion is non-throwing on bad data", async () => {
    const habitat = setupHabitat();
    createEnabledRule(habitat.id, "task.rejected");

    const result = await ingestEvent(habitat.id, { type: "task.rejected", data: null as any });
    expect(result.errors).toBeDefined();
  });

  it("event with task target resolves targetType correctly", async () => {
    const habitat = setupHabitat();
    createEnabledRule(habitat.id, "task.overdue");

    const result = await ingestEvent(habitat.id, {
      type: "task.overdue",
      data: { taskId: "task-1", eventId: "evt-1" },
    });
    expect(result.matched).toBe(1);
  });

  it("mission event triggers matching rule", async () => {
    const habitat = setupHabitat();
    createEnabledRule(habitat.id, "mission.status_changed");
    const result = await ingestEvent(habitat.id, {
      type: "mission.status_changed",
      data: { missionId: "miss-1", eventId: "evt-1" },
    });
    expect(result.matched).toBe(1);
  });

  it("pulse event triggers matching rule", async () => {
    const habitat = setupHabitat();
    createEnabledRule(habitat.id, "pulse.signal_posted");
    const result = await ingestEvent(habitat.id, {
      type: "pulse.signal_posted",
      data: { pulseId: "pulse-1", eventId: "evt-1" },
    });
    expect(result.matched).toBe(1);
  });

  it("sprint event triggers matching rule", async () => {
    const habitat = setupHabitat();
    createEnabledRule(habitat.id, "sprint.started");
    const result = await ingestEvent(habitat.id, {
      type: "sprint.started",
      data: { sprintId: "sprint-1", eventId: "evt-1" },
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

  it("mission_blocked scan triggers rule", async () => {
    const habitat = setupHabitat();
    createEnabledRule(habitat.id, "mission_blocked");
    const reports = await runAllScans();
    const r = reports.find((x) => x.habitatId === habitat.id && x.scanType === "mission_blocked");
    expect(r!.rulesMatched).toBe(1);
  });

  it("agent_silent scan triggers rule", async () => {
    const habitat = setupHabitat();
    createEnabledRule(habitat.id, "agent_silent");
    const reports = await runAllScans();
    const r = reports.find((x) => x.habitatId === habitat.id && x.scanType === "agent_silent");
    expect(r!.rulesMatched).toBe(1);
  });

  it("evidence_gap_open scan triggers rule", async () => {
    const habitat = setupHabitat();
    createEnabledRule(habitat.id, "evidence_gap_open");
    const reports = await runAllScans();
    const r = reports.find((x) => x.habitatId === habitat.id && x.scanType === "evidence_gap_open");
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
    const r = reports.find((x) => x.habitatId === habitat.id && x.scanType === "sprint_ending");
    expect(r).toBeDefined();
    expect(r!.rulesMatched).toBeGreaterThanOrEqual(1);
  });

  it("scan events use deterministic trigger_event_id", async () => {
    const habitat = setupHabitat();
    createEnabledRule(habitat.id, "mission_blocked");
    await runAllScans();
    const { runs } = runRepo.listRunsByHabitat(habitat.id, { limit: 1 });
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].triggerEventId).toContain("scan:mission_blocked");
  });

  it("disabled rules are not triggered by scans", async () => {
    const habitat = setupHabitat();
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
    const r = reports.find((x) => x.habitatId === habitat.id && x.scanType === "mission_blocked");
    // Disabled rules produce no matches — the report may not exist since no rules matched
    if (r) expect(r.rulesMatched).toBe(0);
  });

  it("scan respects cooldown", async () => {
    const habitat = setupHabitat();
    createEnabledRule(habitat.id, "mission_blocked", { cooldownSeconds: 3600 });
    await runAllScans();
    const second = await runAllScans();
    const r = second.find((x) => x.habitatId === habitat.id && x.scanType === "mission_blocked");
    // With cooldown active, no new matches
    if (r) expect(r.rulesMatched).toBe(0);
  });
});
