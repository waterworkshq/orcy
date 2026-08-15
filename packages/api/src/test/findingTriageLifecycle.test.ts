/**
 * Finding Triage Lifecycle command module — discriminators.
 *
 * Covers the load-bearing invariants of the authoritative command kernel:
 *  - routeFinding for all four buckets (Mission shape per bucket)
 *  - route replay from the STORED fingerprint (not current Mission shape)
 *  - different-intent conflict with zero writes
 *  - terminal closure through repository transitionStatus + the real PATCH route
 *  - resolveFinding / markFindingWontfix atomicity + idempotency
 *  - rollback injection (Mission event / Finding link / Resolution insert)
 *
 * Concurrency (real worker processes) lives in
 * findingTriageLifecycleConcurrency.test.ts — sequential calls here are
 * labeled as such and are never presented as concurrency evidence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { missions, missionEvents, pulses, triageResolutions } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as agentRepo from "../repositories/agent.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as triageResolutionsRepo from "../repositories/triageResolutions.js";
import { triageRoutes } from "../routes/triage.js";
import { registerErrorHandler } from "../errors/plugin.js";
import {
  TEST_ONLY_SKIP_IN_TX_AUTHORITY,

  routeFinding,
  resolveFinding,
  markFindingWontfix,
  computeRouteFingerprint,
} from "../services/findingTriageLifecycle.js";

const ACTOR = { type: "human" as const, id: "user-1", authority: TEST_ONLY_SKIP_IN_TX_AUTHORITY };

let habitatId: string;
let columnId: string;
let agentApiKey: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(pulses).run();

  const habitat = habitatRepo.createHabitat({ name: "Lifecycle Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;

  const result = agentRepo.createAgent({
    name: "Lifecycle Test Agent",
    type: "claude-code",
    domain: "general",
  });
  agentApiKey = result.plainApiKey;
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
});

/** Seeds an `open` finding triage record and returns it. */
function seedOpenFinding(subject = "Lifecycle test finding"): findingTriageRepo.FindingTriage {
  const pulse = pulseRepo.createPulse({
    habitatId,
    scope: "habitat",
    fromType: "agent",
    fromId: "agent-1",
    signalType: "finding",
    subject,
    body: "Test body",
    metadata: { findingKind: "pre_existing_bug" },
  });
  return findingTriageRepo.createForPulse(pulse);
}

function countMissions(): number {
  return getDb().select().from(missions).all().length;
}

function countMissionEvents(): number {
  return getDb().select().from(missionEvents).all().length;
}

function countResolutions(): number {
  return getDb().select().from(triageResolutions).all().length;
}

// ---------------------------------------------------------------------------
// routeFinding — bucket outcomes
// ---------------------------------------------------------------------------

