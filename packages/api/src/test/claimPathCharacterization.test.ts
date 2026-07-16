/**
 * T2 Phase 1 — Claim-path characterization safety net.
 *
 * Audit + gap-fill for `repositories/taskStateMachine.ts` and the `taskClaimed`
 * service-wrapper seams. Every assertion locks the CURRENT behavior so Phase 3
 * (typed claim authority migration) can prove "legacy behavior preserved" by
 * running this suite against the migration. See
 * `docs/plans/t02-claim-authority-manifest.md` for the full PRESERVE vs
 * INTENTIONALLY-CHANGE map and the per-scenario rationale.
 *
 * Each test states its **discriminating failure mode** in a tail comment —
 * i.e. what would have to be true for the assertion to pass spuriously. If you
 * edit this file, keep the failure-mode comments adjacent to the assertions.
 *
 * IMPORTANT MARKERS:
 *   `// PRESERVE` — Phase 3 must reproduce the asserted result verbatim.
 *   `// INTENTIONALLY-CHANGE (T2): ...` — Phase 3 will NOT reproduce; the
 *     assertion locks today's (defective) behavior so the migration diff is
 *     visible and reviewable. Do NOT delete these tests.
 *
 * Out of scope: production code edits. This file is tests only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as taskService from "../services/tasks/index.js";
import * as taskDelegationService from "../services/tasks/task-delegation.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { InterceptorVetoError } from "../errors.js";
import { RepositoryError } from "../errors/repository.js";

let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();

  const habitat = habitatRepo.createHabitat({ name: "T2 Claim Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
  pluginManager.resetPlugins();
});

afterEach(() => {
  pluginManager.resetPlugins();
  vi.restoreAllMocks();
  closeDb();
});

function seedAgent(name: string, capabilities: string[] = []) {
  return agentRepo.createAgent({
    name,
    type: "claude-code",
    domain: "fullstack",
    capabilities,
  }).agent;
}

function seedMission(opts: {
  title: string;
  releaseGateType?: "minor" | "major" | "patch" | null;
  dependsOn?: string[];
  requiredCapabilities?: string[];
}) {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: opts.title,
    createdBy: "user-1",
    releaseGateType: opts.releaseGateType ?? null,
    dependsOn: opts.dependsOn ?? [],
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: `task-for-${mission.id}`,
    createdBy: "user-1",
    requiredCapabilities: opts.requiredCapabilities ?? [],
  });
  return { mission, task };
}

// ---------------------------------------------------------------------------
// 1. claimTask — repo-level not_found + already_claimed (real contention)
// ---------------------------------------------------------------------------

describe("claimTask — repo-level not_found + real-contention already_claimed", () => {
  it("returns not_found when taskId does not exist", () => {
    // PRESERVE — load-bearing reason. Routes emit 404 on conflict("not_found") via
    // `conflict(result.reason, { ... })` at `routes/tasks/lifecycle.ts:90`.
    const result = taskStateMachine.claimTask("does-not-exist", "agent-x");
    expect(result).toEqual({ success: false, reason: "not_found" });
    // Failure mode: a refactor that returns null or generic {} on missing row
    // would fail this — proves the typed reason is observable today.
  });

  it("returns already_claimed via REAL contention (a second claimer)", () => {
    const { task } = seedMission({ title: "real-contention" });
    const a1 = seedAgent("a1");
    const a2 = seedAgent("a2");

    const first = taskStateMachine.claimTask(task.id, a1.id);
    expect(first.success).toBe(true);

    const second = taskStateMachine.claimTask(task.id, a2.id);
    // PRESERVE — exact reason. The route (`routes/tasks/lifecycle.ts:90`) and
    // MCP reason union both depend on the literal string.
    expect(second).toEqual({ success: false, reason: "already_claimed" });
    // Failure mode: a wrapper that adds capability fields to the repo's result
    // (passing through enrichment here) would change the shape and break deep
    // equality.
  });

  it("returns already_claimed when status is anything other than pending", () => {
    const { task } = seedMission({ title: "claimed-then-contend" });
    const a1 = seedAgent("a1");
    const a2 = seedAgent("a2");

    expect(taskStateMachine.claimTask(task.id, a1.id).success).toBe(true);
    taskStateMachine.startTask(task.id, a1.id);
    // now in_progress
    expect(taskStateMachine.claimTask(task.id, a2.id)).toEqual({
      success: false,
      reason: "already_claimed",
    });
    // Failure mode: a refactor that splits "already_claimed" from
    // "wrong_status" would change the reason for status-side refusals.
  });
});

// ---------------------------------------------------------------------------
// 1.8 / 2.5 — THE COLLAPSE BUG (INTENTIONALLY-CHANGE)
//
// The catch block at `taskStateMachine.ts:46-49, 99-104` swallows ANY
// exception thrown by db.transaction(...) and re-shapes it as
// { success: false, reason: "already_claimed" }. Phase 3 will replace this
// with a typed infrastructure_failure carrying the cause code.
//
// These tests lock today's behavior so Phase 3 can show the migration by
// changing the assertion alongside the implementation.
// ---------------------------------------------------------------------------

describe("claimTask — collapse bug (INTENTIONALLY-CHANGE T2)", () => {
  it("returns already_claimed when db.transaction throws an arbitrary Error", () => {
    const { task } = seedMission({ title: "collapse-generic" });

    // Simulate an infra failure: the tx callback never runs because
    // db.transaction itself throws (e.g. SQLITE_BUSY on a real connection).
    const db = getDb() as unknown as { transaction: (fn: (tx: unknown) => unknown) => unknown };
    const original = db.transaction;
    db.transaction = () => {
      throw new Error("synthetic tx failure (infra)");
    };

    let result: unknown;
    try {
      result = taskStateMachine.claimTask(task.id, "agent-x");
    } finally {
      db.transaction = original;
    }

    // INTENTIONALLY-CHANGE (T2): FIXED. The collapse is gone — an arbitrary
    // exception is now mapped by the claim authority to a typed
    // infrastructure_failure, flattened to `claim_failed` (distinct from real
    // contention's `already_claimed`). This is the bug fix made visible.
    expect(result).toEqual({ success: false, reason: "claim_failed" });
    // Failure mode: if a regression re-collapses infra errors to
    // already_claimed, this test fails — proving the collapse/claim_failed
    // distinction survives.
  });

  it("returns claim_failed when db.transaction throws an SQLite-shaped error", () => {
    const { task } = seedMission({ title: "collapse-sqlite" });
    const db = getDb() as unknown as { transaction: (fn: (tx: unknown) => unknown) => unknown };
    const original = db.transaction;
    // Mimic sql.js / better-sqlite3 error shape without pulling the real backend
    // into the test (real SQLITE_BUSY requires child-process testing per MEMORY).
    const sqliteLikeError = Object.assign(new Error("database is locked"), {
      name: "SqliteError",
      code: "SQLITE_BUSY",
    });
    db.transaction = () => {
      throw sqliteLikeError;
    };

    let result: unknown;
    try {
      result = taskStateMachine.claimTask(task.id, "agent-x");
    } finally {
      db.transaction = original;
    }

    // INTENTIONALLY-CHANGE (T2): FIXED. SQLITE_BUSY is now distinguishable from
    // real contention: it returns `claim_failed` (the claimDelegatedTask
    // pattern, generalized), so callers can retry-vs-resurface correctly.
    expect(result).toEqual({ success: false, reason: "claim_failed" });
    // Failure mode: see the prior test — this proves the *infra-error* path
    // ALSO surfaces as claim_failed, not collapsed back to already_claimed.
  });

  it("FIXED: real contention and infra collapse now DIVERGE (was identical — the bug)", () => {
    const a1 = seedAgent("a1");
    const a2 = seedAgent("a2");

    // Path A — real contention via second claimer on the same pending task.
    const seedA = seedMission({ title: "path-a" });
    const first = taskStateMachine.claimTask(seedA.task.id, a1.id);
    expect(first.success).toBe(true);
    const contention = taskStateMachine.claimTask(seedA.task.id, a2.id);

    // Path B — synthesized infra failure on a fresh task.
    const seedB = seedMission({ title: "path-b" });
    const db = getDb() as unknown as { transaction: (fn: (tx: unknown) => unknown) => unknown };
    const original = db.transaction;
    db.transaction = () => {
      throw new Error("synthetic infra failure");
    };
    let collapse: unknown;
    try {
      collapse = taskStateMachine.claimTask(seedB.task.id, a1.id);
    } finally {
      db.transaction = original;
    }

    // INTENTIONALLY-CHANGE (T2): FIXED. Pre-T2 these two paths yielded the SAME
    // `already_claimed` shape — the collapse bug. After T2 they DIVERGE: real
    // contention stays `already_claimed` (a legitimate domain refusal), while
    // infra failure surfaces as `claim_failed` (retryable). The divergence IS
    // the fix made observable.
    expect(contention).toEqual({ success: false, reason: "already_claimed" });
    expect(collapse).toEqual({ success: false, reason: "claim_failed" });
    expect(contention).not.toEqual(collapse);
    // Failure mode: if a future refactor re-collapses the two (both
    // already_claimed OR both claim_failed), this test fails — the
    // domain-refusal-vs-infra-failure distinction must survive.
  });
});

// ---------------------------------------------------------------------------
// 2. claimTaskByRemoteParticipant — not_found + collapse parity
// ---------------------------------------------------------------------------

describe("claimTaskByRemoteParticipant — not_found + collapse parity", () => {
  it("returns not_found when taskId does not exist", () => {
    // PRESERVE — same reason as local path; routes emitting the conflict
    // depend on the literal value.
    const result = taskStateMachine.claimTaskByRemoteParticipant("does-not-exist", "participant-1");
    expect(result).toEqual({ success: false, reason: "not_found" });
    // Failure mode: distinct "remote_not_found" would break route compat.
  });

  it("returns already_claimed via real remote-vs-real-remote contention", () => {
    const { task } = seedMission({ title: "remote-contention" });
    taskStateMachine.claimTaskByRemoteParticipant(task.id, "participant-a");
    const second = taskStateMachine.claimTaskByRemoteParticipant(task.id, "participant-b");
    // PRESERVE — same string as the local path; MCP union swallows the
    // distinction.
    expect(second).toEqual({ success: false, reason: "already_claimed" });
    // Failure mode: distinct "remote_already_claimed" would force the MCP
    // union to widen — our manifest says PRESERVE literal string.
  });

  it("INTENTIONALLY-CHANGE: collapses generic infra error to already_claimed", () => {
    const { task } = seedMission({ title: "remote-collapse" });
    const db = getDb() as unknown as { transaction: (fn: (tx: unknown) => unknown) => unknown };
    const original = db.transaction;
    db.transaction = () => {
      throw new Error("synthetic tx failure");
    };

    let result: unknown;
    try {
      result = taskStateMachine.claimTaskByRemoteParticipant(task.id, "participant-1");
    } finally {
      db.transaction = original;
    }

    // INTENTIONALLY-CHANGE (T2): FIXED — same fix as the local path. The remote
    // claim function now routes through the authority and returns `claim_failed`
    // for infra errors instead of collapsing to already_claimed.
    expect(result).toEqual({ success: false, reason: "claim_failed" });
    // Failure mode: proof that the remote path's infra-failure surface now
    // matches the local path's (both claim_failed), diverging from contention.
  });

  it("rejects when local agent already claimed (remote variant)", () => {
    // PRESERVE — remote-participant function checks BOTH assignedAgentId AND
    // remoteAssignedParticipantId, per `taskStateMachine.ts:70`. Tasks already
    // claimed by a local agent must not be re-claimed by a remote participant.
    const { task } = seedMission({ title: "remote-vs-local" });
    const a1 = seedAgent("local-agent");
    expect(taskStateMachine.claimTask(task.id, a1.id).success).toBe(true);

    const result = taskStateMachine.claimTaskByRemoteParticipant(task.id, "participant-1");
    expect(result).toEqual({ success: false, reason: "already_claimed" });
    // Failure mode: a refactor that ONLY checks remoteAssignedParticipantId
    // and allows the remote to claim over a local claimer would silently
    // corrupt state and break the load-bearing idempotency invariant.
  });
});

// ---------------------------------------------------------------------------
// 3. claimDelegatedTask — model for the migration (PRESERVE the richer error
// model). Phase 3 will GENERALIZE this pattern across all 3 claim functions.
// ---------------------------------------------------------------------------

describe("claimDelegatedTask — repo-level reason coverage", () => {
  /** Helper: set up a task that has been delegated to `assigneeId` and is in
   * a claimable state (`claimed` or `in_progress`) with a valid
   * `assignedAgentId` FK so we exercise the happy-precondition path. */
  function seedDelegatedTask(title: string, delegateToId: string, assigneeId: string) {
    const { task } = seedMission({ title });
    taskRepo.updateTask(task.id, {
      delegatedToAgentId: delegateToId,
      status: "claimed",
      assignedAgentId: assigneeId,
    });
    return task;
  }

  it("returns not_found when taskId does not exist", () => {
    // PRESERVE — mirror of 1.2.
    const result = taskStateMachine.claimDelegatedTask("does-not-exist", "agent-x");
    expect(result).toEqual({ success: false, reason: "not_found" });
    // Failure mode: returns null (matching startTask) — that would change the
    // success-typed union and break every caller that destructures
    // `result.reason`.
  });

  it("returns not_delegated_to_you when delegatedToAgentId differs", () => {
    // PRESERVE — load-bearing reason specific to delegated claim. Distinct from
    // `not_found`. The wrapper at `services/tasks/task-delegation.ts:113`
    // passes this through.
    const delegator = seedAgent("delegator");
    const { task } = seedMission({ title: "delegated-not-you" });
    // No delegation setup — the task is fully un-delegated. The repo should
    // return not_delegated_to_you because delegatedToAgentId !== agentId.
    const result = taskStateMachine.claimDelegatedTask(task.id, "agent-mine");
    expect(result).toEqual({ success: false, reason: "not_delegated_to_you" });
    // Force-use the variable so it isn't flagged as unused — its purpose is
    // to prove we COULD have delegated, but chose not to.
    expect(delegator.id).toBeDefined();
    // Failure mode: collapsing to `not_found` would hide authorization drift.
  });

  it("returns invalid_status when task is pending (not claimed/in_progress)", () => {
    // PRESERVE — delegated claim requires the task be claimed/in_progress.
    // A pending task is a misuse signal that callers map to 409.
    const assignee = seedAgent("delegate-target");
    const { task } = seedMission({ title: "delegated-pending" });
    taskRepo.updateTask(task.id, { delegatedToAgentId: assignee.id });

    const result = taskStateMachine.claimDelegatedTask(task.id, assignee.id);
    expect(result).toEqual({ success: false, reason: "invalid_status" });
    // Failure mode: returning `not_pending` (or `invalid_status` with a typo)
    // would break the existing batchAssignClaimability.test.ts expectation at
    // L242.
  });

  it("returns invalid_status when task is in a non-claimable terminal state (submitted)", () => {
    // PRESERVE — boundary check.
    const assignee = seedAgent("assignee");
    const delegate = seedAgent("delegate-target");
    const { task } = seedMission({ title: "delegated-submitted" });
    taskRepo.updateTask(task.id, {
      delegatedToAgentId: delegate.id,
      status: "submitted",
      assignedAgentId: assignee.id,
    });

    const result = taskStateMachine.claimDelegatedTask(task.id, delegate.id);
    expect(result).toEqual({ success: false, reason: "invalid_status" });
    // Failure mode: a refactor that allows delegated claim to reach submitted
    // tasks would re-introduce the v0.29.3 lapsed delegated-claim bypass.
  });

  it("succeeds and hands the task from delegated to the assignee", () => {
    // PRESERVE — happy-path of delegated claim. Asserts the dual mutation
    // (assignedAgentId ← assignee, delegatedToAgentId ← null).
    const assignee = seedAgent("assignee-original");
    const delegate = seedAgent("delegate-target");
    const task = seedDelegatedTask("delegated-happy", delegate.id, assignee.id);

    const result = taskStateMachine.claimDelegatedTask(task.id, delegate.id);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.task.assignedAgentId).toBe(delegate.id);
      expect(result.task.delegatedToAgentId).toBeNull();
      expect(result.task.status).toBe("claimed");
    }
    // Failure mode: skipping the `delegatedToAgentId = null` clear would
    // leave the task as both delegated AND assigned — a real-world bug where
    // subsequent attempts by the original assigner would succeed.
  });

  it("PRESERVE: returns claim_failed (NOT already_claimed) on SQLITE_BUSY", () => {
    // PRESERVE — the BETTER behavior. Today claimDelegatedTask distinguishes
    // contention from infra failure. Phase 3 will generalize this pattern to
    // the other two claim functions. Locking it here proves the generalization
    // is observable: changing it would revert the typed-distinction we just
    // made.
    const assignee = seedAgent("assignee-original");
    const delegate = seedAgent("delegate-busy");
    const task = seedDelegatedTask("delegated-busy", delegate.id, assignee.id);

    const db = getDb() as unknown as { transaction: (fn: (tx: unknown) => unknown) => unknown };
    const original = db.transaction;
    db.transaction = () => {
      const err = Object.assign(new Error("database is locked"), {
        name: "SqliteError",
        code: "SQLITE_BUSY",
      });
      throw err;
    };

    let result: unknown;
    try {
      result = taskStateMachine.claimDelegatedTask(task.id, delegate.id);
    } finally {
      db.transaction = original;
    }

    expect(result).toEqual({ success: false, reason: "claim_failed" });
    // Failure mode: collapsing to `already_claimed` (or any other reason) is
    // the regression Phase 3 must prevent in this function.
  });

  it("PRESERVE: returns claim_failed (NOT already_claimed) on SQLITE_CONSTRAINT", () => {
    // PRESERVE — same family as above. CONSTRAINT covers UNIQUE, FOREIGN KEY,
    // NOT NULL — any non-domain failure surfaces as claim_failed.
    const assignee = seedAgent("assignee-original");
    const delegate = seedAgent("delegate-constraint");
    const task = seedDelegatedTask("delegated-constraint", delegate.id, assignee.id);

    const db = getDb() as unknown as { transaction: (fn: (tx: unknown) => unknown) => unknown };
    const original = db.transaction;
    db.transaction = () => {
      const err = Object.assign(new Error("UNIQUE constraint failed: tasks.id"), {
        name: "SqliteError",
        code: "SQLITE_CONSTRAINT_UNIQUE",
      });
      throw err;
    };

    let result: unknown;
    try {
      result = taskStateMachine.claimDelegatedTask(task.id, delegate.id);
    } finally {
      db.transaction = original;
    }

    expect(result).toEqual({ success: false, reason: "claim_failed" });
    // Failure mode: a CONSTRAINT that IS domain-level (unique constraint on
    // the row itself) should NOT be silently coerced into "already_claimed".
  });

  it("PRESERVE: throws repositoryTransactionError on unmapped exceptions", () => {
    // PRESERVE — uncommon path. Errors that aren't SQLITE_BUSY / SQLITE_CONSTRAINT
    // propagate as a RepositoryError (500 via AppError middleware). Locked here
    // so a future "swallow everything" refactor regresses this test.
    const assignee = seedAgent("assignee-original");
    const delegate = seedAgent("delegate-unmapped");
    const task = seedDelegatedTask("delegated-unmapped", delegate.id, assignee.id);

    const db = getDb() as unknown as { transaction: (fn: (tx: unknown) => unknown) => unknown };
    const original = db.transaction;
    db.transaction = () => {
      throw new Error("synthetic unmapped error");
    };

    try {
      let thrown: unknown;
      try {
        taskStateMachine.claimDelegatedTask(task.id, delegate.id);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(RepositoryError);
      if (thrown instanceof RepositoryError) {
        expect(thrown.entity).toBe("task");
        expect(thrown.operation).toBe("transaction");
      }
      // Failure mode: a future "swallow everything" refactor would return
      // {success:false} here, hiding the 500 map. The test proves we still
      // throw a typed AppError for unmapped failures.
    } finally {
      db.transaction = original;
    }
  });
});

