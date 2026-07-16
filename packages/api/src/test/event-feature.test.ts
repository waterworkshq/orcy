import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import {
  createMissionEvent,
  getMissionEventById,
  getMissionEventsByHabitatId,
  getMissionEventsByMissionId,
} from "../repositories/events/event-feature.js";
import { columns, habitats, missionEvents, missions } from "../db/schema/index.js";
import { setAuditActor, runWithAuditProvenance } from "../services/auditProvenanceContext.js";

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(missionEvents).run();
  db.delete(missions).run();
  db.delete(columns).run();
  db.delete(habitats).run();
});

afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

function createMissionFixture(name: string) {
  const habitat = habitatRepo.createHabitat({ name: `${name} Habitat` });
  const column = columnRepo.createColumn({
    habitatId: habitat.id,
    name: `${name} Todo`,
    order: 0,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: column.id,
    title: `${name} Mission`,
    createdBy: "user-1",
  });
  return { habitat, column, mission };
}

describe("mission event repository", () => {
  it("creates and retrieves a mission event with defaults and metadata", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T10:00:00.000Z"));
    const fixture = createMissionFixture("Create");

    const event = createMissionEvent({
      missionId: fixture.mission.id,
      actorType: "human",
      actorId: "user-1",
      action: "moved",
      fromColumnId: fixture.column.id,
      toColumnId: "next-column",
      fromStatus: "not_started",
      toStatus: "in_progress",
      metadata: { reason: "ready" },
    });

    expect(event).toMatchObject({
      missionId: fixture.mission.id,
      actorType: "human",
      actorId: "user-1",
      action: "moved",
      fromColumnId: fixture.column.id,
      toColumnId: "next-column",
      fromStatus: "not_started",
      toStatus: "in_progress",
      metadata: { reason: "ready" },
      timestamp: "2026-05-28T10:00:00.000Z",
    });
    expect(getMissionEventById(event.id)).toEqual(event);
  });

  it("adds request audit provenance metadata when context is active", () => {
    const fixture = createMissionFixture("Provenance");

    const event = runWithAuditProvenance(
      {
        source: "rest_api",
        requestId: "req-1",
        method: "PATCH",
        route: "/missions/:missionId",
      },
      () => {
        setAuditActor("human", "user-1");
        return createMissionEvent({
          missionId: fixture.mission.id,
          actorType: "human",
          actorId: "user-1",
          action: "updated",
          metadata: { reason: "rename" },
        });
      },
    );

    expect(event.metadata).toMatchObject({
      reason: "rename",
      audit: {
        source: "rest_api",
        requestId: "req-1",
        method: "PATCH",
        route: "/missions/:missionId",
        actorType: "human",
        actorId: "user-1",
      },
    });
  });

  it("returns mission events newest first with independent total count", () => {
    vi.useFakeTimers();
    const fixture = createMissionFixture("Mission List");

    vi.setSystemTime(new Date("2026-05-28T10:00:00.000Z"));
    const oldest = createMissionEvent({
      missionId: fixture.mission.id,
      actorType: "system",
      actorId: "system",
      action: "created",
    });
    vi.setSystemTime(new Date("2026-05-28T10:05:00.000Z"));
    createMissionEvent({
      missionId: fixture.mission.id,
      actorType: "human",
      actorId: "user-1",
      action: "updated",
    });
    vi.setSystemTime(new Date("2026-05-28T10:10:00.000Z"));
    const newest = createMissionEvent({
      missionId: fixture.mission.id,
      actorType: "agent",
      actorId: "agent-1",
      action: "completed",
    });

    const result = getMissionEventsByMissionId(fixture.mission.id, 1, 0);

    expect(result.total).toBe(3);
    expect(result.events.map((event) => event.id)).toEqual([newest.id]);
    expect(
      getMissionEventsByMissionId(fixture.mission.id, 10, 2).events.map((event) => event.id),
    ).toEqual([oldest.id]);
  });

  it("returns only events for missions in the requested habitat", () => {
    vi.useFakeTimers();
    const target = createMissionFixture("Target");
    const other = createMissionFixture("Other");

    vi.setSystemTime(new Date("2026-05-28T10:00:00.000Z"));
    const targetOld = createMissionEvent({
      missionId: target.mission.id,
      actorType: "human",
      actorId: "user-1",
      action: "created",
    });
    vi.setSystemTime(new Date("2026-05-28T10:05:00.000Z"));
    createMissionEvent({
      missionId: other.mission.id,
      actorType: "human",
      actorId: "user-1",
      action: "created",
    });
    vi.setSystemTime(new Date("2026-05-28T10:10:00.000Z"));
    const targetNew = createMissionEvent({
      missionId: target.mission.id,
      actorType: "agent",
      actorId: "agent-1",
      action: "updated",
    });

    const result = getMissionEventsByHabitatId(target.habitat.id, 10, 0);

    expect(result.total).toBe(2);
    expect(result.events.map((event) => event.id)).toEqual([targetNew.id, targetOld.id]);
  });

  it("short-circuits habitat event lookup when the habitat has no missions", () => {
    const habitat = habitatRepo.createHabitat({ name: "Empty Habitat" });

    expect(getMissionEventsByHabitatId(habitat.id)).toEqual({ events: [], total: 0 });
  });
});
