import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initTestDb, closeDb } from "../db/index.js";
import * as taskRepo from "../repositories/task.js";
import * as missionRepo from "../repositories/feature.js";
import * as habitatService from "../services/boardService.js";
import * as agentRepo from "../repositories/agent.js";
import * as timeRepo from "../repositories/timeTracking.js";
import * as effortRepo from "../repositories/effortEntry.js";

let habitatId: string;
let columnId: string;
let missionId: string;
let agentId: string;

function setupHabitat() {
  const { habitat, columns } = habitatService.createHabitat({
    name: "Effort Test Habitat",
    defaultColumns: true,
  });
  habitatId = habitat.id;
  columnId = columns[0].id;

  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: "Effort Test Mission",
    createdBy: "test-user",
  });
  missionId = mission.id;

  const { agent } = agentRepo.createAgent({
    name: `effort-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "claude-code",
    domain: "fullstack",
    capabilities: ["typescript"],
  });
  agentId = agent.id;
}

beforeEach(async () => {
  await initTestDb();
  setupHabitat();
});

afterEach(() => {
  closeDb();
});

describe("createEffortEntry", () => {
  it("creates a human_manual entry with all fields", () => {
    const task = taskRepo.createTask({ missionId, title: "Effort task", createdBy: "test-user" });
    const startedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const endedAt = new Date().toISOString();

    const entry = effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      actorId: "user-1",
      minutes: 30,
      source: "human_manual",
      note: "Did some work",
      startedAt,
      endedAt,
    });

    expect(entry.id).toBeDefined();
    expect(entry.taskId).toBe(task.id);
    expect(entry.actorType).toBe("human");
    expect(entry.actorId).toBe("user-1");
    expect(entry.minutes).toBe(30);
    expect(entry.source).toBe("human_manual");
    expect(entry.note).toBe("Did some work");
    expect(entry.startedAt).toBe(startedAt);
    expect(entry.endedAt).toBe(endedAt);
    expect(entry.recordedAt).toBeDefined();
    expect(entry.correctsEntryId).toBeNull();
  });

  it("creates an agent_reported entry with minimal fields", () => {
    const task = taskRepo.createTask({
      missionId,
      title: "Agent effort task",
      createdBy: "test-user",
    });

    const entry = effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "agent",
      actorId: agentId,
      minutes: 45,
      source: "agent_reported",
    });

    expect(entry.actorType).toBe("agent");
    expect(entry.actorId).toBe(agentId);
    expect(entry.source).toBe("agent_reported");
    expect(entry.note).toBeNull();
    expect(entry.startedAt).toBeNull();
    expect(entry.endedAt).toBeNull();
  });

  it("creates a correction_adjustment entry with correctsEntryId and correctionReason", () => {
    const task = taskRepo.createTask({
      missionId,
      title: "Correction task",
      createdBy: "test-user",
    });
    const original = effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: 60,
      source: "human_manual",
    });

    const correction = effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: -10,
      source: "correction_adjustment",
      correctsEntryId: original.id,
      correctionReason: "Overcounted by 10 minutes",
    });

    expect(correction.source).toBe("correction_adjustment");
    expect(correction.correctsEntryId).toBe(original.id);
    expect(correction.correctionReason).toBe("Overcounted by 10 minutes");
    expect(correction.minutes).toBe(-10);
  });
});

describe("getEffortEntryById", () => {
  it("returns entry when found", () => {
    const task = taskRepo.createTask({ missionId, title: "Lookup task", createdBy: "test-user" });
    const entry = effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: 15,
      source: "human_manual",
    });

    const found = effortRepo.getEffortEntryById(entry.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(entry.id);
  });

  it("returns null when not found", () => {
    const found = effortRepo.getEffortEntryById("nonexistent-id");
    expect(found).toBeNull();
  });
});

describe("getEffortEntriesByTask", () => {
  it("returns entries ordered by recordedAt", () => {
    const task = taskRepo.createTask({ missionId, title: "Ordered task", createdBy: "test-user" });

    const e1 = effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: 10,
      source: "human_manual",
    });
    const e2 = effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: 20,
      source: "human_manual",
    });

    const entries = effortRepo.getEffortEntriesByTask(task.id);
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe(e1.id);
    expect(entries[1].id).toBe(e2.id);
  });

  it("filters out corrections when includeCorrections=false", () => {
    const task = taskRepo.createTask({ missionId, title: "Filter task", createdBy: "test-user" });

    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: 30,
      source: "human_manual",
    });
    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: -5,
      source: "correction_adjustment",
      correctsEntryId: "fake-id",
    });

    const withCorrections = effortRepo.getEffortEntriesByTask(task.id);
    expect(withCorrections).toHaveLength(2);

    const withoutCorrections = effortRepo.getEffortEntriesByTask(task.id, {
      includeCorrections: false,
    });
    expect(withoutCorrections).toHaveLength(1);
    expect(withoutCorrections[0].source).toBe("human_manual");
  });

  it("returns empty array for task with no entries", () => {
    const task = taskRepo.createTask({ missionId, title: "Empty task", createdBy: "test-user" });
    const entries = effortRepo.getEffortEntriesByTask(task.id);
    expect(entries).toEqual([]);
  });
});

describe("getEffortEntriesWithActorByTask", () => {
  it("returns entries with agent name resolved for agent actors", () => {
    const task = taskRepo.createTask({
      missionId,
      title: "Actor name task",
      createdBy: "test-user",
    });
    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "agent",
      actorId: agentId,
      minutes: 20,
      source: "agent_reported",
    });

    const entries = effortRepo.getEffortEntriesWithActorByTask(task.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].actorName).toBeDefined();
    expect(entries[0].actorName).not.toBeNull();
  });

  it("returns entries with null actorName for human actors", () => {
    const task = taskRepo.createTask({
      missionId,
      title: "Human actor task",
      createdBy: "test-user",
    });
    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      actorId: "user-1",
      minutes: 15,
      source: "human_manual",
    });

    const entries = effortRepo.getEffortEntriesWithActorByTask(task.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].actorName).toBeNull();
  });
});

describe("getEffortTotalsForTask", () => {
  it("returns zero totals for task with no entries and no heartbeat", () => {
    const task = taskRepo.createTask({ missionId, title: "Zero task", createdBy: "test-user" });
    const totals = effortRepo.getEffortTotalsForTask(task.id);

    expect(totals.loggedEffortMinutes).toBe(0);
    expect(totals.inferredPresenceMinutes).toBe(0);
    expect(totals.correctionAdjustmentMinutes).toBe(0);
    expect(totals.totalAccountedMinutes).toBe(0);
  });

  it("computes loggedEffortMinutes from human_manual + agent_reported entries", () => {
    const task = taskRepo.createTask({ missionId, title: "Logged task", createdBy: "test-user" });
    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: 20,
      source: "human_manual",
    });
    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "agent",
      actorId: agentId,
      minutes: 30,
      source: "agent_reported",
    });

    const totals = effortRepo.getEffortTotalsForTask(task.id);
    expect(totals.loggedEffortMinutes).toBe(50);
    expect(totals.correctionAdjustmentMinutes).toBe(0);
  });

  it("computes correctionAdjustmentMinutes from correction_adjustment entries", () => {
    const task = taskRepo.createTask({
      missionId,
      title: "Correction totals task",
      createdBy: "test-user",
    });
    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: 60,
      source: "human_manual",
    });
    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: -10,
      source: "correction_adjustment",
      correctsEntryId: "fake",
    });

    const totals = effortRepo.getEffortTotalsForTask(task.id);
    expect(totals.correctionAdjustmentMinutes).toBe(-10);
  });

  it("computes inferredPresenceMinutes from task_time_records where status_during_work=in_progress", () => {
    const task = taskRepo.createTask({ missionId, title: "Inferred task", createdBy: "test-user" });
    timeRepo.createTimeRecord({
      taskId: task.id,
      agentId,
      minutesSpent: 25,
      statusDuringWork: "in_progress",
    });
    timeRepo.createTimeRecord({
      taskId: task.id,
      agentId,
      minutesSpent: 15,
      statusDuringWork: "in_progress",
    });

    const totals = effortRepo.getEffortTotalsForTask(task.id);
    expect(totals.inferredPresenceMinutes).toBe(40);
  });

  it("computes totalAccountedMinutes as sum of all three", () => {
    const task = taskRepo.createTask({ missionId, title: "Total task", createdBy: "test-user" });
    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: 30,
      source: "human_manual",
    });
    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: -5,
      source: "correction_adjustment",
      correctsEntryId: "fake",
    });
    timeRepo.createTimeRecord({
      taskId: task.id,
      agentId,
      minutesSpent: 20,
      statusDuringWork: "in_progress",
    });

    const totals = effortRepo.getEffortTotalsForTask(task.id);
    expect(totals.loggedEffortMinutes).toBe(30);
    expect(totals.correctionAdjustmentMinutes).toBe(-5);
    expect(totals.inferredPresenceMinutes).toBe(20);
    expect(totals.totalAccountedMinutes).toBe(45);
  });
});

describe("getEffortBySourceForTask", () => {
  it("groups effort entries by source", () => {
    const task = taskRepo.createTask({ missionId, title: "Source task", createdBy: "test-user" });
    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: 15,
      source: "human_manual",
    });
    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: 25,
      source: "human_manual",
    });
    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "agent",
      actorId: agentId,
      minutes: 40,
      source: "agent_reported",
    });

    const bySource = effortRepo.getEffortBySourceForTask(task.id);
    expect(bySource["human_manual"]).toBe(40);
    expect(bySource["agent_reported"]).toBe(40);
  });

  it("includes heartbeat_inferred from task_time_records", () => {
    const task = taskRepo.createTask({
      missionId,
      title: "Heartbeat source task",
      createdBy: "test-user",
    });
    timeRepo.createTimeRecord({
      taskId: task.id,
      agentId,
      minutesSpent: 50,
      statusDuringWork: "in_progress",
    });

    const bySource = effortRepo.getEffortBySourceForTask(task.id);
    expect(bySource["heartbeat_inferred"]).toBe(50);
  });
});

describe("getEffortByActorForTask", () => {
  it("groups by actor_type and actor_id", () => {
    const task = taskRepo.createTask({ missionId, title: "Actor task", createdBy: "test-user" });
    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      actorId: "user-1",
      minutes: 20,
      source: "human_manual",
    });
    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "agent",
      actorId: agentId,
      minutes: 30,
      source: "agent_reported",
    });

    const byActor = effortRepo.getEffortByActorForTask(task.id);
    expect(byActor).toHaveLength(2);

    const human = byActor.find((a) => a.actorType === "human");
    expect(human?.loggedEffortMinutes).toBe(20);

    const agent = byActor.find((a) => a.actorType === "agent");
    expect(agent?.loggedEffortMinutes).toBe(30);
    expect(agent?.actorName).toBeDefined();
  });

  it("includes inferred presence from heartbeat records by agent", () => {
    const task = taskRepo.createTask({
      missionId,
      title: "Heartbeat actor task",
      createdBy: "test-user",
    });
    timeRepo.createTimeRecord({
      taskId: task.id,
      agentId,
      minutesSpent: 35,
      statusDuringWork: "in_progress",
    });

    const byActor = effortRepo.getEffortByActorForTask(task.id);
    const agent = byActor.find((a) => a.actorId === agentId);
    expect(agent?.inferredPresenceMinutes).toBe(35);
  });
});

describe("recalculateTaskEffortMetrics", () => {
  it("updates tasks.actualMinutes to totalAccountedMinutes", () => {
    const task = taskRepo.createTask({ missionId, title: "Recalc task", createdBy: "test-user" });
    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: 45,
      source: "human_manual",
    });

    effortRepo.recalculateTaskEffortMetrics(task.id);

    const updated = taskRepo.getTaskById(task.id);
    expect(updated?.actualMinutes).toBe(45);
  });

  it("updates estimationAccuracy when estimatedMinutes exists", () => {
    const task = taskRepo.createTask({
      missionId,
      title: "Accuracy task",
      createdBy: "test-user",
      estimatedMinutes: 60,
    });
    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      minutes: 30,
      source: "human_manual",
    });

    effortRepo.recalculateTaskEffortMetrics(task.id);

    const updated = taskRepo.getTaskById(task.id);
    expect(updated?.estimationAccuracy).toBeCloseTo(0.5);
  });
});

describe("recalculateMissionEffortMetrics", () => {
  it("rolls up actualMinutes from tasks to mission", () => {
    const task1 = taskRepo.createTask({
      missionId,
      title: "Rollup task 1",
      createdBy: "test-user",
    });
    const task2 = taskRepo.createTask({
      missionId,
      title: "Rollup task 2",
      createdBy: "test-user",
    });

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

    effortRepo.recalculateTaskEffortMetrics(task1.id);
    effortRepo.recalculateTaskEffortMetrics(task2.id);

    const mission = missionRepo.getMissionById(missionId);
    expect(mission?.actualMinutes).toBe(50);
  });
});
