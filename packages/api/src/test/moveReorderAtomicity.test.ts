import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import {
  columns as columnsTable,
  missions as missionsTable,
  missionEvents,
} from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import * as missionRepo from "../repositories/feature.js";
import * as columnRepo from "../repositories/column.js";
import * as habitatService from "../services/boardService.js";
import { moveMissionToColumn, autoAdvanceMissionColumn } from "../services/featureService.js";
import * as dependencyService from "../services/dependencyService.js";
import { computeMissionSummary } from "../services/boardService.js";

// Real-write tests against better-sqlite3 (NOT mocked). The existing
// missionMoveContract / columnReorderContract tests mock the repository and
// therefore cannot catch the server-atomicity defects M1/M2/M4. These tests
// exercise the actual write path and the real unique (habitatId, order) index.

let habitatId: string;
let columnIds: string[];

function setupHabitat() {
  const { habitat, columns } = habitatService.createHabitat({
    name: "Atomicity Habitat",
    defaultColumns: true,
  });
  habitatId = habitat.id;
  columnIds = columns.map((c) => c.id);
}

function setColumnOrders(pairs: [string, number][]) {
  const db = getDb();
  pairs.forEach(([id], i) => {
    db.update(columnsTable)
      .set({ order: -(i + 1) })
      .where(eq(columnsTable.id, id))
      .run();
  });
  pairs.forEach(([id, order]) => {
    db.update(columnsTable).set({ order }).where(eq(columnsTable.id, id)).run();
  });
}

function movedEventCount(missionId: string): number {
  const row = getDb()
    .select({ count: missionEvents.id })
    .from(missionEvents)
    .where(eq(missionEvents.missionId, missionId))
    .all();
  return row.length;
}

beforeEach(async () => {
  await initTestDb();
  setupHabitat();
});

afterEach(() => {
  closeDb();
});

describe("M1 — moveMission is server-atomic (version in WHERE, branch on affected rows)", () => {
  it("rejects a stale-version write with zero rows and surfaces currentVersion (simulated concurrent move)", () => {
    const mission = missionRepo.createMission({
      habitatId,
      columnId: columnIds[0],
      title: "Concurrent Mission",
      createdBy: "tester",
    });

    const first = missionRepo.moveMission(mission.id, columnIds[1], mission.version);
    expect(first.success).toBe(true);

    const stale = missionRepo.moveMission(mission.id, columnIds[2], mission.version);
    expect(stale.success).toBe(false);
    if (!stale.success && "versionMismatch" in stale) {
      expect(stale.currentVersion).toBe(
        (first as { mission: { version: number } }).mission.version,
      );
    }

    const after = missionRepo.getMissionById(mission.id)!;
    expect(after.columnId).toBe(columnIds[1]);
    expect(after.version).toBe((first as { mission: { version: number } }).mission.version);
  });

  it("returns notFound for a missing mission (no write)", () => {
    const result = missionRepo.moveMission("nonexistent-id", columnIds[0]);
    expect(result.success).toBe(false);
    if (!result.success) expect("notFound" in result).toBe(true);
  });
});

describe("M4 — moveMission rejects cross-habitat target columns", () => {
  it("the repo returns invalidTarget when the target column belongs to another habitat", () => {
    const other = habitatService.createHabitat({ name: "Other Habitat", defaultColumns: true });
    const otherColumnId = other.columns[0].id;

    const mission = missionRepo.createMission({
      habitatId,
      columnId: columnIds[0],
      title: "Owner Mission",
      createdBy: "tester",
    });

    const result = missionRepo.moveMission(mission.id, otherColumnId, mission.version);
    expect(result.success).toBe(false);
    if (!result.success) expect("invalidTarget" in result).toBe(true);

    const after = missionRepo.getMissionById(mission.id)!;
    expect(after.columnId).toBe(columnIds[0]);
  });

  it("the service moveMissionToColumn returns invalidTarget and the route-facing contract stays non-enumerating", () => {
    const other = habitatService.createHabitat({ name: "Other Habitat", defaultColumns: true });
    const otherColumnId = other.columns[0].id;

    const mission = missionRepo.createMission({
      habitatId,
      columnId: columnIds[0],
      title: "Owner Mission",
      createdBy: "tester",
    });

    const result = moveMissionToColumn(
      mission.id,
      otherColumnId,
      "tester",
      "human",
      mission.version,
    );
    expect("invalidTarget" in result).toBe(true);

    const after = missionRepo.getMissionById(mission.id)!;
    expect(after.columnId).toBe(columnIds[0]);
    expect(after.version).toBe(mission.version);
  });

  it("a same-habitat move still succeeds", () => {
    const mission = missionRepo.createMission({
      habitatId,
      columnId: columnIds[0],
      title: "Movable Mission",
      createdBy: "tester",
    });

    const result = moveMissionToColumn(
      mission.id,
      columnIds[1],
      "tester",
      "human",
      mission.version,
    );
    expect("mission" in result).toBe(true);
    const after = missionRepo.getMissionById(mission.id)!;
    expect(after.columnId).toBe(columnIds[1]);
    expect(after.version).toBe(mission.version + 1);
  });
});

