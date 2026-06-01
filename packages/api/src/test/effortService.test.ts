import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initTestDb, closeDb } from "../db/index.js";
import * as taskRepo from "../repositories/task.js";
import * as missionRepo from "../repositories/feature.js";
import * as habitatService from "../services/boardService.js";
import * as agentRepo from "../repositories/agent.js";
import * as effortRepo from "../repositories/effortEntry.js";
import * as timeRepo from "../repositories/timeTracking.js";

vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: vi.fn() },
}));

import * as effortService from "../services/effortService.js";
import { sseBroadcaster } from "../sse/broadcaster.js";

let habitatId: string;
let columnId: string;
let missionId: string;
let agentId: string;

function setupHabitat() {
  const { habitat, columns } = habitatService.createHabitat({
    name: "Service Test Habitat",
    defaultColumns: true,
  });
  habitatId = habitat.id;
  columnId = columns[0].id;

  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: "Service Test Mission",
    createdBy: "test-user",
  });
  missionId = mission.id;

  const { agent } = agentRepo.createAgent({
    name: `service-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "claude-code",
    domain: "fullstack",
    capabilities: ["typescript"],
  });
  agentId = agent.id;
}

beforeEach(async () => {
  await initTestDb();
  setupHabitat();
  vi.clearAllMocks();
});

afterEach(() => {
  closeDb();
});

describe("logEffort", () => {
  it("creates entry with human_manual source for human actor", () => {
    const task = taskRepo.createTask({
      missionId,
      title: "Log human task",
      createdBy: "test-user",
    });
    const entry = effortService.logEffort(task.id, "human", "user-1", {
      minutes: 30,
      note: "Did stuff",
    });

    expect(entry.actorType).toBe("human");
    expect(entry.source).toBe("human_manual");
    expect(entry.minutes).toBe(30);
  });

  it("creates entry with agent_reported source for agent actor", () => {
    const task = taskRepo.createTask({
      missionId,
      title: "Log agent task",
      createdBy: "test-user",
    });
    const entry = effortService.logEffort(task.id, "agent", agentId, { minutes: 45 });

    expect(entry.actorType).toBe("agent");
    expect(entry.source).toBe("agent_reported");
    expect(entry.minutes).toBe(45);
  });

  it("throws if minutes is not a positive integer", () => {
    const task = taskRepo.createTask({
      missionId,
      title: "Invalid minutes task",
      createdBy: "test-user",
    });

    expect(() => effortService.logEffort(task.id, "human", null, { minutes: 0 })).toThrow(
      "minutes must be a positive integer",
    );
    expect(() => effortService.logEffort(task.id, "human", null, { minutes: -5 })).toThrow(
      "minutes must be a positive integer",
    );
    expect(() => effortService.logEffort(task.id, "human", null, { minutes: 1.5 })).toThrow(
      "minutes must be a positive integer",
    );
  });

  it("recalculates task metrics after logging", () => {
    const task = taskRepo.createTask({
      missionId,
      title: "Recalc after log task",
      createdBy: "test-user",
    });
    effortService.logEffort(task.id, "human", null, { minutes: 60 });

    const updated = taskRepo.getTaskById(task.id);
    expect(updated?.actualMinutes).toBe(60);
  });

  it("publishes SSE event", () => {
    const task = taskRepo.createTask({ missionId, title: "SSE task", createdBy: "test-user" });
    effortService.logEffort(task.id, "human", null, { minutes: 15 });

    expect(sseBroadcaster.publish).toHaveBeenCalledOnce();
    const call = vi.mocked(sseBroadcaster.publish).mock.calls[0];
    expect(call[1].type).toBe("effort.updated");
    expect(call[1].data).toMatchObject({ minutes: 15, actorType: "human" });
  });
});

describe("correctEffortEntry", () => {
  it("creates correction_adjustment entry with correctsEntryId", () => {
    const task = taskRepo.createTask({ missionId, title: "Correct task", createdBy: "test-user" });
    const original = effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: 60,
      source: "human_manual",
    });

    const correction = effortService.correctEffortEntry(task.id, original.id, "human", null, {
      minutesDelta: -10,
      correctionReason: "Overcounted",
    });

    expect(correction.source).toBe("correction_adjustment");
    expect(correction.correctsEntryId).toBe(original.id);
    expect(correction.minutes).toBe(-10);
  });

  it("throws if entry not found", () => {
    const task = taskRepo.createTask({ missionId, title: "No entry task", createdBy: "test-user" });

    expect(() =>
      effortService.correctEffortEntry(task.id, "nonexistent", "human", null, {
        minutesDelta: -5,
        correctionReason: "reason",
      }),
    ).toThrow("Effort entry not found");
  });

  it("throws if minutesDelta is 0", () => {
    const task = taskRepo.createTask({
      missionId,
      title: "Zero delta task",
      createdBy: "test-user",
    });
    const entry = effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: 30,
      source: "human_manual",
    });

    expect(() =>
      effortService.correctEffortEntry(task.id, entry.id, "human", null, {
        minutesDelta: 0,
        correctionReason: "reason",
      }),
    ).toThrow("minutesDelta cannot be 0");
  });

  it("throws if correctionReason is empty", () => {
    const task = taskRepo.createTask({
      missionId,
      title: "Empty reason task",
      createdBy: "test-user",
    });
    const entry = effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: 30,
      source: "human_manual",
    });

    expect(() =>
      effortService.correctEffortEntry(task.id, entry.id, "human", null, {
        minutesDelta: -5,
        correctionReason: "",
      }),
    ).toThrow("correctionReason is required");
  });

  it("allows negative minutesDelta", () => {
    const task = taskRepo.createTask({
      missionId,
      title: "Negative delta task",
      createdBy: "test-user",
    });
    const entry = effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: 30,
      source: "human_manual",
    });

    const correction = effortService.correctEffortEntry(task.id, entry.id, "human", null, {
      minutesDelta: -10,
      correctionReason: "Reduce",
    });
    expect(correction.minutes).toBe(-10);
  });

  it("recalculates task metrics after correction", () => {
    const task = taskRepo.createTask({
      missionId,
      title: "Correct recalc task",
      createdBy: "test-user",
    });
    const original = effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: 60,
      source: "human_manual",
    });

    effortService.correctEffortEntry(task.id, original.id, "human", null, {
      minutesDelta: -15,
      correctionReason: "Adjusted down",
    });

    const updated = taskRepo.getTaskById(task.id);
    expect(updated?.actualMinutes).toBe(45);
  });
});

describe("getTaskEffortReport", () => {
  it("returns null for non-existent task", () => {
    const report = effortService.getTaskEffortReport("nonexistent-id");
    expect(report).toBeNull();
  });

  it("returns full report with totals, bySource, byActor, entries", () => {
    const task = taskRepo.createTask({
      missionId,
      title: "Report task",
      createdBy: "test-user",
      estimatedMinutes: 60,
    });
    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: 30,
      source: "human_manual",
    });

    const report = effortService.getTaskEffortReport(task.id);

    expect(report).not.toBeNull();
    expect(report!.target.type).toBe("task");
    expect(report!.target.id).toBe(task.id);
    expect(report!.totals.loggedEffortMinutes).toBe(30);
    expect(report!.bySource["human_manual"]).toBe(30);
    expect(report!.byActor).toHaveLength(1);
    expect(report!.entries).toHaveLength(1);
    expect(report!.estimate.plannedMinutes).toBe(60);
  });

  it("computes accuracy with logged_effort basis when logged effort exists", () => {
    const task = taskRepo.createTask({
      missionId,
      title: "Accuracy logged task",
      createdBy: "test-user",
      estimatedMinutes: 60,
    });
    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: 30,
      source: "human_manual",
    });

    const report = effortService.getTaskEffortReport(task.id);

    expect(report!.accuracy.basis).toBe("logged_effort");
    expect(report!.accuracy.estimationAccuracy).toBeCloseTo(0.5);
  });

  it("computes accuracy with inferred_only basis when only inferred exists", () => {
    const task = taskRepo.createTask({
      missionId,
      title: "Accuracy inferred task",
      createdBy: "test-user",
      estimatedMinutes: 60,
    });
    timeRepo.createTimeRecord({
      taskId: task.id,
      agentId,
      minutesSpent: 30,
      statusDuringWork: "in_progress",
    });

    const report = effortService.getTaskEffortReport(task.id);

    expect(report!.accuracy.basis).toBe("inferred_only");
    expect(report!.accuracy.estimationAccuracy).toBeCloseTo(0.5);
  });

  it("adds overlap warning when both logged and inferred exist", () => {
    const task = taskRepo.createTask({ missionId, title: "Overlap task", createdBy: "test-user" });
    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: 30,
      source: "human_manual",
    });
    timeRepo.createTimeRecord({
      taskId: task.id,
      agentId,
      minutesSpent: 20,
      statusDuringWork: "in_progress",
    });

    const report = effortService.getTaskEffortReport(task.id);

    expect(report!.warnings.length).toBeGreaterThan(0);
    expect(report!.warnings[0]).toContain("overlap");
  });
});

describe("getMissionEffortReport", () => {
  it("returns null for mission with no tasks", () => {
    const mission = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Empty mission",
      createdBy: "test-user",
    });
    const report = effortService.getMissionEffortReport(mission.id);
    expect(report).toBeNull();
  });

  it("aggregates task totals into mission totals", () => {
    const task1 = taskRepo.createTask({ missionId, title: "Agg task 1", createdBy: "test-user" });
    const task2 = taskRepo.createTask({ missionId, title: "Agg task 2", createdBy: "test-user" });
    effortRepo.createEffortEntry({
      taskId: task1.id,
      actorType: "human",
      minutes: 20,
      source: "human_manual",
    });
    effortRepo.createEffortEntry({
      taskId: task2.id,
      actorType: "human",
      minutes: 30,
      source: "human_manual",
    });

    const report = effortService.getMissionEffortReport(missionId);

    expect(report).not.toBeNull();
    expect(report!.totals.loggedEffortMinutes).toBe(50);
    expect(report!.tasks).toHaveLength(2);
  });

  it("aggregates actor data across tasks", () => {
    const task1 = taskRepo.createTask({
      missionId,
      title: "Actor agg task 1",
      createdBy: "test-user",
    });
    const task2 = taskRepo.createTask({
      missionId,
      title: "Actor agg task 2",
      createdBy: "test-user",
    });
    effortRepo.createEffortEntry({
      taskId: task1.id,
      actorType: "agent",
      actorId: agentId,
      minutes: 20,
      source: "agent_reported",
    });
    effortRepo.createEffortEntry({
      taskId: task2.id,
      actorType: "agent",
      actorId: agentId,
      minutes: 30,
      source: "agent_reported",
    });

    const report = effortService.getMissionEffortReport(missionId);

    const agentActor = report!.byActor.find((a) => a.actorId === agentId);
    expect(agentActor?.loggedEffortMinutes).toBe(50);
  });
});
