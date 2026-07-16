import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { missions, pulses, triageClusterMissions } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as dependencyRepo from "../repositories/dependency.js";
import * as triageClusterMissionsRepo from "../repositories/triageClusterMissions.js";
import { runOrphanMissionUnmappedScan } from "../services/orphanScanService.js";

let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(pulses).run();
  db.delete(missions).run();

  const habitat = habitatRepo.createHabitat({ name: "Orphan Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
});

afterEach(() => closeDb());

function seedMission(title: string) {
  return missionRepo.createMission({ habitatId, columnId, title, createdBy: "user-1" });
}

describe("RM-7: orphan_mission_unmapped scan", () => {
  it("detects a dependency-less mission as an orphan and creates a triage investigation", async () => {
    const orphan = seedMission("orphan — no deps");
    // A connected pair: C depends on B, so both B and C have incident edges.
    const b = seedMission("B");
    const c = seedMission("C");
    dependencyRepo.addMissionDependency(c.id, b.id);

    await runOrphanMissionUnmappedScan(habitatId);

    // The orphan has an active triage junction; B and C do not.
    expect(
      triageClusterMissionsRepo.findActiveByClusterKey(habitatId, `orphan-mission:${orphan.id}`),
    ).not.toBeNull();
    expect(
      triageClusterMissionsRepo.findActiveByClusterKey(habitatId, `orphan-mission:${b.id}`),
    ).toBeNull();
    expect(
      triageClusterMissionsRepo.findActiveByClusterKey(habitatId, `orphan-mission:${c.id}`),
    ).toBeNull();
  });

  it("suppresses re-firing while an orphan triage investigation is active", async () => {
    const orphan = seedMission("orphan");

    await runOrphanMissionUnmappedScan(habitatId);
    const countAfterFirst = getDb()
      .select()
      .from(triageClusterMissions)
      .where(eq(triageClusterMissions.clusterKey, `orphan-mission:${orphan.id}`))
      .all().length;

    await runOrphanMissionUnmappedScan(habitatId);
    const countAfterSecond = getDb()
      .select()
      .from(triageClusterMissions)
      .where(eq(triageClusterMissions.clusterKey, `orphan-mission:${orphan.id}`))
      .all().length;

    // Only one triage mission was created — the second scan was suppressed by the active junction.
    expect(countAfterFirst).toBe(1);
    expect(countAfterSecond).toBe(1);
  });

  it("does not flag done/failed/archived missions as orphans", async () => {
    const done = seedMission("done");
    missionRepo.updateMission(done.id, { status: "done" });
    const archived = seedMission("archived");
    missionRepo.updateMission(archived.id, { isArchived: true });

    await runOrphanMissionUnmappedScan(habitatId);

    expect(
      triageClusterMissionsRepo.findActiveByClusterKey(habitatId, `orphan-mission:${done.id}`),
    ).toBeNull();
    expect(
      triageClusterMissionsRepo.findActiveByClusterKey(habitatId, `orphan-mission:${archived.id}`),
    ).toBeNull();
  });
});
