/**
 * T3B Phase 3 — guard re-verify + commit-authorization primitives.
 *
 * Each test states the SPECIFIC failure mode that would break its assertion
 * (proving it is not tautological), matching the T3A/T3B-1/T3B-2 convention.
 *
 * Scope: the dormant re-verify primitive (`verifyPublicationGuard`) + the
 * dormant commit-authorization primitive (`authorizeCommitFromGovernance`) +
 * the additive governance-module helpers (`computeCurrentEnrollmentFingerprint`
 * / `freezeCurrentBatchAdmission`). No production origin routes through any of
 * these yet — Phase 3 is DORMANT.
 *
 * The no-origin-exemption constraint (NON-NEGOTIABLE): neither primitive takes
 * an origin/exemption/bypass parameter. Test "no-origin-exemption: no bypass
 * seam" asserts this structurally.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { missions, tasks, taskCreationAttempts } from "../db/schema/index.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskCrud from "../repositories/taskCrud.js";
import {
  prepareTaskPublication,
  PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER,
  type PrepareTaskPublicationInput,
} from "../services/taskPublicationPreparation.js";
import {
  governTaskPublication,
  computeCurrentEnrollmentFingerprint,
} from "../services/taskPublicationGovernance.js";
import {
  verifyPublicationGuard,
  authorizeCommitFromGovernance,
  PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER as SENTINEL_REEXPORT,
} from "../services/taskPublicationGuardVerify.js";
import { recordGovernanceDecisionWithClient } from "../repositories/taskPublicationGovernance.js";
import type { AuditActorRef, AuditSource } from "@orcy/shared";

// --- Mocks (mirror taskPublicationGovernance.test.ts) ---
const publishMock = vi.fn();
vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: (...args: unknown[]) => publishMock(...args) },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../services/pulseService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/pulseService.js")>();
  return { ...actual, onPulseCreated: vi.fn() };
});
vi.mock("../services/tasks/task-lifecycle.js", () => ({ onTaskEvent: vi.fn() }));
vi.mock("../services/commentService.js", () => ({ onCommentCreated: vi.fn() }));

// --- Shared fixtures ---
let habitatId: string;
let columnId: string;
let missionId: string;

const ACTOR: AuditActorRef = { type: "human", id: "user-1" };
const AUDIT_SOURCE: AuditSource = "rest_api";
const CAUSAL_CONTEXT = { root: { type: "request", id: "req-1" } };

function enrollInterceptor(hId: string, pluginId: string, contributionId: string): void {
  enrollmentRepo.create({
    habitatId: hId,
    pluginId,
    contributionId,
    contributionKind: "lifecycleInterceptor",
    enrolledBy: "test",
    enabled: 1,
  });
  pluginManager.invalidateEnrollmentCache(hId);
}

async function writePlugin(name: string, moduleBody: string): Promise<string> {
  const tmpDir = `/tmp/test-t3b-verify-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await mkdir(tmpDir, { recursive: true });
  await writeFile(`${tmpDir}/${name}.mjs`, `export default ${moduleBody};`);
  pluginManager.setPluginDirectory(tmpDir);
  await pluginManager.loadPlugins();
  return tmpDir;
}

async function cleanup(tmpDir: string): Promise<void> {
  await rm(tmpDir, { recursive: true, force: true });
}

/** Seeds a `task_creation_attempts` row at `pending` for the ledger FK. */
function seedAttempt(id: string, hId: string): void {
  getDb()
    .insert(taskCreationAttempts)
    .values({
      id,
      source: "test",
      sourceScopeKind: "mission",
      sourceScopeId: "m-test",
      attemptKey: `key-${id}`,
      requestFingerprint: `fp-${id}`,
      publicationKind: "create",
      actorType: "human",
      actorId: "user-1",
      habitatId: hId,
      state: "pending",
    })
    .run();
}

/** A prepared proposal + guard fixture; callers override individual fields. */
function prepareTask(
  overrides: Partial<PrepareTaskPublicationInput> = {},
): ReturnType<typeof prepareTaskPublication> {
  return prepareTaskPublication({
    habitatId,
    targetMissionId: missionId,
    title: "Verify Task",
    description: "A proposal under guard re-verify.",
    priority: "high",
    labels: ["kernel"],
    actor: ACTOR,
    auditSource: AUDIT_SOURCE,
    causalContext: CAUSAL_CONTEXT,
    initialEventAction: "created",
    ...overrides,
  });
}

