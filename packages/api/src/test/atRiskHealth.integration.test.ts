import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { tasks } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import { updateTaskFixtureForTests } from "./helpers/taskFixtures.js";
import { getPredictions } from "../services/predictionService.js";
import { calculateHealth } from "../services/boardHealthService.js";

beforeEach(async () => {
  await initTestDb();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-04T12:00:00.000Z"));
});
afterEach(() => { vi.useRealTimers(); closeDb(); });

it("counts distinct predicted Tasks in health while retaining their reasons", () => {
  const habitat = habitatRepo.createHabitat({ name: "Habitat" });
  const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0, requiresClaim: false });
  const mission = missionRepo.createMission({ habitatId: habitat.id, columnId: column.id, title: "Mission", createdBy: "user-1", dueAt: "2026-06-03T12:00:00.000Z" });
  const recommendation = "Several at-risk tasks detected — check for blockers or stalled work";
  expect(calculateHealth(habitat.id).dimensions.delivery.atRiskTasks).toBe(0);

  const addStaleTask = (title: string) => {
    const task = taskRepo.createTask({ missionId: mission.id, title, priority: "critical", createdBy: "user-1" });
    updateTaskFixtureForTests(task.id, { status: "in_progress" });
    getDb().update(tasks).set({ updatedAt: "2026-06-02T11:00:00.000Z" }).where(eq(tasks.id, task.id)).run();
    return task;
  };
  const first = addStaleTask("Late task");
  const reasons = getPredictions(habitat.id).atRiskTasks;
  expect(reasons.map(r => [r.taskId, r.reason, r.severity])).toEqual([
    [first.id, "overdue_prediction", "critical"],
    [first.id, "past_due", "critical"],
    [first.id, "no_activity", "high"],
  ]);
  const one = calculateHealth(habitat.id);
  expect(one.dimensions.delivery.atRiskTasks).toBe(1);
  expect(one.recommendations).not.toContain(recommendation);

  addStaleTask("Second task");
  addStaleTask("Third task");
  const three = calculateHealth(habitat.id);
  expect(three.dimensions.delivery.atRiskTasks).toBe(3);
  expect(three.recommendations).toContain(recommendation);
});