describe("routeFinding — bucket outcomes", () => {
  it("fix_now creates ONE ungated corrective Mission and sets in_progress with activation attribution", () => {
    const finding = seedOpenFinding();
    const missionsBefore = countMissions();

    const result = routeFinding({
      findingId: finding.id,
      actor: ACTOR,
      route: {
        bucket: "fix_now",
        missionTitle: "Corrective: fix now",
        missionDescription: "Fix immediately",
      },
    });

    expect(result.outcome).toBe("applied");
    if (result.outcome !== "applied") return;
    expect(result.value.status).toBe("in_progress");
    expect(result.value.bucket).toBe("fix_now");
    expect(result.value.correctiveMissionId).not.toBeNull();
    expect(result.value.routeFingerprint).not.toBeNull();
    expect(result.value.activatedAt).not.toBeNull();
    expect(result.value.activatedByType).toBe("human");
    expect(result.value.activatedById).toBe("user-1");
    expect(result.value.activationCause).toBe("manual");

    // Exactly ONE new Mission, ungated.
    expect(countMissions()).toBe(missionsBefore + 1);
    const mission = missionRepo.getMissionById(result.value.correctiveMissionId!);
    expect(mission).not.toBeNull();
    expect(mission!.releaseGateType).toBeNull();
    expect(mission!.releaseGateVersion).toBeNull();

    // Mission `created` event written on the same client.
    expect(countMissionEvents()).toBeGreaterThan(0);
  });

  it("defer_to_patch creates ONE gated corrective Mission with dependencies and sets triaged", () => {
    const finding = seedOpenFinding();

    // Seed a dependency Mission.
    const dep = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Dependency Mission",
      createdBy: "user-1",
    });
    const missionsBefore = countMissions();

    const result = routeFinding({
      findingId: finding.id,
      actor: ACTOR,
      route: {
        bucket: "defer_to_patch",
        missionTitle: "Corrective: deferred",
        missionDescription: "Deferred to patch",
        dependencies: [dep.id],
        releaseGateType: "patch",
        releaseGateVersion: "v0.40.0",
      },
    });

    expect(result.outcome).toBe("applied");
    if (result.outcome !== "applied") return;
    expect(result.value.status).toBe("triaged");
    expect(result.value.bucket).toBe("defer_to_patch");
    expect(result.value.correctiveMissionId).not.toBeNull();
    expect(result.value.activatedAt).toBeNull();
    expect(result.value.activationCause).toBeNull();

    // Exactly ONE new Mission, gated, dependency-placed.
    expect(countMissions()).toBe(missionsBefore + 1);
    const mission = missionRepo.getMissionById(result.value.correctiveMissionId!);
    expect(mission!.releaseGateType).toBe("patch");
    expect(mission!.releaseGateVersion).toBe("v0.40.0");
    expect(mission!.dependsOn).toContain(dep.id);
  });

  it("defer_to_release creates ONE gated corrective Mission and sets triaged", () => {
    const finding = seedOpenFinding();

    const result = routeFinding({
      findingId: finding.id,
      actor: ACTOR,
      route: {
        bucket: "defer_to_release",
        missionTitle: "Corrective: release deferred",
        missionDescription: "Deferred to release",
        releaseGateType: "minor",
        releaseGateVersion: "v0.41.0",
      },
    });

    expect(result.outcome).toBe("applied");
    if (result.outcome !== "applied") return;
    expect(result.value.status).toBe("triaged");
    const mission = missionRepo.getMissionById(result.value.correctiveMissionId!);
    expect(mission!.releaseGateType).toBe("minor");
  });

  it("document_as_known_limitation sets triaged with NO Mission", () => {
    const finding = seedOpenFinding();
    const missionsBefore = countMissions();

    const result = routeFinding({
      findingId: finding.id,
      actor: ACTOR,
      route: { bucket: "document_as_known_limitation" },
    });

    expect(result.outcome).toBe("applied");
    if (result.outcome !== "applied") return;
    expect(result.value.status).toBe("triaged");
    expect(result.value.bucket).toBe("document_as_known_limitation");
    expect(result.value.correctiveMissionId).toBeNull();
    expect(countMissions()).toBe(missionsBefore);
  });

  it("needs_investigation sets triaged with NO Mission", () => {
    const finding = seedOpenFinding();
    const missionsBefore = countMissions();

    const result = routeFinding({
      findingId: finding.id,
      actor: ACTOR,
      route: { bucket: "needs_investigation" },
    });

    expect(result.outcome).toBe("applied");
    if (result.outcome !== "applied") return;
    expect(result.value.status).toBe("triaged");
    expect(result.value.bucket).toBe("needs_investigation");
    expect(result.value.correctiveMissionId).toBeNull();
    expect(countMissions()).toBe(missionsBefore);
  });

  it("conflicts on a nonexistent finding", () => {
    const result = routeFinding({
      findingId: "nonexistent",
      actor: ACTOR,
      route: { bucket: "needs_investigation" },
    });
    expect(result.outcome).toBe("conflict");
    if (result.outcome === "conflict") expect(result.reason).toBe("not_found");
  });

  it("conflicts on a terminal finding without writes", () => {
    const finding = seedOpenFinding();
    const resolved = resolveFinding({
      findingId: finding.id,
      actor: ACTOR,
      resolution: "Already resolved",
      resolutionKind: "code_fix",
    });
    expect(resolved.outcome).toBe("applied");

    const result = routeFinding({
      findingId: finding.id,
      actor: ACTOR,
      route: { bucket: "needs_investigation" },
    });
    expect(result.outcome).toBe("conflict");
    if (result.outcome === "conflict") expect(result.reason).toBe("terminal");

    // Finding unchanged.
    const after = findingTriageRepo.getById(finding.id);
    expect(after!.status).toBe("resolved");
  });

  it("conflicts on a legacy-lineage-repair-required finding", () => {
    const finding = seedOpenFinding();
    const db = getDb();
    db.run(
      sql`UPDATE finding_triage SET legacy_lineage_repair_required = 1 WHERE id = ${finding.id}`,
    );

    const result = routeFinding({
      findingId: finding.id,
      actor: ACTOR,
      route: { bucket: "needs_investigation" },
    });
    expect(result.outcome).toBe("conflict");
    if (result.outcome === "conflict") {
      expect(result.reason).toBe("legacy_lineage_repair_required");
    }
  });
});

