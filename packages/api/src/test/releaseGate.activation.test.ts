import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import {
  missions,
  pulses,
  releases as releasesTable,
  findingTriage as findingTriageTable,
  notificationEvents,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as pulseRepo from "../repositories/pulse.js";
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
  db.delete(notificationEvents).run();

  const habitat = habitatRepo.createHabitat({ name: "Gate Activation Habitat" });
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
 * Seeds a gated mission linked to a triaged finding. The finding is the source
 * signal (e.g. a deferred bug) that the gated mission was created to address;
 * `triageMissionId` is the back-link the gate-resolution loop consults.
 */
function seedGatedMissionWithFinding(opts: {
  title: string;
  releaseGateType?: "patch" | "minor" | "major";
  releaseGateVersion?: string;
  findingSubject?: string;
}) {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: opts.title,
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
    subject: opts.findingSubject ?? `finding-for-${mission.id}`,
    body: "",
    metadata: { findingKind: "bug", severity: "minor", blocksCurrentWork: false },
  });
  const t = findingTriageRepo.createForPulse(pulse);
  findingTriageRepo.transitionStatus(t.id, "triaged", ACTOR);
  findingTriageRepo.setBucket(t.id, "defer_to_release");
  findingTriageRepo.setTriageMissionId(t.id, mission.id);

  return { mission, finding: t };
}

function refreshFinding(id: string) {
  return findingTriageRepo.getById(id)!;
}

function missionCount(): number {
  return getDb().select().from(missions).all().length;
}

function retrospectivePulsesFor(version: string) {
  return getDb()
    .select()
    .from(pulses)
    .where(eq(pulses.habitatId, habitatId))
    .all()
    .filter((p) => {
      const meta = p.metadata as Record<string, unknown> | null;
      return meta?.releaseRetrospective === true && meta.version === version;
    });
}

/**
 * AC-GATE-6 — `detectAndActivate` on release ship resolves (marks satisfied)
 * release-gates on missions whose gate matches the shipped release.
 *
 * In v0.25.0 the gate-resolution loop runs BEFORE the legacy findReleaseMatched
 * loop. A finding linked to a matching gated mission is promoted via the gate
 * path; the legacy loop's status guard naturally skips it (CONFLICT catch).
 */
describe("AC-GATE-6: detectAndActivate resolves matched gated missions", () => {
  it("resolves a minor-gated mission on a minor release and promotes the linked finding", async () => {
    // Seed the prior release so v0.2.0 self-classifies without an explicit type.
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    const { mission, finding } = seedGatedMissionWithFinding({
      title: "minor-gated-corrective",
      releaseGateType: "minor",
    });

    const missionsBefore = missionCount();
    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.2.0", {
      detectedBy: "api",
    });

    expect(result.release.releaseType).toBe("minor");
    // The finding was promoted via gate-resolution (not the legacy loop).
    expect(refreshFinding(finding.id).status).toBe("in_progress");
    expect(refreshFinding(finding.id).triageMissionId).toBe(mission.id);
    // No NEW mission was created — the gate path does not call createMission.
    expect(missionCount()).toBe(missionsBefore);
  });

  it("resolves matching type cascade: major release resolves minor- and major-gated missions", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    const minorLinked = seedGatedMissionWithFinding({
      title: "minor-gated",
      releaseGateType: "minor",
    });
    const majorLinked = seedGatedMissionWithFinding({
      title: "major-gated",
      releaseGateType: "major",
    });
    // A patch-gated mission also resolves (patch gate matches any release).
    const patchLinked = seedGatedMissionWithFinding({
      title: "patch-gated",
      releaseGateType: "patch",
    });

    await releaseTriggerService.detectAndActivate(habitatId, "v1.0.0", {
      detectedBy: "api",
    });

    expect(refreshFinding(minorLinked.finding.id).status).toBe("in_progress");
    expect(refreshFinding(majorLinked.finding.id).status).toBe("in_progress");
    expect(refreshFinding(patchLinked.finding.id).status).toBe("in_progress");
  });

  it("does NOT resolve a major-gated mission on a minor release", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    const majorLinked = seedGatedMissionWithFinding({
      title: "major-gated-only",
      releaseGateType: "major",
    });

    await releaseTriggerService.detectAndActivate(habitatId, "v0.2.0", {
      detectedBy: "api",
    });

    // The major-gated mission stays blocked; its linked finding stays triaged.
    expect(refreshFinding(majorLinked.finding.id).status).toBe("triaged");
  });
});

/**
 * AC-SUPERSEDE-1 — the gate-resolution path runs FIRST and does NOT create
 * new missions for findings that have linked gated missions.
 */
describe("AC-SUPERSEDE-1: gate path does not call findReleaseMatched+createMission for linked findings", () => {
  it("promotedCount stays 0 (legacy loop skipped via CONFLICT); activatedMissionCount in retrospective > 0", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    seedGatedMissionWithFinding({
      title: "supersede-target",
      releaseGateType: "minor",
    });

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.2.0", {
      detectedBy: "api",
    });

    // The legacy loop's status guard filters out the gate-promoted finding,
    // so promotedCount is 0 and no new missions are created.
    expect(result.promotedCount).toBe(0);
    expect(result.createdMissionCount).toBe(0);

    // But the retrospective records the activated mission via activatedMissionCount.
    const retro = retrospectivePulsesFor("0.2.0");
    expect(retro).toHaveLength(1);
    const meta = retro[0].metadata as Record<string, unknown>;
    expect(meta.activatedMissionCount).toBe(1);
  });
});

/**
 * AC-SUPERSEDE-2 — a finding linked to a gated mission promotes
 * (`triaged → in_progress`) when the mission's gate resolves.
 */