describe("M2 — reorderColumns commits on non-contiguous orders without UNIQUE failure", () => {
  it("reorders columns whose current orders have gaps (e.g. post-deletion [0,2])", () => {
    const { habitat } = habitatService.createHabitat({
      name: "Two-Column Habitat",
      defaultColumns: false,
    });
    const c0 = columnRepo.createColumn({ habitatId: habitat.id, name: "A", order: 0 });
    const c1 = columnRepo.createColumn({ habitatId: habitat.id, name: "B", order: 1 });
    getDb().update(columnsTable).set({ order: 2 }).where(eq(columnsTable.id, c1.id)).run();
    const twoColumnIds = [c0.id, c1.id];

    const result = columnRepo.reorderColumns(habitat.id, twoColumnIds, [c1.id, c0.id]);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.columns.map((c) => c.id)).toEqual([c1.id, c0.id]);
    expect(result.columns.map((c) => c.order)).toEqual([0, 1]);
  });

  it("reorders four columns with wide non-contiguous gaps [0,2,4,6]", () => {
    setColumnOrders([
      [columnIds[0], 0],
      [columnIds[1], 2],
      [columnIds[2], 4],
      [columnIds[3], 6],
    ]);

    const desired = [columnIds[3], columnIds[2], columnIds[1], columnIds[0]];
    const result = columnRepo.reorderColumns(habitatId, [...columnIds], desired);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.columns.map((c) => c.id)).toEqual(desired);
    expect(result.columns.map((c) => c.order)).toEqual([0, 1, 2, 3]);
  });

  it("still returns versionConflict with zero writes on stale expectedOrder", () => {
    setColumnOrders([
      [columnIds[0], 0],
      [columnIds[1], 1],
      [columnIds[2], 2],
      [columnIds[3], 3],
    ]);

    const staleExpected = [columnIds[3], columnIds[2], columnIds[1], columnIds[0]];
    const result = columnRepo.reorderColumns(habitatId, staleExpected, [...columnIds]);
    expect(result.success).toBe(false);
    if (!result.success && "versionConflict" in result) {
      expect(result.currentOrder).toEqual(columnIds);
    }
  });
});

describe("autoAdvanceMissionColumn — no write + no event on stale version under atomic move", () => {
  it("returns staleVersion and leaves the row untouched when a prior commit bumped the version", () => {
    const mission = missionRepo.createMission({
      habitatId,
      columnId: columnIds[0],
      title: "Auto-advance Mission",
      createdBy: "tester",
    });

    const advanced = missionRepo.moveMission(mission.id, columnIds[1], mission.version);
    expect(advanced.success).toBe(true);

    const eventsBefore = movedEventCount(mission.id);

    const result = autoAdvanceMissionColumn(mission, "in_progress");

    expect(result).not.toBeNull();
    expect(result && "staleVersion" in result).toBe(true);
    const after = missionRepo.getMissionById(mission.id)!;
    expect(after.columnId).toBe(columnIds[1]);
    expect(after.version).toBe((advanced as { mission: { version: number } }).mission.version);
    expect(movedEventCount(mission.id)).toBe(eventsBefore);
  });
});

describe("m8 — blocked is computed from the mission_dependencies join, not the denormalized JSON", () => {
  it("counts a dependency added via the dependency endpoint (join-only, JSON stays empty)", () => {
    const upstream = missionRepo.createMission({
      habitatId,
      columnId: columnIds[0],
      title: "Upstream",
      createdBy: "tester",
    });
    const downstream = missionRepo.createMission({
      habitatId,
      columnId: columnIds[0],
      title: "Downstream",
      createdBy: "tester",
    });

    const added = dependencyService.addMissionDependency(downstream.id, upstream.id);
    expect(added.success).toBe(true);

    const refreshed = missionRepo.getMissionById(downstream.id)!;
    expect(refreshed.dependsOn).toEqual([]);

    const allMissions = missionRepo.getMissionsByHabitatId(habitatId).missions;
    const edges = missionRepo.getMissionDependencyEdges(allMissions.map((m) => m.id));
    const summary = computeMissionSummary(allMissions, edges);
    expect(summary.blocked).toBe(1);
  });

  it("does not block when the join dependency target is done", () => {
    const upstream = missionRepo.createMission({
      habitatId,
      columnId: columnIds[0],
      title: "Done Upstream",
      createdBy: "tester",
    });
    const downstream = missionRepo.createMission({
      habitatId,
      columnId: columnIds[0],
      title: "Downstream",
      createdBy: "tester",
    });

    missionRepo.updateMission(upstream.id, { status: "done" });
    dependencyService.addMissionDependency(downstream.id, upstream.id);

    const allMissions = missionRepo.getMissionsByHabitatId(habitatId).missions;
    const edges = missionRepo.getMissionDependencyEdges(allMissions.map((m) => m.id));
    const summary = computeMissionSummary(allMissions, edges);
    expect(summary.blocked).toBe(0);
  });
});
