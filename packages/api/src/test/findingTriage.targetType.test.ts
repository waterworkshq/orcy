import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import { pulses, findingTriage as findingTriageTable } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";

let habitatId: string;
let missionId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(findingTriageTable).run();
  db.delete(pulses).run();

  const habitat = habitatRepo.createHabitat({ name: "Target Type Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: "Seed",
    createdBy: "user-1",
  });
  missionId = mission.id;
});

afterEach(() => closeDb());

function seedFinding() {
  const pulse = pulseRepo.createPulse({
    habitatId,
    missionId,
    scope: "mission",
    fromType: "agent",
    fromId: "agent-1",
    signalType: "finding",
    subject: "target-type-finding",
    body: "",
    metadata: { findingKind: "bug", severity: "minor", blocksCurrentWork: false },
  });
  return findingTriageRepo.createForPulse(pulse);
}

describe("AC-DEFER-1: targetReleaseType column nullable with NULL default", () => {
  it("a newly created finding_triage record has targetReleaseType = NULL", () => {
    const t = seedFinding();
    const record = findingTriageRepo.getById(t.id)!;

    expect(record.targetReleaseType).toBeNull();
  });

  it("the column exists in the schema (migration 0047 applied)", () => {
    const db = getDb();
    const cols = db
      .all("PRAGMA table_info(finding_triage)")
      .map((r) => (r as Record<string, unknown>).name);
    expect(cols).toContain("target_release_type");
  });

  // The "NULL targetReleaseType matches nothing via findReleaseMatched" case was
  // removed in v0.25.1 (RM-12): the free-floating activation path was deleted,
  // so release-target matching no longer runs at the finding level. The column
  // stays as informational/denormalized per ADR-0032; gate-resolution is the
  // sole activation path (covered by releaseGate.activation.test.ts).
});

describe("AC-DEFER-2: setTargetReleaseType persists type + clearable to NULL", () => {
  it("persists 'minor' when setTargetReleaseType(id, 'minor') is called", () => {
    const t = seedFinding();
    findingTriageRepo.setTargetReleaseType(t.id, "minor");

    const record = findingTriageRepo.getById(t.id)!;
    expect(record.targetReleaseType).toBe("minor");
  });

  it("persists each ReleaseType value (patch / minor / major)", () => {
    for (const type of ["patch", "minor", "major"] as const) {
      const t = seedFinding();
      findingTriageRepo.setTargetReleaseType(t.id, type);
      expect(findingTriageRepo.getById(t.id)!.targetReleaseType).toBe(type);
    }
  });

  it("clears to NULL when setTargetReleaseType(id, null) is called", () => {
    const t = seedFinding();
    findingTriageRepo.setTargetReleaseType(t.id, "minor");
    expect(findingTriageRepo.getById(t.id)!.targetReleaseType).toBe("minor");

    findingTriageRepo.setTargetReleaseType(t.id, null);
    expect(findingTriageRepo.getById(t.id)!.targetReleaseType).toBeNull();
  });

  it("PATCH /triage/findings/:id with targetReleaseType persists via the route body schema", async () => {
    // The route's body schema accepts targetReleaseType (z.enum patch|minor|major
    // | null | optional) and dispatches to setTargetReleaseType. Verify the
    // repository path the route uses persists correctly — route-level auth is
    // covered in triageRoutesAuth.test.ts and releaseTrigger.auth.test.ts.
    const t = seedFinding();
    findingTriageRepo.setTargetReleaseType(t.id, "major");
    const record = findingTriageRepo.getById(t.id)!;
    expect(record.targetReleaseType).toBe("major");
  });
});

describe("RM-10: setTriageMissionId unlink (accepts null)", () => {
  it("links a finding to a mission then clears the link with null", () => {
    const t = seedFinding();

    findingTriageRepo.setTriageMissionId(t.id, missionId);
    expect(findingTriageRepo.getById(t.id)!.triageMissionId).toBe(missionId);

    findingTriageRepo.setTriageMissionId(t.id, null);
    expect(findingTriageRepo.getById(t.id)!.triageMissionId).toBeNull();
  });
});
