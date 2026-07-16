import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as agentRepo from "../repositories/agent.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as predictionService from "../services/predictionService.js";
import {
  agents,
  columns,
  habitats,
  missionEvents,
  missions,
  sprints,
  taskDependencies,
  taskEvents,
  tasks,
} from "../db/schema/index.js";

const NOW = "2026-06-04T12:00:00.000Z";

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(taskDependencies).run();
  db.delete(taskEvents).run();
  db.delete(missionEvents).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(sprints).run();
  db.delete(columns).run();
  db.delete(habitats).run();
  db.delete(agents).run();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

function daysAgo(days: number): string {
  return new Date(new Date(NOW).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function daysFromNow(days: number): string {
  return new Date(new Date(NOW).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function createFixture(options: { dueAt?: string | null } = {}) {
  const habitat = habitatRepo.createHabitat({ name: "Habitat" });
  const column = columnRepo.createColumn({
    habitatId: habitat.id,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: column.id,
    title: "Mission",
    createdBy: "user-1",
    dueAt: options.dueAt ?? null,
  });
  return { habitat, mission };
}

function createTask(
  missionId: string,
  title: string,
  priority: "low" | "medium" | "high" | "critical" = "medium",
) {
  return taskRepo.createTask({ missionId, title, priority, createdBy: "user-1" });
}

function completeTask(taskId: string, completedAt: string, assignedAgentId?: string) {
  taskRepo.updateTask(taskId, {
    status: "done",
    completedAt,
    assignedAgentId: assignedAgentId ?? null,
  });
}

describe("predictionService", () => {
  it("calculates habitat and per-agent velocity windows from completed tasks", () => {
    const { habitat, mission } = createFixture();
    const { agent: agentA } = agentRepo.createAgent({
      name: "Agent A",
      type: "opencode",
      domain: "backend",
    });
    const { agent: agentB } = agentRepo.createAgent({
      name: "Agent B",
      type: "opencode",
      domain: "frontend",
    });

    completeTask(createTask(mission.id, "Recent", "high").id, daysAgo(3), agentA.id);
    completeTask(createTask(mission.id, "Two weeks", "medium").id, daysAgo(10), agentA.id);
    completeTask(createTask(mission.id, "Month", "low").id, daysAgo(20), agentB.id);
    completeTask(createTask(mission.id, "Old", "low").id, daysAgo(40), agentB.id);

    const velocity = predictionService.calculateVelocity(habitat.id);

    expect(velocity).toMatchObject({ days7: 1, days14: 2, days30: 3 });
    expect(velocity.perAgent[agentA.id]).toMatchObject({
      agentName: "Agent A",
      days7: 1,
      days14: 2,
      days30: 2,
    });
    expect(velocity.perAgent[agentB.id]).toMatchObject({
      agentName: "Agent B",
      days7: 0,
      days14: 0,
      days30: 1,
    });
  });

  it("estimates active work using priority order, queue position, dependencies, and confidence thresholds", () => {
    const { habitat, mission } = createFixture({ dueAt: daysFromNow(7) });
    const critical = createTask(mission.id, "Critical", "critical");
    const blocked = createTask(mission.id, "Blocked", "high");
    const dependency = createTask(mission.id, "Dependency", "medium");
    const inProgress = createTask(mission.id, "In progress", "low");
    taskRepo.updateTask(inProgress.id, { status: "in_progress" });
    getDb()
      .insert(taskDependencies)
      .values({ taskId: blocked.id, dependsOnId: dependency.id })
      .run();

    const estimates = predictionService.estimateCompletionDates(habitat.id, {
      days7: 3,
      days14: 5,
      days30: 8,
      perAgent: {},
    });

    expect(estimates.map((estimate) => estimate.taskId)).toEqual([
      critical.id,
      blocked.id,
      dependency.id,
      inProgress.id,
    ]);
    expect(estimates.find((estimate) => estimate.taskId === critical.id)).toMatchObject({
      targetType: "task",
      targetId: critical.id,
      missionId: mission.id,
      confidence: "high",
      confidenceScore: 0.9,
      confidenceReasons: [
        "5 tasks completed in the last 14 days.",
        "No unmet dependencies are blocking this task.",
      ],
      sampleSize: 8,
      basis: "throughput",
      positionInQueue: 0,
      daysUntilEstimated: 4,
    });
    expect(estimates.find((estimate) => estimate.taskId === critical.id)).toEqual(
      expect.objectContaining({
        earliestCompletionAt: daysFromNow(3.2),
        latestCompletionAt: daysFromNow(4.8),
      }),
    );
    expect(estimates.find((estimate) => estimate.taskId === blocked.id)).toMatchObject({
      confidence: "medium",
      confidenceScore: 0.65,
      confidenceReasons: [
        "5 tasks completed in the last 14 days.",
        "1 unmet dependency reduces confidence.",
      ],
      reasons: [
        {
          code: "blocked_dependencies",
          message: "1 unmet dependency reduces confidence.",
          severity: "warning",
        },
      ],
      positionInQueue: 1,
      daysUntilEstimated: 6.6,
    });
    expect(estimates.find((estimate) => estimate.taskId === inProgress.id)).toMatchObject({
      confidence: "high",
      positionInQueue: 0,
      daysUntilEstimated: 2.3,
    });
  });

  it("detects due-date risk, stale active work, and blocked pending work", () => {
    const { habitat, mission } = createFixture({ dueAt: daysAgo(1) });
    const stale = createTask(mission.id, "Stale", "medium");
    taskRepo.updateTask(stale.id, { status: "in_progress" });
    getDb()
      .update(tasks)
      .set({ updatedAt: daysAgo(4) })
      .where(eq(tasks.id, stale.id))
      .run();

    const dependency = createTask(mission.id, "Dependency", "medium");
    const blocked = createTask(mission.id, "Blocked", "medium");
    getDb()
      .insert(taskDependencies)
      .values({ taskId: blocked.id, dependsOnId: dependency.id })
      .run();

    const atRisk = predictionService.detectAtRiskTasks(habitat.id, [
      {
        taskId: stale.id,
        targetType: "task",
        targetId: stale.id,
        missionId: mission.id,
        taskTitle: "Stale",
        status: "in_progress",
        priority: "medium",
        assignedAgentId: null,
        dueAt: daysAgo(1),
        estimatedCompletionAt: daysFromNow(4),
        earliestCompletionAt: daysFromNow(2),
        latestCompletionAt: daysFromNow(6),
        confidence: "low",
        confidenceScore: 0.4,
        confidenceReasons: ["manual fixture"],
        reasons: [],
        sampleSize: 3,
        basis: "throughput",
        positionInQueue: 0,
        daysUntilDue: -1,
        daysUntilEstimated: 4,
      },
    ]);

    expect(atRisk).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: stale.id,
          reason: "overdue_prediction",
          severity: "critical",
        }),
        expect.objectContaining({ taskId: stale.id, reason: "past_due", severity: "critical" }),
        expect.objectContaining({ taskId: stale.id, reason: "no_activity", severity: "critical" }),
        expect.objectContaining({
          taskId: blocked.id,
          reason: "blocked_by_dependency",
          severity: "medium",
        }),
      ]),
    );
  });

  it("combines velocity, estimates, and at-risk tasks in getPredictions", () => {
    const { habitat, mission } = createFixture({ dueAt: daysAgo(1) });
    const task = createTask(mission.id, "Late task", "critical");
    taskRepo.updateTask(task.id, { status: "in_progress" });
    getDb()
      .update(tasks)
      .set({ updatedAt: daysAgo(2) })
      .where(eq(tasks.id, task.id))
      .run();

    const predictions = predictionService.getPredictions(habitat.id);

    expect(predictions.velocity).toMatchObject({ days7: 0, days14: 0, days30: 0 });
    expect(predictions.estimates).toHaveLength(1);
    expect(predictions.estimates[0]).toMatchObject({
      taskId: task.id,
      confidence: "insufficient_data",
      confidenceScore: 0.2,
      confidenceReasons: [
        "Insufficient completion history: 0 tasks in 14 days and 0 tasks in 30 days.",
      ],
      earliestCompletionAt: null,
      latestCompletionAt: null,
      daysUntilDue: -1,
    });
    expect(predictions.forecasts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetType: "task",
          targetId: task.id,
          confidence: "insufficient_data",
          sampleSize: 0,
          basis: "throughput",
          reasons: [
            {
              code: "no_recent_velocity",
              message:
                "No completed tasks in the last 30 days; forecast uses a conservative fallback throughput.",
              severity: "warning",
            },
          ],
        }),
        expect.objectContaining({
          targetType: "mission",
          targetId: mission.id,
          confidence: "insufficient_data",
        }),
      ]),
    );
    expect(predictions.atRiskTasks.map((risk) => risk.reason)).toEqual(
      expect.arrayContaining(["overdue_prediction", "past_due", "no_activity"]),
    );
  });

  it("adds mission and sprint aggregate forecasts", () => {
    const { habitat, mission } = createFixture();
    const sprintId = "sprint-1";
    getDb()
      .insert(sprints)
      .values({
        id: sprintId,
        habitatId: habitat.id,
        name: "Sprint 1",
        goal: "Ship forecasts",
        startDate: daysAgo(1),
        endDate: daysFromNow(13),
        status: "active",
        committedMissionIds: [mission.id],
        completedMissionIds: [],
        capacityMinutes: null,
        notes: "",
        createdBy: "user-1",
      })
      .run();
    getDb().update(missions).set({ sprintId }).where(eq(missions.id, mission.id)).run();

    const task = createTask(mission.id, "Forecasted", "medium");
    const estimates = predictionService.estimateCompletionDates(habitat.id, {
      days7: 3,
      days14: 5,
      days30: 8,
      perAgent: {},
    });
    const forecasts = predictionService.buildForecasts(
      habitat.id,
      { days7: 3, days14: 5, days30: 8, perAgent: {} },
      estimates,
    );

    expect(forecasts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetType: "task", targetId: task.id, confidence: "high" }),
        expect.objectContaining({
          targetType: "mission",
          targetId: mission.id,
          confidence: "high",
        }),
        expect.objectContaining({ targetType: "sprint", targetId: sprintId, confidence: "high" }),
      ]),
    );
    expect(forecasts.find((forecast) => forecast.targetType === "sprint")).toMatchObject({
      sampleSize: 8,
      basis: "throughput",
      earliestCompletionAt: estimates[0].earliestCompletionAt,
      latestCompletionAt: estimates[0].latestCompletionAt,
    });
  });

  it("builds burndown data with ideal remaining and estimated completion", () => {
    const { habitat, mission } = createFixture();
    completeTask(createTask(mission.id, "Done", "medium").id, daysAgo(1));
    createTask(mission.id, "Remaining", "medium");

    const burndown = predictionService.getBurndown(habitat.id, 2);

    expect(burndown).toMatchObject({
      totalTasks: 2,
      completedTasks: 1,
      remainingTasks: 1,
      averageDailyVelocity: 0.5,
    });
    expect(burndown.data).toHaveLength(3);
    expect(burndown.data.at(-1)).toMatchObject({ completed: 1, remaining: 1, totalTasks: 2 });
    expect(burndown.estimatedCompletionDate).toBe(daysFromNow(2));
  });
});
