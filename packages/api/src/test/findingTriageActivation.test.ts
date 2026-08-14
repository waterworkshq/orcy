/**
 * Finding Triage Lifecycle — manual + Release-mode activation kernel
 * discriminators (restored lifecycle T5).
 *
 * Covers the load-bearing invariants of `activateCorrectiveMission` and the
 * internal `activateCorrectiveMissionForRelease`:
 *  - gate-ONLY clearing on manual activation (every other Mission field,
 *    dependency edges, and Tasks compared byte-for-byte before/after)
 *  - homogeneous-group activation (all-or-none over the shared Mission)
 *  - conflict matrix: missing link / stale version / archived / terminal
 *    Mission / mixed group / partial eligibility — ZERO writes each
 *  - replay of an already-activated group (manual + Release convergence)
 *  - Release mode RETAINS the gate, attributes every row to the Release,
 *    and re-verifies the caller's gate proof against the live gate
 *  - rollback injection: Mission-event / gate-CAS / group-activation
 *    failure rolls back the ENTIRE activation
 *  - the REAL activation route through HTTP (production-path discriminator)
 *
 * Real cross-process manual-vs-Release racing lives in
 * `findingTriageActivationConcurrency.test.ts` — sequential calls here are
 * never presented as concurrency evidence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { eq, sql } from "drizzle-orm";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { missions, missionEvents, pulses, tasks } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import { triageRoutes } from "../routes/triage.js";
import {
  routeFinding,
  resolveFinding,
  activateCorrectiveMission,
  activateCorrectiveMissionForRelease,
} from "../services/findingTriageLifecycle.js";
import type { Mission } from "../models/index.js";

const ACTOR = { type: "human" as const, id: "user-1" };

const JWT_SECRET = "dev-secret-change-in-production";

let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(tasks).run();
  db.delete(missionEvents).run();
  db.delete(missions).run();
  db.delete(pulses).run();
  db.run(sql`DELETE FROM finding_triage`);

  const habitat = habitatRepo.createHabitat({ name: "Activation Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
});

/** The Mission fields activation is ALLOWED to change. */
const ACTIVATION_MUTABLE_MISSION_FIELDS = new Set([
  "releaseGateType",
  "releaseGateVersion",
  "version",
  "updatedAt",
]);

/**
 * Compares complete Mission state before/after activation. Only gate/version/
 * updatedAt may differ, and only in the expected direction.
 */
function assertMissionOnlyActivationFieldsChanged(
  before: Mission,
  after: Mission,
  expect: { gateCleared: boolean; versionDelta: number },
): void {
  for (const key of Object.keys(before) as (keyof Mission)[]) {
    if (ACTIVATION_MUTABLE_MISSION_FIELDS.has(key)) continue;
    expect_equal(before[key], after[key], key);
  }
  if (expect.gateCleared) {
    if (!(after.releaseGateType === null)) throw new Error("gate type not cleared");
  } else {
    expect_equal(before.releaseGateType, after.releaseGateType, "releaseGateType");
    expect_equal(before.releaseGateVersion, after.releaseGateVersion, "releaseGateVersion");
  }
  if (after.version !== before.version + expect.versionDelta) {
    throw new Error(
      `version delta: before=${before.version} after=${after.version} expected +${expect.versionDelta}`,
    );
  }
}

