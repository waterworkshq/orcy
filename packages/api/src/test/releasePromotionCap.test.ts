import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  missions,
  pulses,
  releases as releasesTable,
  findingTriage as findingTriageTable,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as releaseTriggerService from "../services/releaseTriggerService.js";

const ACTOR = { type: "human" as const, id: "user-1" };
let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(releasesTable).run();
  db.delete(findingTriageTable).run();
  db.delete(pulses).run();
  db.delete(missions).run();
  const habitat = habitatRepo.createHabitat({ name: "Cap Habitat" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  }).id;
});

afterEach(() => closeDb());

function seedGatedMissionWithFinding(title: string) {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title,
    createdBy: "triage-agent",
    releaseGateType: "minor",
  });
  const pulse = pulseRepo.createPulse({
    habitatId,
    missionId: mission.id,
    scope: "mission",
    fromType: "agent",
    fromId: "agent-1",
    signalType: "finding",
    subject: title,
    body: "",
    metadata: { findingKind: "bug", severity: "minor", blocksCurrentWork: false },
  });
  const t = findingTriageRepo.createForPulse(pulse);
  findingTriageRepo.transitionStatus(t.id, "triaged", ACTOR);
  findingTriageRepo.setTriageMissionId(t.id, mission.id);
  return { mission, finding: t };
}

describe("REL-9: per-release promotion cap", () => {
  it("promotes up to the cap and records the rest as cappedCount", async () => {
    // Set a cap of 2.
    habitatRepo.updateHabitat(habitatId, {
      releaseSettings: {
        autoPromote: true,
        releaseWorkflowName: "release",
        requireVersionTag: true,
        maxPromotionsPerRelease: 2,
      },
    });

    // Seed 3 gated missions with linked findings.
    const a = seedGatedMissionWithFinding("A");
    seedGatedMissionWithFinding("B");
    seedGatedMissionWithFinding("C");

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    expect(result.cappedCount).toBe(1);
    // Two promoted, one capped (stays triaged).
    const refreshed = [
      a.finding.id,
      ...findingTriageRepo.findByTriageMissionId(a.mission.id).map((f) => f.id),
    ];
    void refreshed;
    const allFindings = getDb().select().from(findingTriageTable).all();
    const inProgress = allFindings.filter((f) => f.status === "in_progress");
    const stillTriaged = allFindings.filter((f) => f.status === "triaged");
    expect(inProgress.length).toBe(2);
    expect(stillTriaged.length).toBe(1);
  });

  it("null cap = unlimited (all promote)", async () => {
    habitatRepo.updateHabitat(habitatId, {
      releaseSettings: {
        autoPromote: true,
        releaseWorkflowName: "release",
        requireVersionTag: true,
        maxPromotionsPerRelease: null,
      },
    });
    for (const t of ["A", "B", "C", "D", "E"]) seedGatedMissionWithFinding(t);

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    expect(result.cappedCount).toBe(0);
    const allFindings = getDb().select().from(findingTriageTable).all();
    expect(allFindings.filter((f) => f.status === "in_progress").length).toBe(5);
  });
});
