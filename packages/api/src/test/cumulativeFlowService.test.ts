import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import * as snapshotRepo from "../repositories/cumulativeFlowSnapshot.js";
import { getCumulativeFlow } from "../services/cumulativeFlowService.js";
import {
  agents,
  columns,
  cumulativeFlowSnapshots,
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
  db.delete(cumulativeFlowSnapshots).run();
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

function createFixture() {
  const habitat = habitatRepo.createHabitat({ name: "Habitat" });
  const todo = columnRepo.createColumn({
    habitatId: habitat.id,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  const doing = columnRepo.createColumn({
    habitatId: habitat.id,
    name: "Doing",
    order: 1,
    requiresClaim: true,
  });
  return { habitat, todo, doing };
}

describe("cumulativeFlowService", () => {
  it("reads stored snapshots for chart points", () => {
    const { habitat, todo, doing } = createFixture();
    snapshotRepo.upsertSnapshot({
      habitatId: habitat.id,
      snapshotDate: "2026-06-04",
      countsByColumn: { [todo.id]: 2, [doing.id]: 1 },
      countsByStatus: { pending: 2, in_progress: 1 },
    });
    snapshotRepo.upsertSnapshot({
      habitatId: habitat.id,
      snapshotDate: "2026-06-05",
      countsByColumn: { [todo.id]: 1, [doing.id]: 2 },
      countsByStatus: { pending: 1, in_progress: 2 },
    });

    const flow = getCumulativeFlow(habitat.id, 7);

    expect(flow.columns).toEqual([
      { columnId: todo.id, name: "Todo", order: 0 },
      { columnId: doing.id, name: "Doing", order: 1 },
    ]);
    expect(flow.data.at(-2)).toEqual({
      date: "2026-06-04",
      countsByColumn: { [todo.id]: 2, [doing.id]: 1 },
      countsByStatus: { pending: 2, in_progress: 1 },
    });
    expect(flow.data.at(-1)).toEqual({
      date: "2026-06-05",
      countsByColumn: { [todo.id]: 1, [doing.id]: 2 },
      countsByStatus: { pending: 1, in_progress: 2 },
    });
    expect(flow.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "partial_history" })]),
    );
  });

  it("uses current board state for today when no snapshot exists", () => {
    const { habitat, todo, doing } = createFixture();
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: doing.id,
      title: "Mission",
      createdBy: "user-1",
    });
    taskRepo.createTask({
      missionId: mission.id,
      title: "Pending",
      priority: "medium",
      createdBy: "user-1",
    });
    taskRepo.createTask({
      missionId: mission.id,
      title: "Second",
      priority: "medium",
      createdBy: "user-1",
    });

    const flow = getCumulativeFlow(habitat.id, 7);

    expect(flow.data.at(-1)).toEqual({
      date: "2026-06-05",
      countsByColumn: { [todo.id]: 0, [doing.id]: 1 },
      countsByStatus: { pending: 2 },
    });
    expect(flow.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "partial_history" }),
        expect.objectContaining({ code: "current_state_projection" }),
      ]),
    );
  });

  it("upserts snapshots by habitat and date", () => {
    const { habitat, todo } = createFixture();
    const first = snapshotRepo.upsertSnapshot({
      habitatId: habitat.id,
      snapshotDate: "2026-06-05",
      countsByColumn: { [todo.id]: 1 },
      countsByStatus: { pending: 1 },
    });
    const second = snapshotRepo.upsertSnapshot({
      habitatId: habitat.id,
      snapshotDate: "2026-06-05",
      countsByColumn: { [todo.id]: 3 },
      countsByStatus: { pending: 3 },
      completeness: "partial",
    });

    expect(second.id).toBe(first.id);
    expect(second.countsByColumn).toEqual({ [todo.id]: 3 });
    expect(second.completeness).toBe("partial");
    expect(snapshotRepo.listSnapshotsForRange(habitat.id, "2026-06-01", "2026-06-05")).toHaveLength(
      1,
    );
  });
});
