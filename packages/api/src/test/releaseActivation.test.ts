import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import {
  missions,
  pulses,
  releases as releasesTable,
  findingTriage as findingTriageTable,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as releaseTriggerService from "../services/releaseTriggerService.js";
import type { ReleaseType } from "@orcy/shared";

let habitatId: string;
let columnId: string;
let missionId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(releasesTable).run();
  db.delete(findingTriageTable).run();
  db.delete(pulses).run();

  const habitat = habitatRepo.createHabitat({ name: "Activation Matrix Habitat" });
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
    title: "Seed Mission",
    createdBy: "user-1",
  });
  missionId = mission.id;
});

afterEach(() => closeDb());

const ACTOR = { type: "human" as const, id: "user-1" };

/**
 * v0.25.0 migrated seeding: a gated mission linked to a triaged finding. The
 * release trigger resolves the gate and promotes the linked finding via the
 * gate-resolution path (not the legacy findReleaseMatched path). The linked
 * finding's `triaged → in_progress` flip is the activation signal.
 */
function seedGatedMissionWithFinding(opts: {
  subject: string;
  releaseGateType?: ReleaseType;
  releaseGateVersion?: string;
  status?: "triaged" | "in_progress";
}) {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: `gated-${opts.subject}`,
    createdBy: "triage-agent",
    releaseGateType: opts.releaseGateType,
    releaseGateVersion: opts.releaseGateVersion,
  });

  const pulse = pulseRepo.createPulse({
    habitatId,
    missionId,
    scope: "mission",
    fromType: "agent",
    fromId: "agent-1",
    signalType: "finding",
    subject: opts.subject,
    body: "",
    metadata: { findingKind: "bug", severity: "minor", blocksCurrentWork: false },
  });
  const t = findingTriageRepo.createForPulse(pulse);
  findingTriageRepo.transitionStatus(t.id, "triaged", ACTOR);
  findingTriageRepo.setBucket(t.id, "defer_to_release");
  findingTriageRepo.setTriageMissionId(t.id, mission.id);
  if (opts.status === "in_progress") {
    findingTriageRepo.promote(t.id, ACTOR);
  }
  return { mission, finding: t };
}

function refresh(findingId: string) {
  return findingTriageRepo.getById(findingId)!;
}

function missionCount(): number {
  return getDb().select().from(missions).all().length;
}

function retroMeta(version: string): Record<string, unknown> | undefined {
  const retro = getDb()
    .select()
    .from(pulses)
    .where(eq(pulses.habitatId, habitatId))
    .all()
    .find((p) => {
      const meta = p.metadata as Record<string, unknown> | null;
      return meta?.releaseRetrospective === true && meta.version === version;
    });
  return retro?.metadata as Record<string, unknown> | undefined;
}

/**
 * AC-ACTIVATE-1/2/3 — the gate-perspective cascade. A gate is satisfied by
 * releases of equal-or-larger scope (patch gate → any release; minor gate →
 * minor|major; major gate → major only).
 *
 * Hand-traced cascade (matches the semver engine's gate-perspective matcher):
 *   gate=patch  → satisfied by shipped patch | minor | major
 *   gate=minor  → satisfied by shipped minor | major
 *   gate=major  → satisfied by shipped major only
 *
 * Therefore:
 *   shipped "patch" → only patch-gated missions resolve.
 *   shipped "minor" → patch + minor gated resolve; major-gated untouched.
 *   shipped "major" → all three resolve.
 */
describe("AC-ACTIVATE-1/2/3 (migrated): type-cascade matching matrix (gate perspective)", () => {
  it("AC-ACTIVATE-1: patch release resolves ONLY patch-gated missions", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    const patchLinked = seedGatedMissionWithFinding({
      subject: "patch-gated",
      releaseGateType: "patch",
    });
    const minorLinked = seedGatedMissionWithFinding({
      subject: "minor-gated",
      releaseGateType: "minor",
    });
    const majorLinked = seedGatedMissionWithFinding({
      subject: "major-gated",
      releaseGateType: "major",
    });

    const before = missionCount();
    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.1", {
      detectedBy: "api",
    });

    expect(result.release.releaseType).toBe("patch");
    // No NEW missions created — gates resolve linked findings, not create.
    expect(result.createdMissionCount).toBe(0);
    expect(missionCount()).toBe(before);

    // Only the patch-gated mission's finding promotes.
    expect(refresh(patchLinked.finding.id).status).toBe("in_progress");
    expect(refresh(minorLinked.finding.id).status).toBe("triaged");
    expect(refresh(majorLinked.finding.id).status).toBe("triaged");

    // Retrospective records exactly one gate resolution.
    const meta = retroMeta("0.1.1");
    expect(meta?.activatedMissionCount).toBe(1);
  });

  it("AC-ACTIVATE-2: minor release resolves patch + minor gated; major untouched", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    const patchLinked = seedGatedMissionWithFinding({
      subject: "patch-gated",
      releaseGateType: "patch",
    });
    const minorLinked = seedGatedMissionWithFinding({
      subject: "minor-gated",
      releaseGateType: "minor",
    });
    const majorLinked = seedGatedMissionWithFinding({
      subject: "major-gated",
      releaseGateType: "major",
    });

    const before = missionCount();
    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.2.0", {
      detectedBy: "api",
    });

    expect(result.release.releaseType).toBe("minor");
    expect(result.createdMissionCount).toBe(0);
    expect(missionCount()).toBe(before);

    expect(refresh(patchLinked.finding.id).status).toBe("in_progress");
    expect(refresh(minorLinked.finding.id).status).toBe("in_progress");
    expect(refresh(majorLinked.finding.id).status).toBe("triaged");

    const meta = retroMeta("0.2.0");
    expect(meta?.activatedMissionCount).toBe(2);
  });

  it("AC-ACTIVATE-3: major release resolves all three gate types", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    const patchLinked = seedGatedMissionWithFinding({
      subject: "patch-gated",
      releaseGateType: "patch",
    });
    const minorLinked = seedGatedMissionWithFinding({
      subject: "minor-gated",
      releaseGateType: "minor",
    });
    const majorLinked = seedGatedMissionWithFinding({
      subject: "major-gated",
      releaseGateType: "major",
    });

    const before = missionCount();
    const result = await releaseTriggerService.detectAndActivate(habitatId, "v1.0.0", {
      detectedBy: "api",
    });

    expect(result.release.releaseType).toBe("major");
    expect(result.createdMissionCount).toBe(0);
    expect(missionCount()).toBe(before);

    expect(refresh(patchLinked.finding.id).status).toBe("in_progress");
    expect(refresh(minorLinked.finding.id).status).toBe("in_progress");
    expect(refresh(majorLinked.finding.id).status).toBe("in_progress");

    const meta = retroMeta("1.0.0");
    expect(meta?.activatedMissionCount).toBe(3);
  });
});