// ---------------------------------------------------------------------------
// routeFinding — replay / conflict (stored fingerprint)
// ---------------------------------------------------------------------------

describe("routeFinding — replay and conflict", () => {
  it("replays the same route fingerprint after a simulated lost response AND a later Mission edit (STORED fingerprint, not current Mission shape)", () => {
    const finding = seedOpenFinding();

    // 1. First application commits.
    const first = routeFinding({
      findingId: finding.id,
      actor: ACTOR,
      route: {
        bucket: "fix_now",
        missionTitle: "Corrective: original",
        missionDescription: "Original description",
      },
    });
    expect(first.outcome).toBe("applied");
    if (first.outcome !== "applied") return;
    const missionId = first.value.correctiveMissionId!;
    const missionsAfterFirst = countMissions();

    // 2. Simulated lost response: the caller retries the SAME intent. Before
    //    the retry, a legitimate human roadmap edit changes the Mission shape
    //    (title + version bump — both excluded from the fingerprint).
    const db = getDb();
    db.run(
      sql`UPDATE missions SET title = ${"Corrective: edited by human"}, version = 7 WHERE id = ${missionId}`,
    );

    const retry = routeFinding({
      findingId: finding.id,
      actor: ACTOR,
      route: {
        bucket: "fix_now",
        missionTitle: "Corrective: original",
        missionDescription: "Original description",
      },
    });

    // 3. The retry REPLAYS — the STORED fingerprint (from the original route
    //    intent) matches; the current Mission shape (edited title, bumped
    //    version) is irrelevant. Had replay compared the current Mission
    //    shape, the edited title would have produced a conflict.
    expect(retry.outcome).toBe("replayed");
    if (retry.outcome !== "replayed") return;
    expect(retry.value.correctiveMissionId).toBe(missionId);

    // Still exactly one Mission linked to this finding.
    expect(countMissions()).toBe(missionsAfterFirst);
    const linked = getDb().select().from(missions).where(eq(missions.id, missionId)).all();
    expect(linked).toHaveLength(1);
  });

  it("same no-work bucket + fingerprint replays", () => {
    const finding = seedOpenFinding();

    const first = routeFinding({
      findingId: finding.id,
      actor: ACTOR,
      route: { bucket: "document_as_known_limitation" },
    });
    expect(first.outcome).toBe("applied");

    const retry = routeFinding({
      findingId: finding.id,
      actor: ACTOR,
      route: { bucket: "document_as_known_limitation" },
    });
    expect(retry.outcome).toBe("replayed");
  });

  it("different route conflicts WITHOUT creating a second Mission", () => {
    const finding = seedOpenFinding();

    const first = routeFinding({
      findingId: finding.id,
      actor: ACTOR,
      route: {
        bucket: "fix_now",
        missionTitle: "Corrective: original",
        missionDescription: "Original description",
      },
    });
    expect(first.outcome).toBe("applied");
    const missionsAfterFirst = countMissions();

    // Different title → different fingerprint → conflict.
    const different = routeFinding({
      findingId: finding.id,
      actor: ACTOR,
      route: {
        bucket: "fix_now",
        missionTitle: "Corrective: DIFFERENT intent",
        missionDescription: "Original description",
      },
    });

    expect(different.outcome).toBe("conflict");
    if (different.outcome === "conflict") {
      expect(different.reason).toBe("different_route");
    }
    // No second Mission was created.
    expect(countMissions()).toBe(missionsAfterFirst);
  });

  it("permits a work-bearing reroute after needs_investigation and replaces the fingerprint", () => {
    const finding = seedOpenFinding();

    const first = routeFinding({
      findingId: finding.id,
      actor: ACTOR,
      route: { bucket: "needs_investigation" },
    });
    expect(first.outcome).toBe("applied");

    // Work-bearing reroute while triaged + no link — permitted.
    const reroute = routeFinding({
      findingId: finding.id,
      actor: ACTOR,
      route: {
        bucket: "fix_now",
        missionTitle: "Corrective: after investigation",
        missionDescription: "Now we know what to do",
      },
    });

    expect(reroute.outcome).toBe("applied");
    if (reroute.outcome !== "applied") return;
    expect(reroute.value.status).toBe("in_progress");
    expect(reroute.value.correctiveMissionId).not.toBeNull();
    // Fingerprint replaced with the new route's.
    expect(reroute.value.routeFingerprint).toBe(
      computeRouteFingerprint({
        bucket: "fix_now",
        missionTitle: "Corrective: after investigation",
        missionDescription: "Now we know what to do",
      }),
    );
  });

  it("fingerprint excludes actor — different actor, same intent, replays", () => {
    const finding = seedOpenFinding();

    const first = routeFinding({
      findingId: finding.id,
      actor: ACTOR,
      route: {
        bucket: "fix_now",
        missionTitle: "Corrective: intent",
        missionDescription: "Description",
      },
    });
    expect(first.outcome).toBe("applied");

    const otherActor = { type: "human" as const, id: "user-2", authority: TEST_ONLY_SKIP_IN_TX_AUTHORITY };
    const retry = routeFinding({
      findingId: finding.id,
      actor: otherActor,
      route: {
        bucket: "fix_now",
        missionTitle: "Corrective: intent",
        missionDescription: "Description",
      },
    });
    expect(retry.outcome).toBe("replayed");
  });

  it("replay conflicts when rerouting a triaged finding WITH a corrective Mission link to a different bucket", () => {
    const finding = seedOpenFinding();

    const first = routeFinding({
      findingId: finding.id,
      actor: ACTOR,
      route: {
        bucket: "defer_to_patch",
        missionTitle: "Corrective: deferred",
        missionDescription: "Description",
        releaseGateType: "patch",
        releaseGateVersion: "v0.40.0",
      },
    });
    expect(first.outcome).toBe("applied");

    // Triaged WITH a link — a different work-bearing route is NOT a
    // permitted reroute (only no-link reroute is permitted).
    const different = routeFinding({
      findingId: finding.id,
      actor: ACTOR,
      route: { bucket: "document_as_known_limitation" },
    });
    expect(different.outcome).toBe("conflict");
  });
});