function expect_equal(a: unknown, b: unknown, key: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`Mission field "${key}" changed by activation: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  }
}

/** Seeds a `triaged` finding with its own gated corrective Mission. */
function seedDeferredFinding(subject: string, opts: { dependsOn?: string[] } = {}) {
  const pulse = pulseRepo.createPulse({
    habitatId,
    scope: "habitat",
    fromType: "agent",
    fromId: "agent-1",
    signalType: "finding",
    subject,
    body: "Activation test body",
    metadata: { findingKind: "pre_existing_bug" },
  });
  const finding = findingTriageRepo.createForPulse(pulse);
  const outcome = routeFinding({
    findingId: finding.id,
    actor: ACTOR,
    route: {
      bucket: "defer_to_patch",
      missionTitle: `Corrective: ${subject}`,
      missionDescription: "Deferred corrective work",
      dependencies: opts.dependsOn,
      releaseGateType: "patch",
      releaseGateVersion: "9.9.9",
    },
  });
  if (outcome.outcome !== "applied") {
    throw new Error(`seed routeFinding failed: ${JSON.stringify(outcome)}`);
  }
  return outcome.value;
}

/** A dependency Mission the corrective Mission depends on. */
function seedDependencyMission(title: string): Mission {
  return missionRepo.createMission({
    habitatId,
    columnId,
    title,
    createdBy: ACTOR.id,
  });
}

/** Links a second `triaged` finding onto an existing corrective Mission. */
function linkSecondFinding(missionId: string, subject = "Second shared finding") {
  const routed = seedDeferredFinding(subject);
  // Relink onto the shared Mission (production paths do this via the legacy
  // link-only PATCH; direct repo write keeps the fixture minimal).
  findingTriageRepo.setTriageMissionId(routed.id, missionId);
  return findingTriageRepo.getById(routed.id)!;
}

function missionEventsFor(missionId: string) {
  return getDb()
    .select()
    .from(missionEvents)
    .where(eq(missionEvents.missionId, missionId))
    .all();
}

function snapshotTasksFor(missionId: string) {
  return getDb()
    .select()
    .from(tasks)
    .where(eq(tasks.missionId, missionId))
    .all()
    .map((t) => JSON.stringify(t));
}

// ---------------------------------------------------------------------------
// Manual activation
// ---------------------------------------------------------------------------

describe("activateCorrectiveMission — manual", () => {
  it("activates the homogeneous group, clears ONLY the gate, CASes version, writes ONE audit event", () => {
    const dep = seedDependencyMission("Upstream dep");
    const f1 = seedDeferredFinding("Manual activation target", { dependsOn: [dep.id] });
    const missionId = f1.correctiveMissionId!;
    const f2 = linkSecondFinding(missionId);

    taskRepo.createTask({
      missionId,
      title: "Corrective task",
      description: "do the work",
      requiredCapabilities: [],
      labels: [],
      createdBy: ACTOR.id,
    });

    const missionBefore = missionRepo.getMissionById(missionId)!;
    const depEdgesBefore = missionRepo.getMissionDependencyEdges([missionId]);
    const tasksBefore = snapshotTasksFor(missionId);
    const missionsCountBefore = getDb().select().from(missions).all().length;

    const outcome = activateCorrectiveMission({
      findingId: f1.id,
      actor: ACTOR,
      expectedMissionVersion: missionBefore.version,
    });

    expect(outcome.outcome).toBe("applied");
    if (outcome.outcome !== "applied") return;

    // Mission id NEVER changes; no new Mission created.
    expect(outcome.value.mission.id).toBe(missionId);
    expect(getDb().select().from(missions).all().length).toBe(missionsCountBefore);

    // Only gate/version/updatedAt changed; deps/status/deadlines retained.
    assertMissionOnlyActivationFieldsChanged(missionBefore, outcome.value.mission, {
      gateCleared: true,
      versionDelta: 1,
    });
    expect(missionRepo.getMissionDependencyEdges([missionId])).toEqual(depEdgesBefore);
    expect(snapshotTasksFor(missionId)).toEqual(tasksBefore);

    // Complete eligible group activated with manual attribution.
    expect(outcome.value.findings.map((f) => f.id).sort()).toEqual([f1.id, f2.id].sort());
    for (const finding of outcome.value.findings) {
      const row = findingTriageRepo.getById(finding.id)!;
      expect(row.status).toBe("in_progress");
      expect(row.correctiveMissionId).toBe(missionId);
      expect(row.activatedAt).not.toBeNull();
      expect(row.activatedByType).toBe("human");
      expect(row.activatedById).toBe(ACTOR.id);
      expect(row.activationCause).toBe("manual");
      expect(row.activationReleaseId).toBeNull();
    }

    // ONE Mission `updated` audit event with the required metadata.
    const updatedEvents = missionEventsFor(missionId).filter((e) => e.action === "updated");
    expect(updatedEvents).toHaveLength(1);
    const meta = updatedEvents[0].metadata as Record<string, unknown>;
    expect(meta.source).toBe("finding_triage_manual_activation");
    expect((meta.findingIds as string[]).sort()).toEqual([f1.id, f2.id].sort());
    expect(meta.priorGate).toEqual({ releaseGateType: "patch", releaseGateVersion: "9.9.9" });
    expect(meta.changedFields).toEqual(["releaseGateType", "releaseGateVersion", "version"]);
    expect(meta.releaseId).toBeUndefined();
  });

  it("replays an already-activated group without a second write", () => {
    const f1 = seedDeferredFinding("Replay target");
    const missionId = f1.correctiveMissionId!;
    const mission = missionRepo.getMissionById(missionId)!;

    const first = activateCorrectiveMission({
      findingId: f1.id,
      actor: ACTOR,
      expectedMissionVersion: mission.version,
    });
    expect(first.outcome).toBe("applied");

    const eventsAfterFirst = missionEventsFor(missionId).length;
    const versionAfterFirst = missionRepo.getMissionById(missionId)!.version;

    // Retry after the response was lost — despite the version having moved.
    const second = activateCorrectiveMission({
      findingId: f1.id,
      actor: ACTOR,
      expectedMissionVersion: mission.version,
    });
    expect(second.outcome).toBe("replayed");
    expect(missionEventsFor(missionId).length).toBe(eventsAfterFirst);
    expect(missionRepo.getMissionById(missionId)!.version).toBe(versionAfterFirst);
  });

  it("conflicts on a stale expected Mission version with ZERO writes", () => {
    const f1 = seedDeferredFinding("Stale version target");
    const missionId = f1.correctiveMissionId!;
    const mission = missionRepo.getMissionById(missionId)!;
    const eventsBefore = missionEventsFor(missionId).length;

    const outcome = activateCorrectiveMission({
      findingId: f1.id,
      actor: ACTOR,
      expectedMissionVersion: mission.version + 5,
    });

    expect(outcome.outcome).toBe("conflict");
    if (outcome.outcome !== "conflict") return;
    expect(outcome.reason).toBe("stale_mission_version");
    expect(outcome.current).toEqual({ currentVersion: mission.version });

    // ZERO writes: gate intact, version unchanged, finding still triaged.
    const after = missionRepo.getMissionById(missionId)!;
    expect(after.version).toBe(mission.version);
    expect(after.releaseGateType).toBe("patch");
    expect(findingTriageRepo.getById(f1.id)!.status).toBe("triaged");
    expect(missionEventsFor(missionId).length).toBe(eventsBefore);
  });

  it("conflicts on a missing corrective Mission link", () => {
    const f1 = seedDeferredFinding("No-link target");
    findingTriageRepo.setTriageMissionId(f1.id, null);

    const outcome = activateCorrectiveMission({
      findingId: f1.id,
      actor: ACTOR,
      expectedMissionVersion: 1,
    });
    expect(outcome.outcome).toBe("conflict");
    if (outcome.outcome === "conflict") expect(outcome.reason).toBe("missing_link");
    expect(findingTriageRepo.getById(f1.id)!.status).toBe("triaged");
  });

  it("conflicts on an archived corrective Mission", () => {
    const f1 = seedDeferredFinding("Archived mission target");
    const missionId = f1.correctiveMissionId!;
    missionRepo.updateMission(missionId, { status: "done" });
    missionRepo.updateMission(missionId, { isArchived: true });
    const version = missionRepo.getMissionById(missionId)!.version;

    const outcome = activateCorrectiveMission({
      findingId: f1.id,
      actor: ACTOR,
      expectedMissionVersion: version,
    });
    expect(outcome.outcome).toBe("conflict");
    if (outcome.outcome === "conflict") expect(outcome.reason).toBe("mission_not_activatable");
    expect(findingTriageRepo.getById(f1.id)!.status).toBe("triaged");
  });

  it("conflicts on a terminal-status (done) corrective Mission", () => {
    const f1 = seedDeferredFinding("Terminal mission target");
    const missionId = f1.correctiveMissionId!;
    missionRepo.updateMission(missionId, { status: "done" });
    const version = missionRepo.getMissionById(missionId)!.version;

    const outcome = activateCorrectiveMission({
      findingId: f1.id,
      actor: ACTOR,
      expectedMissionVersion: version,
    });
    expect(outcome.outcome).toBe("conflict");
    if (outcome.outcome === "conflict") expect(outcome.reason).toBe("mission_not_activatable");
  });

  it("conflicts on a MIXED linked group (one in_progress sibling) with ZERO writes", () => {
    const f1 = seedDeferredFinding("Mixed group target");
    const missionId = f1.correctiveMissionId!;
    const f2 = linkSecondFinding(missionId);

    // Move the sibling to in_progress WITHOUT activating this finding.
    findingTriageRepo.transitionStatus(f2.id, "in_progress", ACTOR);

    const mission = missionRepo.getMissionById(missionId)!;
    const eventsBefore = missionEventsFor(missionId).length;

    const outcome = activateCorrectiveMission({
      findingId: f1.id,
      actor: ACTOR,
      expectedMissionVersion: mission.version,
    });

    expect(outcome.outcome).toBe("conflict");
    if (outcome.outcome !== "conflict") return;
    expect(outcome.reason).toBe("mixed_group");
    expect(findingTriageRepo.getById(f1.id)!.status).toBe("triaged");
    expect(missionRepo.getMissionById(missionId)!.releaseGateType).toBe("patch");
    expect(missionRepo.getMissionById(missionId)!.version).toBe(mission.version);
    expect(missionEventsFor(missionId).length).toBe(eventsBefore);
  });

  it("conflicts on partial eligibility (an OPEN sibling on the shared Mission)", () => {
    const f1 = seedDeferredFinding("Partial eligibility target");
    const missionId = f1.correctiveMissionId!;

    // An open (unrouted) finding linked onto the same Mission.
    const pulse = pulseRepo.createPulse({
      habitatId,
      scope: "habitat",
      fromType: "agent",
      fromId: "agent-1",
      signalType: "finding",
      subject: "Open sibling",
      body: "Open sibling body",
      metadata: { findingKind: "pre_existing_bug" },
    });
    const open = findingTriageRepo.createForPulse(pulse);
    findingTriageRepo.setTriageMissionId(open.id, missionId);

    const mission = missionRepo.getMissionById(missionId)!;
    const outcome = activateCorrectiveMission({
      findingId: f1.id,
      actor: ACTOR,
      expectedMissionVersion: mission.version,
    });

    expect(outcome.outcome).toBe("conflict");
    if (outcome.outcome !== "conflict") return;
    expect(outcome.reason).toBe("mixed_group");
    expect(findingTriageRepo.getById(f1.id)!.status).toBe("triaged");
    expect(missionRepo.getMissionById(missionId)!.releaseGateType).toBe("patch");
  });

  it("conflicts on a TERMINAL finding (activation cannot resurrect)", () => {
    const f1 = seedDeferredFinding("Terminal finding target");
    const resolved = resolveFinding({
      findingId: f1.id,
      actor: ACTOR,
      resolution: "done",
      resolutionKind: "code_fix",
    });
    expect(resolved.outcome).toBe("applied");

    const outcome = activateCorrectiveMission({
      findingId: f1.id,
      actor: ACTOR,
      expectedMissionVersion: 1,
    });
    expect(outcome.outcome).toBe("conflict");
    if (outcome.outcome === "conflict") expect(outcome.reason).toBe("terminal");
  });

  it("rejects non-human actors (defense in depth under the route authority)", () => {
    const f1 = seedDeferredFinding("Agent activate target");
    const outcome = activateCorrectiveMission({
      findingId: f1.id,
      actor: { type: "agent", id: "agent-1" },
      expectedMissionVersion: 1,
    });
    expect(outcome.outcome).toBe("conflict");
    if (outcome.outcome === "conflict") expect(outcome.reason).toBe("not_authorized");
  });

  it("oversized manual activation is ALLOWED (no cap), attributed manual, consumes no Release budget", () => {
    // Freeze the habitat's Release budget BELOW the group size: manual
    // activation must remain uncapped.
    habitatRepo.updateHabitat(habitatId, {
      releaseSettings: {
        autoPromote: true,
        releaseWorkflowName: "release",
        requireVersionTag: true,
        maxPromotionsPerRelease: 1,
      },
    });

    const f1 = seedDeferredFinding("Oversized group target");
    const missionId = f1.correctiveMissionId!;
    const f2 = linkSecondFinding(missionId, "Oversized sibling");
    const f3 = linkSecondFinding(missionId, "Oversized sibling two");

    const mission = missionRepo.getMissionById(missionId)!;
    const outcome = activateCorrectiveMission({
      findingId: f1.id,
      actor: ACTOR,
      expectedMissionVersion: mission.version,
    });

    expect(outcome.outcome).toBe("applied");
    for (const id of [f1.id, f2.id, f3.id]) {
      const row = findingTriageRepo.getById(id)!;
      expect(row.status).toBe("in_progress");
      expect(row.activationCause).toBe("manual");
      expect(row.activationReleaseId).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Release-mode activation (internal entry)
// ---------------------------------------------------------------------------

describe("activateCorrectiveMissionForRelease — internal Release mode", () => {
  it("activates the group, RETAINS the gate, attributes every row to the Release", () => {
    const f1 = seedDeferredFinding("Release activation target");
    const missionId = f1.correctiveMissionId!;
    const missionBefore = missionRepo.getMissionById(missionId)!;

    const outcome = activateCorrectiveMissionForRelease({
      findingId: f1.id,
      releaseId: "release-1",
      gateProof: { releaseGateType: "patch", releaseGateVersion: "9.9.9" },
    });

    expect(outcome.outcome).toBe("applied");
    if (outcome.outcome !== "applied") return;

    // Gate RETAINED; version CASed/incremented; nothing else changed.
    assertMissionOnlyActivationFieldsChanged(missionBefore, outcome.value.mission, {
      gateCleared: false,
      versionDelta: 1,
    });

    const row = findingTriageRepo.getById(f1.id)!;
    expect(row.status).toBe("in_progress");
    expect(row.activationCause).toBe("release");
    expect(row.activationReleaseId).toBe("release-1");
    expect(row.activatedByType).toBe("system");

    const updatedEvents = missionEventsFor(missionId).filter((e) => e.action === "updated");
    expect(updatedEvents).toHaveLength(1);
    const meta = updatedEvents[0].metadata as Record<string, unknown>;
    expect(meta.source).toBe("finding_triage_release_activation");
    expect(meta.releaseId).toBe("release-1");
    expect(meta.priorGate).toEqual({ releaseGateType: "patch", releaseGateVersion: "9.9.9" });
    expect(meta.changedFields).toEqual(["version"]);
  });

  it("replays when the group is already activated (manual/release convergence)", () => {
    const f1 = seedDeferredFinding("Release replay target");
    const outcome = activateCorrectiveMissionForRelease({
      findingId: f1.id,
      releaseId: "release-1",
      gateProof: { releaseGateType: "patch", releaseGateVersion: "9.9.9" },
    });
    expect(outcome.outcome).toBe("applied");

    const eventsAfterFirst = missionEventsFor(f1.correctiveMissionId!).length;
    const second = activateCorrectiveMissionForRelease({
      findingId: f1.id,
      releaseId: "release-2",
      gateProof: { releaseGateType: "patch", releaseGateVersion: "9.9.9" },
    });
    expect(second.outcome).toBe("replayed");
    expect(missionEventsFor(f1.correctiveMissionId!).length).toBe(eventsAfterFirst);
  });

  it("conflicts when the gate proof does not match the Mission's live gate (ZERO writes)", () => {
    const f1 = seedDeferredFinding("Gate proof mismatch target");
    const missionId = f1.correctiveMissionId!;
    const mission = missionRepo.getMissionById(missionId)!;
    const eventsBefore = missionEventsFor(missionId).length;

    const outcome = activateCorrectiveMissionForRelease({
      findingId: f1.id,
      releaseId: "release-1",
      gateProof: { releaseGateType: "minor", releaseGateVersion: "1.0.0" },
    });

    expect(outcome.outcome).toBe("conflict");
    if (outcome.outcome !== "conflict") return;
    expect(outcome.reason).toBe("gate_proof_mismatch");
    expect(missionRepo.getMissionById(missionId)!.version).toBe(mission.version);
    expect(missionRepo.getMissionById(missionId)!.releaseGateType).toBe("patch");
    expect(findingTriageRepo.getById(f1.id)!.status).toBe("triaged");
    expect(missionEventsFor(missionId).length).toBe(eventsBefore);
  });

  it("an UNGATED fix_now group replays (already in_progress at route time)", () => {
    const pulse = pulseRepo.createPulse({
      habitatId,
      scope: "habitat",
      fromType: "agent",
      fromId: "agent-1",
      signalType: "finding",
      subject: "Ungated release target",
      body: "Body",
      metadata: { findingKind: "pre_existing_bug" },
    });
    const finding = findingTriageRepo.createForPulse(pulse);
    const routed = routeFinding({
      findingId: finding.id,
      actor: ACTOR,
      route: {
        bucket: "fix_now",
        missionTitle: "Ungated corrective",
        missionDescription: "No gate",
      },
    });
    if (routed.outcome !== "applied") throw new Error("seed failed");

    const outcome = activateCorrectiveMissionForRelease({
      findingId: finding.id,
      releaseId: "release-1",
      gateProof: { releaseGateType: "patch", releaseGateVersion: "9.9.9" },
    });
    expect(outcome.outcome).toBe("replayed"); // fix_now group already in_progress
  });
});

// ---------------------------------------------------------------------------
// Rollback injection
// ---------------------------------------------------------------------------

describe("activation rollback injection", () => {
  it("Mission-event failure rolls back the gate-CAS AND the group activation", async () => {
    const f1 = seedDeferredFinding("Rollback event target");
    const missionId = f1.correctiveMissionId!;
    const mission = missionRepo.getMissionById(missionId)!;

    // Inject AFTER seeding (seedDeferredFinding's routeFinding also writes a
    // Mission `created` event through the same primitive).
    vi.spyOn(
      await import("../repositories/events/event-feature.js"),
      "createMissionEventWithClient",
    ).mockImplementation(() => {
      throw new Error("injected: mission event failure");
    });

    expect(() =>
      activateCorrectiveMission({
        findingId: f1.id,
        actor: ACTOR,
        expectedMissionVersion: mission.version,
      }),
    ).toThrow(/injected: mission event failure/);

    // Full rollback: gate intact, version unchanged, finding still triaged,
    // zero events.
    const after = missionRepo.getMissionById(missionId)!;
    expect(after.version).toBe(mission.version);
    expect(after.releaseGateType).toBe("patch");
    expect(findingTriageRepo.getById(f1.id)!.status).toBe("triaged");
    expect(missionEventsFor(missionId).filter((e) => e.action === "updated")).toHaveLength(0);
  });

  it("gate-CAS failure rolls back everything before the group write", async () => {
    vi.spyOn(
      await import("../repositories/mission.js"),
      "activationVersionCasWithClient",
    ).mockImplementation(() => {
      throw new Error("injected: gate cas failure");
    });

    const f1 = seedDeferredFinding("Rollback cas target");
    const missionId = f1.correctiveMissionId!;

    expect(() =>
      activateCorrectiveMission({
        findingId: f1.id,
        actor: ACTOR,
        expectedMissionVersion: 1,
      }),
    ).toThrow(/injected: gate cas failure/);

    expect(missionRepo.getMissionById(missionId)!.releaseGateType).toBe("patch");
    expect(findingTriageRepo.getById(f1.id)!.status).toBe("triaged");
  });

  it("group-activation failure (short count) rolls back the gate-CAS AND the audit event", async () => {
    vi.spyOn(
      await import("../repositories/findingTriage.js"),
      "activateGroupWithClient",
    ).mockImplementation(() => {
      throw new Error("injected: group activation failure");
    });

    const f1 = seedDeferredFinding("Rollback group target");
    const missionId = f1.correctiveMissionId!;
    const mission = missionRepo.getMissionById(missionId)!;

    expect(() =>
      activateCorrectiveMission({
        findingId: f1.id,
        actor: ACTOR,
        expectedMissionVersion: mission.version,
      }),
    ).toThrow(/injected: group activation failure/);

    const after = missionRepo.getMissionById(missionId)!;
    expect(after.version).toBe(mission.version);
    expect(after.releaseGateType).toBe("patch");
    expect(findingTriageRepo.getById(f1.id)!.status).toBe("triaged");
    expect(missionEventsFor(missionId).filter((e) => e.action === "updated")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// REAL route — production-path discriminator
// ---------------------------------------------------------------------------

describe("POST /api/triage/findings/:id/activate — real route", () => {
  let app: FastifyInstance | null = null;
  beforeEach(async () => {
    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(
      async (f) => {
        await f.register(triageRoutes);
      },
      { prefix: "/api" },
    );
    await app.ready();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("through the REAL route: only gate/version/audit + Finding activation fields change", async () => {
    const dep = seedDependencyMission("Route dep");
    const f1 = seedDeferredFinding("Route activation target", { dependsOn: [dep.id] });
    const missionId = f1.correctiveMissionId!;
    taskRepo.createTask({
      missionId,
      title: "Route task",
      description: "task",
      requiredCapabilities: [],
      labels: [],
      createdBy: ACTOR.id,
    });

    const missionBefore = missionRepo.getMissionById(missionId)!;
    const depEdgesBefore = missionRepo.getMissionDependencyEdges([missionId]);
    const tasksBefore = snapshotTasksFor(missionId);

    const token = jwt.sign({ sub: "user-1", username: "test", role: "admin" }, JWT_SECRET, {
      issuer: "orcy",
    });
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${f1.id}/activate`,
      payload: { expectedMissionVersion: missionBefore.version },
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.activation.mission.id).toBe(missionId);
    expect(body.activation.mission.releaseGateType).toBeNull();

    assertMissionOnlyActivationFieldsChanged(
      missionBefore,
      missionRepo.getMissionById(missionId)!,
      { gateCleared: true, versionDelta: 1 },
    );
    expect(missionRepo.getMissionDependencyEdges([missionId])).toEqual(depEdgesBefore);
    expect(snapshotTasksFor(missionId)).toEqual(tasksBefore);

    const row = findingTriageRepo.getById(f1.id)!;
    expect(row.status).toBe("in_progress");
    expect(row.activationCause).toBe("manual");
  });

  it("stale version through the REAL route → 409 MISSION_VERSION_MISMATCH with X-Current-Version", async () => {
    const f1 = seedDeferredFinding("Route stale target");
    const token = jwt.sign({ sub: "user-1", username: "test", role: "admin" }, JWT_SECRET, {
      issuer: "orcy",
    });
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${f1.id}/activate`,
      payload: { expectedMissionVersion: 99 },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("MISSION_VERSION_MISMATCH");
    expect(res.headers["x-current-version"]).toBe("1");
  });
});
