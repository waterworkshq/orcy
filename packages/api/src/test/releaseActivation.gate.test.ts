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
import type { ReleaseType } from "@orcy/shared";

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

/**
 * Migrated seeding: a patch-gated mission linked to a triaged finding. The
 * kill-switch tests are MECHANISM tests (preserved per the migration rule);
 * only the seeding fixture moves from free-floating finding → gated mission.
 */
function seedGatedPatchMission(subject: string) {
  const gatedMission = missionRepo.createMission({
    habitatId,
    columnId,
    title: `gated-${subject}`,
    createdBy: "triage-agent",
    releaseGateType: "patch" as ReleaseType,
  });
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
  findingTriageRepo.setTriageMissionId(t.id, gatedMission.id);
  return { mission: gatedMission, finding: t };
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

describe("AC-ACTIVATE-10 / AC-ACTIVATE-8: env ORCY_RELEASE_AUTO_PROMOTE=false disables the activation loop", () => {
  it("release row + retrospective + event still occur, but no gate activations or promotions", async () => {
    process.env.ORCY_RELEASE_AUTO_PROMOTE = "false";

    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });
    const { finding } = seedGatedPatchMission("gated-finding");

    const missionsBefore = getDb().select().from(missions).all().length;
    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.1", {
      detectedBy: "api",
    });

    // Release row exists.
    expect(result.release.version).toBe("0.1.1");
    expect(result.release.releaseType).toBe("patch");

    // Zero promotions / gate activations — the loop is fully disabled.
    expect(result.promotedCount).toBe(0);
    expect(result.createdMissionCount).toBe(0);
    expect(result.skippedCount).toBe(0);

    // The linked finding stayed `triaged`.
    expect(findingTriageRepo.getById(finding.id)!.status).toBe("triaged");

    // No new missions created.
    expect(getDb().select().from(missions).all().length).toBe(missionsBefore);

    // Retrospective still posted with zero counts.
    const retro = retrospectivePulsesFor("0.1.1");
    expect(retro).toHaveLength(1);
    const meta = retro[0].metadata as Record<string, unknown>;
    expect(meta.promotedCount).toBe(0);
    expect(meta.activatedMissionCount).toBe(0);

    // release.shipped event still fires (verified by the retrospective being
    // posted AFTER ingestEvent in detectAndActivate's flow).
  });
});

describe("AC-ACTIVATE-8: habitat-level releaseSettings.autoPromote=false disables the activation loop", () => {
  it("env default ON but habitat OFF → no gate activations, release row + retrospective still exist", async () => {
    delete process.env.ORCY_RELEASE_AUTO_PROMOTE;

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
    const { finding } = seedGatedPatchMission("habitat-gated");

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

  it("env default ON + habitat default (null) → activation loop runs normally", async () => {
    delete process.env.ORCY_RELEASE_AUTO_PROMOTE;

    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });
    seedGatedPatchMission("ungated-finding");

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.1", {
      detectedBy: "api",
    });

    // The gate activates (the linked finding promotes via gate resolution).
    expect(result.promotedCount).toBe(0);
    expect(result.createdMissionCount).toBe(0);
    const retro = retrospectivePulsesFor("0.1.1");
    expect(retro).toHaveLength(1);
    const meta = retro[0].metadata as Record<string, unknown>;
    expect(meta.activatedMissionCount).toBe(1);
  });
});

describe("AC-ACTIVATE-8: gate OFF + zero matched gates — event + retrospective still fire", () => {
  it("env OFF + no matching gated missions → release.shipped event + retrospective with zero counts", async () => {
    process.env.ORCY_RELEASE_AUTO_PROMOTE = "false";

    // No gated missions seeded — zero-match scenario.
    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    expect(result.release.version).toBe("0.1.0");
    expect(result.promotedCount).toBe(0);
    expect(result.createdMissionCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.erroredCount).toBe(0);

    const retro = retrospectivePulsesFor("0.1.0");
    expect(retro).toHaveLength(1);
    const meta = retro[0].metadata as Record<string, unknown>;
    expect(meta.promotedCount).toBe(0);
    expect(meta.createdMissionCount).toBe(0);
    expect(meta.activatedMissionCount).toBe(0);
  });
});