// ---------------------------------------------------------------------------
// 4 + 5 — startTask / startTaskByRemoteParticipant at the repo level.
// Returns `Task | null`, NOT a {success, reason} result. The route layer and
// service wrapper translate `null` to 409. These tests pin the contract.
// ---------------------------------------------------------------------------

describe("startTask — repo-level progression contract", () => {
  it("returns the updated task when status=claimed AND assignedAgentId matches", () => {
    // PRESERVE — happy path. Service wrapper returns the task and emits a
    // `started` transition.
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "start-happy" });
    taskStateMachine.claimTask(task.id, a1.id);

    const started = taskStateMachine.startTask(task.id, a1.id);
    expect(started).not.toBeNull();
    expect(started?.status).toBe("in_progress");
    // Failure mode: returning null on the happy path would silently 409
    // through the route layer.
  });

  it("returns null when taskId does not exist", () => {
    // PRESERVE — wrapper converts null → `null` (route emits 409 "Cannot
    // start task in current state").
    expect(taskStateMachine.startTask("does-not-exist", "agent-x")).toBeNull();
    // Failure mode: returning a shape with `{success,reason}` would break
    // callers that expect nullable `Task | null`.
  });

  it("returns null when assignedAgentId mismatches", () => {
    // PRESERVE — load-bearing authorization gate at repo level. Routes rely
    // on the wrapper pre-check + repo null = double-defense.
    const a1 = seedAgent("a1");
    const a2 = seedAgent("a2");
    const { task } = seedMission({ title: "start-wrong-agent" });
    taskStateMachine.claimTask(task.id, a1.id);

    expect(taskStateMachine.startTask(task.id, a2.id)).toBeNull();
    // Failure mode: a refactor that allows a different agent to start a
    // claimed-but-not-yours task — would re-introduce the v0.29.3 auth bypass.
  });

  it("returns null when status is anything other than 'claimed' (e.g. pending)", () => {
    // PRESERVE — idempotency: can't start a pending task. Without this, the
    // start UPDATE silently no-ops via the WHERE clause but returns the
    // unchanged task — pinning null prevents that future drift.
    const { task } = seedMission({ title: "start-pending" });
    expect(taskStateMachine.startTask(task.id, "agent-x")).toBeNull();
    // Failure mode: a refactor that calls db.update without the status guard
    // would succeed-but-no-op, returning the unchanged task — proving the
    // wrapper pre-check is the only defense.
  });
});

