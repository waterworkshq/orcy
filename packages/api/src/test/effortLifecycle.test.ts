import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as taskRepo from "../repositories/task.js";
import * as missionRepo from "../repositories/feature.js";
import * as habitatService from "../services/boardService.js";
import * as agentRepo from "../repositories/agent.js";
import * as timeRepo from "../repositories/timeTracking.js";
import * as effortRepo from "../repositories/effortEntry.js";

vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: vi.fn() },
}));

vi.mock("../plugins/pluginManager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/pluginManager.js")>();
  return {
    ...actual,
    emitTaskClaimed: vi.fn().mockResolvedValue(undefined),
    emitTaskSubmitted: vi.fn().mockResolvedValue(undefined),
    emitTaskApproved: vi.fn().mockResolvedValue(undefined),
    emitTaskRejected: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../services/pulseService.js", () => ({
  emitAutoSignal: vi.fn(),
}));

vi.mock("../services/reviewAssignmentService.js", () => ({
  assignReviewers: vi.fn(() => ({ skipped: true, assigned: [] })),
  hasAssignedReviewers: vi.fn(() => false),
  isAssignedReviewer: vi.fn(() => false),
  recordApproval: vi.fn(),
  hasAllRequiredApprovals: vi.fn(() => true),
}));

vi.mock("../services/qualityGateService.js", () => ({
  ensureTaskChecklists: vi.fn(),
  validateQualityGates: vi.fn(() => ({ passed: true, failures: [] })),
}));

import * as timeTrackingService from "../services/timeTrackingService.js";
import { claimTask, startTask, submitTask } from "../services/tasks/task-lifecycle.js";

let habitatId: string;
let columnId: string;
let missionId: string;
let agentId: string;