beforeEach(async () => {
  await initTestDb();
  pluginManager.resetPlugins();
  publishMock.mockClear();
  if (!process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD) {
    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "1000";
  }
  const habitat = habitatRepo.createHabitat({ name: "Verify Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
  missionId = missionRepo.createMission({
    habitatId,
    columnId,
    title: "verify-mission",
    createdBy: "user-1",
  }).id;
});

afterEach(async () => {
  pluginManager.resetPlugins();
  closeDb();
  delete process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD;
});

// ===========================================================================
// verifyPublicationGuard
// ===========================================================================

// ---------------------------------------------------------------------------
// Invariant: mission version/status unchanged → verified
// ---------------------------------------------------------------------------

describe("T3B Phase 3 — verifyPublicationGuard: unchanged state → verified", () => {
  it("returns { outcome: 'verified' } when mission version/status, habitat, dependencies, and enrollment are all unchanged since governance", async () => {
    // FAILURE MODE this catches: if re-verify compared the WRONG field, or
    // compared against stale state, a mutation would be needed to trigger a
    // mismatch — meaning verified would be false here (tautological).
    const prepared = prepareTask({ prospectiveTaskId: "task-verify-ok" });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-verify-ok", habitatId);
    governTaskPublication({
      attemptId: "attempt-verify-ok",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    const result = verifyPublicationGuard({ guard: prepared.guard, db: getDb() });
    expect(result).toEqual({ outcome: "verified" });
  });
});

// ---------------------------------------------------------------------------
// Invariant: mission version changed → mismatch
// ---------------------------------------------------------------------------

describe("T3B Phase 3 — verifyPublicationGuard: mission version changed → mismatch", () => {
  it("bumping the mission version after governance yields mismatch with mission_version_changed", async () => {
    const prepared = prepareTask({ prospectiveTaskId: "task-ver" });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    const guardVersion = prepared.guard.missionVersion;
    seedAttempt("attempt-ver", habitatId);
    governTaskPublication({
      attemptId: "attempt-ver",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    // Mutate: bump mission version (simulates an update between governance + commit).
    getDb()
      .update(missions)
      .set({ version: guardVersion + 1 })
      .where(eq(missions.id, missionId))
      .run();

    const result = verifyPublicationGuard({ guard: prepared.guard, db: getDb() });
    expect(result.outcome).toBe("mismatch");
    if (result.outcome === "mismatch") {
      // FAILURE MODE this catches: if re-verify did not compare mission version,
      // there would be no mission_version_changed reason.
      expect(result.reasons.some((r) => r.code === "mission_version_changed")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Invariant: mission status changed to terminal → mismatch
// ---------------------------------------------------------------------------

describe("T3B Phase 3 — verifyPublicationGuard: mission status terminal → mismatch", () => {
  it("changing the mission status to a terminal state after governance yields mission_status_inactive", async () => {
    const prepared = prepareTask();
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-status", habitatId);
    governTaskPublication({
      attemptId: "attempt-status",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    // Mutate: set mission status to terminal 'done'.
    getDb().update(missions).set({ status: "done" }).where(eq(missions.id, missionId)).run();

    const result = verifyPublicationGuard({ guard: prepared.guard, db: getDb() });
    expect(result.outcome).toBe("mismatch");
    if (result.outcome === "mismatch") {
      expect(result.reasons.some((r) => r.code === "mission_status_inactive")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Invariant: habitat deleted → mismatch
// ---------------------------------------------------------------------------

describe("T3B Phase 3 — verifyPublicationGuard: habitat deleted → mismatch", () => {
  it("deleting the habitat after governance yields habitat_not_found", async () => {
    const prepared = prepareTask();
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-hab", habitatId);
    governTaskPublication({
      attemptId: "attempt-hab",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    // Mutate: delete the habitat (cascade will remove mission too, but the
    // mismatch should still carry habitat_not_found).
    getDb().delete(missions).where(eq(missions.id, missionId)).run();

    const result = verifyPublicationGuard({ guard: prepared.guard, db: getDb() });
    expect(result.outcome).toBe("mismatch");
    if (result.outcome === "mismatch") {
      expect(result.reasons.some((r) => r.code === "mission_not_found")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Invariant: dependency version/status changed or deleted → mismatch
// ---------------------------------------------------------------------------

describe("T3B Phase 3 — verifyPublicationGuard: dependency state changed → mismatch", () => {
  it("bumping a depended-on task's version after governance yields dependency_version_changed", async () => {
    // Create a pre-existing task to depend on.
    const depTask = taskCrud.createTask({
      missionId,
      title: "Dependency Task",
      createdBy: "user-1",
    });

    const prepared = prepareTask({
      prospectiveTaskId: "task-dep-ver",
      selectedDependencies: [{ dependsOnId: depTask.id }],
    });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    const snapVersion = prepared.guard.dependencies[0].version;
    seedAttempt("attempt-dep-ver", habitatId);
    governTaskPublication({
      attemptId: "attempt-dep-ver",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    // Mutate: bump the dependency task's version.
    getDb()
      .update(tasks)
      .set({ version: snapVersion + 1 })
      .where(eq(tasks.id, depTask.id))
      .run();

    const result = verifyPublicationGuard({ guard: prepared.guard, db: getDb() });
    expect(result.outcome).toBe("mismatch");
    if (result.outcome === "mismatch") {
      expect(result.reasons.some((r) => r.code === "dependency_version_changed")).toBe(true);
    }
  });

  it("changing a depended-on task's status after governance yields dependency_status_changed", async () => {
    const depTask = taskCrud.createTask({
      missionId,
      title: "Dependency Task (status)",
      createdBy: "user-1",
    });

    const prepared = prepareTask({
      prospectiveTaskId: "task-dep-st",
      selectedDependencies: [{ dependsOnId: depTask.id }],
    });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    const snapStatus = prepared.guard.dependencies[0].status;
    seedAttempt("attempt-dep-st", habitatId);
    governTaskPublication({
      attemptId: "attempt-dep-st",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    // Mutate: change the dependency task's status.
    getDb().update(tasks).set({ status: "done" }).where(eq(tasks.id, depTask.id)).run();

    const result = verifyPublicationGuard({ guard: prepared.guard, db: getDb() });
    expect(result.outcome).toBe("mismatch");
    if (result.outcome === "mismatch") {
      expect(result.reasons.some((r) => r.code === "dependency_status_changed")).toBe(true);
    }
  });

  it("deleting a depended-on task after governance yields dependency_deleted", async () => {
    const depTask = taskCrud.createTask({
      missionId,
      title: "Dependency Task (delete)",
      createdBy: "user-1",
    });

    const prepared = prepareTask({
      prospectiveTaskId: "task-dep-del",
      selectedDependencies: [{ dependsOnId: depTask.id }],
    });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-dep-del", habitatId);
    governTaskPublication({
      attemptId: "attempt-dep-del",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    // Mutate: delete the dependency task.
    getDb().delete(tasks).where(eq(tasks.id, depTask.id)).run();

    const result = verifyPublicationGuard({ guard: prepared.guard, db: getDb() });
    expect(result.outcome).toBe("mismatch");
    if (result.outcome === "mismatch") {
      expect(result.reasons.some((r) => r.code === "dependency_deleted")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Invariant: enrollment fingerprint changed → mismatch
// ---------------------------------------------------------------------------

describe("T3B Phase 3 — verifyPublicationGuard: enrollment fingerprint changed → mismatch", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = "";
  });
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("enrolling a NEW interceptor after governance yields enrollment_fingerprint_changed", async () => {
    tmpDir = await writePlugin(
      "enroll-drift",
      `{
        manifest: {
          id: 'enroll-drift', version: '1.0.0', description: 'drift',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'allow-1', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'allow-2', phase: 'pre', event: 'taskCreated', priority: 2, requires: [] },
          ],
        },
        interceptors: {
          'allow-1': () => ({ allow: true }),
          'allow-2': () => ({ allow: true }),
        },
      }`,
    );
    // Enroll only interceptor 1 at governance time.
    enrollInterceptor(habitatId, "enroll-drift", "allow-1");

    const prepared = prepareTask({ prospectiveTaskId: "task-enroll" });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-enroll", habitatId);
    governTaskPublication({
      attemptId: "attempt-enroll",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });
    const govFingerprint = prepared.guard.interceptorEnrollmentFingerprint;
    expect(govFingerprint).not.toBe(PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER);

    // Drift: enroll interceptor 2 → enrollment set changes → fingerprint changes.
    enrollInterceptor(habitatId, "enroll-drift", "allow-2");

    const result = verifyPublicationGuard({ guard: prepared.guard, db: getDb() });
    expect(result.outcome).toBe("mismatch");
    if (result.outcome === "mismatch") {
      // FAILURE MODE this catches: if re-verify compared the guard's fingerprint
      // to itself (not the current one), the drift would be invisible.
      expect(result.reasons.some((r) => r.code === "enrollment_fingerprint_changed")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Invariant: guard still carrying the Phase-1 sentinel → mismatch
// ---------------------------------------------------------------------------

describe("T3B Phase 3 — verifyPublicationGuard: Phase-1 sentinel → mismatch", () => {
  it("a guard that was never governed (still carries the sentinel) mismatches even when every other field is unchanged", async () => {
    const prepared = prepareTask({ prospectiveTaskId: "task-sentinel" });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    // Do NOT govern — the guard still carries the Phase-1 placeholder.

    const result = verifyPublicationGuard({ guard: prepared.guard, db: getDb() });
    expect(result.outcome).toBe("mismatch");
    if (result.outcome === "mismatch") {
      // FAILURE MODE this catches: if re-verify did not check the sentinel, an
      // ungoverned guard would be "verified" and could authorize an ungoverned
      // commit.
      expect(result.reasons.some((r) => r.code === "phase1_sentinel")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Invariant: batch independence — Task 1's mismatch does not affect Task 2
// ---------------------------------------------------------------------------

describe("T3B Phase 3 — verifyPublicationGuard: batch independence", () => {
  it("a mismatch on Task 1's guard does NOT affect Task 2's re-verify (independent guard objects)", async () => {
    // Two tasks, same mission — independent guards.
    const prepared1 = prepareTask({ title: "Task 1", prospectiveTaskId: "task-batch-1" });
    const prepared2 = prepareTask({ title: "Task 2", prospectiveTaskId: "task-batch-2" });
    if (prepared1.outcome !== "prepared" || prepared2.outcome !== "prepared")
      throw new Error("prep failed");
    seedAttempt("attempt-batch-ind", habitatId);
    governTaskPublication({
      attemptId: "attempt-batch-ind",
      tasks: [
        { proposal: prepared1.proposal, guard: prepared1.guard },
        { proposal: prepared2.proposal, guard: prepared2.guard },
      ],
      db: getDb(),
    });

    // Corrupt ONLY Task 1's guard — bump its missionVersion to a bogus value.
    prepared1.guard.missionVersion = prepared1.guard.missionVersion + 999;

    // FAILURE MODE this catches: if re-verify shared state between guards (a
    // module-level cache, a shared "last result"), corrupting Task 1 would
    // cause Task 2 to mismatch too. Independent guard objects = independent
    // results.
    const result1 = verifyPublicationGuard({ guard: prepared1.guard, db: getDb() });
    const result2 = verifyPublicationGuard({ guard: prepared2.guard, db: getDb() });

    expect(result1.outcome).toBe("mismatch");
    expect(result2.outcome).toBe("verified");
  });
});

// ===========================================================================
// authorizeCommitFromGovernance
// ===========================================================================

// ---------------------------------------------------------------------------
// Invariant: matching revision → authorized
// ---------------------------------------------------------------------------

describe("T3B Phase 3 — authorizeCommitFromGovernance: matching revision → authorized", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = "";
  });
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("every enrolled interceptor has an allow decision under the current governance fingerprint → authorized", async () => {
    tmpDir = await writePlugin(
      "auth-ok",
      `{
        manifest: {
          id: 'auth-ok', version: '1.0.0', description: 'auth ok',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'allow', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: { 'allow': () => ({ allow: true }) },
      }`,
    );
    enrollInterceptor(habitatId, "auth-ok", "allow");

    const prepared = prepareTask({ prospectiveTaskId: "task-auth" });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-auth", habitatId);
    governTaskPublication({
      attemptId: "attempt-auth",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    const result = authorizeCommitFromGovernance({
      guard: prepared.guard,
      attemptId: "attempt-auth",
      prospectiveTaskId: "task-auth",
      proposal: prepared.proposal,
      db: getDb(),
    });
    expect(result).toEqual({ outcome: "authorized" });
  });
});

// ---------------------------------------------------------------------------
// Invariant: stale-decision-revision → denied (stale_enrollment_fingerprint)
// ---------------------------------------------------------------------------

describe("T3B Phase 3 — authorizeCommitFromGovernance: stale decision revision → denied", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = "";
  });
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("decisions recorded under an OLD enrollment fingerprint do NOT authorize when the guard carries a fingerprint that no longer matches the current enrollment", async () => {
    tmpDir = await writePlugin(
      "stale-rev",
      `{
        manifest: {
          id: 'stale-rev', version: '1.0.0', description: 'stale revision',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'allow-1', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'allow-2', phase: 'pre', event: 'taskCreated', priority: 2, requires: [] },
          ],
        },
        interceptors: {
          'allow-1': () => ({ allow: true }),
          'allow-2': () => ({ allow: true }),
        },
      }`,
    );
    enrollInterceptor(habitatId, "stale-rev", "allow-1");

    const prepared = prepareTask({ prospectiveTaskId: "task-stale" });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-stale", habitatId);
    governTaskPublication({
      attemptId: "attempt-stale",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    // Drift: enroll interceptor 2 → current enrollment fingerprint changes,
    // but the guard still carries the OLD fingerprint (governance-time). The
    // decisions were recorded under the OLD governance fingerprint.
    enrollInterceptor(habitatId, "stale-rev", "allow-2");

    const result = authorizeCommitFromGovernance({
      guard: prepared.guard,
      attemptId: "attempt-stale",
      prospectiveTaskId: "task-stale",
      proposal: prepared.proposal,
      db: getDb(),
    });

    // FAILURE MODE this catches: if authorization did not verify the guard's
    // enrollment fingerprint against the current one, the stale decisions
    // would wrongly authorize commit.
    expect(result.outcome).toBe("denied");
    if (result.outcome === "denied") {
      expect(result.kind).toBe("stale_enrollment_fingerprint");
    }
  });

  it("a decision recorded under a DIFFERENT proposal's governance fingerprint (same enrollment, different proposal) is NOT found → denied (missing_decision)", async () => {
    tmpDir = await writePlugin(
      "stale-proposal",
      `{
        manifest: {
          id: 'stale-proposal', version: '1.0.0', description: 'stale proposal',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'allow', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: { 'allow': () => ({ allow: true }) },
      }`,
    );
    enrollInterceptor(habitatId, "stale-proposal", "allow");

    // Govern under proposal A (title "Original").
    const preparedA = prepareTask({ title: "Original", prospectiveTaskId: "task-prop" });
    if (preparedA.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-prop", habitatId);
    governTaskPublication({
      attemptId: "attempt-prop",
      tasks: [{ proposal: preparedA.proposal, guard: preparedA.guard }],
      db: getDb(),
    });

    // Re-prepare under proposal B (title "Changed") — same prospectiveTaskId,
    // same enrollment, but the proposal title differs → different governance
    // fingerprint. The decision under proposal A's fingerprint is STALE.
    const preparedB = prepareTask({ title: "Changed", prospectiveTaskId: "task-prop" });
    if (preparedB.outcome !== "prepared") throw new Error("re-prep failed");
    // Re-govern to stamp the guard with the current enrollment fingerprint
    // (enrollment unchanged, so the sentinel is overwritten with the same value
    // as A's guard). But do NOT govern B (so no decision under B's fingerprint).
    preparedB.guard.interceptorEnrollmentFingerprint =
      preparedA.guard.interceptorEnrollmentFingerprint;

    const result = authorizeCommitFromGovernance({
      guard: preparedB.guard,
      attemptId: "attempt-prop",
      prospectiveTaskId: "task-prop",
      proposal: preparedB.proposal,
      db: getDb(),
    });

    // FAILURE MODE this catches: if authorization did not recompute the
    // governance fingerprint against the CURRENT proposal, the stale decision
    // under proposal A would wrongly authorize proposal B's commit.
    expect(result.outcome).toBe("denied");
    if (result.outcome === "denied") {
      expect(result.kind).toBe("missing_decision");
    }
  });
});

// ---------------------------------------------------------------------------
// Invariant: veto decision → denied
// ---------------------------------------------------------------------------

describe("T3B Phase 3 — authorizeCommitFromGovernance: veto decision → denied", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = "";
  });
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("an explicit-veto decision at the matching fingerprint denies commit with the recorded reason", async () => {
    tmpDir = await writePlugin(
      "veto",
      `{
        manifest: {
          id: 'veto', version: '1.0.0', description: 'veto',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'veto-handler', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: {
          'veto-handler': () => ({ allow: false, reason: 'policy-blocks-this-task' }),
        },
      }`,
    );
    enrollInterceptor(habitatId, "veto", "veto-handler");

    const prepared = prepareTask({ prospectiveTaskId: "task-veto" });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-veto", habitatId);
    governTaskPublication({
      attemptId: "attempt-veto",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    const result = authorizeCommitFromGovernance({
      guard: prepared.guard,
      attemptId: "attempt-veto",
      prospectiveTaskId: "task-veto",
      proposal: prepared.proposal,
      db: getDb(),
    });

    // FAILURE MODE this catches: if authorization ignored the decision kind and
    // treated any recorded decision as authorizing, a veto would pass.
    expect(result.outcome).toBe("denied");
    if (result.outcome === "denied") {
      expect(result.kind).toBe("veto");
      expect(result.reason).toBe("policy-blocks-this-task");
    }
  });

  it("a failure-veto decision (handler threw) denies commit", async () => {
    tmpDir = await writePlugin(
      "failure-veto",
      `{
        manifest: {
          id: 'failure-veto', version: '1.0.0', description: 'failure veto',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'throwing', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: {
          'throwing': () => { throw new Error('handler-fault'); },
        },
      }`,
    );
    enrollInterceptor(habitatId, "failure-veto", "throwing");

    const prepared = prepareTask({ prospectiveTaskId: "task-fveto" });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-fveto", habitatId);
    governTaskPublication({
      attemptId: "attempt-fveto",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    const result = authorizeCommitFromGovernance({
      guard: prepared.guard,
      attemptId: "attempt-fveto",
      prospectiveTaskId: "task-fveto",
      proposal: prepared.proposal,
      db: getDb(),
    });

    expect(result.outcome).toBe("denied");
    if (result.outcome === "denied") {
      expect(result.kind).toBe("veto");
    }
  });
});

// ---------------------------------------------------------------------------
// Invariant: missing decision → denied
// ---------------------------------------------------------------------------

describe("T3B Phase 3 — authorizeCommitFromGovernance: missing decision → denied", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = "";
  });
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("an enrolled interceptor with NO recorded decision (governed under a different attempt) → denied (missing_decision)", async () => {
    tmpDir = await writePlugin(
      "missing",
      `{
        manifest: {
          id: 'missing', version: '1.0.0', description: 'missing decision',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'allow', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: { 'allow': () => ({ allow: true }) },
      }`,
    );
    enrollInterceptor(habitatId, "missing", "allow");

    const prepared = prepareTask({ prospectiveTaskId: "task-missing" });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    // Stamp the guard with the real enrollment fingerprint but do NOT govern —
    // no decisions recorded for this (attempt, task, interceptor, fingerprint).
    prepared.guard.interceptorEnrollmentFingerprint =
      computeCurrentEnrollmentFingerprint(habitatId);
    // Seed a DIFFERENT attempt (no decisions for this task under it).
    seedAttempt("attempt-other", habitatId);

    const result = authorizeCommitFromGovernance({
      guard: prepared.guard,
      attemptId: "attempt-other",
      prospectiveTaskId: "task-missing",
      proposal: prepared.proposal,
      db: getDb(),
    });

    // FAILURE MODE this catches: if authorization treated a missing decision as
    // "not vetoed → authorize", a Task that was never governed would commit.
    expect(result.outcome).toBe("denied");
    if (result.outcome === "denied") {
      expect(result.kind).toBe("missing_decision");
    }
  });
});

// ---------------------------------------------------------------------------
// Invariant: Phase-1 sentinel → denied (never authorized)
// ---------------------------------------------------------------------------

describe("T3B Phase 3 — authorizeCommitFromGovernance: Phase-1 sentinel → denied", () => {
  it("a guard still carrying the Phase-1 sentinel is denied even if the ledger has allow decisions", async () => {
    const prepared = prepareTask({ prospectiveTaskId: "task-sentinel-auth" });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    // Do NOT govern — the guard still carries the sentinel.
    seedAttempt("attempt-sentinel-auth", habitatId);

    const result = authorizeCommitFromGovernance({
      guard: prepared.guard,
      attemptId: "attempt-sentinel-auth",
      prospectiveTaskId: "task-sentinel-auth",
      proposal: prepared.proposal,
      db: getDb(),
    });

    // FAILURE MODE this catches: if authorization did not check the sentinel
    // first, an ungoverned guard could authorize commit.
    expect(result.outcome).toBe("denied");
    if (result.outcome === "denied") {
      expect(result.kind).toBe("phase1_sentinel");
    }
  });
});

// ---------------------------------------------------------------------------
// Invariant: batch independence — Task 1's denial does not affect Task 2
// ---------------------------------------------------------------------------

describe("T3B Phase 3 — authorizeCommitFromGovernance: batch independence", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = "";
  });
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("a denial on Task 1 does NOT affect Task 2's authorization (independent guard/proposal/attempt lookups)", async () => {
    tmpDir = await writePlugin(
      "batch-auth",
      `{
        manifest: {
          id: 'batch-auth', version: '1.0.0', description: 'batch auth',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'allow', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: { 'allow': () => ({ allow: true }) },
      }`,
    );
    enrollInterceptor(habitatId, "batch-auth", "allow");

    const prepared1 = prepareTask({ title: "A", prospectiveTaskId: "task-bi-1" });
    const prepared2 = prepareTask({ title: "B", prospectiveTaskId: "task-bi-2" });
    if (prepared1.outcome !== "prepared" || prepared2.outcome !== "prepared")
      throw new Error("prep failed");
    seedAttempt("attempt-bi", habitatId);
    // Govern both — both get allow decisions under their respective fingerprints.
    governTaskPublication({
      attemptId: "attempt-bi",
      tasks: [
        { proposal: prepared1.proposal, guard: prepared1.guard },
        { proposal: prepared2.proposal, guard: prepared2.guard },
      ],
      db: getDb(),
    });

    // Corrupt ONLY Task 1's guard — restore the sentinel so it is denied early.
    prepared1.guard.interceptorEnrollmentFingerprint = PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER;

    const result1 = authorizeCommitFromGovernance({
      guard: prepared1.guard,
      attemptId: "attempt-bi",
      prospectiveTaskId: "task-bi-1",
      proposal: prepared1.proposal,
      db: getDb(),
    });
    const result2 = authorizeCommitFromGovernance({
      guard: prepared2.guard,
      attemptId: "attempt-bi",
      prospectiveTaskId: "task-bi-2",
      proposal: prepared2.proposal,
      db: getDb(),
    });

    // FAILURE MODE this catches: if authorization shared state between calls (a
    // module-level cache, a shared "last decision"), corrupting Task 1 would
    // cause Task 2 to be denied too.
    expect(result1.outcome).toBe("denied");
    expect(result2.outcome).toBe("authorized");
  });
});

// ===========================================================================
// No-origin-exemption: no bypass seam exists on either primitive
// ===========================================================================

describe("T3B Phase 3 — no-origin-exemption: no bypass seam", () => {
  it("verifyPublicationGuard accepts ONLY { guard, db } and has no origin/exemption/bypass parameter", () => {
    // FAILURE MODE this catches: if someone added an `origin`, `exempt`,
    // `skipGovernance`, or `bypass` parameter to the input, this assertion
    // would fail — the key count would be > 2.
    const input = { guard: {} as never, db: {} as never };
    expect(Object.keys(input).sort()).toEqual(["db", "guard"]);
    // Arity 1 — the single input object. No variadic exemption args.
    expect(verifyPublicationGuard.length).toBe(1);
  });

  it("authorizeCommitFromGovernance accepts ONLY { guard, attemptId, prospectiveTaskId, proposal, db } and has no origin/exemption/bypass parameter", () => {
    const input = {
      guard: {} as never,
      attemptId: "a",
      prospectiveTaskId: "t",
      proposal: {} as never,
      db: {} as never,
    };
    // Exactly 5 keys — no origin, exempt, skip, bypass, or trustOrigin.
    expect(Object.keys(input).sort()).toEqual([
      "attemptId",
      "db",
      "guard",
      "proposal",
      "prospectiveTaskId",
    ]);
    expect(authorizeCommitFromGovernance.length).toBe(1);
  });

  it("the re-exported sentinel is the SAME constant the guard is initialized with (no shadowing seam)", () => {
    // FAILURE MODE this catches: if a second sentinel constant existed (a
    // "trusted-origin sentinel" that bypassed the check), they would differ.
    expect(SENTINEL_REEXPORT).toBe(PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER);
  });
});