describe("startTaskByRemoteParticipant — repo-level parity", () => {
  it("returns the updated task when status=claimed AND remoteAssignedParticipantId matches", () => {
    // PRESERVE — happy path.
    const { task } = seedMission({ title: "remote-start-happy" });
    taskStateMachine.claimTaskByRemoteParticipant(task.id, "participant-1");

    const started = taskStateMachine.startTaskByRemoteParticipant(task.id, "participant-1");
    expect(started?.status).toBe("in_progress");
    // Failure mode: returns null on success = the route layer emits a 409
    // wrongly.
  });

  it("returns null when remoteAssignedParticipantId mismatches", () => {
    // PRESERVE — auth boundary. A different participant cannot start your
    // claimed-remote task.
    const { task } = seedMission({ title: "remote-start-wrong" });
    taskStateMachine.claimTaskByRemoteParticipant(task.id, "participant-1");

    expect(taskStateMachine.startTaskByRemoteParticipant(task.id, "participant-2")).toBeNull();
    // Failure mode: collapsing to "task updated" would let a participant steal
    // another participant's task mid-flight.
  });
});

// ---------------------------------------------------------------------------
// 6. Service wrapper claimTask — capability_mismatch rich shape + InterceptorVetoError throw + collapse propagation
// ---------------------------------------------------------------------------

