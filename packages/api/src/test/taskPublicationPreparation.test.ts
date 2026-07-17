/**
 * T3B Phase 1 — canonical Task publication preparation.
 *
 * Exercises the PURE preparation boundary against the REAL test DB (sql.js —
 * SQLite semantics behave identically to production better-sqlite3). Each
 * test states the SPECIFIC failure mode that would break its assertion
 * (proving it is not tautological), matching the T3A
 * `taskCreationAttempts.test.ts` convention.
 *
 * Scope: validation + canonicalization + guard capture ONLY. No domain rows
 * are written by `prepareTaskPublication`; it is DORMANT — no production
 * origin routes through it yet. Phase 2 owns the prospective interceptor
 * transition; Phase 3 owns guard re-verify inside the publication tx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { tasks } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import { createTask } from "../repositories/taskCrud.js";
import * as taskQueries from "../repositories/taskQueries.js";
import {
  prepareTaskPublication,
  PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER,
  type PrepareTaskPublicationInput,
} from "../services/taskPublicationPreparation.js";
import type { AuditActorRef, AuditSource } from "@orcy/shared";

let habitatId: string;
let otherHabitatId: string;
let columnId: string;
let missionId: string;

const ACTOR: AuditActorRef = { type: "human", id: "user-1" };
const AUDIT_SOURCE: AuditSource = "rest_api";
const CAUSAL_CONTEXT = {
  root: { type: "request", id: "req-1" },
};

beforeEach(async () => {
  await initTestDb();
  const habitat = habitatRepo.createHabitat({ name: "Preparation Habitat" });
  habitatId = habitat.id;
  const otherHabitat = habitatRepo.createHabitat({ name: "Other Habitat" });
  otherHabitatId = otherHabitat.id;
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
    title: "target-mission",
    createdBy: "user-1",
  }).id;
});

afterEach(() => closeDb());

// ---------------------------------------------------------------------------
// Seeders / fixtures
// ---------------------------------------------------------------------------

/** Canonical preparation input; callers override individual fields. */
function baseInput(
  overrides: Partial<PrepareTaskPublicationInput> = {},
): PrepareTaskPublicationInput {
  return {
    habitatId,
    targetMissionId: missionId,
    title: "Prepared Task",
    description: "A canonical proposal.",
    priority: "high",
    labels: ["kernel"],
    requiredDomain: "backend",
    requiredCapabilities: ["typescript"],
    estimatedMinutes: 30,
    actor: ACTOR,
    auditSource: AUDIT_SOURCE,
    causalContext: CAUSAL_CONTEXT,
    initialEventAction: "created",
    ...overrides,
  };
}

