import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import {
  missions,
  pulses,
  releases as releasesTable,
  findingTriage as findingTriageTable,
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

/** Seed a triaged finding pinned to a specific release type / version. */
function seedFinding(opts: {
  subject: string;
  targetReleaseType?: ReleaseType;
  targetRelease?: string;
  status?: "triaged" | "in_progress";
}) {
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
  if (opts.targetReleaseType) {
    findingTriageRepo.setTargetReleaseType(t.id, opts.targetReleaseType);
  }
  if (opts.targetRelease !== undefined) {
    findingTriageRepo.setTargetRelease(t.id, opts.targetRelease);
  }
  if (opts.status === "in_progress") {
    findingTriageRepo.promote(t.id, ACTOR);
  }
  return t;
}

function refresh(findingId: string) {
  return findingTriageRepo.getById(findingId)!;
}

function missionCount(): number {
  return getDb().select().from(missions).all().length;
}

/**
 * AC-DEFER-5 + AC-ACTIVATE-1/2/3 — the cascading-type matcher.
 *
 * Hand-traced cascade (matches the semver engine's `matchesReleaseType`):
 *   target="patch"  → matches shipped patch | minor | major  (largest scope)
 *   target="minor"  → matches shipped minor | major
 *   target="major"  → matches shipped major only
 *
 * Therefore:
 *   shipped "patch" → only patch-tagged findings promote.
 *   shipped "minor" → patch + minor tagged promote; major untouched.
 *   shipped "major" → all three promote.
 */
describe("AC-ACTIVATE-1/2/3: type-cascade matching matrix", () => {
  it("AC-ACTIVATE-1: patch release promotes ONLY patch-tagged findings", async () => {
    // Prior release for self-classification.
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    const patch = seedFinding({ subject: "patch-finding", targetReleaseType: "patch" });
    const minor = seedFinding({ subject: "minor-finding", targetReleaseType: "minor" });
    const major = seedFinding({ subject: "major-finding", targetReleaseType: "major" });

    const before = missionCount();
    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.1", {
      detectedBy: "api",
    });

    expect(result.release.releaseType).toBe("patch");
    expect(result.promotedCount).toBe(1);
    expect(result.createdMissionCount).toBe(1);
    expect(missionCount()).toBe(before + 1);

    expect(refresh(patch.id).status).toBe("in_progress");
    expect(refresh(minor.id).status).toBe("triaged"); // untouched.
    expect(refresh(major.id).status).toBe("triaged"); // untouched.
  });

  it("AC-ACTIVATE-2: minor release promotes patch + minor; major untouched", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    const patch = seedFinding({ subject: "patch-finding", targetReleaseType: "patch" });
    const minor = seedFinding({ subject: "minor-finding", targetReleaseType: "minor" });
    const major = seedFinding({ subject: "major-finding", targetReleaseType: "major" });

    const before = missionCount();
    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.2.0", {
      detectedBy: "api",
    });

    expect(result.release.releaseType).toBe("minor");
    expect(result.promotedCount).toBe(2);
    expect(result.createdMissionCount).toBe(2);
    expect(missionCount()).toBe(before + 2);

    expect(refresh(patch.id).status).toBe("in_progress");
    expect(refresh(minor.id).status).toBe("in_progress");
    expect(refresh(major.id).status).toBe("triaged"); // untouched.
  });

  it("AC-ACTIVATE-3: major release promotes all three type-tagged findings", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    const patch = seedFinding({ subject: "patch-finding", targetReleaseType: "patch" });
    const minor = seedFinding({ subject: "minor-finding", targetReleaseType: "minor" });
    const major = seedFinding({ subject: "major-finding", targetReleaseType: "major" });

    const before = missionCount();
    const result = await releaseTriggerService.detectAndActivate(habitatId, "v1.0.0", {
      detectedBy: "api",
    });

    expect(result.release.releaseType).toBe("major");
    expect(result.promotedCount).toBe(3);
    expect(result.createdMissionCount).toBe(3);
    expect(missionCount()).toBe(before + 3);

    expect(refresh(patch.id).status).toBe("in_progress");
    expect(refresh(minor.id).status).toBe("in_progress");
    expect(refresh(major.id).status).toBe("in_progress");
  });
});

