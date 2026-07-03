import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  pulses,
  releases as releasesTable,
  findingTriage as findingTriageTable,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as missionService from "../services/featureService.js";
import * as taskRepo from "../repositories/task.js";
import * as releaseRepo from "../repositories/release.js";
import { getAvailableTasksForAgent } from "../repositories/taskQueries.js";
import { createMissionSchema, updateMissionSchema } from "../models/schemas.js";

let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(releasesTable).run();
  db.delete(findingTriageTable).run();
  db.delete(pulses).run();

  const habitat = habitatRepo.createHabitat({ name: "Authoring Habitat" });
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

function availableTaskIds() {
  return getAvailableTasksForAgent(habitatId, "backend", { status: "pending" }).map((t) => t.id);
}

/**
 * AC-AUTHOR-1 — the mission create/edit form includes an optional release-gate
 * selector (type + version). The schema is the contract the form binds to.
 */
describe("AC-AUTHOR-1: create/edit schema accepts optional release-gate fields", () => {
  it("createMissionSchema accepts releaseGateType + releaseGateVersion", () => {
    const result = createMissionSchema.safeParse({
      title: "Gated",
      releaseGateType: "minor",
      releaseGateVersion: "v0.25",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.releaseGateType).toBe("minor");
      expect(result.data.releaseGateVersion).toBe("v0.25");
    }
  });

  it("createMissionSchema accepts a mission without gate fields (optional)", () => {
    const result = createMissionSchema.safeParse({ title: "Ungated" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.releaseGateType).toBeUndefined();
      expect(result.data.releaseGateVersion).toBeUndefined();
    }
  });

  it("createMissionSchema rejects an invalid releaseGateType", () => {
    const result = createMissionSchema.safeParse({
      title: "Bad",
      releaseGateType: "mega",
    });
    expect(result.success).toBe(false);
  });

  it("updateMissionSchema accepts nullable releaseGateType (clear-the-gate path)", () => {
    const result = updateMissionSchema.safeParse({ releaseGateType: null });
    expect(result.success).toBe(true);
  });

  it("updateMissionSchema accepts nullable releaseGateVersion", () => {
    const result = updateMissionSchema.safeParse({ releaseGateVersion: null });
    expect(result.success).toBe(true);
  });
});

/**
 * AC-AUTHOR-2 — a human-created mission with a release-gate is blocked from
 * claiming until the matching release ships.
 */
describe("AC-AUTHOR-2: gated mission is blocked until matching release ships", () => {
  it("POST create with releaseGateType='minor' → mission persisted with gate; tasks excluded", () => {
    const mission = missionService.createMission({
      habitatId,
      columnId,
      title: "Human-authored gated mission",
      createdBy: "user-1",
      releaseGateType: "minor",
    });

    expect(mission.releaseGateType).toBe("minor");
    expect(mission.releaseGateVersion).toBeNull();

    const task = taskRepo.createTask({
      missionId: mission.id,
      title: "gated-task",
      createdBy: "user-1",
    });

    // No matching release → blocked.
    expect(availableTaskIds()).not.toContain(task.id);

    // Ship a matching release → claimable.
    releaseRepo.create({
      habitatId,
      version: "0.2.0",
      releaseType: "minor",
      detectedBy: "api",
    });
    expect(availableTaskIds()).toContain(task.id);
  });

  it("a mission with no gate is immediately claimable (backwards-compat)", () => {
    const mission = missionService.createMission({
      habitatId,
      columnId,
      title: "Ungated",
      createdBy: "user-1",
    });
    const task = taskRepo.createTask({
      missionId: mission.id,
      title: "free-task",
      createdBy: "user-1",
    });

    expect(availableTaskIds()).toContain(task.id);
  });
});

/**
 * AC-AUTHOR-3 — a human can set and clear the release-gate on an existing
 * mission (PATCH).
 */
describe("AC-AUTHOR-3: PATCH mission gate on/off", () => {
  it("PATCH gate off (null) → mission's tasks become claimable", () => {
    const mission = missionService.createMission({
      habitatId,
      columnId,
      title: "Will-be-cleared",
      createdBy: "user-1",
      releaseGateType: "minor",
    });
    const task = taskRepo.createTask({
      missionId: mission.id,
      title: "task",
      createdBy: "user-1",
    });
    expect(availableTaskIds()).not.toContain(task.id);

    const result = missionService.updateMission(
      mission.id,
      { releaseGateType: null, releaseGateVersion: null },
      "user-1",
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mission.releaseGateType).toBeNull();
      expect(result.mission.releaseGateVersion).toBeNull();
    }
    expect(availableTaskIds()).toContain(task.id);
  });

  it("PATCH gate from 'minor' to 'patch' + seed any release → mission claimable", () => {
    // Initially gated on minor; no release shipped → blocked.
    const mission = missionService.createMission({
      habitatId,
      columnId,
      title: "Will-be-retyped",
      createdBy: "user-1",
      releaseGateType: "minor",
    });
    const task = taskRepo.createTask({
      missionId: mission.id,
      title: "task",
      createdBy: "user-1",
    });
    expect(availableTaskIds()).not.toContain(task.id);

    // Ship a patch release — does NOT satisfy a minor gate.
    releaseRepo.create({
      habitatId,
      version: "0.1.1",
      releaseType: "patch",
      detectedBy: "api",
    });
    expect(availableTaskIds()).not.toContain(task.id);

    // PATCH the gate down to patch — the existing patch release now satisfies it.
    const result = missionService.updateMission(mission.id, { releaseGateType: "patch" }, "user-1");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mission.releaseGateType).toBe("patch");
    }
    expect(availableTaskIds()).toContain(task.id);
  });

  it("PATCH setting a gate on a previously-ungated mission blocks its tasks", () => {
    const mission = missionService.createMission({
      habitatId,
      columnId,
      title: "Will-be-gated",
      createdBy: "user-1",
    });
    const task = taskRepo.createTask({
      missionId: mission.id,
      title: "task",
      createdBy: "user-1",
    });
    expect(availableTaskIds()).toContain(task.id);

    const result = missionService.updateMission(mission.id, { releaseGateType: "major" }, "user-1");
    expect(result.success).toBe(true);
    // No major release shipped → blocked.
    expect(availableTaskIds()).not.toContain(task.id);

    // Ship a major release → claimable.
    releaseRepo.create({
      habitatId,
      version: "1.0.0",
      releaseType: "major",
      detectedBy: "api",
    });
    expect(availableTaskIds()).toContain(task.id);
  });
});