/** Seeds a plain pending Task in the target mission and returns its id. */
function seedTask(title = "dep-task"): string {
  return createTask({ missionId, title, createdBy: "user-1" }).id;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("prepareTaskPublication — happy path", () => {
  it("allocates a prospective ID, canonicalizes, and captures a guard when the proposal is valid", () => {
    // FAILURE MODE: if any validation short-circuited to rejected_validation,
    // outcome would not be "prepared" and proposal/guard would be absent.
    const result = prepareTaskPublication(baseInput());

    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;

    const { proposal, guard } = result;

    // Prospective ID allocated (uuid shape, not the target mission id).
    expect(proposal.prospectiveTaskId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(proposal.prospectiveTaskId).not.toBe(missionId);

    // Canonicalization applied defaults + normalized inputs.
    expect(proposal.title).toBe("Prepared Task");
    expect(proposal.priority).toBe("high");
    expect(proposal.description).toBe("A canonical proposal.");
    expect(proposal.labels).toEqual(["kernel"]);
    expect(proposal.requestedAssigneeId).toBeNull();
    expect(proposal.cloneSourceTaskId).toBeNull();
    expect(proposal.initialEventAction).toBe("created");

    // Proposal EXCLUDES execution history — the load-bearing boundary.
    expect(proposal).not.toHaveProperty("status");
    expect(proposal).not.toHaveProperty("version");
    expect(proposal).not.toHaveProperty("createdAt");
    expect(proposal).not.toHaveProperty("order");

    // Guard captured the resolved Mission identity + version.
    const mission = missionRepo.getMissionById(missionId)!;
    expect(guard.missionId).toBe(missionId);
    expect(guard.missionVersion).toBe(mission.version);
    expect(guard.missionStatus).toBe("not_started");
    expect(guard.habitatId).toBe(habitatId);

    // Guard carries the enrollment fingerprint field (Phase-1 sentinel;
    // Phase 2 overwrites with the real fingerprint).
    expect(guard.interceptorEnrollmentFingerprint).toBe(PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER);
    expect(guard.dependencies).toEqual([]);
  });

  it("honors an explicit prospectiveTaskId override (deterministic identity for clone/batch)", () => {
    const fixedId = "11111111-1111-4111-8111-111111111111";
    const result = prepareTaskPublication(baseInput({ prospectiveTaskId: fixedId }));
    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;
    expect(result.proposal.prospectiveTaskId).toBe(fixedId);
  });
});

// ---------------------------------------------------------------------------
// Active-Mission rule (Technical Plan § "Active Mission and scope rules")
// ---------------------------------------------------------------------------

describe("prepareTaskPublication — active-Mission rule", () => {
  it("rejects a Mission in terminal status `done` with mission_inactive", () => {
    // FAILURE MODE: if the active-status check were missing, a done Mission
    // would be accepted for publication, violating the terminal-Mission rule.
    missionRepo.updateMission(missionId, { status: "done" });
    const result = prepareTaskPublication(baseInput());

    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors).toContainEqual({
      field: "targetMissionId",
      code: "mission_inactive",
      message: expect.any(String),
    });
  });

  it("rejects a Mission in terminal status `failed` with mission_inactive", () => {
    missionRepo.updateMission(missionId, { status: "failed" });
    const result = prepareTaskPublication(baseInput());

    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors.some((e) => e.code === "mission_inactive")).toBe(true);
  });

  it("rejects an archived Mission with mission_archived", () => {
    // FAILURE MODE: if archived state were ignored, an archived Mission would
    // accept new Tasks, breaking the archive invariant.
    missionRepo.updateMission(missionId, { isArchived: true });
    const result = prepareTaskPublication(baseInput());

    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors.some((e) => e.code === "mission_archived")).toBe(true);
  });

  it("rejects a Mission belonging to a different Habitat with cross_habitat_mission", () => {
    // FAILURE MODE: if the habitat-consistency check were missing, a Task
    // could be published into a Mission outside the authoritative Habitat.
    const crossMission = missionRepo.createMission({
      habitatId: otherHabitatId,
      columnId: columnRepo.createColumn({
        habitatId: otherHabitatId,
        name: "Other",
        order: 0,
        requiresClaim: false,
      }).id,
      title: "other-habitat-mission",
      createdBy: "user-1",
    }).id;

    const result = prepareTaskPublication(baseInput({ targetMissionId: crossMission }));

    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors.some((e) => e.code === "cross_habitat_mission")).toBe(true);
  });

  it("rejects a missing Mission with mission_not_found", () => {
    // FAILURE MODE: if existence were assumed, a dangling targetMissionId
    // would surface as a downstream null-deref instead of a typed rejection.
    const result = prepareTaskPublication(baseInput({ targetMissionId: "miss-nonexistent" }));

    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors.some((e) => e.code === "mission_not_found")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multiple-errors collection (Technical Plan § "Validation phases")
// ---------------------------------------------------------------------------

describe("prepareTaskPublication — error collection", () => {
  it("returns ALL actionable field errors together (not first-only)", () => {
    // FAILURE MODE: if validation short-circuited on the first defect, only
    // one error would be returned and the caller could not surface every
    // correctable field in one round-trip.
    const result = prepareTaskPublication(
      baseInput({
        title: "   ", // missing_title
        priority: "urgent" as never, // invalid_priority
        requiredCapabilities: "not-an-array" as never, // invalid_required_capabilities_shape
        estimatedMinutes: -5, // invalid_estimated_minutes
      }),
    );

    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;

    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain("missing_title");
    expect(codes).toContain("invalid_priority");
    expect(codes).toContain("invalid_required_capabilities_shape");
    expect(codes).toContain("invalid_estimated_minutes");
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });

  it("collects field errors AND scope errors in the same result", () => {
    // FAILURE MODE: if scope checks ran only after clean field validation,
    // a mission_not_found would mask the missing_title, forcing two round-trips.
    const result = prepareTaskPublication(
      baseInput({
        title: "", // missing_title
        targetMissionId: "miss-nonexistent", // mission_not_found
      }),
    );

    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain("missing_title");
    expect(codes).toContain("mission_not_found");
  });
});

// ---------------------------------------------------------------------------
// Repository-model rejection (Technical Plan § "Canonical Task proposal")
// ---------------------------------------------------------------------------

describe("prepareTaskPublication — repository-model rejection", () => {
  it("rejects input carrying an execution-history field (e.g. a repository Task model) with forbidden_execution_history_field", () => {
    // FAILURE MODE: if the preparation service stripped unknown fields instead
    // of rejecting them, a caller passing a full Task model would silently
    // establish forbidden execution state (status/version/timestamps).
    const repositoryTaskShape = baseInput({
      // Simulate a caller spreading a repository Task model into the input.
      ...({
        status: "pending",
        version: 1,
        createdAt: "2026-01-01T00:00:00Z",
        createdBy: "user-1",
        claimedAt: null,
      } as Partial<PrepareTaskPublicationInput>),
    });

    const result = prepareTaskPublication(repositoryTaskShape);

    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain("forbidden_execution_history_field");
    // Every offending field is named — not just the first.
    const forbiddenFields = result.errors
      .filter((e) => e.code === "forbidden_execution_history_field")
      .map((e) => e.field);
    expect(forbiddenFields).toEqual(
      expect.arrayContaining(["status", "version", "createdAt", "createdBy", "claimedAt"]),
    );
  });
});

// ---------------------------------------------------------------------------
// Dependency-graph integrity (Technical Plan § "Validation phases")
// ---------------------------------------------------------------------------

describe("prepareTaskPublication — dependency-graph integrity", () => {
  it("rejects a dangling dependency reference with dangling_dependency", () => {
    // FAILURE MODE: if existence were not checked, a non-existent depId would
    // later produce a FK violation or a guard snapshot referencing nothing.
    const result = prepareTaskPublication(
      baseInput({
        selectedDependencies: [{ dependsOnId: "task-nonexistent" }],
      }),
    );

    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors.some((e) => e.code === "dangling_dependency")).toBe(true);
  });

  it("rejects a self-dependency (the Phase-1 cycle-class rejection) with self_dependency", () => {
    // FAILURE MODE: for a brand-new prospective task with only outgoing edges,
    // a topological cycle is impossible — self-reference is the meaningful
    // cycle case. If unchecked, a caller could pin prospectiveTaskId == a
    // selected dep, creating a self-loop on commit.
    const fixedId = "22222222-2222-4222-8222-222222222222";
    const result = prepareTaskPublication(
      baseInput({
        prospectiveTaskId: fixedId,
        selectedDependencies: [{ dependsOnId: fixedId }],
      }),
    );

    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors.some((e) => e.code === "self_dependency")).toBe(true);
  });

  it("rejects duplicate selected dependencies with duplicate_dependency", () => {
    // FAILURE MODE: if dedup were not enforced, the same edge would be inserted
    // twice (or silently coalesced), masking a caller bug.
    const dep = seedTask();
    const result = prepareTaskPublication(
      baseInput({
        selectedDependencies: [{ dependsOnId: dep }, { dependsOnId: dep }],
      }),
    );

    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors.some((e) => e.code === "duplicate_dependency")).toBe(true);
  });

  it("rejects a cross-Habitat dependency with cross_habitat_dependency", () => {
    // FAILURE MODE: if scope were not enforced on selected deps, a Task could
    // depend on a Task in another Habitat, breaking the same-graph invariant
    // of taskDependencies.
    const otherColumn = columnRepo.createColumn({
      habitatId: otherHabitatId,
      name: "Other",
      order: 0,
      requiresClaim: false,
    });
    const otherMission = missionRepo.createMission({
      habitatId: otherHabitatId,
      columnId: otherColumn.id,
      title: "other-mission",
      createdBy: "user-1",
    }).id;
    const otherTask = createTask({
      missionId: otherMission,
      title: "cross-habitat-task",
      createdBy: "user-1",
    }).id;

    const result = prepareTaskPublication(
      baseInput({ selectedDependencies: [{ dependsOnId: otherTask }] }),
    );

    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors.some((e) => e.code === "cross_habitat_dependency")).toBe(true);
  });

  it("captures each depended-on task's id + version + status in the guard", () => {
    // FAILURE MODE: if the dependency snapshot were absent or incomplete,
    // Phase 3's re-verify could not detect a depended-on task changing
    // status/version between preparation and commit.
    const dep = seedTask("guard-snapshot-dep");
    const result = prepareTaskPublication(
      baseInput({ selectedDependencies: [{ dependsOnId: dep }] }),
    );

    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;

    const depTask = getDb().select().from(tasks).where(eq(tasks.id, dep)).get();
    expect(depTask).toBeDefined();

    expect(result.guard.dependencies).toEqual([
      {
        taskId: dep,
        version: depTask!.version,
        status: depTask!.status,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Guard staleness (Technical Plan § "Optimistic publication guard")
// ---------------------------------------------------------------------------

describe("prepareTaskPublication — guard captures mutable state for re-verify", () => {
  it("freezes missionVersion so a post-preparation Mission update would mismatch on re-verify", () => {
    // FAILURE MODE: if the guard captured a stale or constant version, Phase
    // 3's re-verify could not detect that the Mission advanced between
    // preparation and commit (e.g. status changed, or a concurrent edit
    // bumped the optimistic-lock version).
    const prepared = prepareTaskPublication(baseInput());
    expect(prepared.outcome).toBe("prepared");
    if (prepared.outcome !== "prepared") return;

    const capturedVersion = prepared.guard.missionVersion;

    // Advance the Mission (updateMission bumps version via `version + 1`).
    missionRepo.updateMission(missionId, { status: "in_progress" });

    const currentMission = missionRepo.getMissionById(missionId)!;
    expect(currentMission.version).toBe(capturedVersion + 1);
    expect(currentMission.status).toBe("in_progress");

    // The captured guard is now stale relative to live state — exactly the
    // mismatch Phase 3's re-verify must detect and roll back on.
    expect(capturedVersion).not.toBe(currentMission.version);
    expect(prepared.guard.missionStatus).not.toBe(currentMission.status);
  });

  it("freezes the depended-on task state so a status change would mismatch on re-verify", () => {
    const dep = seedTask();
    const prepared = prepareTaskPublication(
      baseInput({ selectedDependencies: [{ dependsOnId: dep }] }),
    );
    expect(prepared.outcome).toBe("prepared");
    if (prepared.outcome !== "prepared") return;

    const captured = prepared.guard.dependencies[0];
    expect(captured.status).toBe("pending");

    // Advance the depended-on task's lifecycle.
    getDb().update(tasks).set({ status: "done", version: 2 }).where(eq(tasks.id, dep)).run();

    // The captured snapshot is now stale — Phase 3 re-verify detects it.
    expect(captured.status).toBe("pending"); // unchanged snapshot
    expect(captured.version).toBe(1); // unchanged snapshot
  });
});

// ---------------------------------------------------------------------------
// T3B Phase R — cold-review remediation (R2 malformed-input + R3 one-snapshot).
// ---------------------------------------------------------------------------

describe("R2 — malformed input returns rejected_validation (validation decisions never throw)", () => {
  it("non-array selectedDependencies → rejected_validation (not a TypeError)", () => {
    // OLD code: `selectedDeps.map(...)` threw TypeError on a string because
    // `input.selectedDependencies ?? []` kept the truthy non-array. NEW code
    // normalizes to a safe array first and collects the shape error.
    const result = prepareTaskPublication(
      baseInput({ selectedDependencies: "not-an-array" as never }),
    );
    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors.some((e) => e.code === "invalid_selected_dependencies_shape")).toBe(true);
  });

  it("non-string description → rejected_validation (not a TypeError from .trim())", () => {
    const result = prepareTaskPublication(baseInput({ description: 12345 as never }));
    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors.some((e) => e.code === "invalid_description_shape")).toBe(true);
  });

  it("non-string requestedAssigneeId → rejected_validation", () => {
    const result = prepareTaskPublication(baseInput({ requestedAssigneeId: 42 as never }));
    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors.some((e) => e.code === "invalid_requested_assignee_shape")).toBe(true);
  });

  it("non-string subtask assigneeId → rejected_validation", () => {
    const result = prepareTaskPublication(
      baseInput({ subtasks: [{ title: "ok", assigneeId: false as never }] }),
    );
    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors.some((e) => e.code === "invalid_subtask_assignee_shape")).toBe(true);
  });
});

describe("R3 — guard captures the validated dependency snapshot from ONE read", () => {
  it("getTasksByIds is called exactly ONCE regardless of dep count (no per-dep guard re-read)", () => {
    const depA = seedTask("r3-dep-a");
    const depB = seedTask("r3-dep-b");
    const spy = vi.spyOn(taskQueries, "getTasksByIds");

    const result = prepareTaskPublication(
      baseInput({
        selectedDependencies: [{ dependsOnId: depA }, { dependsOnId: depB }],
      }),
    );
    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;

    // NEW: ONE getTasksByIds call (the validated snapshot reused for the guard).
    // OLD code: 1 (validation) + 2 (per-dep blind re-read in guard-build) = 3.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("the captured snapshot matches the validated rows (id + version + status), coherently", () => {
    const dep = seedTask("r3-snap");
    const result = prepareTaskPublication(
      baseInput({ selectedDependencies: [{ dependsOnId: dep }] }),
    );
    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;
    expect(result.guard.dependencies).toHaveLength(1);
    const snap = result.guard.dependencies[0];
    expect(snap.taskId).toBe(dep);
    const depRow = getDb().select().from(tasks).where(eq(tasks.id, dep)).get();
    expect(snap.version).toBe(depRow?.version);
    expect(snap.status).toBe(depRow?.status);
  });
});