describe("AC-SUPERSEDE-2: linked finding promotes on gate resolution", () => {
  it("triaged → in_progress when the matching release ships", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    const { finding } = seedGatedMissionWithFinding({
      title: "promote-on-resolve",
      releaseGateType: "minor",
    });

    expect(refreshFinding(finding.id).status).toBe("triaged");

    await releaseTriggerService.detectAndActivate(habitatId, "v0.2.0", {
      detectedBy: "api",
    });

    expect(refreshFinding(finding.id).status).toBe("in_progress");
  });
});

/**
 * RM-8 — `findByTriageMissionId` N:1 safety. The schema permits multiple
 * findings sharing one `triageMissionId` (no UNIQUE constraint), so every
 * linked `triaged` finding must promote on gate resolution — not just the
 * first `.get()` row.
 */
describe("RM-8: N:1 finding-mission linkage promotes all linked findings", () => {
  it("two findings linked to one gated mission both promote on gate resolution", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    const mission = missionRepo.createMission({
      habitatId,
      columnId,
      title: "N:1 gated mission",
      createdBy: "triage-agent",
      releaseGateType: "minor",
    });

    const linked: string[] = [];
    for (const subject of ["n1-finding-a", "n1-finding-b"]) {
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
      findingTriageRepo.setBucket(t.id, "defer_to_release");
      findingTriageRepo.setTriageMissionId(t.id, mission.id);
      linked.push(t.id);
    }

    // Repo contract: returns BOTH linked findings (N:1), not just the first.
    expect(findingTriageRepo.findByTriageMissionId(mission.id)).toHaveLength(2);

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.2.0", {
      detectedBy: "api",
    });

    // activatedMissionCount is local to detectAndActivate (not on the result
    // type); the N:1 proof is that BOTH linked findings promoted to in_progress.
    expect(result.promotedCount).toBe(0);
    expect(refreshFinding(linked[0]).status).toBe("in_progress");
    expect(refreshFinding(linked[1]).status).toBe("in_progress");
  });
});

/**
 * AC-SUPERSEDE-3 — `finding_triage.targetReleaseType` column is retained
 * (no destructive migration); existing rows are not orphaned.
 */
describe("AC-SUPERSEDE-3: finding_triage.targetReleaseType column retained", () => {
  it("the column still exists in the schema (migration 0050 did not drop it)", () => {
    const db = getDb();
    const cols = db
      .all("PRAGMA table_info(finding_triage)")
      .map((r) => (r as Record<string, unknown>).name);
    expect(cols).toContain("target_release_type");
  });

  it("a v0.24.0-style finding with only targetReleaseType (no gated mission) does NOT auto-promote (RM-12: legacy path removed)", async () => {
    // RM-12 removed the legacy free-floating findReleaseMatched activation loop.
    // A finding with targetReleaseType but no linked gated mission is no longer
    // auto-promoted on release — gate-resolution is the sole activation path.
    // The column stays as informational/denormalized (ADR-0032); the finding
    // remains triaged until linked to a gated mission or handled manually.
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    const pulse = pulseRepo.createPulse({
      habitatId,
      missionId,
      scope: "mission",
      fromType: "agent",
      fromId: "agent-1",
      signalType: "finding",
      subject: "v0.24.0-finding",
      body: "",
      metadata: { findingKind: "bug", severity: "minor", blocksCurrentWork: false },
    });
    const t = findingTriageRepo.createForPulse(pulse);
    findingTriageRepo.transitionStatus(t.id, "triaged", ACTOR);
    findingTriageRepo.setBucket(t.id, "defer_to_release");
    findingTriageRepo.setTargetReleaseType(t.id, "minor");

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.2.0", {
      detectedBy: "api",
    });

    expect(result.promotedCount).toBe(0);
    expect(refreshFinding(t.id).status).toBe("triaged");
  });
});

/**
 * Retrospective + notification envelope — the widened notification guard
 * (`promotedCount > 0 || activatedMissionCount > 0`) fires when only gates
 * resolved, and the retrospective records the activation count.
 */
describe("Retrospective + notification surface gate activations", () => {
  it("retrospective carries activatedMissionCount and a notification_event row is created", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    seedGatedMissionWithFinding({
      title: "notification-target",
      releaseGateType: "minor",
    });

    await releaseTriggerService.detectAndActivate(habitatId, "v0.2.0", {
      detectedBy: "api",
    });

    const retro = retrospectivePulsesFor("0.2.0");
    expect(retro).toHaveLength(1);
    const meta = retro[0].metadata as Record<string, unknown>;
    expect(meta.activatedMissionCount).toBe(1);

    // The widened notification guard (promotedCount > 0 || activatedMissionCount > 0)
    // fires a release.activated event row even when promotedCount is 0.
    const events = getDb()
      .select()
      .from(notificationEvents)
      .where(eq(notificationEvents.habitatId, habitatId))
      .all()
      .filter((e) => e.eventType === "release.activated");
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("notification fires when only gates resolved (promotedCount=0, activatedMissionCount>0)", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    // All seeded findings are linked to gated missions — no free-floating findings.
    seedGatedMissionWithFinding({
      title: "gate-only-1",
      releaseGateType: "minor",
    });

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.2.0", {
      detectedBy: "api",
    });

    // The widened guard fires the notification even though promotedCount is 0.
    expect(result.promotedCount).toBe(0);
    const events = getDb()
      .select()
      .from(notificationEvents)
      .where(eq(notificationEvents.habitatId, habitatId))
      .all()
      .filter((e) => e.eventType === "release.activated");
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});