// ---------------------------------------------------------------------------
// resolveFinding / markFindingWontfix
// ---------------------------------------------------------------------------

describe("resolveFinding", () => {
  it("writes terminal state + exactly one Finding-sourced Resolution atomically", () => {
    const finding = seedOpenFinding();
    const resolutionsBefore = countResolutions();

    const result = resolveFinding({
      findingId: finding.id,
      actor: ACTOR,
      resolution: "Fixed by patching the schema",
      resolutionKind: "code_fix",
      rootCause: "Missing migration",
    });

    expect(result.outcome).toBe("applied");
    if (result.outcome !== "applied") return;
    expect(result.value.status).toBe("resolved");
    expect(result.value.resolvedAt).not.toBeNull();
    expect(result.value.resolvedByType).toBe("human");
    expect(result.value.resolutionNote).toBe("Fixed by patching the schema");

    // Exactly ONE new Resolution Record.
    expect(countResolutions()).toBe(resolutionsBefore + 1);
    const resolution = triageResolutionsRepo.findByFindingSource(habitatId, finding.id);
    expect(resolution).not.toBeNull();
    expect(resolution!.resolution).toBe("Fixed by patching the schema");
    expect(resolution!.resolutionKind).toBe("code_fix");
    expect(resolution!.rootCause).toBe("Missing migration");
  });

  it("replays an identical retry (simulated lost response) — still exactly one Resolution", () => {
    const finding = seedOpenFinding();

    const first = resolveFinding({
      findingId: finding.id,
      actor: ACTOR,
      resolution: "Same resolution",
      resolutionKind: "config_change",
    });
    expect(first.outcome).toBe("applied");
    expect(countResolutions()).toBe(1);

    const retry = resolveFinding({
      findingId: finding.id,
      actor: ACTOR,
      resolution: "Same resolution",
      resolutionKind: "config_change",
    });
    expect(retry.outcome).toBe("replayed");

    // Still exactly ONE Resolution Record.
    expect(countResolutions()).toBe(1);
  });

  it("conflicts on a different payload WITHOUT a second Resolution", () => {
    const finding = seedOpenFinding();

    const first = resolveFinding({
      findingId: finding.id,
      actor: ACTOR,
      resolution: "First resolution",
      resolutionKind: "code_fix",
    });
    expect(first.outcome).toBe("applied");

    const different = resolveFinding({
      findingId: finding.id,
      actor: ACTOR,
      resolution: "DIFFERENT resolution",
      resolutionKind: "code_fix",
    });
    expect(different.outcome).toBe("conflict");
    if (different.outcome === "conflict") {
      expect(different.reason).toBe("different_payload");
    }
    expect(countResolutions()).toBe(1);
  });

  it("replays an identical retry that includes the SAME root cause", () => {
    const finding = seedOpenFinding();

    const first = resolveFinding({
      findingId: finding.id,
      actor: ACTOR,
      resolution: "Same resolution",
      resolutionKind: "code_fix",
      rootCause: "Same root cause",
    });
    expect(first.outcome).toBe("applied");

    const retry = resolveFinding({
      findingId: finding.id,
      actor: ACTOR,
      resolution: "Same resolution",
      resolutionKind: "code_fix",
      rootCause: "Same root cause",
    });
    expect(retry.outcome).toBe("replayed");
    expect(countResolutions()).toBe(1);
  });

  it("conflicts on a ROOT-CAUSE-ONLY divergence and returns the persisted payload", () => {
    const finding = seedOpenFinding();

    const first = resolveFinding({
      findingId: finding.id,
      actor: ACTOR,
      resolution: "Same resolution",
      resolutionKind: "code_fix",
      rootCause: "Original root cause",
    });
    expect(first.outcome).toBe("applied");

    const diverged = resolveFinding({
      findingId: finding.id,
      actor: ACTOR,
      resolution: "Same resolution",
      resolutionKind: "code_fix",
      rootCause: "DIFFERENT root cause",
    });
    expect(diverged.outcome).toBe("conflict");
    if (diverged.outcome === "conflict") {
      expect(diverged.reason).toBe("different_payload");
      expect(diverged.current).toEqual({
        existingResolution: "Same resolution",
        existingKind: "code_fix",
        existingRootCause: "Original root cause",
      });
    }
    expect(countResolutions()).toBe(1);
  });

  it("conflicts when a retry DROPS a previously persisted root cause (null ≠ value)", () => {
    const finding = seedOpenFinding();

    const first = resolveFinding({
      findingId: finding.id,
      actor: ACTOR,
      resolution: "Same resolution",
      resolutionKind: "code_fix",
      rootCause: "Original root cause",
    });
    expect(first.outcome).toBe("applied");

    const dropped = resolveFinding({
      findingId: finding.id,
      actor: ACTOR,
      resolution: "Same resolution",
      resolutionKind: "code_fix",
    });
    expect(dropped.outcome).toBe("conflict");
    if (dropped.outcome === "conflict") {
      expect(dropped.reason).toBe("different_payload");
    }
    expect(countResolutions()).toBe(1);
  });

  it("rejects non-human actors", () => {
    const finding = seedOpenFinding();
    const result = resolveFinding({
      findingId: finding.id,
      actor: { type: "agent", id: "agent-1", authority: TEST_ONLY_SKIP_IN_TX_AUTHORITY },
      resolution: "Agent cannot resolve",
      resolutionKind: "code_fix",
    });
    expect(result.outcome).toBe("conflict");
    if (result.outcome === "conflict") expect(result.reason).toBe("not_authorized");
    expect(countResolutions()).toBe(0);
  });

  it("rejects empty resolution text", () => {
    const finding = seedOpenFinding();
    const result = resolveFinding({
      findingId: finding.id,
      actor: ACTOR,
      resolution: "   ",
      resolutionKind: "code_fix",
    });
    expect(result.outcome).toBe("conflict");
    if (result.outcome === "conflict") expect(result.reason).toBe("invalid_input");
  });

  it("rejects resolving an already-wontfix finding", () => {
    const finding = seedOpenFinding();
    const wontfixed = markFindingWontfix({
      findingId: finding.id,
      actor: ACTOR,
      reason: "Not worth fixing",
    });
    expect(wontfixed.outcome).toBe("applied");

    const result = resolveFinding({
      findingId: finding.id,
      actor: ACTOR,
      resolution: "Try to resolve anyway",
      resolutionKind: "code_fix",
    });
    expect(result.outcome).toBe("conflict");
    if (result.outcome === "conflict") expect(result.reason).toBe("terminal");
  });

  it("root cause may be omitted (unknown)", () => {
    const finding = seedOpenFinding();
    const result = resolveFinding({
      findingId: finding.id,
      actor: ACTOR,
      resolution: "Resolved without root cause",
      resolutionKind: "other",
    });
    expect(result.outcome).toBe("applied");
    const resolution = triageResolutionsRepo.findByFindingSource(habitatId, finding.id);
    expect(resolution!.rootCause).toBeNull();
  });
});