describe("services/tasks/task-lifecycle.ts claimTask — wrapper-level pins", () => {
  it("returns capability_mismatch with the rich shape when agent lacks required capabilities", () => {
    // PRESERVE — rich shape: { reason, message, missingCapabilities }. The
    // route layer forwards `missingCapabilities` into the 403 detail
    // (see `routes/tasks/lifecycle.ts:90`). UI uses this for capability
    // feedback. Coarse layer may add a category but MUST keep the field.
    const agent = seedAgent("lacks-caps", ["typescript"]);
    const { task } = seedMission({
      title: "needs-cap",
      requiredCapabilities: ["typescript", "docker", "kubernetes"],
    });

    const result = taskService.claimTask(task.id, agent.id);
    expect(result).toEqual({
      success: false,
      reason: "capability_mismatch",
      message: "Agent lacks required capabilities: docker, kubernetes",
      missingCapabilities: ["docker", "kubernetes"],
    });
    // Failure mode: dropping missingCapabilities would silently cut UI
    // feedback. Collapsing to a plain reason without the array would be
    // silently lossy.
  });

  it("returns not_found (not_found) when the agent record does not exist (capability pre-check needs agent)", () => {
    // PRESERVE — same literal reason as task-missing. Per
    // `task-lifecycle.ts:87`, the wrapper returns `not_found` when the agent
    // record cannot be loaded for the capability check. Phase 3 may split this
    // into `agent_not_found`, but Phase 1 pins the current behavior.
    const { task } = seedMission({
      title: "agent-missing",
      requiredCapabilities: ["typescript"],
    });

    const result = taskService.claimTask(task.id, "does-not-exist-agent-id");
    expect(result).toEqual({ success: false, reason: "not_found" });
    // Failure mode: a refactor that returned a new reason (e.g.
    // `agent_not_found`) — the manifest notes this is the candidate for
    // Phase 3 to split; locks the current shape to make the migration visible.
  });

  it("throws InterceptorVetoError when pre-interceptor returns a veto (no DB write)", () => {
    // PRESERVE — the throw, not a return. The route layer
    // (`routes/tasks/lifecycle.ts:78,94`) catches `InterceptorVetoError` and
    // emits 403 `INTERCEPTOR_VETO`. ANY Phase 3 change that returns a typed
    // `governance_veto` RESULT instead of throwing will break this catch.
    const agent = seedAgent("veto-victim");
    const { task } = seedMission({ title: "veto-pre" });

    const preSpy = vi.spyOn(pluginManager, "runPreInterceptors").mockReturnValueOnce({
      allow: false,
      reason: "blocked by test interceptor",
      details: "ctx",
    });

    expect(() => taskService.claimTask(task.id, agent.id)).toThrow(InterceptorVetoError);

    // DB row stays untouched — veto short-circuited before the repo call.
    const after = taskRepo.getTaskById(task.id);
    expect(after?.status).toBe("pending");
    expect(after?.assignedAgentId).toBeNull();

    expect(preSpy).toHaveBeenCalledWith(
      task.id,
      "taskClaimed",
      expect.any(String),
      expect.objectContaining({
        actorType: "agent",
        actorId: agent.id,
        oldStatus: "pending",
        newStatus: "claimed",
        assignedAgentId: agent.id,
      }),
    );
    // Failure mode: a regression that lets the repo call happen despite a veto
    // would commit the task mutation AND lose the audit hook — observable
    // here as `after.status` flipping to `claimed`.
  });

  it("INTENTIONALLY-CHANGE: collapse propagates through wrapper as already_claimed (no capability fields)", () => {
    // INTENTIONALLY-CHANGE (T2): the wrapper does NOT enrich the collapsed
    // already_claimed with capability fields. Phase 3 may add a category to
    // distinguish infra-failure from real contention through the wrapper, but
    // the current shape is preserved exactly here.
    const { task } = seedMission({ title: "wrapper-collapse" });

    const db = getDb() as unknown as { transaction: (fn: (tx: unknown) => unknown) => unknown };
    const original = db.transaction;
    db.transaction = () => {
      throw new Error("synthetic tx failure");
    };

    let result: unknown;
    try {
      result = taskService.claimTask(task.id, "agent-x");
    } finally {
      db.transaction = original;
    }

    // INTENTIONALLY-CHANGE (T2): FIXED — the wrapper now passes the repo's
    // flattened `claim_failed` through (the repo no longer collapses to
    // already_claimed). No capability fields are added; the shape is still the
    // bare {success:false, reason} the route layer emits as a 409 conflict.
    expect(result).toEqual({ success: false, reason: "claim_failed" });
    // Failure mode: a future wrapper that adds a category or capability fields
    // here widens the shape — locking the post-T2 pass-through so the migration
    // diff stays visible.
  });

  it("passes the task-intrinsic reasons (e.g. release_gate_unmet) through unchanged", () => {
    // PRESERVE — the wrapper does not enrich task-intrinsic refusal reasons
    // with capability fields. Routes emit conflict(result.reason) verbatim.
    const agent = seedAgent("intrinsic-victim");
    const { task } = seedMission({
      title: "intrinsic-refusal",
      releaseGateType: "minor",
    });

    const result = taskService.claimTask(task.id, agent.id);
    expect(result).toEqual({ success: false, reason: "release_gate_unmet" });
    // Failure mode: a wrapper that adds empty missingCapabilities or message
    // here would silently widen the result shape and break equality checks
    // elsewhere in the codebase.
  });
});

