import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as pulseService from "../services/pulseService.js";

function setupMission() {
  const habitat = habitatRepo.createHabitat({ name: "Finding Habitat" });
  const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0 });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: column.id,
    title: "Finding Mission",
    createdBy: "human-1",
  });
  return { habitat, mission };
}

describe("Pulse structured finding metadata", () => {
  beforeEach(async () => {
    await initTestDb();
  });

  afterEach(() => {
    closeDb();
  });

  it("accepts complete structured metadata", () => {
    const { mission } = setupMission();
    const result = pulseService.postMissionPulseSignal({
      missionId: mission.id,
      caller: { type: "human", id: "human-1" },
      body: {
        signalType: "finding",
        subject: "Pre-existing auth bug",
        metadata: {
          findingKind: "pre_existing_bug",
          severity: "high",
          affectedFiles: ["packages/api/src/auth/token.ts"],
          blocksCurrentWork: false,
        },
      },
    });

    expect(result.pulse.metadata?.findingKind).toBe("pre_existing_bug");
  });

  it("rejects partial structured metadata with missing field names", () => {
    const { mission } = setupMission();

    expect(() =>
      pulseService.postMissionPulseSignal({
        missionId: mission.id,
        caller: { type: "human", id: "human-1" },
        body: {
          signalType: "finding",
          subject: "Partial structured finding",
          metadata: { findingKind: "pre_existing_bug" },
        },
      }),
    ).toThrow(/severity.*affectedFiles.*blocksCurrentWork/);
  });

  it("accepts free-form finding metadata with no structured fields", () => {
    const { mission } = setupMission();
    const result = pulseService.postMissionPulseSignal({
      missionId: mission.id,
      caller: { type: "human", id: "human-1" },
      body: {
        signalType: "finding",
        subject: "Free-form finding",
        metadata: { note: "Token format changed to JWT v3" },
      },
    });

    expect(result.pulse.subject).toBe("Free-form finding");
  });

  it("rejects invalid structured enum values", () => {
    const { mission } = setupMission();

    expect(() =>
      pulseService.postMissionPulseSignal({
        missionId: mission.id,
        caller: { type: "human", id: "human-1" },
        body: {
          signalType: "finding",
          subject: "Invalid structured finding",
          metadata: {
            findingKind: "typo",
            severity: "high",
            affectedFiles: ["packages/api/src/auth/token.ts"],
            blocksCurrentWork: false,
          },
        },
      }),
    ).toThrow(/findingKind must be one of/);
  });

  it("applies the same validation to habitat-scoped pulses", () => {
    const { habitat } = setupMission();

    expect(() =>
      pulseService.postHabitatPulseSignal({
        habitatId: habitat.id,
        caller: { type: "human", id: "human-1" },
        body: {
          signalType: "finding",
          subject: "Habitat finding",
          metadata: { severity: "medium" },
        },
      }),
    ).toThrow(/findingKind/);
  });
});
