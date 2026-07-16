import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  effortEntries,
  habitats,
  taskDependencies,
  taskEvents,
  tasks,
  taskTimeRecords,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as sprintService from "../services/sprintService.js";
import * as taskRepo from "../repositories/task.js";
import {
  getSprintBurndown,
  getSprintCarryOver,
  getSprintMetrics,
} from "../services/sprintAnalyticsService.js";

let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  const habitat = habitatRepo.createHabitat({ name: "Sprint Analytics Habitat" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({
    habitatId,
    name: "Backlog",
    order: 0,
    requiresClaim: false,
  }).id;
});

afterEach(() => {
  closeDb();
});

function createMission(title: string, status = "not_started", dueAt?: string | null) {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title,
    createdBy: "user-1",
    dueAt,
  });
  if (status !== "not_started") {
    missionRepo.updateMission(mission.id, { status: status as any });
  }
  return missionRepo.getMissionById(mission.id)!;
}

function createTask(
  missionId: string,
  title: string,
  status = "pending",
  estimatedMinutes?: number,
) {
  const task = taskRepo.createTask({ missionId, title, createdBy: "user-1", estimatedMinutes });
  if (status !== "pending") {
    taskRepo.updateTask(task.id, {
      status: status as any,
      completedAt: status === "done" || status === "approved" ? new Date().toISOString() : null,
    });
  }
  return taskRepo.getTaskById(task.id)!;
}

describe("sprintAnalyticsService", () => {
  it("returns populated metrics with separated effort semantics", () => {
    const db = getDb();
    const sprint = sprintService.createSprint(
      habitatId,
      { name: "Sprint 1", startDate: "2026-06-01", endDate: "2026-06-14" },
      "user-1",
    );
    const doneMission = createMission("Done", "done");
    const activeMission = createMission("Active", "in_progress");
    sprintService.addMissionToSprint(sprint.id, doneMission.id);
    sprintService.addMissionToSprint(sprint.id, activeMission.id);
    const doneTask = createTask(doneMission.id, "Done task", "done", 60);
    const activeTask = createTask(activeMission.id, "Active task", "in_progress", 120);

    db.insert(effortEntries)
      .values({
        id: "effort-1",
        taskId: doneTask.id,
        actorType: "human",
        actorId: "user-1",
        minutes: 50,
        source: "human_manual",
        recordedAt: new Date().toISOString(),
      })
      .run();
    db.insert(effortEntries)
      .values({
        id: "effort-2",
        taskId: doneTask.id,
        actorType: "system",
        actorId: "system",
        minutes: 10,
        source: "correction_adjustment",
        recordedAt: new Date().toISOString(),
      })
      .run();
    db.insert(taskTimeRecords)
      .values({
        id: "time-1",
        taskId: activeTask.id,
        agentId: null,
        minutesSpent: 30,
        statusDuringWork: "in_progress",
        recordedAt: new Date().toISOString(),
      })
      .run();

    const metrics = getSprintMetrics(sprint.id);

    expect(metrics).toMatchObject({
      sprintId: sprint.id,
      totalMissions: 2,
      completedMissions: 1,
      totalTasks: 2,
      completedTasks: 1,
      completionPercentage: 50,
      plannedMinutes: 180,
      loggedEffortMinutes: 60,
      inferredPresenceMinutes: 30,
      carryOverCount: 1,
    });
    expect(metrics?.forecast === null || metrics?.forecast.targetType === "sprint").toBe(true);
  });

  it("returns sprint-scoped burndown excluding non-sprint work", () => {
    const sprint = sprintService.createSprint(
      habitatId,
      { name: "Sprint 1", startDate: "2026-06-01", endDate: "2026-06-14" },
      "user-1",
    );
    const sprintMission = createMission("Sprint mission");
    const outsideMission = createMission("Outside mission");
    sprintService.addMissionToSprint(sprint.id, sprintMission.id);
    createTask(sprintMission.id, "Sprint done", "done", 30);
    createTask(outsideMission.id, "Outside done", "done", 30);

    const burndown = getSprintBurndown(sprint.id);

    expect(burndown?.totalTasks).toBe(1);
    expect(burndown?.completedTasks).toBe(1);
    expect(burndown?.data.length).toBeGreaterThan(1);
  });

  it("explains carry-over candidates with supported reasons", () => {
    const db = getDb();
    db.update(habitats)
      .set({ carryOverPolicy: "next_sprint" })
      .where(eq(habitats.id, habitatId))
      .run();
    const sprint = sprintService.createSprint(
      habitatId,
      { name: "Sprint 1", startDate: "2026-06-01", endDate: "2026-06-14" },
      "user-1",
    );
    const mission = createMission("Carried", "in_progress", "2020-01-01T00:00:00.000Z");
    sprintService.addMissionToSprint(sprint.id, mission.id);
    const blocked = createTask(mission.id, "Blocked", "pending");
    const dependency = createTask(mission.id, "Dependency", "pending", 10);
    db.insert(taskDependencies).values({ taskId: blocked.id, dependsOnId: dependency.id }).run();
    db.update(tasks).set({ rejectedCount: 2 }).where(eq(tasks.id, blocked.id)).run();
    db.insert(effortEntries)
      .values({
        id: "effort-overrun",
        taskId: dependency.id,
        actorType: "human",
        actorId: "user-1",
        minutes: 20,
        source: "human_manual",
        recordedAt: new Date().toISOString(),
      })
      .run();
    db.insert(taskEvents)
      .values({
        id: "event-old",
        taskId: blocked.id,
        actorType: "human",
        actorId: "user-1",
        action: "updated",
        timestamp: "2020-01-02T00:00:00.000Z",
      })
      .run();

    const report = getSprintCarryOver(sprint.id);
    const reasonCodes = report?.carriedOverMissions[0]?.reasons.map((reason) => reason.code) ?? [];

    expect(report?.policy).toBe("next_sprint");
    expect(report?.carriedOverMissions).toHaveLength(1);
    expect(reasonCodes).toEqual(
      expect.arrayContaining([
        "incomplete_tasks",
        "blocked_dependencies",
        "missing_estimates",
        "overdue",
        "no_recent_activity",
        "high_rejection_rate",
        "effort_overrun",
      ]),
    );
  });
});
