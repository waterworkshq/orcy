import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import { getTimeInColumnSummary } from "../services/timeInColumnService.js";
import {
  agents,
  columns,
  habitats,
  missionEvents,
  missions,
  taskEvents,
  tasks,
} from "../db/schema/index.js";

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

function hoursAgo(hours: number): string {
  return new Date(new Date(NOW).getTime() - hours * 60 * 60 * 1000).toISOString();
}

function createFixture() {
  const habitat = habitatRepo.createHabitat({ name: "Habitat" });
  const todo = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0 });
  const doing = columnRepo.createColumn({ habitatId: habitat.id, name: "Doing", order: 1 });
  const done = columnRepo.createColumn({ habitatId: habitat.id, name: "Done", order: 2 });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: doing.id,
    title: "Mission",
    createdBy: "user-1",
  });
  return { habitat, todo, doing, done, mission };
}

function addMoveEvent(
  id: string,
  taskId: string,
  fromColumnId: string | null,
  toColumnId: string | null,
  timestamp: string,
) {
  getDb()
    .insert(taskEvents)
    .values({
      id,
      taskId,
      actorType: "human",
      actorId: "user-1",
      action: "moved",
      fromColumnId,
      toColumnId,
      fromStatus: null,
      toStatus: null,
      metadata: {},
      timestamp,
    })
    .run();
}

describe("timeInColumnService", () => {
  it("computes average, median, p90, and confidence from completed dwell samples", () => {
    const { habitat, todo, doing, done, mission } = createFixture();
    const durations = [2, 4, 8];
    durations.forEach((duration, index) => {
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: `Task ${index}`,
        priority: "medium",
        createdBy: "user-1",
      });
      const enter = hoursAgo(20 - index * 5);
      const leave = new Date(new Date(enter).getTime() + duration * 60 * 60 * 1000).toISOString();
      addMoveEvent(`enter-${index}`, task.id, todo.id, doing.id, enter);
      addMoveEvent(`leave-${index}`, task.id, doing.id, done.id, leave);
    });

    const summary = getTimeInColumnSummary(habitat.id, 7);

    expect(summary.columns.find((column) => column.columnId === doing.id)).toMatchObject({
      columnName: "Doing",
      sampleSize: 3,
      averageMinutes: 280,
      medianMinutes: 240,
      p90Minutes: 480,
      confidence: "low",
    });
  });

  it("marks columns insufficient when there are fewer than three dwell samples", () => {
    const { habitat } = createFixture();

    const summary = getTimeInColumnSummary(habitat.id, 7);

    expect(summary.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sampleSize: 0, confidence: "insufficient_data" }),
      ]),
    );
    expect(summary.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "insufficient_data" })]),
    );
  });
});