function setupHabitat() {
  const { habitat, columns } = habitatService.createHabitat({
    name: "Lifecycle Test Habitat",
    defaultColumns: true,
  });
  habitatId = habitat.id;
  columnId = columns[0].id;

  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: "Lifecycle Test Mission",
    createdBy: "test-user",
  });
  missionId = mission.id;

  const { agent } = agentRepo.createAgent({
    name: `lifecycle-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "claude-code",
    domain: "fullstack",
    capabilities: ["typescript"],
  });
  agentId = agent.id;
}

function createAndAdvanceToInProgress(title: string, estimatedMinutes?: number) {
  const task = taskRepo.createTask({
    missionId,
    title,
    createdBy: "test-user",
    estimatedMinutes: estimatedMinutes ?? null,
  });
  claimTask(task.id, agentId);
  startTask(task.id, agentId);
  return taskRepo.getTaskById(task.id)!;
}

beforeEach(async () => {
  await initTestDb();
  setupHabitat();
  vi.clearAllMocks();
});

afterEach(() => {
  closeDb();
});

describe("submitTask skips 0-minute record", () => {
  it("limits time records returned by task", () => {
    const task = createAndAdvanceToInProgress("Time record limit task");

    timeRepo.createTimeRecord({
      taskId: task.id,
      agentId,
      minutesSpent: 10,
      statusDuringWork: "in_progress",
    });
    timeRepo.createTimeRecord({
      taskId: task.id,
      agentId,
      minutesSpent: 15,
      statusDuringWork: "in_progress",
    });

    expect(timeRepo.getTimeRecordsByTask(task.id, { limit: 1 })).toHaveLength(1);
  });

  it("does not create a task_time_records entry with status_during_work='submitted'", () => {
    const task = createAndAdvanceToInProgress("Submit skip task");

    timeRepo.createTimeRecord({
      taskId: task.id,
      agentId: agentId,
      minutesSpent: 10,
      statusDuringWork: "in_progress",
    });

    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "agent",
      actorId: agentId,
      minutes: 20,
      source: "agent_reported",
    });

    const result = submitTask(task.id, agentId, "done", []);
    expect(result.task).not.toBeNull();

    const records = timeRepo.getTimeRecordsByTask(task.id);
    const submittedRecords = records.filter((r) => r.statusDuringWork === "submitted");
    expect(submittedRecords.length).toBe(0);
  });

  it("persists logged effort as actualMinutes when logged and inferred effort may overlap", () => {
    const task = createAndAdvanceToInProgress("Submit metrics task", 120);

    timeRepo.createTimeRecord({
      taskId: task.id,
      agentId: agentId,
      minutesSpent: 15,
      statusDuringWork: "in_progress",
    });

    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      actorId: "user-1",
      minutes: 30,
      source: "human_manual",
    });

    const result = submitTask(task.id, agentId, "done", []);
    expect(result.task).not.toBeNull();

    const updated = taskRepo.getTaskById(task.id)!;
    expect(updated.actualMinutes).toBe(30);
  });

  it("still recalculates mission metrics on submit", () => {
    const task = createAndAdvanceToInProgress("Submit mission task", 60);

    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "agent",
      actorId: agentId,
      minutes: 25,
      source: "agent_reported",
    });

    submitTask(task.id, agentId, "done", []);

    const mission = missionRepo.getMissionById(missionId);
    expect(mission!.actualMinutes).toBe(25);
  });
});

describe("completion metrics use canonical effort basis", () => {
  it("prefers logged effort for actualMinutes when logged and inferred effort may overlap", () => {
    const task = createAndAdvanceToInProgress("Dual-table complete", 100);

    timeRepo.createTimeRecord({
      taskId: task.id,
      agentId: agentId,
      minutesSpent: 20,
      statusDuringWork: "in_progress",
    });

    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      actorId: "user-1",
      minutes: 35,
      source: "human_manual",
    });

    submitTask(task.id, agentId, "done", []);

    timeTrackingService.calculateAndSetCompletionMetrics(task.id);

    const updated = taskRepo.getTaskById(task.id)!;
    expect(updated.actualMinutes).toBe(35);
  });

  it("uses logged effort for estimationAccuracy when logged and inferred effort may overlap", () => {
    const task = createAndAdvanceToInProgress("Accuracy dual-table", 100);

    timeRepo.createTimeRecord({
      taskId: task.id,
      agentId: agentId,
      minutesSpent: 30,
      statusDuringWork: "in_progress",
    });

    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "agent",
      actorId: agentId,
      minutes: 20,
      source: "agent_reported",
    });

    submitTask(task.id, agentId, "done", []);

    timeTrackingService.calculateAndSetCompletionMetrics(task.id);

    const updated = taskRepo.getTaskById(task.id)!;
    expect(updated.estimationAccuracy).toBeCloseTo(0.2, 2);
  });

  it("includes correction adjustments in persisted logged basis", () => {
    const task = createAndAdvanceToInProgress("Correction total", 200);

    timeRepo.createTimeRecord({
      taskId: task.id,
      agentId: agentId,
      minutesSpent: 10,
      statusDuringWork: "in_progress",
    });

    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "agent",
      actorId: agentId,
      minutes: 40,
      source: "agent_reported",
    });

    effortRepo.createEffortEntry({
      taskId: task.id,
      actorType: "human",
      actorId: "user-1",
      minutes: 15,
      source: "correction_adjustment",
    });

    submitTask(task.id, agentId, "done", []);

    timeTrackingService.calculateAndSetCompletionMetrics(task.id);

    const updated = taskRepo.getTaskById(task.id)!;
    expect(updated.actualMinutes).toBe(55);
  });

  it("still computes cycleTime and leadTime from timestamps", () => {
    const task = createAndAdvanceToInProgress("Timestamp metrics");

    submitTask(task.id, agentId, "done", []);

    timeTrackingService.calculateAndSetCompletionMetrics(task.id);

    const updated = taskRepo.getTaskById(task.id)!;
    expect(updated.cycleTimeMinutes).not.toBeNull();
    expect(updated.cycleTimeMinutes!).toBeGreaterThanOrEqual(0);
    expect(updated.leadTimeMinutes).not.toBeNull();
    expect(updated.leadTimeMinutes!).toBeGreaterThanOrEqual(0);
  });
});

describe("habitat metrics include effort splits", () => {
  function completeTaskWithEffort(
    title: string,
    heartbeatMinutes: number,
    effortMinutes: number,
    correctionMinutes: number = 0,
  ) {
    const task = createAndAdvanceToInProgress(title, 100);

    if (heartbeatMinutes > 0) {
      timeRepo.createTimeRecord({
        taskId: task.id,
        agentId: agentId,
        minutesSpent: heartbeatMinutes,
        statusDuringWork: "in_progress",
      });
    }

    if (effortMinutes > 0) {
      effortRepo.createEffortEntry({
        taskId: task.id,
        actorType: "agent",
        actorId: agentId,
        minutes: effortMinutes,
        source: "agent_reported",
      });
    }

    if (correctionMinutes > 0) {
      effortRepo.createEffortEntry({
        taskId: task.id,
        actorType: "human",
        actorId: "user-1",
        minutes: correctionMinutes,
        source: "correction_adjustment",
      });
    }

    submitTask(task.id, agentId, "done", []);
    timeTrackingService.calculateAndSetCompletionMetrics(task.id);

    taskRepo.markTaskDone(task.id);
    return task;
  }

  it("populates totalLoggedEffortMinutes", () => {
    completeTaskWithEffort("Logged effort habitat", 0, 30);
    completeTaskWithEffort("More logged effort", 0, 45);

    const metrics = timeTrackingService.getHabitatMetrics(habitatId);
    expect(metrics.totalLoggedEffortMinutes).toBe(75);
  });

  it("populates totalInferredPresenceMinutes", () => {
    completeTaskWithEffort("Inferred 1", 20, 0);
    completeTaskWithEffort("Inferred 2", 15, 0);

    const metrics = timeTrackingService.getHabitatMetrics(habitatId);
    expect(metrics.totalInferredPresenceMinutes).toBe(35);
  });

  it("totalAccountedMinutes = logged + inferred + corrections", () => {
    completeTaskWithEffort("Mixed 1", 10, 20, 5);
    completeTaskWithEffort("Mixed 2", 15, 30, 10);

    const metrics = timeTrackingService.getHabitatMetrics(habitatId);
    expect(metrics.totalLoggedEffortMinutes).toBe(65);
    expect(metrics.totalInferredPresenceMinutes).toBe(25);
    expect(metrics.totalAccountedMinutes).toBe(90);
  });

  it("keeps totalActualMinutes canonical while totalAccountedMinutes remains a labeled rollup", () => {
    completeTaskWithEffort("Compat task", 10, 25, 5);

    const metrics = timeTrackingService.getHabitatMetrics(habitatId);
    expect(metrics.totalActualMinutes).toBe(30);
    expect(metrics.totalAccountedMinutes).toBe(40);
  });

  it("returns zeros when no completed tasks exist", () => {
    createAndAdvanceToInProgress("Still in progress");

    const metrics = timeTrackingService.getHabitatMetrics(habitatId);
    expect(metrics.totalLoggedEffortMinutes).toBe(0);
    expect(metrics.totalInferredPresenceMinutes).toBe(0);
    expect(metrics.totalAccountedMinutes).toBe(0);
  });
});
