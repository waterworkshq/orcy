import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import {
  missions,
  pulses,
  releases as releasesTable,
  findingTriage as findingTriageTable,
  automationRuleRuns,
  habitats,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as releaseTriggerService from "../services/releaseTriggerService.js";

let habitatId: string;
let columnId: string;
let missionId: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(releasesTable).run();
  db.delete(findingTriageTable).run();
  db.delete(pulses).run();
  db.delete(automationRuleRuns).run();

  const habitat = habitatRepo.createHabitat({ name: "Gate Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: "Seed",
    createdBy: "user-1",
  });
  missionId = mission.id;

  savedEnv = process.env.ORCY_RELEASE_AUTO_PROMOTE;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.ORCY_RELEASE_AUTO_PROMOTE;
  else process.env.ORCY_RELEASE_AUTO_PROMOTE = savedEnv;
  closeDb();
});

const ACTOR = { type: "human" as const, id: "user-1" };

function seedTriagedPatchFinding(subject: string) {
  const pulse = pulseRepo.createPulse({
    habitatId,
    missionId,
    scope: "mission",
    fromType: "agent",
    fromId: "agent-1",
    signalType: "finding",
    subject,
    body: "",
    metadata: { findingKind: "bug", severity: "minor", blocksCurrentWork: false },
  });
  const t = findingTriageRepo.createForPulse(pulse);
  findingTriageRepo.transitionStatus(t.id, "triaged", ACTOR);
  findingTriageRepo.setBucket(t.id, "defer_to_patch");
  findingTriageRepo.setTargetReleaseType(t.id, "patch");
  return t;
}

function retrospectivePulsesFor(version: string) {
  const db = getDb();
  return db
    .select()
    .from(pulses)
    .where(eq(pulses.habitatId, habitatId))
    .all()
    .filter((p) => {
      const meta = p.metadata as Record<string, unknown> | null;
      return meta?.releaseRetrospective === true && meta.version === version;
    });
}

describe("AC-ACTIVATE-10 / AC-ACTIVATE-8: env ORCY_RELEASE_AUTO_PROMOTE=false disables the promotion loop", () => {
  it("release row + retrospective + event still occur, but no promotions", async () => {
    process.env.ORCY_RELEASE_AUTO_PROMOTE = "false";

    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });
    const finding = seedTriagedPatchFinding("gated-finding");

    const missionsBefore = getDb().select().from(missions).all().length;
    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.1", {
      detectedBy: "api",
    });

    // Release row exists.
    expect(result.release.version).toBe("0.1.1");
    expect(result.release.releaseType).toBe("patch");

    // Zero promotions even though a matching triaged finding exists.
    expect(result.promotedCount).toBe(0);
    expect(result.createdMissionCount).toBe(0);
    expect(result.skippedCount).toBe(0);

    // The matched finding stayed in `triaged`.
    expect(findingTriageRepo.getById(finding.id)!.status).toBe("triaged");

    // No new missions created.
    expect(getDb().select().from(missions).all().length).toBe(missionsBefore);

    // Retrospective still posted with zero counts.
    const retro = retrospectivePulsesFor("0.1.1");
    expect(retro).toHaveLength(1);
    const meta = retro[0].metadata as Record<string, unknown>;
    expect(meta.promotedCount).toBe(0);

    // release.shipped event still fires (rule run recorded when rules exist; here
    // we assert via the absence of throws + presence of the retrospective which
    // is posted AFTER ingestEvent in detectAndActivate's flow).
  });
});

describe("AC-ACTIVATE-8: habitat-level releaseSettings.autoPromote=false disables the promotion loop", () => {
  it("env default ON but habitat OFF → no promotions, release row + retrospective still exist", async () => {
    // Env default (delete to fall through to the true default).
    delete process.env.ORCY_RELEASE_AUTO_PROMOTE;

    // Seed a habitat-scoped releaseSettings JSON with autoPromote=false.
    const db = getDb();
    db.update(habitats)
      .set({
        releaseSettings: {
          autoPromote: false,
          releaseWorkflowName: "release",
          requireVersionTag: true,
        },
      })
      .where(eq(habitats.id, habitatId))
      .run();

    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });
    const finding = seedTriagedPatchFinding("habitat-gated");

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.1", {
      detectedBy: "api",
    });

    expect(result.release.version).toBe("0.1.1");
    expect(result.promotedCount).toBe(0);
    expect(result.createdMissionCount).toBe(0);
    expect(findingTriageRepo.getById(finding.id)!.status).toBe("triaged");

    const retro = retrospectivePulsesFor("0.1.1");
    expect(retro).toHaveLength(1);
  });

  it("env default ON + habitat default (null) → promotion loop runs normally", async () => {
    delete process.env.ORCY_RELEASE_AUTO_PROMOTE;

    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });
    seedTriagedPatchFinding("ungated-finding");

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.1", {
      detectedBy: "api",
    });

    expect(result.promotedCount).toBe(1);
    expect(result.createdMissionCount).toBe(1);
  });
});

describe("AC-ACTIVATE-8: gate OFF + zero matched findings — event + retrospective still fire", () => {
  it("env OFF + no matching findings → release.shipped event + retrospective with zero counts", async () => {
    process.env.ORCY_RELEASE_AUTO_PROMOTE = "false";

    // No findings seeded — zero-match scenario.
    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    expect(result.release.version).toBe("0.1.0");
    expect(result.promotedCount).toBe(0);
    expect(result.createdMissionCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.erroredCount).toBe(0);

    // Retrospective still posted with zero counts.
    const retro = retrospectivePulsesFor("0.1.0");
    expect(retro).toHaveLength(1);
    const meta = retro[0].metadata as Record<string, unknown>;
    expect(meta.promotedCount).toBe(0);
    expect(meta.createdMissionCount).toBe(0);

    // release.shipped event still fires (verified by the retrospective being
    // posted AFTER ingestEvent in detectAndActivate's flow).
  });
});
