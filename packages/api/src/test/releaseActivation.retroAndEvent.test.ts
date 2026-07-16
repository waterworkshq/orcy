import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import {
  pulses,
  releases as releasesTable,
  findingTriage as findingTriageTable,
  automationRuleRuns,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as releaseTriggerService from "../services/releaseTriggerService.js";

let habitatId: string;
let columnId: string;
let missionId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(releasesTable).run();
  db.delete(findingTriageTable).run();
  db.delete(pulses).run();
  db.delete(automationRuleRuns).run();

  const habitat = habitatRepo.createHabitat({ name: "Retro Habitat" });
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
});

afterEach(() => closeDb());

const ACTOR = { type: "human" as const, id: "user-1" };

/**
 * Migrated seeding: a patch-gated mission linked to a triaged finding. The
 * retrospective + automation-event mechanisms are preserved; only the seeding
 * fixture moves from free-floating finding → gated mission.
 */
function seedGatedPatchMission(subject: string) {
  const gatedMission = missionRepo.createMission({
    habitatId,
    columnId,
    title: `gated-${subject}`,
    createdBy: "triage-agent",
    releaseGateType: "patch",
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

function retrospectivePulses() {
  const db = getDb();
  return db
    .select()
    .from(pulses)
    .where(eq(pulses.habitatId, habitatId))
    .all()
    .filter((p) => {
      const meta = p.metadata as Record<string, unknown> | null;
      return meta?.releaseRetrospective === true;
    });
}

describe("AC-ACTIVATE-6: release retrospective pulse (migrated)", () => {
  it("posts exactly one retrospective per release with correct counts (activatedMissionCount)", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });
    seedGatedPatchMission("f1");
    seedGatedPatchMission("f2");

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.1", {
      detectedBy: "api",
    });

    // Two patch-gated missions → 2 gate activations; legacy loop sees nothing
    // (linked findings already promoted via gate resolution).
    expect(result.promotedCount).toBe(0);
    expect(result.createdMissionCount).toBe(0);

    const retros = retrospectivePulses();
    expect(retros.length).toBe(2);

    const latest = retros.find((p) => {
      const meta = p.metadata as Record<string, unknown>;
      return meta.version === "0.1.1";
    });
    expect(latest).toBeDefined();
    const meta = latest!.metadata as Record<string, unknown>;
    expect(meta.releaseRetrospective).toBe(true);
    expect(meta.version).toBe("0.1.1");
    expect(meta.releaseType).toBe("patch");
    expect(meta.detectedBy).toBe("api");
    expect(meta.promotedCount).toBe(0);
    expect(meta.createdMissionCount).toBe(0);
    expect(meta.activatedMissionCount).toBe(2);
    expect(meta.skippedCount).toBe(0);
    expect(meta.releaseId).toBe(result.release.id);
  });

  it("AC-ACTIVATE-6 (zero-match): retrospective STILL posted with zero counts when no gates match", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });
    // No gated missions seeded at all — the v0.1.1 trigger activates nothing.

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.1", {
      detectedBy: "api",
    });

    expect(result.promotedCount).toBe(0);
    expect(result.createdMissionCount).toBe(0);
    expect(result.skippedCount).toBe(0);

    const retros = retrospectivePulses();
    const latest = retros.find((p) => {
      const meta = p.metadata as Record<string, unknown>;
      return meta.version === "0.1.1";
    });
    expect(latest).toBeDefined();
    const meta = latest!.metadata as Record<string, unknown>;
    expect(meta.promotedCount).toBe(0);
    expect(meta.createdMissionCount).toBe(0);
    expect(meta.activatedMissionCount).toBe(0);
    expect(meta.skippedCount).toBe(0);
  });
});

describe("AC-ACTIVATE-7: release.shipped automation event fires user-authored rules (mechanism)", () => {
  it("a rule bound to release.shipped records a run via executeAndRecordRuleRun", async () => {
    ruleRepo.createAutomationRule({
      habitatId,
      name: "release-shipped-rule",
      priority: 0,
      trigger: { type: "event", eventType: "release.shipped" } as any,
      enabled: true,
      cooldownSeconds: 0,
      maxRunsPerHour: 100,
      actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "T" }],
      createdBy: "system:test",
    });

    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    const db = getDb();
    const runs = db
      .select()
      .from(automationRuleRuns)
      .where(eq(automationRuleRuns.habitatId, habitatId))
      .all();
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const ruleRun = runs.find((r) => r.triggerType === "release.shipped");
    expect(ruleRun).toBeDefined();
  });

  it("AC-ACTIVATE-6 (zero-match): release.shipped event STILL fires on a no-match release", async () => {
    ruleRepo.createAutomationRule({
      habitatId,
      name: "release-shipped-zero-match",
      priority: 0,
      trigger: { type: "event", eventType: "release.shipped" } as any,
      enabled: true,
      cooldownSeconds: 0,
      maxRunsPerHour: 100,
      actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "T" }],
      createdBy: "system:test",
    });

    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    const db = getDb();
    const ruleRun = db
      .select()
      .from(automationRuleRuns)
      .where(eq(automationRuleRuns.habitatId, habitatId))
      .all()
      .find((r) => r.triggerType === "release.shipped");
    expect(ruleRun).toBeDefined();
  });
});
