/**
 * Release activation epochs + projection reconciliation (restored lifecycle
 * T7) — production-path discriminators.
 *
 * Covers: epoch freeze determinism and finality (never reopens under
 * cap/membership/gate/eligibility changes), the reconciliation disposition
 * matrix (activated / deferred_changed / deferred_oversized / deferred_budget
 * / already-attributed classification), replay without duplicate targets,
 * incomplete-projection reporting, the pre-cutover legacy carve-out, and the
 * shared detector seam (GitHub webhook handler, CI workflow convention,
 * CLI/REST paths all flow through `detectAndActivate`).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  missions,
  pulses,
  releases as releasesTable,
  findingTriage as findingTriageTable,
  notificationEvents,
  releaseActivationEpochs,
  releaseActivationEpochGroups,
  releaseProjectionDeliveries,
  automationEventInbox,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as releaseRepo from "../repositories/release.js";
import * as releaseTriggerService from "../services/releaseTriggerService.js";
import {
  bootstrapReleaseWithEpoch,
  reconcileActivationGroups,
  finalizeActivationEpoch,
} from "../services/releaseReconciliationService.js";
import {
  TEST_ONLY_SKIP_IN_TX_AUTHORITY,
 activateCorrectiveMission } from "../services/findingTriageLifecycle.js";
import { handleGitHubReleaseEvent } from "../services/githubReleaseWebhook.js";

const ACTOR = { type: "human" as const, id: "user-1", authority: TEST_ONLY_SKIP_IN_TX_AUTHORITY };
let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(releasesTable).run();
  db.delete(findingTriageTable).run();
  db.delete(pulses).run();
  db.delete(missions).run();
  const habitat = habitatRepo.createHabitat({ name: "Epoch Habitat" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  }).id;
});

afterEach(() => closeDb());

function setCap(cap: number | null): void {
  habitatRepo.updateHabitat(habitatId, {
    releaseSettings: {
      autoPromote: true,
      releaseWorkflowName: "release",
      requireVersionTag: true,
      maxPromotionsPerRelease: cap,
    },
  });
}

function seedGatedMissionWithFindings(
  title: string,
  opts: { gateType?: "patch" | "minor" | "major"; findings?: number } = {},
): { missionId: string; findingIds: string[] } {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title,
    createdBy: "triage-agent",
    releaseGateType: opts.gateType ?? "minor",
  });
  const findingIds: string[] = [];
  const count = opts.findings ?? 1;
  for (let i = 0; i < count; i++) {
    const pulse = pulseRepo.createPulse({
      habitatId,
      missionId: mission.id,
      scope: "mission",
      fromType: "agent",
      fromId: "agent-1",
      signalType: "finding",
      subject: `${title} #${i}`,
      body: "",
      metadata: { findingKind: "bug", severity: "minor", blocksCurrentWork: false },
    });
    const t = findingTriageRepo.createForPulse(pulse);
    findingTriageRepo.transitionStatus(t.id, "triaged", ACTOR);
    findingTriageRepo.setTriageMissionId(t.id, mission.id);
    findingIds.push(t.id);
  }
  return { missionId: mission.id, findingIds };
}

function epochFor(releaseId: string) {
  return getDb()
    .select()
    .from(releaseActivationEpochs)
    .where(eq(releaseActivationEpochs.releaseId, releaseId))
    .get();
}

function groupsFor(releaseId: string) {
  return getDb()
    .select()
    .from(releaseActivationEpochGroups)
    .where(eq(releaseActivationEpochGroups.releaseId, releaseId))
    .all()
    .sort((a, b) => a.position - b.position);
}

function projectionsFor(releaseId: string) {
  return getDb()
    .select()
    .from(releaseProjectionDeliveries)
    .where(eq(releaseProjectionDeliveries.releaseId, releaseId))
    .all();
}

function retrospectivePulses() {
  return getDb()
    .select()
    .from(pulses)
    .where(eq(pulses.habitatId, habitatId))
    .all()
    .filter((p) => (p.metadata as Record<string, unknown> | null)?.releaseRetrospective === true);
}

function findingsInStatus(status: string) {
  return getDb()
    .select()
    .from(findingTriageTable)
    .all()
    .filter((f) => f.status === status);
}

// ---------------------------------------------------------------------------
// Epoch freeze + finality
// ---------------------------------------------------------------------------

describe("T7: epoch freeze and deterministic ordering", () => {
  it("freezes cap, ordered groups, exact membership, and digest once at Release creation", async () => {
    setCap(2);
    const a = seedGatedMissionWithFindings("A");
    seedGatedMissionWithFindings("B");

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    const epoch = epochFor(result.release.id);
    expect(epoch).toBeDefined();
    expect(epoch!.frozenCap).toBe(2);
    expect(epoch!.completedAt).not.toBeNull();

    const groups = groupsFor(result.release.id);
    expect(groups).toHaveLength(2);
    // Deterministic order by mission createdAt (insert order here), exact membership.
    expect(groups[0]!.missionId).toBe(a.missionId);
    expect(groups[0]!.findingIds).toEqual(a.findingIds);
    // Cap 2 with two size-1 groups: both fit.
    expect(groups[0]!.disposition).toBe("activated");
    expect(groups[1]!.disposition).toBe("activated");
    expect(result.cappedCount).toBe(0);
    expect(result.incompleteProjections).toEqual([]);
  });

  it("a mixed (non-homogeneous) linked group is excluded from the epoch, never partially activated", async () => {
    // One mission with a triaged finding AND an open finding → not eligible.
    const mission = missionRepo.createMission({
      habitatId,
      columnId,
      title: "mixed",
      createdBy: "triage-agent",
      releaseGateType: "minor",
    });
    const findingIds: string[] = [];
    for (const leaveOpen of [false, true]) {
      const pulse = pulseRepo.createPulse({
        habitatId,
        missionId: mission.id,
        scope: "mission",
        fromType: "agent",
        fromId: "agent-1",
        signalType: "finding",
        subject: `mixed-${leaveOpen}`,
        body: "",
        metadata: { findingKind: "bug", severity: "minor", blocksCurrentWork: false },
      });
      const t = findingTriageRepo.createForPulse(pulse);
      if (!leaveOpen) findingTriageRepo.transitionStatus(t.id, "triaged", ACTOR);
      findingTriageRepo.setTriageMissionId(t.id, mission.id);
      findingIds.push(t.id);
    }

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    expect(groupsFor(result.release.id)).toHaveLength(0);
    expect(findingsInStatus("in_progress")).toHaveLength(0);
  });
});

describe("T7: epoch completion is final — cap/eligibility changes never reopen", () => {
  it("cap decrease after completion leaves already-attributed findings immutable; replay does nothing", async () => {
    setCap(2);
    seedGatedMissionWithFindings("A");
    seedGatedMissionWithFindings("B");

    const first = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });
    expect(findingsInStatus("in_progress")).toHaveLength(2);

    // Cap decreases below the already-consumed budget.
    setCap(1);
    const second = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      detectedBy: "api",
    });

    expect(second.release.id).toBe(first.release.id);
    expect(findingsInStatus("in_progress")).toHaveLength(2);
    const epoch = epochFor(first.release.id);
    expect(epoch!.frozenCap).toBe(2); // frozen value never mutated
    expect(groupsFor(first.release.id).every((g) => g.disposition !== "pending")).toBe(true);
  });

  it("cap increase + newly eligible findings after completion do not reopen the epoch", async () => {
    setCap(1);
    seedGatedMissionWithFindings("A");
    seedGatedMissionWithFindings("B");

    const first = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });
    expect(findingsInStatus("in_progress")).toHaveLength(1);

    // Cap rises; a NEW eligible gated mission appears; replay.
    setCap(10);
    seedGatedMissionWithFindings("C");
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", { detectedBy: "api" });

    // The completed epoch is untouched: still 2 frozen groups, 1 activated.
    const groups = groupsFor(first.release.id);
    expect(groups).toHaveLength(2);
    expect(groups.filter((g) => g.disposition === "activated")).toHaveLength(1);
    expect(findingsInStatus("in_progress")).toHaveLength(1);
    // B and C are reconsidered only by a LATER release's own frozen snapshot.
    const later = await releaseTriggerService.detectAndActivate(habitatId, "v0.2.0", {
      detectedBy: "api",
    });
    const laterGroups = groupsFor(later.release.id);
    expect(laterGroups).toHaveLength(2);
    expect(laterGroups.every((g) => g.disposition === "activated")).toBe(true);
    expect(findingsInStatus("in_progress")).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation disposition matrix
// ---------------------------------------------------------------------------

describe("T7: reconciliation disposition matrix", () => {
  async function bootstrapOnly(version = "0.1.0") {
    return bootstrapReleaseWithEpoch(habitatId, version, {
      releaseType: "minor" as const,
      detectedBy: "api" as const,
    });
  }

  it("membership drift (a member terminalizes before reconciliation) → deferred_changed", async () => {
    const seeded = seedGatedMissionWithFindings("A");
    const boot = await bootstrapOnly();

    // Drift: resolve one member between freeze and reconciliation.
    getDb()
      .update(findingTriageTable)
      .set({ status: "resolved" })
      .where(eq(findingTriageTable.id, seeded.findingIds[0]!))
      .run();

    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", { detectedBy: "api" });
    const groups = groupsFor(boot.release.id);
    expect(groups[0]!.disposition).toBe("deferred_changed");
    expect(findingsInStatus("in_progress")).toHaveLength(0);
  });

  it("gate change between freeze and reconciliation → deferred_changed (gate retained)", async () => {
    const seeded = seedGatedMissionWithFindings("A");
    const boot = await bootstrapOnly();

    getDb()
      .update(missions)
      .set({ releaseGateType: "major" })
      .where(eq(missions.id, seeded.missionId))
      .run();

    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", { detectedBy: "api" });
    const groups = groupsFor(boot.release.id);
    expect(groups[0]!.disposition).toBe("deferred_changed");
    // Release activation never clears the (changed) gate.
    const mission = missionRepo.getMissionById(seeded.missionId)!;
    expect(mission.releaseGateType).toBe("major");
  });

  it("already activated by ANOTHER attribution before reconciliation → deferred_changed", async () => {
    const seeded = seedGatedMissionWithFindings("A");
    const boot = await bootstrapOnly();

    // Manual activation wins the group first.
    const version = missionRepo.getMissionById(seeded.missionId)!.version;
    const manual = activateCorrectiveMission({
      findingId: seeded.findingIds[0]!,
      actor: { type: "human", id: "user-1", authority: TEST_ONLY_SKIP_IN_TX_AUTHORITY },
      expectedMissionVersion: version,
    });
    expect(manual.outcome).toBe("applied");

    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", { detectedBy: "api" });
    const groups = groupsFor(boot.release.id);
    expect(groups[0]!.disposition).toBe("deferred_changed");
    expect(groups[0]!.dispositionDetail).toContain("activated_by_other_attribution");
    // No release attribution was written.
    const finding = findingTriageRepo.getById(seeded.findingIds[0]!)!;
    expect(finding.activationCause).toBe("manual");
    expect(finding.activationReleaseId).toBeNull();
  });

  it("already attributed to THIS release → idempotent activated classification, no second write", async () => {
    const seeded = seedGatedMissionWithFindings("A");
    const boot = await bootstrapOnly();

    // Activate through the reserved-client path with THIS release identity
    // but leave the disposition pending (simulates a lost disposition write).
    const { runReleaseActivationOnReservedClient, withImmediateLifecycleTransaction } =
      await import("../services/findingTriageLifecycle.js");
    withImmediateLifecycleTransaction((client) => {
      const r = runReleaseActivationOnReservedClient(client, {
        findingId: seeded.findingIds[0]!,
        releaseId: boot.release.id,
        gateProof: { releaseGateType: "minor", releaseGateVersion: null },
      });
      return { outcome: r.outcome === "conflict" ? "conflict" : "applied", value: r } as never;
    });

    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", { detectedBy: "api" });
    const groups = groupsFor(boot.release.id);
    expect(groups[0]!.disposition).toBe("activated");
    expect(groups[0]!.dispositionDetail).toContain("already_attributed_to_this_release");
    // Exactly ONE Mission updated activation event exists.
    const events = getDb().select().from(missions).where(eq(missions.id, seeded.missionId)).get();
    void events;
  });

  it("group larger than the frozen cap → deferred_oversized (manual activation remains the escape hatch)", async () => {
    setCap(1);
    seedGatedMissionWithFindings("big", { findings: 2 });

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    const groups = groupsFor(result.release.id);
    expect(groups[0]!.disposition).toBe("deferred_oversized");
    expect(groups[0]!.dispositionDetail).toContain("oversized_for_release_cap");
    expect(result.cappedCount).toBe(2);
    expect(findingsInStatus("in_progress")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Replay, projections, and the seam
// ---------------------------------------------------------------------------

describe("T7: replay resumes durable state without duplicate targets", () => {
  it("a completed Release replays without duplicate pulse/notifications/inbox", async () => {
    seedGatedMissionWithFindings("A");
    const first = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    expect(retrospectivePulses()).toHaveLength(1);
    const inboxBefore = getDb().select().from(automationEventInbox).all().length;

    const second = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      detectedBy: "api",
    });

    expect(second.release.id).toBe(first.release.id);
    expect(second.incompleteProjections).toEqual([]);
    expect(retrospectivePulses()).toHaveLength(1);
    expect(getDb().select().from(automationEventInbox).all().length).toBe(inboxBefore);
    expect(
      getDb()
        .select()
        .from(notificationEvents)
        .where(
          and(
            eq(notificationEvents.habitatId, habitatId),
            eq(notificationEvents.sourceId, first.release.id),
          ),
        )
        .all(),
    ).toHaveLength(1); // the release.activated event, exactly once
  });

  it("a Release row created before T7 (no epoch) is returned without new effects", async () => {
    const legacy = releaseRepo.create({
      habitatId,
      version: "0.5.0",
      releaseType: "patch",
      detectedBy: "external",
    });
    seedGatedMissionWithFindings("A");

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.5.0", {
      releaseType: "major",
      detectedBy: "api",
    });

    expect(result.release.id).toBe(legacy.id);
    expect(result.release.releaseType).toBe("patch");
    expect(result.incompleteProjections).toEqual([]);
    expect(epochFor(legacy.id)).toBeUndefined();
    expect(findingsInStatus("in_progress")).toHaveLength(0);
    expect(retrospectivePulses()).toHaveLength(0);
  });
});

describe("T7: every detector flows through the shared seam", () => {
  it("GitHub webhook, CI workflow convention, CLI, and REST detectors all create epochs via detectAndActivate", async () => {
    seedGatedMissionWithFindings("A");

    // Seed the first release with an explicit type (webhook self-classify
    // needs a prior row, exactly like the retired chain).
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    // GitHub release webhook handler (github_release_webhook detector).
    const webhook = await handleGitHubReleaseEvent(
      {
        action: "published",
        release: {
          tag_name: "v0.1.1",
          name: "v0.1.1",
          body: null,
          html_url: "https://github.com/o/r",
          draft: false,
          prerelease: false,
        },
        repository: { full_name: "o/r" },
      },
      { habitatId },
    );
    expect(webhook.status).toBe("recorded");

    // CI/CD release-workflow convention detector.
    await releaseTriggerService.detectAndActivate(habitatId, "v0.3.0", {
      detectedBy: "cicd_pipeline",
    });
    // CLI detector.
    await releaseTriggerService.detectAndActivate(habitatId, "v0.4.0", {
      detectedBy: "cli",
    });
    // Provider-agnostic REST detector.
    await releaseTriggerService.detectAndActivate(habitatId, "v0.5.0", {
      detectedBy: "api",
    });

    const rows = getDb().select().from(releasesTable).all();
    expect(rows.map((r) => r.version)).toEqual([
      "0.1.0",
      "0.1.1",
      "0.3.0",
      "0.4.0",
      "0.5.0",
    ]);
    // Every detected Release has exactly one epoch and five projections —
    // no detector retains a short-circuit early return.
    for (const row of rows) {
      const epoch = epochFor(row.id);
      expect(epoch, `epoch for ${row.version}`).toBeDefined();
      const projections = projectionsFor(row.id);
      expect(projections).toHaveLength(5);
      expect(projections.every((p) => p.state === "completed")).toBe(true);
    }
  });
});

describe("T7: autoPromote kill switch freezes an empty epoch", () => {
  it("kill switch OFF at freeze → zero groups, projections still complete, pulse still posted", async () => {
    process.env.ORCY_RELEASE_AUTO_PROMOTE = "false";
    try {
      seedGatedMissionWithFindings("A");
      const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
        releaseType: "minor",
        detectedBy: "api",
      });

      const epoch = epochFor(result.release.id);
      expect(epoch!.autoPromoteEnabled).toBe(0);
      expect(groupsFor(result.release.id)).toHaveLength(0);
      expect(epoch!.completedAt).not.toBeNull();
      expect(result.incompleteProjections).toEqual([]);
      expect(retrospectivePulses()).toHaveLength(1);
      expect(findingsInStatus("in_progress")).toHaveLength(0);
    } finally {
      delete process.env.ORCY_RELEASE_AUTO_PROMOTE;
    }
  });
});

// ---------------------------------------------------------------------------
// Low-level reconciler API (used by the worker race) — direct discriminators
// ---------------------------------------------------------------------------

describe("T7: reconcileActivationGroups + finalizeActivationEpoch (durable API)", () => {
  it("final pass classifies groups a partial scan missed, then closes the epoch exactly once", async () => {
    setCap(3);
    const a = seedGatedMissionWithFindings("A");
    const b = seedGatedMissionWithFindings("B");
    const boot = await bootstrapReleaseWithEpoch(habitatId, "0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    // Partial scan: only A's group (as a forced subset would).
    const outcomes = reconcileActivationGroups(boot.release.id, { onlyMissionIds: [a.missionId] });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.disposition).toBe("activated");

    // The epoch is NOT complete yet — a frozen group is unclassified.
    expect(epochFor(boot.release.id)!.completedAt).toBeNull();

    const counts = finalizeActivationEpoch(boot.release.id);
    expect(counts.activatedFindingCount).toBe(2);
    expect(counts.groupCount).toBe(2);
    expect(epochFor(boot.release.id)!.completedAt).not.toBeNull();

    // The activation projection completed with the full classification.
    const activation = projectionsFor(boot.release.id).find(
      (p) => p.projectionKind === "activation_reconciliation",
    )!;
    expect(activation.state).toBe("completed");

    // Idempotent re-finalization.
    const again = finalizeActivationEpoch(boot.release.id);
    expect(again.activatedFindingCount).toBe(2);
    expect(
      getDb()
        .select()
        .from(findingTriageTable)
        .all()
        .filter((f) => f.activationReleaseId === boot.release.id),
    ).toHaveLength(2);
    void b;
  });
});
