import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import {
  agents,
  columns,
  habitats,
  missionEvents,
  missions,
  taskEvents,
  tasks,
} from "../db/schema/index.js";
import { getHabitatTrends } from "../services/trendService.js";

const NOW = "2026-06-05T12:00:00.000Z";

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(taskEvents).run();
  db.delete(missionEvents).run();
  db.delete(tasks).run();
  db.delete(missions).run();
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

function createFixture() {
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
  });
  return { habitat, mission };
}

function completeTask(missionId: string, title: string, claimedAt: string, completedAt: string) {
  const task = taskRepo.createTask({ missionId, title, priority: "medium", createdBy: "user-1" });
  getDb()
    .update(tasks)
    .set({ status: "done", claimedAt, completedAt })
    .where(eq(tasks.id, task.id))
    .run();
  return task;
}

describe("trendService", () => {
  it("compares current period with the previous equal period", () => {
    const { habitat, mission } = createFixture();
    completeTask(mission.id, "Current fast 1", daysAgo(2.5), daysAgo(2));
    completeTask(mission.id, "Current fast 2", daysAgo(3.5), daysAgo(3));
    completeTask(mission.id, "Current fast 3", daysAgo(4.5), daysAgo(4));
    completeTask(mission.id, "Previous slow", daysAgo(12), daysAgo(10));

    const trends = getHabitatTrends(habitat.id, 7);

    expect(trends).toMatchObject({ habitatId: habitat.id, periodDays: 7, generatedAt: NOW });
    expect(trends.trends).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: "throughput",
          current: 0.43,
          previous: 0.14,
          absoluteDelta: 0.29,
          relativeDelta: 2.03,
          direction: "improving",
          sampleSize: 4,
          confidence: "low",
        }),
        expect.objectContaining({
          metric: "cycle_time",
          current: 720,
          previous: 2880,
          absoluteDelta: -2160,
          relativeDelta: -0.75,
          direction: "improving",
          sampleSize: 4,
          confidence: "low",
        }),
      ]),
    );
  });

  it("marks trends unknown when sample size is insufficient", () => {
    const { habitat, mission } = createFixture();
    completeTask(mission.id, "Only one", daysAgo(2.5), daysAgo(2));

    const trends = getHabitatTrends(habitat.id, 7);

    expect(trends.trends).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: "throughput",
          sampleSize: 1,
          confidence: "insufficient_data",
          direction: "unknown",
        }),
        expect.objectContaining({
          metric: "cycle_time",
          sampleSize: 1,
          confidence: "insufficient_data",
          direction: "unknown",
        }),
      ]),
    );
  });
});