describe("AC-ACTIVATE-4: in_progress findings are skipped (no re-promote, no duplicate mission)", () => {
  it("skips a finding already in_progress without creating a duplicate mission", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    // Seed a patch-tagged finding that is ALREADY in_progress (manually promoted earlier).
    const alreadyPromoted = seedFinding({
      subject: "already-patched",
      targetReleaseType: "patch",
      status: "in_progress",
    });
    const alreadyMissionId = refresh(alreadyPromoted.id).triageMissionId;
    // And a normal triaged one that should still match.
    const fresh = seedFinding({ subject: "fresh-patch", targetReleaseType: "patch" });

    const missionsBefore = missionCount();
    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.1", {
      detectedBy: "api",
    });

    expect(result.release.releaseType).toBe("patch");
    // Only the fresh triaged finding is promoted. The in_progress finding is
    // filtered out of the matched set (only status='triaged' is matched), so
    // it neither promotes nor shows up in skippedCount — that count is for
    // race-condition promote conflicts, not pre-existing non-triaged state.
    expect(result.promotedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.createdMissionCount).toBe(1);
    // Only one new mission was created (for the fresh finding).
    expect(missionCount()).toBe(missionsBefore + 1);

    // The already-promoted finding kept its prior state and mission link — no re-promote.
    const stillPromoted = refresh(alreadyPromoted.id);
    expect(stillPromoted.status).toBe("in_progress");
    expect(stillPromoted.triageMissionId).toBe(alreadyMissionId);
    expect(refresh(fresh.id).status).toBe("in_progress");
  });

  it("skippedCount counts promote-conflict race findings (CONFLICT catch path)", async () => {
    // The skippedCount metric is the catch path for findings that were triaged
    // when matched but transitioned out before promote fired (a true race).
    // Verify the metric exists and surfaces 0 when no race occurs.
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });
    seedFinding({ subject: "lone-finding", targetReleaseType: "patch" });

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.1", {
      detectedBy: "api",
    });

    expect(result.promotedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
  });
});

describe("AC-ACTIVATE-5: version-pin finding activates regardless of release type classification", () => {
  it("version-pin finding promotes when its exact targetRelease ships", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    // Pin to v0.2.0 — no type target. Whatever 0.1.0 → 0.2.0 classifies as
    // (minor), the version arm should still match.
    const pinned = seedFinding({ subject: "pin-v0.2.0", targetRelease: "v0.2.0" });

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.2.0", {
      detectedBy: "api",
    });

    expect(result.release.releaseType).toBe("minor"); // sanity.
    expect(result.promotedCount).toBe(1);
    expect(refresh(pinned.id).status).toBe("in_progress");
  });

  it("version-pin finding does NOT promote on a non-matching version", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    // Pin to v0.9.9 — not the version being shipped.
    const pinned = seedFinding({ subject: "pin-v0.9.9", targetRelease: "v0.9.9" });

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.2.0", {
      detectedBy: "api",
    });

    expect(result.promotedCount).toBe(0);
    expect(refresh(pinned.id).status).toBe("triaged"); // untouched.
  });
});

describe("AC-DEFER-7: dual-target OR — type arm OR version arm matches", () => {
  it("dual-target finding promotes when type arm matches even if version arm does not", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    // Both arms set: type=minor (matches minor release), version=v9.9.9 (won't match).
    const dual = seedFinding({
      subject: "dual-or",
      targetReleaseType: "minor",
      targetRelease: "v9.9.9",
    });

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.2.0", {
      detectedBy: "api",
    });

    expect(result.release.releaseType).toBe("minor");
    expect(result.promotedCount).toBe(1);
    expect(refresh(dual.id).status).toBe("in_progress");
  });
});
