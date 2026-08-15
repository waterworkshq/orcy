/**
 * Structured-cluster Finding occurrence publication — discriminators.
 *
 * Covers the load-bearing invariants of the restored cluster intake:
 *  - canonical occurrence identity (JCS collision safety, summary-drift
 *    stability, template/display exclusion)
 *  - the exactly-one-`investigate` guard BEFORE attempt reservation
 *  - the admission matrix: all-new, all-active (corroboration only),
 *    old-evidence no-op, one-new-Pulse recurrence, reset-baseline cutoff,
 *    legacy-repair blocking, and the mixed cluster
 *  - the first-writer-frozen aggregate (template mutation/deletion between
 *    freeze and replay cannot reshape or reject replay)
 *  - participant rollback (Mission/Task/workflow/junction/Finding/evidence/
 *    Pulse pointer roll back TOGETHER)
 *  - suppression finalization (`batch_rejected` + `suppressed_active_lifecycle`)
 *    and scan-time repair of crash-stranded attempts through the REAL scan path
 *
 * Real cross-process occurrence contention lives in
 * triageOccurrenceContention.test.ts — sequential calls here are labeled as
 * such and are never presented as concurrency evidence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import {
  missions,
  tasks,
  pulses,
  triageClusterMissions,
  missionTemplates,
  taskCreationAttempts,
  findingTriageEvidence,
  findingTriageLineageRepairs,
  findingTriageLineageBaselineEvidence,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as occurrencesRepo from "../repositories/triagePublicationOccurrences.js";
import { TRIAGE_MISSION_TEMPLATE_ID } from "../repositories/template.js";
import {
  intakeStructuredCluster,
  classifyClusterIdentities,
  buildOccurrenceCandidateSnapshot,
  repairStrandedOccurrenceAttempts,
  type StructuredEvidencePulse,
} from "../services/triageOccurrencePublication.js";
import * as lifecycleModule from "../services/findingTriageLifecycle.js";
import { runSignalPatternClusteredScan } from "../services/triageScanService.js";
import { normalize } from "../services/habitatSkillService.js";
import {
  canonicalJson,
  deriveOccurrenceIdentity,
} from "../services/occurrenceCanonicalization.js";

let habitatId: string;
/** The normalized cluster key for the default subject (what the scan derives). */
const CLUSTER_KEY = normalize("flaky deploy");

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(pulses).run();

  const habitat = habitatRepo.createHabitat({ name: "Occurrence Habitat" });
  habitatId = habitat.id;
  columnRepo.createColumn({ habitatId, name: "Todo", order: 0, requiresClaim: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let pulseSeq = 0;

/** Creates a structured finding Pulse (findingKind-bearing). */
function seedFindingPulse(findingKind: string, subject = "flaky deploy", createdAt?: string): {
  id: string;
  createdAt: string;
  findingKind: string;
} {
  pulseSeq += 1;
  const pulse = pulseRepo.createPulse({
    habitatId,
    scope: "habitat",
    fromType: "agent",
    fromId: "agent-1",
    signalType: "finding",
    subject,
    body: `body ${pulseSeq}`,
    metadata: { findingKind },
  });
  // createPulse stamps its own createdAt; an explicit one is applied via a
  // direct update (the reset-baseline cutoff rule reads pulse.createdAt).
  if (createdAt) {
    getDb()
      .update(pulses)
      .set({ createdAt })
      .where(eq(pulses.id, pulse.id))
      .run();
  }
  return { id: pulse.id, createdAt: createdAt ?? pulse.createdAt, findingKind };
}

function seedExperiencePulse(subject: string): void {
  pulseRepo.createPulse({
    habitatId,
    scope: "habitat",
    fromType: "agent",
    fromId: "agent-1",
    signalType: "experience",
    subject,
    body: "experience body",
  });
}

/** Minimal cluster payload for the intake (rendered-content input only). */
function payloadFor(clusterKey: string, pulseCount: number) {
  return {
    clusterKey,
    skillCategory: "finding",
    provenanceBreakdown: { finding: pulseCount },
    signalCount: pulseCount,
    affectedTaskIds: [],
    affectedMissionIds: [],
    agentIds: ["agent-1"],
    crossMissionCount: 0,
    distinctAgentCount: 1,
    timeWindowDays: 7,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
}

function intake(pulsesIn: StructuredEvidencePulse[], clusterKey = CLUSTER_KEY) {
  return intakeStructuredCluster({
    habitatId,
    clusterKey,
    pulses: pulsesIn,
    payload: payloadFor(clusterKey, pulsesIn.length),
  });
}

function occurrences() {
  return occurrencesRepo.listByCluster(habitatId, CLUSTER_KEY);
}

function findings(): findingTriageRepo.FindingTriage[] {
  return findingTriageRepo.findByHabitatInStatus(habitatId, [
    "open",
    "triaged",
    "in_progress",
    "resolved",
    "wontfix",
  ]);
}

function missionCount(): number {
  return getDb().select().from(missions).all().length;
}

function evidenceFor(findingId: string) {
  return findingTriageRepo.listEvidenceWithClient(getDb(), findingId);
}

function attemptRows(occurrenceId: string) {
  return getDb()
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.sourceScopeId, occurrenceId))
    .all();
}

function resolveJunctionFor(missionId: string) {
  getDb()
    .update(triageClusterMissions)
    .set({ status: "resolved", resolvedAt: new Date().toISOString() })
    .where(eq(triageClusterMissions.missionId, missionId))
    .run();
}

/** Replaces the triage template's tasksTemplate (investigate-key tests). */
function setTemplateTasks(entries: unknown[]): void {
  getDb()
    .update(missionTemplates)
    .set({ tasksTemplate: entries as never })
    .where(eq(missionTemplates.id, TRIAGE_MISSION_TEMPLATE_ID))
    .run();
}

// ---------------------------------------------------------------------------
// Canonical identity (JCS discriminators)
// ---------------------------------------------------------------------------

describe("occurrence canonicalization", () => {
  it("ambiguous delimiter strings do NOT collide (JCS structural typing)", () => {
    const a = deriveOccurrenceIdentity({
      v: 1,
      habitatId: "h",
      clusterKey: "c",
      candidates: [{ kind: "new", findingKind: "a|b", pulseIds: ["c"], predecessorId: null }],
    });
    const b = deriveOccurrenceIdentity({
      v: 1,
      habitatId: "h",
      clusterKey: "c",
      candidates: [{ kind: "new", findingKind: "a", pulseIds: ["b|c"], predecessorId: null }],
    });
    expect(a.occurrenceId).not.toBe(b.occurrenceId);
    expect(a.snapshotDigest).not.toBe(b.snapshotDigest);
  });

  it("key/value confusion does not collide", () => {
    const a = canonicalJson({ "a-b": "c" });
    const b = canonicalJson({ a: "b-c" });
    expect(a).not.toBe(b);
  });

  it("object key order is irrelevant (recursive sort)", () => {
    const a = canonicalJson({ z: 1, a: { y: [1, { q: 2, b: 3 }], m: "x" } });
    const b = canonicalJson({ a: { m: "x", y: [1, { b: 3, q: 2 }] }, z: 1 });
    expect(a).toBe(b);
  });

  it("summary-only drift never changes identity (rendered state excluded)", () => {
    const classification = classifyClusterIdentities(getDb(), {
      habitatId,
      clusterKey: CLUSTER_KEY,
      pulses: [seedFindingPulse("bug")],
    });
    const snap1 = buildOccurrenceCandidateSnapshot(habitatId, CLUSTER_KEY, classification);
    const snap2 = buildOccurrenceCandidateSnapshot(habitatId, CLUSTER_KEY, classification);
    // The snapshot shape carries NO rendered/template field at all — identity
    // cannot drift with the payload or template by construction.
    expect(deriveOccurrenceIdentity(snap1).occurrenceId).toBe(
      deriveOccurrenceIdentity(snap2).occurrenceId,
    );
    expect(JSON.stringify(snap1)).not.toContain("title");
    expect(JSON.stringify(snap1)).not.toContain("description");
  });
});

// ---------------------------------------------------------------------------
// Exactly-one-investigate guard
// ---------------------------------------------------------------------------

describe("exactly-one investigate guard (before attempt reservation)", () => {
  it("ZERO investigate keys reject before the occurrence row is written", () => {
    setTemplateTasks([
      { key: "analyze", title: "Analyze {{clusterSubject}}", requiredCapabilities: ["investigation"] },
    ]);
    const result = intake([seedFindingPulse("bug")]);
    expect(result).toEqual({ outcome: "rejected_investigate_key", found: 0 });
    expect(occurrences()).toHaveLength(0);
    expect(missionCount()).toBe(0);
    expect(findings()).toHaveLength(0);
  });

  it("MULTIPLE investigate keys reject before attempt reservation (duplicate_task_key validation)", () => {
    // Two entries keyed "investigate" cannot survive preparation — the task-key
    // map rejects duplicates, which already satisfies "zero or multiple
    // investigate keys reject before attempts". (The found:2 literal variant
    // is unreachable input; the guard's found:0 case is the load-bearing one.)
    setTemplateTasks([
      { key: "investigate", title: "Investigate {{clusterSubject}}", requiredCapabilities: ["investigation"] },
      { key: "investigate", title: "Investigate again {{clusterSubject}}", requiredCapabilities: ["investigation"] },
    ]);
    const result = intake([seedFindingPulse("bug")]);
    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors.some((e) => e.code === "duplicate_task_key")).toBe(true);
    expect(occurrences()).toHaveLength(0);
    expect(missionCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Admission matrix (sequential — labeled as such)
// ---------------------------------------------------------------------------

describe("admission matrix (sequential intake calls)", () => {
  it("all-NEW cluster publishes once and admits with exact provenance", () => {
    const p1 = seedFindingPulse("bug");
    const p2 = seedFindingPulse("bug");
    const result = intake([p1, p2]);

    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") return;

    // One Mission, one investigation Task, one junction, one open Finding.
    expect(missionCount()).toBe(1);
    const finding = findings()[0];
    expect(finding.status).toBe("open");
    expect(finding.admittedByTriageMissionId).toBe(result.missionId);
    expect(finding.admittedByInvestigationTaskId).toBe(result.investigationTaskId);
    expect(finding.recurrenceOfId).toBeNull();

    // Task provenance: the committed investigate Task exists and carries the
    // template key's capabilities.
    const task = getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.id, result.investigationTaskId))
      .get();
    expect(task).toBeTruthy();
    expect(task!.missionId).toBe(result.missionId);

    // Exact membership: ALL window pulses as source evidence; projection
    // excludes the source pulse.
    const evidence = evidenceFor(finding.id);
    expect(evidence.map((e) => e.pulseId).sort()).toEqual([p1.id, p2.id].sort());
    expect(evidence.every((e) => e.role === "source")).toBe(true);
    expect(evidence.every((e) => e.admittedByTriageMissionId === result.missionId)).toBe(true);
    expect(finding.corroboratingPulseIds).toEqual(
      [p1.id, p2.id].filter((id) => id !== finding.pulseId),
    );

    // Junction committed atomically.
    const junction = getDb()
      .select()
      .from(triageClusterMissions)
      .where(eq(triageClusterMissions.missionId, result.missionId))
      .get();
    expect(junction?.status).toBe("open");

    // Write-once Pulse pointer committed in the same transaction.
    const pointed = getDb()
      .select()
      .from(pulses)
      .where(eq(pulses.id, finding.pulseId))
      .get();
    expect((pointed!.metadata as Record<string, unknown>).findingTriageId).toBe(finding.id);

    // The occurrence row froze the committed aggregate verbatim.
    const [occurrence] = occurrences();
    expect(occurrence.id).toBe(result.occurrenceId);
    const frozen = JSON.parse(occurrence.preparedAggregate) as { mission: { missionId: string } };
    expect(frozen.mission.missionId).toBe(result.missionId);
  });

  it("repeat scan with the SAME evidence is an idempotent no-op (no second investigation)", () => {
    const pulsesIn = [seedFindingPulse("bug"), seedFindingPulse("bug"), seedFindingPulse("bug")];
    const first = intake(pulsesIn);
    expect(first.outcome).toBe("published");
    const missionsAfterFirst = missionCount();

    // The admitted Finding is now ACTIVE: the repeat intake suppresses with
    // zero unseen corroborating evidence — never a second investigation.
    // (Attempt-level replay is exercised by the crash-resume + worker-contention
    // tests; through intake it is only reachable while a candidate remains
    // publishable, i.e. before the winner's admission commits.)
    const second = intake(pulsesIn);
    expect(second).toMatchObject({
      outcome: "suppressed",
      reason: "all_active_lifecycles",
      corroboratedPulseIds: [],
    });
    expect(missionCount()).toBe(missionsAfterFirst);
    expect(findings()).toHaveLength(1);
    expect(occurrences()).toHaveLength(1);
    expect(evidenceFor(first.outcome === "published" ? first.admittedFindingIds[0] : "")).toHaveLength(3);
  });

  it("ALL-ACTIVE cluster (junction resolved) suppresses and appends only UNSEEN corroborating evidence", () => {
    const pulsesIn = [seedFindingPulse("bug")];
    const first = intake(pulsesIn);
    expect(first.outcome).toBe("published");
    if (first.outcome !== "published") return;
    const findingId = first.admittedFindingIds[0];
    resolveJunctionFor(first.missionId);

    // Same evidence + one new pulse: no new mission, only the new pulse
    // corroborates.
    const fresh = seedFindingPulse("bug");
    const second = intake([...pulsesIn, fresh]);
    expect(second).toMatchObject({ outcome: "suppressed", reason: "all_active_lifecycles" });
    expect(missionCount()).toBe(1);
    expect(findings()).toHaveLength(1);

    const evidence = evidenceFor(findingId);
    expect(evidence.filter((e) => e.role === "corroborating").map((e) => e.pulseId)).toEqual([
      fresh.id,
    ]);
    // The source-role evidence is untouched — never duplicated as corroboration.
    expect(evidence.filter((e) => e.pulseId === pulsesIn[0].id)).toHaveLength(1);
    const finding = findingTriageRepo.getById(findingId)!;
    expect(finding.corroboratingPulseIds).toContain(fresh.id);
    expect(finding.admittedByTriageMissionId).toBe(first.missionId); // never a second investigation
  });

  it("TERMINAL identity with OLD-ONLY evidence is evidence_already_accounted (no-op)", () => {
    const pulsesIn = [seedFindingPulse("bug")];
    const first = intake(pulsesIn);
    expect(first.outcome).toBe("published");
    if (first.outcome !== "published") return;
    resolveJunctionFor(first.missionId);
    getDb().run(
      sql`UPDATE finding_triage SET status='resolved' WHERE id = ${first.admittedFindingIds[0]}`,
    );

    const second = intake(pulsesIn);
    expect(second).toMatchObject({ outcome: "suppressed", reason: "evidence_already_accounted" });
    expect(missionCount()).toBe(1);
    expect(findings()).toHaveLength(1); // no recurrence row
  });

  it("TERMINAL identity with ONE post-cutoff novel Pulse creates exactly ONE recurrence row", () => {
    const pulsesIn = [seedFindingPulse("bug")];
    const first = intake(pulsesIn);
    expect(first.outcome).toBe("published");
    if (first.outcome !== "published") return;
    const originalFindingId = first.admittedFindingIds[0];
    resolveJunctionFor(first.missionId);
    getDb().run(
      sql`UPDATE finding_triage SET status='wontfix' WHERE id = ${originalFindingId}`,
    );

    const novel = seedFindingPulse("bug");
    const second = intake([...pulsesIn, novel]);
    expect(second.outcome).toBe("published");
    if (second.outcome !== "published") return;

    // Exactly one new linked open row; the old row stays terminal.
    expect(second.recurredFindingIds).toHaveLength(1);
    const recurrence = findingTriageRepo.getById(second.recurredFindingIds[0])!;
    expect(recurrence.status).toBe("open");
    expect(recurrence.recurrenceOfId).toBe(originalFindingId);
    expect(recurrence.admittedByTriageMissionId).toBe(second.missionId);
    expect(recurrence.admittedByInvestigationTaskId).toBe(second.investigationTaskId);
    // Evidence: ONLY the novel pulse (old evidence accounted).
    expect(evidenceFor(recurrence.id).map((e) => e.pulseId)).toEqual([novel.id]);

    const original = findingTriageRepo.getById(originalFindingId)!;
    expect(original.status).toBe("wontfix"); // never resurrected
    expect(missionCount()).toBe(2); // one mission per occurrence
  });

  it("RESET BASELINE: pre-cutoff evidence is accounted; only post-cutoff novel Pulses recur", () => {
    const old = seedFindingPulse("bug", "flaky deploy", "2026-01-01T00:00:00.000Z");
    const first = intake([old]);
    expect(first.outcome).toBe("published");
    if (first.outcome !== "published") return;
    const findingId = first.admittedFindingIds[0];
    resolveJunctionFor(first.missionId);
    getDb().run(sql`UPDATE finding_triage SET status='resolved' WHERE id = ${findingId}`);

    // Evidence-baselined reset with a cutoff AFTER the old pulses.
    const db = getDb();
    db.insert(findingTriageLineageRepairs)
      .values({
        id: "repair-1",
        habitatId,
        clusterKey: CLUSTER_KEY,
        findingKind: "bug",
        mode: "evidence_baselined_root",
        affectedIdentity: `${habitatId}|${CLUSTER_KEY}|bug`,
        actorType: "human",
        actorId: "op-1",
        reason: "ambiguous legacy lineage",
        inputSnapshotDigest: "digest-1",
        cutoffTimestamp: "2026-06-01T00:00:00.000Z",
      })
      .run();
    db.insert(findingTriageLineageBaselineEvidence)
      .values({
        repairId: "repair-1",
        pulseId: old.id,
        digest: "d",
      })
      .run();

    // Pre-cutoff pulse (not in the lineage either): accounted, no recurrence.
    const preCutoff = seedFindingPulse("bug", "flaky deploy", "2026-02-01T00:00:00.000Z");
    expect(intake([old, preCutoff])).toMatchObject({
      outcome: "suppressed",
      reason: "evidence_already_accounted",
    });

    // Post-cutoff novel pulse: recurrence with ONLY that pulse.
    const postCutoff = seedFindingPulse("bug", "flaky deploy", "2026-08-01T00:00:00.000Z");
    const recurred = intake([old, preCutoff, postCutoff]);
    expect(recurred.outcome).toBe("published");
    if (recurred.outcome !== "published") return;
    expect(recurred.recurredFindingIds).toHaveLength(1);
    const recurrence = findingTriageRepo.getById(recurred.recurredFindingIds[0])!;
    expect(evidenceFor(recurrence.id).map((e) => e.pulseId)).toEqual([postCutoff.id]);
  });

  it("legacy_lineage_repair_required blocks automatic recurrence (human-only)", () => {
    const pulsesIn = [seedFindingPulse("bug")];
    const first = intake(pulsesIn);
    expect(first.outcome).toBe("published");
    if (first.outcome !== "published") return;
    resolveJunctionFor(first.missionId);
    getDb().run(
      sql`UPDATE finding_triage SET status='resolved', legacy_lineage_repair_required=1 WHERE id = ${first.admittedFindingIds[0]}`,
    );

    const novel = seedFindingPulse("bug");
    const second = intake([...pulsesIn, novel]);
    expect(second.outcome).toBe("suppressed");
    expect(findings()).toHaveLength(1); // no recurrence, no new row
    expect(missionCount()).toBe(1);
  });

  it("MIXED cluster publishes ONCE, admits only new/recurrence, corroborates the active identity", () => {
    // Identity A: new (kind "bug").
    // Identity B: active from a prior intake (kind "perf").
    // Identity C: terminal with a novel pulse (kind "sec").
    const a1 = seedFindingPulse("bug");
    const b1 = seedFindingPulse("perf");
    const c1 = seedFindingPulse("sec");

    // Seed B active + C terminal directly (prior lifecycle rows).
    const db = getDb();
    db.run(
      sql`INSERT INTO finding_triage (id, habitat_id, pulse_id, cluster_key, finding_kind, status, corroborating_pulse_ids, created_at, updated_at)
          VALUES ('f-b', ${habitatId}, ${b1.id}, ${CLUSTER_KEY}, 'perf', 'open', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );
    db.run(
      sql`INSERT INTO finding_triage (id, habitat_id, pulse_id, cluster_key, finding_kind, status, corroborating_pulse_ids, created_at, updated_at, resolved_at)
          VALUES ('f-c', ${habitatId}, ${c1.id}, ${CLUSTER_KEY}, 'sec', 'resolved', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')`,
    );
    db.run(
      sql`INSERT INTO finding_triage_evidence (finding_triage_id, pulse_id, habitat_id, role, admitted_at) VALUES ('f-b', ${b1.id}, ${habitatId}, 'source', '2026-01-01T00:00:00Z')`,
    );
    db.run(
      sql`INSERT INTO finding_triage_evidence (finding_triage_id, pulse_id, habitat_id, role, admitted_at) VALUES ('f-c', ${c1.id}, ${habitatId}, 'source', '2026-01-01T00:00:00Z')`,
    );

    // New window: A pulses (new identity), one more B pulse (corroboration),
    // one novel C pulse (recurrence).
    const a2 = seedFindingPulse("bug");
    const b2 = seedFindingPulse("perf");
    const c2 = seedFindingPulse("sec");

    const result = intake([a1, a2, b1, b2, c1, c2]);
    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") return;

    // ONE mission + junction for the whole mixed cluster.
    expect(missionCount()).toBe(1);

    // Admitted: only the new identity.
    expect(result.admittedFindingIds).toHaveLength(1);
    const admitted = findingTriageRepo.getById(result.admittedFindingIds[0])!;
    expect(admitted.findingKind).toBe("bug");
    expect(evidenceFor(admitted.id).map((e) => e.pulseId).sort()).toEqual([a1.id, a2.id].sort());

    // Recurred: only the terminal identity, novel pulse only.
    expect(result.recurredFindingIds).toHaveLength(1);
    const recurred = findingTriageRepo.getById(result.recurredFindingIds[0])!;
    expect(recurred.findingKind).toBe("sec");
    expect(recurred.recurrenceOfId).toBe("f-c");
    expect(evidenceFor(recurred.id).map((e) => e.pulseId)).toEqual([c2.id]);

    // Corroborated: the active identity received ONLY the unseen pulse.
    expect(result.corroboratedPulseIds).toEqual([b2.id]);
    const bEvidence = evidenceFor("f-b");
    expect(bEvidence.map((e) => e.pulseId).sort()).toEqual([b1.id, b2.id].sort());
  });
});

// ---------------------------------------------------------------------------
// First-writer-frozen aggregate (template mutation discriminators)
// ---------------------------------------------------------------------------

describe("first-writer-frozen aggregate", () => {
  function frozenTaskTitle(occurrenceId: string): string {
    const occurrence = occurrencesRepo.getById(occurrenceId)!;
    const prepared = JSON.parse(occurrence.preparedAggregate) as {
      tasks: Array<{ proposal: { title: string } }>;
    };
    return prepared.tasks[0].proposal.title;
  }

  it("template MUTATION between freeze and replay cannot reshape the published aggregate", () => {
    const pulsesIn = [seedFindingPulse("bug"), seedFindingPulse("bug")];

    // Crash-equivalent: freeze the occurrence, then fail admission so the
    // publication rolls back with attempts left pending.
    vi.spyOn(findingTriageRepo, "admitWithClient").mockImplementation(() => {
      throw new Error("injected: admission failure");
    });
    expect(() => intake(pulsesIn)).toThrow(/injected: admission failure/);
    vi.restoreAllMocks();

    const [occurrence] = occurrences();
    expect(occurrence).toBeTruthy(); // the freeze committed before publication
    const frozenTitle = frozenTaskTitle(occurrence.id);
    const pending = attemptRows(occurrence.id);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((a) => a.state === "pending")).toBe(true);

    // MUTATE the live template's task title AFTER the winner persisted.
    getDb()
      .update(missionTemplates)
      .set({
        tasksTemplate: [
          {
            key: "investigate",
            title: "MUTATED title {{clusterSubject}}",
            requiredCapabilities: ["investigation"],
          },
        ] as never,
      })
      .where(eq(missionTemplates.id, TRIAGE_MISSION_TEMPLATE_ID))
      .run();

    // Replay: the same evidence must reproduce the FROZEN aggregate, not the
    // current template content.
    const replay = intake(pulsesIn);
    expect(replay.outcome).toBe("published");
    if (replay.outcome !== "published") return;
    const committedTask = getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.id, replay.investigationTaskId))
      .get();
    expect(committedTask!.title).toBe(frozenTitle);
    expect(committedTask!.title).not.toContain("MUTATED");
    // Exactly one occurrence — the mutation manufactured no second occurrence.
    expect(occurrences()).toHaveLength(1);
  });

  it("template DELETION between freeze and replay cannot reject replay", () => {
    const pulsesIn = [seedFindingPulse("bug")];
    vi.spyOn(findingTriageRepo, "admitWithClient").mockImplementation(() => {
      throw new Error("injected: admission failure");
    });
    expect(() => intake(pulsesIn)).toThrow(/injected: admission failure/);
    vi.restoreAllMocks();

    const frozenTitle = frozenTaskTitle(occurrences()[0].id);

    getDb()
      .delete(missionTemplates)
      .where(eq(missionTemplates.id, TRIAGE_MISSION_TEMPLATE_ID))
      .run();

    const replay = intake(pulsesIn);
    expect(replay.outcome).toBe("published");
    if (replay.outcome !== "published") return;
    const committedTask = getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.id, replay.investigationTaskId))
      .get();
    expect(committedTask!.title).toBe(frozenTitle);
  });
});