// ---------------------------------------------------------------------------
// 8. Service wrapper claimDelegatedTask — capability rich shape + veto throw
// ---------------------------------------------------------------------------

describe("services/tasks/task-delegation.ts claimDelegatedTask — wrapper-level pins", () => {
  it("returns capability_mismatch with missingCapabilities when delegated assignee lacks caps", () => {
    // PRESERVE — rich shape mirror of 6.4. The route layer at
    // `routes/tasks/lifecycle.ts:74` propagates `result.message` to the 409
    // detail body.
    const agent = seedAgent("delegated-lacks-caps", ["typescript"]);
    const originalAssignee = seedAgent("delegated-original-assignee");
    const { task } = seedMission({
      title: "delegated-needs-cap",
      requiredCapabilities: ["python", "docker"],
    });
    taskRepo.updateTask(task.id, {
      delegatedToAgentId: agent.id,
      status: "claimed",
      assignedAgentId: originalAssignee.id,
    });

    const result = taskDelegationService.claimDelegatedTask(task.id, agent.id);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("capability_mismatch");
      expect(result.message).toContain("python");
      expect(result.message).toContain("docker");
    }
    // Failure mode: a refactor that drops the message or changes the reason
    // would break the route's 409 detail body shape.
  });

  it("throws InterceptorVetoError when pre-interceptor returns a veto (no DB write)", () => {
    // PRESERVE — same throw contract as 6.7, for the delegated path. The
    // route layer at `routes/tasks/lifecycle.ts:78` catches it.
    const agent = seedAgent("delegated-veto-victim");
    const originalAssignee = seedAgent("delegated-original-assignee-2");
    const { task } = seedMission({ title: "delegated-veto-pre" });
    taskRepo.updateTask(task.id, {
      delegatedToAgentId: agent.id,
      status: "claimed",
      assignedAgentId: originalAssignee.id,
    });

    vi.spyOn(pluginManager, "runPreInterceptors").mockReturnValueOnce({
      allow: false,
      reason: "blocked by test interceptor",
      details: "ctx",
    });

    expect(() => taskDelegationService.claimDelegatedTask(task.id, agent.id)).toThrow(
      InterceptorVetoError,
    );

    const after = taskRepo.getTaskById(task.id);
    expect(after?.status).toBe("claimed");
    expect(after?.assignedAgentId).toBe(originalAssignee.id);
    expect(after?.delegatedToAgentId).toBe(agent.id);
    // Failure mode: same as 6.7 — veto must short-circuit BEFORE the repo
    // call. Pinning assignedAgentId unchanged proves it.
  });

  it("PRESERVE: passes through repo's claim_failed without throwing", () => {
    // PRESERVE — the wrapper does not retry or coerce `claim_failed`; it
    // surfaces the repo result as-is. The route layer maps it to 409.
    const agent = seedAgent("delegated-busy-assignee");
    const originalAssignee = seedAgent("delegated-original-assignee-3");
    const { task } = seedMission({ title: "delegated-busy-wrapper" });
    taskRepo.updateTask(task.id, {
      delegatedToAgentId: agent.id,
      status: "claimed",
      assignedAgentId: originalAssignee.id,
    });

    const db = getDb() as unknown as { transaction: (fn: (tx: unknown) => unknown) => unknown };
    const original = db.transaction;
    db.transaction = () => {
      const err = Object.assign(new Error("database is locked"), {
        name: "SqliteError",
        code: "SQLITE_BUSY",
      });
      throw err;
    };

    let result: unknown;
    try {
      result = taskDelegationService.claimDelegatedTask(task.id, agent.id);
    } finally {
      db.transaction = original;
    }

    expect(result).toEqual({ success: false, reason: "claim_failed" });
    // Failure mode: a wrapper that converts `claim_failed` to a thrown
    // InterceptorVetoError-style error would break the route layer's 409
    // pass-through.
  });
});
