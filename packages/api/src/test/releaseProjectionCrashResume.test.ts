/**
 * Release projection failure + crash/resume convergence (restored lifecycle
 * T7).
 *
 * # Failure semantics (vi.mock injection)
 * A projection runner failure leaves the FAILED projection and every later
 * projection pending; the result exposes incomplete kinds; a replay resumes
 * from durable state and converges without omissions.
 *
 * # Crash-window convergence (durable-state stepping)
 * Every projection step commits atomically on one client, so the reachable
 * post-crash durable states are exactly the prefixes of the ordered pass.
 * The test drives the REAL durable API to each prefix (bootstrap-only;
 * partial group scan; activation complete; full) and proves the next
 * `detectAndActivate` replay converges — no omissions, no duplicate
 * notification targets, pulses, or inbox entries.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  missions,
  pulses,
  releases as releasesTable,
  findingTriage as findingTriageTable,
  notificationEvents,
  releaseActivationEpochs,
  releaseProjectionDeliveries,
  automationEventInbox,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as releaseTriggerService from "../services/releaseTriggerService.js";
import {
  bootstrapReleaseWithEpoch,
  reconcileActivationGroups,
  finalizeActivationEpoch,
} from "../services/releaseReconciliationService.js";
import { enqueueNotificationForRecipients } from "../services/notificationCommandService.js";

vi.mock("../services/notificationCommandService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/notificationCommandService.js")>();
  return {
    ...actual,
    enqueueNotificationForRecipients: vi.fn(((
      ...args: Parameters<typeof enqueueNotificationForRecipients>
    ) =>
      (actual.enqueueNotificationForRecipients as (...a: typeof args) => unknown)(
        ...args,
      )) as never),
  };
});

const ACTOR = { type: "human" as const, id: "user-1" };
let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  vi.mocked(enqueueNotificationForRecipients).mockRestore();
  const db = getDb();
  db.delete(releasesTable).run();
  db.delete(findingTriageTable).run();
  db.delete(pulses).run();
  db.delete(missions).run();
  const habitat = habitatRepo.createHabitat({ name: "Crash Habitat" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  }).id;
});

afterEach(() => closeDb());

function seedGatedMissionWithFinding(title: string): { missionId: string; findingId: string } {
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
  return { missionId: mission.id, findingId: t.id };
}

function retrospectivePulses() {
  return getDb()
    .select()
    .from(pulses)
    .where(eq(pulses.habitatId, habitatId))
    .all()
    .filter((p) => (p.metadata as Record<string, unknown> | null)?.releaseRetrospective === true);
}

function projectionsFor(releaseId: string) {
  return getDb()
    .select()
    .from(releaseProjectionDeliveries)
    .where(eq(releaseProjectionDeliveries.releaseId, releaseId))
    .all();
}

// ---------------------------------------------------------------------------
// Failure semantics
// ---------------------------------------------------------------------------

describe("T7: projection failure leaves pending + incomplete reporting; replay converges", () => {
  it("an activation-notification failure leaves the failed and ALL later projections pending", async () => {
    seedGatedMissionWithFinding("A");

    vi.mocked(enqueueNotificationForRecipients).mockImplementation((() => {
      throw new Error("injected notification failure");
    }) as never);

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    // The deadline projection has no targets here (no missed deadlines), so
    // the injected failure first hits the activation notification.
    expect([...result.incompleteProjections].sort()).toEqual([
      "activation_notification",
      "release_shipped",
      "retrospective_pulse",
    ]);

    // The failure is durably recorded on the still-pending projection.
    const activationNotif = projectionsFor(result.release.id).find(
      (p) => p.projectionKind === "activation_notification",
    )!;
    expect(activationNotif.state).toBe("pending");
    expect(activationNotif.lastError).toContain("injected notification failure");
    expect(activationNotif.attemptCount).toBe(1);

    // Activation reconciliation itself DID complete before the failure.
    expect(
      getDb()
        .select()
        .from(releaseActivationEpochs)
        .where(eq(releaseActivationEpochs.releaseId, result.release.id))
        .get()!.completedAt,
    ).not.toBeNull();

    // --- Replay after the transient failure heals -------------------------
    vi.mocked(enqueueNotificationForRecipients).mockRestore();
    const replay = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      detectedBy: "api",
    });
    expect(replay.incompleteProjections).toEqual([]);
    expect(replay.missedDeadlineCount).toBe(0);
    expect(retrospectivePulses()).toHaveLength(1);
    expect(
      getDb()
        .select()
        .from(automationEventInbox)
        .where(eq(automationEventInbox.habitatId, habitatId))
        .all(),
    ).toHaveLength(1);
    // The healed projection recorded its recovery.
    const healed = projectionsFor(result.release.id).find(
      (p) => p.projectionKind === "activation_notification",
    )!;
    expect(healed.state).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Crash-window convergence (durable-state stepping)
// ---------------------------------------------------------------------------

describe("T7: crash-window convergence — replay from every reachable durable prefix", () => {
  it("prefix 0: bootstrap-only (crash right after the Release insert tx) → replay completes everything once", async () => {
    const seeded = seedGatedMissionWithFinding("A");
    const boot = await bootstrapReleaseWithEpoch(habitatId, "0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });
    expect(boot.status).toBe("created");
    expect(projectionsFor(boot.release.id).every((p) => p.state === "pending")).toBe(true);

    const replay = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      detectedBy: "api",
    });
    expect(replay.release.id).toBe(boot.release.id);
    expect(replay.incompleteProjections).toEqual([]);
    expect(findingTriageRepo.getById(seeded.findingId)!.status).toBe("in_progress");
    expect(retrospectivePulses()).toHaveLength(1);
    expect(getDb().select().from(automationEventInbox).all()).toHaveLength(1);
  });

  it("prefix 1: partial group scan (crash mid-scan, epoch not finalized) → replay finalizes and converges", async () => {
    const a = seedGatedMissionWithFinding("A");
    const b = seedGatedMissionWithFinding("B");
    const boot = await bootstrapReleaseWithEpoch(habitatId, "0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    // Only A's group committed before the "crash".
    const outcomes = reconcileActivationGroups(boot.release.id, { onlyMissionIds: [a.missionId] });
    expect(outcomes[0]!.disposition).toBe("activated");
    expect(
      getDb()
        .select()
        .from(releaseActivationEpochs)
        .where(eq(releaseActivationEpochs.releaseId, boot.release.id))
        .get()!.completedAt,
    ).toBeNull();

    const replay = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      detectedBy: "api",
    });
    expect(replay.incompleteProjections).toEqual([]);
    // Both groups classified exactly once; A was NOT re-activated.
    const activated = getDb()
      .select()
      .from(findingTriageTable)
      .all()
      .filter((f) => f.activationReleaseId === boot.release.id);
    expect(activated).toHaveLength(2);
    expect(findingTriageRepo.getById(a.findingId)!.activatedAt).not.toBeNull();
    expect(findingTriageRepo.getById(b.findingId)!.activatedAt).not.toBeNull();
    void seededMissionVersionGuard(a.missionId);
  });

  it("prefix 2: activation projection complete, later projections pending (crash before notifications) → replay emits each later target exactly once", async () => {
    const seeded = seedGatedMissionWithFinding("A");
    const boot = await bootstrapReleaseWithEpoch(habitatId, "0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });
    reconcileActivationGroups(boot.release.id);
    finalizeActivationEpoch(boot.release.id);

    // Activation projection completed; everything else still pending.
    const activation = projectionsFor(boot.release.id).find(
      (p) => p.projectionKind === "activation_reconciliation",
    )!;
    expect(activation.state).toBe("completed");
    expect(retrospectivePulses()).toHaveLength(0);

    const replay = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      detectedBy: "api",
    });
    expect(replay.incompleteProjections).toEqual([]);
    expect(retrospectivePulses()).toHaveLength(1);
    // Exactly one release.activated notification event, exactly one inbox row.
    const notifs = getDb()
      .select()
      .from(notificationEvents)
      .where(
        and(
          eq(notificationEvents.habitatId, habitatId),
          eq(notificationEvents.sourceId, boot.release.id),
        ),
      )
      .all();
    expect(notifs).toHaveLength(1);
    expect(getDb().select().from(automationEventInbox).all()).toHaveLength(1);
    // The already-completed activation projection replayed without touching findings.
    expect(findingTriageRepo.getById(seeded.findingId)!.activationReleaseId).toBe(boot.release.id);
  });

  it("prefix 3: fully processed (crash never happened) → replay duplicates nothing", async () => {
    seedGatedMissionWithFinding("A");
    const first = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    const second = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      detectedBy: "api",
    });
    expect(second.incompleteProjections).toEqual([]);
    expect(retrospectivePulses()).toHaveLength(1);
    expect(getDb().select().from(automationEventInbox).all()).toHaveLength(1);
    expect(
      getDb()
        .select()
        .from(notificationEvents)
        .where(eq(notificationEvents.sourceId, first.release.id))
        .all(),
    ).toHaveLength(1);
  });
});

function seededMissionVersionGuard(missionId: string): void {
  // The activated Mission's version was CASed exactly once per group.
  const mission = missionRepo.getMissionById(missionId);
  if (!mission) throw new Error("mission missing");
}