// ---------------------------------------------------------------------------
// Participant rollback (mutate/revert injection)
// ---------------------------------------------------------------------------

describe("participant rollback — everything rolls back TOGETHER", () => {
  it("admission failure rolls back Mission, Tasks, junction, Findings, evidence, and Pulse pointer", () => {
    const pulsesIn = [seedFindingPulse("bug"), seedFindingPulse("bug")];
    const missionsBefore = missionCount();
    const tasksBefore = getDb().select().from(tasks).all().length;
    const findingsBefore = findings().length;
    const evidenceBefore = getDb().select().from(findingTriageEvidence).all().length;

    vi.spyOn(findingTriageRepo, "appendEvidenceWithClient").mockImplementation(() => {
      throw new Error("injected: evidence failure");
    });
    expect(() => intake(pulsesIn)).toThrow(/injected: evidence failure/);

    expect(missionCount()).toBe(missionsBefore); // Mission rolled back
    expect(getDb().select().from(tasks).all().length).toBe(tasksBefore); // Tasks rolled back
    expect(
      getDb().select().from(triageClusterMissions).all().filter((j) => j.clusterKey === CLUSTER_KEY),
    ).toHaveLength(0); // junction rolled back
    expect(findings()).toHaveLength(findingsBefore); // Findings rolled back

    // Evidence rolled back with the aggregate.
    expect(getDb().select().from(findingTriageEvidence).all().length).toBe(evidenceBefore);

    // Pulse pointer rolled back with the aggregate.
    for (const pulse of pulsesIn) {
      const row = getDb().select().from(pulses).where(eq(pulses.id, pulse.id)).get();
      expect((row!.metadata as Record<string, unknown>).findingTriageId).toBeUndefined();
    }

    // The occurrence row persists (committed before publication) and its
    // attempts stay pending/resumable — this is the resume path, not cleanup.
    const [occurrence] = occurrences();
    expect(occurrence).toBeTruthy();
    expect(attemptRows(occurrence.id).every((a) => a.state === "pending")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suppression finalization + scan-time repair through the REAL scan path
// ---------------------------------------------------------------------------

describe("suppression finalization + scan-time repair (real scan path)", () => {
  it("kill-after-rollback-before-cleanup: the next no-publication scan repairs pending attempts", async () => {
    // Three structured pulses → threshold cluster.
    const p1 = seedFindingPulse("bug");
    const p2 = seedFindingPulse("bug");
    const p3 = seedFindingPulse("bug");

    // Simulate the crash: freeze + reserve, then die before publication
    // cleanup (injected admission failure == process death after rollback).
    vi.spyOn(findingTriageRepo, "admitWithClient").mockImplementation(() => {
      throw new Error("injected: simulated crash");
    });
    expect(() => intake([p1, p2, p3])).toThrow(/injected: simulated crash/);
    vi.restoreAllMocks();

    const [occurrence] = occurrences();
    expect(occurrence).toBeTruthy();
    const pendingBefore = attemptRows(occurrence.id);
    expect(pendingBefore.length).toBeGreaterThan(0);
    expect(pendingBefore.every((a) => a.state === "pending")).toBe(true);

    // The publishable candidate disappears: the identity becomes ACTIVE via
    // another channel (the concurrent winner admitted it).
    findingTriageRepo.createForPulse({
      id: p1.id,
      habitatId,
      subject: "flaky deploy",
      metadata: { findingKind: "bug" },
    });

    // The REAL scan path: classification finds all-active → suppressed, and
    // the repair path finalizes the stranded pending attempts BEFORE returning.
    const reports = await runSignalPatternClusteredScan(habitatId);
    expect(reports[0].errors).toHaveLength(0);

    const rows = attemptRows(occurrence.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((a) => a.state === "batch_rejected")).toBe(true);
    expect(rows.every((a) => a.terminalOutcome === "suppressed_active_lifecycle")).toBe(true);
    expect(rows.every((a) => a.completedAt !== null)).toBe(true);

    // The occurrence row survives as durable history; no Mission was created.
    expect(occurrencesRepo.getById(occurrence.id)).toBeTruthy();
    expect(missionCount()).toBe(0);

    // Idempotent: a second no-publication scan finalizes nothing new.
    await runSignalPatternClusteredScan(habitatId);
    expect(attemptRows(occurrence.id).every((a) => a.state === "batch_rejected")).toBe(true);
  });

  it("the REAL scan path publishes a structured cluster (mission + admitted finding)", async () => {
    seedFindingPulse("bug");
    seedFindingPulse("bug");
    seedFindingPulse("bug");

    const reports = await runSignalPatternClusteredScan(habitatId);
    expect(reports[0].errors).toHaveLength(0);

    expect(missionCount()).toBe(1);
    const finding = findings()[0];
    expect(finding.status).toBe("open");
    expect(finding.admittedByTriageMissionId).not.toBeNull();
    expect(finding.admittedByInvestigationTaskId).not.toBeNull();
    expect(occurrences()).toHaveLength(1);
  });

  it("an ordinary (non-structured) cluster keeps the legacy triage path unchanged", async () => {
    seedExperiencePulse("plain signal");
    seedExperiencePulse("plain signal");
    seedExperiencePulse("plain signal");

    const reports = await runSignalPatternClusteredScan(habitatId);
    expect(reports[0].errors).toHaveLength(0);

    expect(missionCount()).toBe(1); // legacy createTriageMission path
    expect(occurrences()).toHaveLength(0); // no occurrence rows
    expect(findings()).toHaveLength(0); // no Finding admission
  });
});

// ---------------------------------------------------------------------------
// FU3 — the intake no-op reclassification race
// ---------------------------------------------------------------------------
// The pre-lock classification at the top of intake is ONLY a fast-path gate.
// The actual no-op decision + corroboration re-run under ONE `BEGIN IMMEDIATE`
// reservation. The discriminator below terminalizes the active Finding AFTER
// the pre-lock classification observes it active but BEFORE the no-op
// transaction's locked reclassification — exactly the window the cold review
// demonstrated. Because the intake is synchronous, the injection happens on the
// intake's FIRST writer reservation (the no-op transaction itself): a separate
// connection's human terminalization is indistinguishable from this, since the
// no-op tx re-reads under its own lock.
describe("intake no-op reclassification race (FU3)", () => {
  /** Installs the FU3 interleaving: terminalize `findingId` at the intake's first writer reservation. */
  function terminalizeAtFirstReservation(findingId: string) {
    type Tx = typeof lifecycleModule.withImmediateLifecycleTransaction;
    const realTx = lifecycleModule.withImmediateLifecycleTransaction;
    let terminalized = false;
    vi.spyOn(lifecycleModule, "withImmediateLifecycleTransaction").mockImplementation(
      ((fn, db) => {
        if (!terminalized) {
          terminalized = true;
          const outcome = lifecycleModule.markFindingWontfix({
            findingId,
            actor: {
              type: "human",
              id: "human-1",
              authority: { habitatAccess: { userHasHabitatWriteAccess: () => true } },
            },
            reason: "terminalized mid-intake",
          });
          expect(outcome.outcome).toBe("applied");
        }
        return realTx(fn, db);
      }) as Tx,
    );
    return () => terminalized;
  }

  it("mid-flight terminalization + NOVEL pulse: the recurrence is admitted, never consumed onto the terminal row", () => {
    const p1 = seedFindingPulse("bug");
    const first = intake([p1]);
    expect(first.outcome).toBe("published");
    if (first.outcome !== "published") return;
    const findingId = first.admittedFindingIds[0];
    resolveJunctionFor(first.missionId);

    const novel = seedFindingPulse("bug");

    const wasTerminalized = terminalizeAtFirstReservation(findingId);
    const second = intake([p1, novel]);
    expect(wasTerminalized()).toBe(true);

    // The locked reclassification saw the terminalized identity with a NOVEL
    // pulse → the no-op branch aborted and restarted through publication. The
    // recurrence is ADMITTED, not consumed as corroboration.
    expect(second.outcome).toBe("published");
    if (second.outcome !== "published") return;
    expect(second.recurredFindingIds).toHaveLength(1);
    const recurrence = findingTriageRepo.getById(second.recurredFindingIds[0])!;
    expect(recurrence.status).toBe("open");
    expect(recurrence.recurrenceOfId).toBe(findingId);
    expect(evidenceFor(recurrence.id).map((e) => e.pulseId)).toEqual([novel.id]);

    // The terminal predecessor received NO corroborating evidence.
    const original = findingTriageRepo.getById(findingId)!;
    expect(original.status).toBe("wontfix");
    expect(original.corroboratingPulseIds).not.toContain(novel.id);
    expect(evidenceFor(findingId).map((e) => e.pulseId)).not.toContain(novel.id);
  });

  it("mid-flight terminalization + lineage-accounted pulse: evidence_already_accounted with NO append to the terminal row", () => {
    // F1 (open) → corroborated with the old pulse → resolved.
    const p1 = seedFindingPulse("bug");
    const first = intake([p1]);
    expect(first.outcome).toBe("published");
    if (first.outcome !== "published") return;
    const f1Id = first.admittedFindingIds[0];
    resolveJunctionFor(first.missionId);

    const oldP = seedFindingPulse("bug");
    const appended = findingTriageRepo.appendEvidenceWithClient(getDb(), {
      findingTriageId: f1Id,
      pulseIds: [oldP.id],
      role: "corroborating",
    });
    expect(appended.appendedPulseIds).toEqual([oldP.id]);
    getDb().run(sql`UPDATE finding_triage SET status='resolved' WHERE id = ${f1Id}`);

    // F2 = recurrence of F1 (novel p2), currently OPEN/active.
    const p2 = seedFindingPulse("bug");
    const recurred = intake([p1, oldP, p2]);
    expect(recurred.outcome).toBe("published");
    if (recurred.outcome !== "published") return;
    const f2Id = recurred.recurredFindingIds[0];
    expect(f2Id).toBeTruthy();
    resolveJunctionFor(recurred.missionId);

    // The window pulse is lineage-accounted (lives on terminal F1) but unseen
    // on active F2 — the pre-lock classification sees F2 active with the pulse
    // as unseen corroboration. Terminalizing F2 mid-flight must make the
    // LOCKED classification reclassify it as accounted (no publishable, no
    // append) instead of appending onto the now-terminal row.
    const wasTerminalized = terminalizeAtFirstReservation(f2Id);
    const second = intake([p2, oldP]);
    expect(wasTerminalized()).toBe(true);

    expect(second).toMatchObject({
      outcome: "suppressed",
      reason: "evidence_already_accounted",
      corroboratedPulseIds: [],
    });
    const terminal = findingTriageRepo.getById(f2Id)!;
    expect(terminal.status).toBe("wontfix");
    expect(terminal.corroboratingPulseIds).not.toContain(oldP.id);
    expect(evidenceFor(f2Id).map((e) => e.pulseId)).toEqual([p2.id]);
  });

  it("scan-time repair rechecks publishability under the SAME writer reservation", () => {
    const p1 = seedFindingPulse("bug");
    const p2 = seedFindingPulse("bug");
    const p3 = seedFindingPulse("bug");

    // Freeze + crash: admission throws AFTER the freeze committed, leaving the
    // occurrence's attempts pending (process-death equivalent).
    vi.spyOn(findingTriageRepo, "admitWithClient").mockImplementation(() => {
      throw new Error("injected: simulated crash");
    });
    expect(() => intake([p1, p2, p3])).toThrow(/injected: simulated crash/);
    vi.restoreAllMocks();

    const [occurrence] = occurrences();
    expect(occurrence).toBeTruthy();
    expect(attemptRows(occurrence.id).length).toBeGreaterThan(0);

    // Make the frozen candidate non-publishable OUTSIDE the repair: the
    // identity becomes ACTIVE via the concurrent-winner channel.
    findingTriageRepo.createForPulse({
      id: p1.id,
      habitatId,
      subject: "flaky deploy",
      metadata: { findingKind: "bug" },
    });
    const active = findingTriageRepo.findByHabitatInStatus(habitatId, ["open"])[0];
    expect(active).toBeTruthy();

    // At the repair's finalize boundary, terminalize the active finding so the
    // frozen evidence becomes a NOVEL recurrence again. The in-tx recheck must
    // observe it and skip the finalization.
    const wasTerminalized = terminalizeAtFirstReservation(active.id);
    const finalized = repairStrandedOccurrenceAttempts(habitatId, CLUSTER_KEY);
    expect(wasTerminalized()).toBe(true);

    // FU3 repair: the "no candidate remains" decision and the terminalization
    // share one reservation — nothing was finalized, the attempts stay pending.
    expect(finalized).toHaveLength(0);
    expect(attemptRows(occurrence.id).every((a) => a.state === "pending")).toBe(true);
    expect(attemptRows(occurrence.id).some((a) => a.state === "batch_rejected")).toBe(false);
  });
});
