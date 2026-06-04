import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as missionEventRepo from "../repositories/events/event-feature.js";
import { columns, habitats, missionEvents, missions } from "../db/schema/index.js";
import { deleteMission } from "../services/featureService.js";

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(missionEvents).run();
  db.delete(missions).run();
  db.delete(columns).run();
  db.delete(habitats).run();
});

afterEach(() => {
  closeDb();
});

describe("featureService.deleteMission persistence", () => {
  it("retains the deletion audit event after the mission row is deleted", () => {
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
      title: "Delete me",
      createdBy: "user-1",
    });

    expect(deleteMission(mission.id, "user-1", "human")).toEqual({ success: true });
    expect(missionRepo.getMissionById(mission.id)).toBeNull();

    const events = missionEventRepo.getMissionEventsByMissionId(mission.id, 10).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      missionId: mission.id,
      actorType: "human",
      actorId: "user-1",
      action: "deleted",
      metadata: {
        title: "Delete me",
        habitatId: habitat.id,
        columnId: column.id,
      },
    });
  });
});