/**
 * AC-ACTIVATE-4 — findings already in_progress are skipped (no re-promote, no
 * duplicate mission). MECHANISM TEST (preserved as-is per the migration rule).
 *
 * The skip mechanism now fires inside the gate-resolution loop: the
 * gate-resolution loop only promotes findings still in `triaged` status. An
 * already-promoted finding is filtered out, so no re-promotion or counting.
 */
describe("AC-ACTIVATE-4 (migrated): in_progress findings are skipped", () => {
  it("skips a finding already in_progress (manually promoted earlier) without counting it", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    // Seed a patch-gated mission whose linked finding is ALREADY in_progress.
    const alreadyPromoted = seedGatedMissionWithFinding({
      subject: "already-promoted",
      releaseGateType: "patch",
      status: "in_progress",
    });
    // And a normal triaged one that should still resolve.
    const fresh = seedGatedMissionWithFinding({
      subject: "fresh-patch",
      releaseGateType: "patch",
    });

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.1", {
      detectedBy: "api",
    });

    expect(result.release.releaseType).toBe("patch");
    expect(result.promotedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.createdMissionCount).toBe(0);

    // The already-promoted finding kept its prior state.
    const stillPromoted = refresh(alreadyPromoted.finding.id);
    expect(stillPromoted.status).toBe("in_progress");
    expect(stillPromoted.triageMissionId).toBe(alreadyPromoted.mission.id);

    // The fresh triaged finding promoted via the gate-resolution path.
    expect(refresh(fresh.finding.id).status).toBe("in_progress");

    // Only 1 gate activated (the fresh one) — the already-promoted is skipped.
    const meta = retroMeta("0.1.1");
    expect(meta?.activatedMissionCount).toBe(1);
  });

  it("skippedCount counts promote-conflict race findings (CONFLICT catch path)", async () => {
    // Mechanism preserved: skippedCount is the race-condition catch path.
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });
    seedGatedMissionWithFinding({
      subject: "lone-finding",
      releaseGateType: "patch",
    });

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.1", {
      detectedBy: "api",
    });

    expect(result.skippedCount).toBe(0);
  });
});

/**
 * AC-ACTIVATE-5 — version-pin gate activates regardless of release-type
 * classification.
 */
describe("AC-ACTIVATE-5 (migrated): version-pin gate", () => {
  it("version-pinned gate resolves when its exact targetRelease ships", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    const pinned = seedGatedMissionWithFinding({
      subject: "pin-v0.2.0",
      releaseGateVersion: "v0.2.0",
    });

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.2.0", {
      detectedBy: "api",
    });

    expect(result.release.releaseType).toBe("minor"); // sanity.
    expect(refresh(pinned.finding.id).status).toBe("in_progress");
  });

  it("version-pinned gate does NOT resolve on a non-matching version", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    const pinned = seedGatedMissionWithFinding({
      subject: "pin-v0.9.9",
      releaseGateVersion: "v0.9.9",
    });

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.2.0", {
      detectedBy: "api",
    });

    expect(result.promotedCount).toBe(0);
    expect(refresh(pinned.finding.id).status).toBe("triaged"); // untouched.
  });
});

/**
 * AC-DEFER-7 — dual-target OR — type arm OR version arm matches.
 */
describe("AC-DEFER-7 (migrated): dual-target OR", () => {
  it("dual-target gate resolves when the type arm matches even if the version arm does not", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    // Both arms set: type=minor (matches minor release), version=v9.9.9 (won't match).
    const dual = seedGatedMissionWithFinding({
      subject: "dual-or",
      releaseGateType: "minor",
      releaseGateVersion: "v9.9.9",
    });

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.2.0", {
      detectedBy: "api",
    });

    expect(result.release.releaseType).toBe("minor");
    expect(refresh(dual.finding.id).status).toBe("in_progress");
  });
});
