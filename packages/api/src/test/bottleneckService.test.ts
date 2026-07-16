import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import { getBottlenecks } from "../services/bottleneckService.js";
import {
  agents,
  columns,
  habitats,
  missionEvents,
  missions,
  taskDependencies,
  taskEvents,
  tasks,
} from "../db/schema/index.js";

const NOW = "2026-06-05T12:00:00.000Z";

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(taskDependencies).run();
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
  const doing = columnRepo.createColumn({
    habitatId: habitat.id,
    name: "Doing",
    order: 1,
    wipLimit: 1,
  });
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

describe("bottleneckService", () => {
  it("reports dwell-time and WIP bottlenecks", () => {
    const { habitat, todo, doing, done, mission } = createFixture();
    [30, 36, 48].forEach((duration, index) => {
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: `Slow ${index}`,
        priority: "medium",
        createdBy: "user-1",
      });
      const enter = hoursAgo(100 - index * 10);
      const leave = new Date(new Date(enter).getTime() + duration * 60 * 60 * 1000).toISOString();
      addMoveEvent(`enter-${index}`, task.id, todo.id, doing.id, enter);
      addMoveEvent(`leave-${index}`, task.id, doing.id, done.id, leave);
    });
    missionRepo.createMission({
      habitatId: habitat.id,
      columnId: doing.id,
      title: "Second Mission",
      createdBy: "user-1",
    });

    const report = getBottlenecks(habitat.id, 7);

    expect(report.bottlenecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          columnId: doing.id,
          signal: "dwell_time",
          severity: "medium",
          confidence: "low",
        }),
        expect.objectContaining({
          columnId: doing.id,
          signal: "wip_exceeded",
          severity: "high",
          confidence: "high",
        }),
      ]),
    );
  });

  it("reports blocked dependency bottlenecks", () => {
    const { habitat, mission } = createFixture();
    const blocked = taskRepo.createTask({
      missionId: mission.id,
      title: "Blocked",
      priority: "medium",
      createdBy: "user-1",
    });
    const dependency = taskRepo.createTask({
      missionId: mission.id,
      title: "Dependency",
      priority: "medium",
      createdBy: "user-1",
    });
    getDb()
      .insert(taskDependencies)
      .values({ taskId: blocked.id, dependsOnId: dependency.id })
      .run();

    const report = getBottlenecks(habitat.id, 7);

    expect(report.bottlenecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          missionId: mission.id,
          signal: "blocked_dependencies",
          severity: "low",
          confidence: "high",
        }),
      ]),
    );
  });
});