describe("markFindingWontfix", () => {
  it("writes terminal state + one Resolution with kind fixed to wontfix", () => {
    const finding = seedOpenFinding();

    const result = markFindingWontfix({
      findingId: finding.id,
      actor: ACTOR,
      reason: "Acceptable risk",
    });

    expect(result.outcome).toBe("applied");
    if (result.outcome !== "applied") return;
    expect(result.value.status).toBe("wontfix");

    const resolution = triageResolutionsRepo.findByFindingSource(habitatId, finding.id);
    expect(resolution).not.toBeNull();
    expect(resolution!.resolutionKind).toBe("wontfix");
    expect(resolution!.resolution).toBe("Acceptable risk");
  });

  it("replays an identical retry", () => {
    const finding = seedOpenFinding();

    const first = markFindingWontfix({
      findingId: finding.id,
      actor: ACTOR,
      reason: "Same reason",
    });
    expect(first.outcome).toBe("applied");

    const retry = markFindingWontfix({
      findingId: finding.id,
      actor: ACTOR,
      reason: "Same reason",
    });
    expect(retry.outcome).toBe("replayed");
    expect(countResolutions()).toBe(1);
  });

  it("conflicts on a different reason", () => {
    const finding = seedOpenFinding();

    markFindingWontfix({ findingId: finding.id, actor: ACTOR, reason: "First reason" });

    const different = markFindingWontfix({
      findingId: finding.id,
      actor: ACTOR,
      reason: "DIFFERENT reason",
    });
    expect(different.outcome).toBe("conflict");
    if (different.outcome === "conflict") {
      expect(different.reason).toBe("different_payload");
    }
    expect(countResolutions()).toBe(1);
  });

  it("rejects non-human actors and empty reasons", () => {
    const finding = seedOpenFinding();
    const agent = markFindingWontfix({
      findingId: finding.id,
      actor: { type: "agent", id: "agent-1", authority: TEST_ONLY_SKIP_IN_TX_AUTHORITY },
      reason: "reason",
    });
    expect(agent.outcome).toBe("conflict");

    const empty = markFindingWontfix({ findingId: finding.id, actor: ACTOR, reason: "" });
    expect(empty.outcome).toBe("conflict");
    expect(countResolutions()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Terminal closure — repository seam + REAL PATCH route
// ---------------------------------------------------------------------------

describe("terminal closure", () => {
  it("repository transitionStatus rejects resolved -> open AND wontfix -> open", () => {
    const resolvedFinding = seedOpenFinding("Terminal resolved");
    resolveFinding({
      findingId: resolvedFinding.id,
      actor: ACTOR,
      resolution: "Done",
      resolutionKind: "code_fix",
    });

    expect(() => findingTriageRepo.transitionStatus(resolvedFinding.id, "open", ACTOR)).toThrow(
      /terminal/i,
    );

    const wontfixFinding = seedOpenFinding("Terminal wontfix");
    markFindingWontfix({ findingId: wontfixFinding.id, actor: ACTOR, reason: "No" });

    expect(() => findingTriageRepo.transitionStatus(wontfixFinding.id, "open", ACTOR)).toThrow(
      /terminal/i,
    );
  });

  it("legitimate transitions still work (open -> triaged, triaged -> resolved)", () => {
    const finding = seedOpenFinding();
    const triaged = findingTriageRepo.transitionStatus(finding.id, "triaged", ACTOR);
    expect(triaged.status).toBe("triaged");
    const resolved = findingTriageRepo.transitionStatus(finding.id, "resolved", ACTOR);
    expect(resolved.status).toBe("resolved");
  });

  describe("real PATCH route (retired — FU13)", () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      app = Fastify({ logger: false });
      await registerErrorHandler(app);
      await app.register(
        async (f) => {
          await f.register(triageRoutes);
        },
        { prefix: "/api" },
      );
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it("PATCH resolved -> open is retired (400 LEGACY_PATCH_RETIRED) and preserves the row + Resolution", async () => {
      const finding = seedOpenFinding("PATCH terminal resolved");
      const applied = resolveFinding({
        findingId: finding.id,
        actor: ACTOR,
        resolution: "Resolved for PATCH test",
        resolutionKind: "code_fix",
      });
      expect(applied.outcome).toBe("applied");

      const res = await app.inject({
        method: "PATCH",
        url: `/api/triage/findings/${finding.id}`,
        payload: { status: "open" },
        headers: { "x-agent-api-key": agentApiKey },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("LEGACY_PATCH_RETIRED");

      // Original row + Resolution preserved.
      const after = findingTriageRepo.getById(finding.id);
      expect(after!.status).toBe("resolved");
      expect(triageResolutionsRepo.findByFindingSource(habitatId, finding.id)).not.toBeNull();
    });

    it("PATCH wontfix -> open is retired (400 LEGACY_PATCH_RETIRED) and preserves the row + Resolution", async () => {
      const finding = seedOpenFinding("PATCH terminal wontfix");
      const applied = markFindingWontfix({
        findingId: finding.id,
        actor: ACTOR,
        reason: "Wontfix for PATCH test",
      });
      expect(applied.outcome).toBe("applied");

      const res = await app.inject({
        method: "PATCH",
        url: `/api/triage/findings/${finding.id}`,
        payload: { status: "open" },
        headers: { "x-agent-api-key": agentApiKey },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("LEGACY_PATCH_RETIRED");
      const after = findingTriageRepo.getById(finding.id);
      expect(after!.status).toBe("wontfix");
      expect(triageResolutionsRepo.findByFindingSource(habitatId, finding.id)).not.toBeNull();
    });

    it("PATCH terminal -> triaged and terminal -> in_progress are retired too (every non-terminal target)", async () => {
      const resolvedFinding = seedOpenFinding("PATCH resolved to triaged");
      resolveFinding({
        findingId: resolvedFinding.id,
        actor: ACTOR,
        resolution: "Done",
        resolutionKind: "code_fix",
      });
      const res1 = await app.inject({
        method: "PATCH",
        url: `/api/triage/findings/${resolvedFinding.id}`,
        payload: { status: "triaged" },
        headers: { "x-agent-api-key": agentApiKey },
      });
      expect(res1.statusCode).toBe(400);
      expect(JSON.parse(res1.body).code).toBe("LEGACY_PATCH_RETIRED");

      const wontfixFinding = seedOpenFinding("PATCH wontfix to in_progress");
      markFindingWontfix({ findingId: wontfixFinding.id, actor: ACTOR, reason: "No" });
      const res2 = await app.inject({
        method: "PATCH",
        url: `/api/triage/findings/${wontfixFinding.id}`,
        payload: { status: "in_progress" },
        headers: { "x-agent-api-key": agentApiKey },
      });
      expect(res2.statusCode).toBe(400);
      expect(JSON.parse(res2.body).code).toBe("LEGACY_PATCH_RETIRED");
    });
  });
});

// ---------------------------------------------------------------------------
// Rollback injection — failures leave ZERO partial lifecycle authority
// ---------------------------------------------------------------------------

describe("rollback injection", () => {
  it("Mission event insertion failure (after Mission creation + link intent) rolls back the Mission AND leaves the finding open", async () => {
    vi.spyOn(
      await import("../repositories/events/event-feature.js"),
      "createMissionEventWithClient",
    ).mockImplementation(() => {
      throw new Error("injected: mission event failure");
    });

    const finding = seedOpenFinding();
    const missionsBefore = countMissions();
    const eventsBefore = countMissionEvents();

    expect(() =>
      routeFinding({
        findingId: finding.id,
        actor: ACTOR,
        route: {
          bucket: "fix_now",
          missionTitle: "Corrective: will roll back",
          missionDescription: "Description",
        },
      }),
    ).toThrow(/injected: mission event failure/);

    // ZERO new Missions, ZERO new Mission events, finding still open.
    expect(countMissions()).toBe(missionsBefore);
    expect(countMissionEvents()).toBe(eventsBefore);
    const after = findingTriageRepo.getById(finding.id);
    expect(after!.status).toBe("open");
    expect(after!.routeFingerprint).toBeNull();
    expect(after!.correctiveMissionId).toBeNull();
  });

  it("Finding link write failure rolls back the Mission AND the Mission event", async () => {
    vi.spyOn(
      await import("../repositories/findingTriage.js"),
      "routeWithClient",
    ).mockImplementation(() => {
      throw new Error("injected: finding link failure");
    });

    const finding = seedOpenFinding();
    const missionsBefore = countMissions();
    const eventsBefore = countMissionEvents();

    expect(() =>
      routeFinding({
        findingId: finding.id,
        actor: ACTOR,
        route: {
          bucket: "fix_now",
          missionTitle: "Corrective: will roll back",
          missionDescription: "Description",
        },
      }),
    ).toThrow(/injected: finding link failure/);

    // ZERO new Missions, ZERO new Mission events.
    expect(countMissions()).toBe(missionsBefore);
    expect(countMissionEvents()).toBe(eventsBefore);
    const after = findingTriageRepo.getById(finding.id);
    expect(after!.status).toBe("open");
  });

  it("Resolution insertion failure rolls back the terminal Finding state", async () => {
    vi.spyOn(
      await import("../repositories/triageResolutions.js"),
      "createWithClient",
    ).mockImplementation(() => {
      throw new Error("injected: resolution failure");
    });

    const finding = seedOpenFinding();

    expect(() =>
      resolveFinding({
        findingId: finding.id,
        actor: ACTOR,
        resolution: "Will roll back",
        resolutionKind: "code_fix",
      }),
    ).toThrow(/injected: resolution failure/);

    // Finding NOT terminal; NO Resolution Record.
    const after = findingTriageRepo.getById(finding.id);
    expect(after!.status).toBe("open");
    expect(after!.resolvedAt).toBeNull();
    expect(triageResolutionsRepo.findByFindingSource(habitatId, finding.id)).toBeNull();
  });
});
