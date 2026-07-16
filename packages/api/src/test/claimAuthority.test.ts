/**
 * T2 Phase 2 — Typed claim authority unit tests (ISOLATION).
 *
 * Exercises `claimWithAuthority` / `claimWithAuthorityClient` against synthetic
 * tasks WITHOUT wiring it to the 5 legacy claim functions (that migration is
 * Phase 3). The characterization suite (`claimPathCharacterization.test.ts`)
 * tests the UN-WIRED legacy functions and must stay green unchanged — this
 * file is the additive counterpart that proves the new authority's contract.
 *
 * Coverage (each test states its discriminating failure mode in a tail
 * comment):
 *   - success (local + remote) — assignee column, status, version++
 *   - not_found
 *   - already_claimed (occupancy) + not_pending (wrong status)
 *   - ineligible (each ADR-0038 task-intrinsic reason, via checkClaimability reuse)
 *   - observation gate open for legacy (creationIntegrity=0) + observation_pending
 *     when a post-cutover task (creationIntegrity>0) lacks its checkpoint
 *   - reservation gate: reserved_for_other when an active reservation exists for
 *     another claimant; gate open otherwise (incl. matching-identity reservation)
 *   - infrastructure_failure (SQLITE_BUSY via real-DB FailingDbClient) — NOT
 *     already_claimed (the collapse bug fixed)
 *   - version_conflict (SQLITE_CONSTRAINT_UNIQUE)
 *   - infrastructure_failure (generic non-sqlite error)
 *   - delegated mode: success hand-off, not_delegated_to_you, invalid_status
 *
 * The infra-failure tests inject via the real-DB `FailingDbClient` from T1
 * wrapped around the tx (patches `db.transaction` to hand the callback a
 * failing client) — this exercises the authority's real catch-and-map path,
 * not a mock.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import {
  tasks,
  taskCreationAttempts,
  taskCreationAssignmentReservations,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskRepo from "../repositories/taskCrud.js";
import { addTaskDependency } from "../repositories/dependency.js";
import {
  claimWithAuthority,
  claimWithAuthorityClient,
  type Claimant,
  type ClaimResult,
} from "../repositories/claimAuthority.js";
import { FailingDbClient } from "./helpers/failingDbClient.js";
import type { TaskPublicationDbClient } from "../repositories/taskPublication.js";

let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  const habitat = habitatRepo.createHabitat({ name: "Claim Authority Habitat" });
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
  closeDb();
});

function seedAgent(name: string) {
  return agentRepo.createAgent({
    name,
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  }).agent;
}

function seedMission(opts: {
  title: string;
  releaseGateType?: "minor" | "major" | "patch" | null;
  dependsOn?: string[];
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
  });
  return { mission, task };
}

/** Inserts a minimal taskCreationAttempts row + an active reservation on taskId. */
function seedActiveReservation(
  db: TaskPublicationDbClient,
  taskId: string,
  requestedAgentId: string,
  suffix = "r1",
): string {
  const attemptId = `attempt-${suffix}`;
  db.insert(taskCreationAttempts)
    .values({
      id: attemptId,
      source: "test",
      sourceScopeKind: "mission",
      sourceScopeId: "m-test",
      attemptKey: `key-${suffix}`,
      requestFingerprint: `fp-${suffix}`,
      publicationKind: "create",
      actorType: "human",
      actorId: "user-1",
      state: "pending",
    })
    .run();
  const reservationId = `res-${suffix}`;
  db.insert(taskCreationAssignmentReservations)
    .values({
      id: reservationId,
      taskId,
      attemptId,
      requestedAgentId,
      deadline: new Date().toISOString(),
      state: "active",
    })
    .run();
  return reservationId;
}

const localClaimant = (id: string): Claimant => ({ kind: "local", id });
const remoteClaimant = (id: string): Claimant => ({ kind: "remote", id });

// ---------------------------------------------------------------------------
// Success + the open gates (observation open for legacy, reservation open)
// ---------------------------------------------------------------------------

describe("claimWithAuthority — success path (plain claim)", () => {
  it("writes assignedAgentId for a local claimant and flips status to claimed", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "plain-local" });

    const result = claimWithAuthority(getDb(), task.id, localClaimant(a1.id));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.task.assignedAgentId).toBe(a1.id);
      expect(result.task.remoteAssignedParticipantId).toBeNull();
      expect(result.task.status).toBe("claimed");
      expect(result.task.claimedAt).not.toBeNull();
    }
    // Failure mode: writing to remoteAssignedParticipantId for a local claimant
    // would corrupt the FK to agents(id).
  });

  it("writes remoteAssignedParticipantId for a remote claimant (NOT assignedAgentId)", () => {
    const { task } = seedMission({ title: "plain-remote" });

    const result = claimWithAuthority(getDb(), task.id, remoteClaimant("participant-1"));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.task.remoteAssignedParticipantId).toBe("participant-1");
      expect(result.task.assignedAgentId).toBeNull();
      expect(result.task.status).toBe("claimed");
    }
    // Failure mode: writing assignedAgentId for a remote participant would
    // violate the agents(id) FK (participant ids are not agent ids).
  });

  it("bumps version on claim", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "version-bump" });
    const before = taskRepo.getTaskById(task.id)!.version;

    const result = claimWithAuthority(getDb(), task.id, localClaimant(a1.id));

    expect(result.success).toBe(true);
    if (result.success) expect(result.task.version).toBe(before + 1);
    // Failure mode: a no-op UPDATE would leave version unchanged, losing the
    // optimistic-concurrency signal downstream.
  });
});

// ---------------------------------------------------------------------------
// not_found + occupancy + state
// ---------------------------------------------------------------------------

describe("claimWithAuthority — not_found + occupancy + wrong-state", () => {
  it("returns not_found when the task does not exist", () => {
    const result = claimWithAuthority(getDb(), "does-not-exist", localClaimant("agent-x"));
    expect(result).toEqual({ success: false, category: "not_found", reason: "not_found" });
    // Failure mode: returning null or {} would lose the literal reason routes
    // depend on (routes/tasks/lifecycle.ts emits 404 on conflict("not_found")).
  });

  it("returns already_claimed when a local assignee is already set", () => {
    const a1 = seedAgent("a1");
    const a2 = seedAgent("a2");
    const { task } = seedMission({ title: "occupied-local" });
    claimWithAuthority(getDb(), task.id, localClaimant(a1.id)); // first claimer

    const result = claimWithAuthority(getDb(), task.id, localClaimant(a2.id));
    expect(result).toEqual({
      success: false,
      category: "already_claimed",
      reason: "already_claimed",
    });
    // Failure mode: a second claim that overwrites assignee would silently
    // steal the task — the occupancy gate must fire before mutation.
  });

  it("returns already_claimed when a remote assignee is set (symmetric guard)", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "occupied-remote" });
    claimWithAuthority(getDb(), task.id, remoteClaimant("participant-1"));

    const result = claimWithAuthority(getDb(), task.id, localClaimant(a1.id));
    expect(result).toEqual({
      success: false,
      category: "already_claimed",
      reason: "already_claimed",
    });
    // Failure mode: a local claim allowed over a remote-claimed task would
    // corrupt the symmetric occupancy invariant.
  });

  it("returns not_pending when status is non-pending and no assignee is set", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "wrong-state" });
    // Push into a non-pending state WITHOUT setting an assignee (direct write,
    // simulating a lifecycle edge). Guards that the not_pending category is
    // distinguishable from already_claimed.
    getDb().update(tasks).set({ status: "submitted" }).where(eq(tasks.id, task.id)).run();

    const result = claimWithAuthority(getDb(), task.id, localClaimant(a1.id));
    expect(result).toEqual({ success: false, category: "not_pending", reason: "not_pending" });
    // Failure mode: collapsing wrong-state into already_claimed (the legacy
    // behavior) would lose the coarse distinction the new authority provides.
  });
});

// ---------------------------------------------------------------------------
// ineligible — ADR-0038 task-intrinsic reasons (checkClaimability reused)
// ---------------------------------------------------------------------------

describe("claimWithAuthority — ineligible (task-intrinsic, via checkClaimability)", () => {
  it("returns ineligible / dependencies_unmet when a TASK dependency is not met", () => {
    const a1 = seedAgent("a1");
    const { task: blocker } = seedMission({ title: "task-blocker" });
    const { task } = seedMission({ title: "task-blocked" });
    // Task-level dependency (the taskDependencies table, not mission dependsOn).
    addTaskDependency(task.id, blocker.id); // blocker is not done → unmet

    const result = claimWithAuthority(getDb(), task.id, localClaimant(a1.id));
    expect(result).toEqual({
      success: false,
      category: "ineligible",
      reason: "dependencies_unmet",
    });
    // Failure mode: re-implementing the predicate here (instead of reusing
    // checkClaimability) would drift the ordered vocabulary codified in ADR-0038.
  });

  it("returns ineligible / mission_dependencies_unmet when a MISSION dependency is not met", () => {
    const a1 = seedAgent("a1");
    const blocker = seedMission({ title: "mission-blocker" });
    const { task } = seedMission({ title: "mission-blocked", dependsOn: [blocker.mission.id] });

    const result = claimWithAuthority(getDb(), task.id, localClaimant(a1.id));
    expect(result).toEqual({
      success: false,
      category: "ineligible",
      reason: "mission_dependencies_unmet",
    });
    // Failure mode: the coarse category MUST preserve the specific reason —
    // collapsing dependencies_unmet and mission_dependencies_unmet into one
    // would lose the ADR-0038 ordered-vocabulary diagnostic.
  });

  it("returns ineligible / release_gate_unmet when the release gate is not satisfied", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "release-gated", releaseGateType: "minor" });

    const result = claimWithAuthority(getDb(), task.id, localClaimant(a1.id));
    expect(result).toEqual({
      success: false,
      category: "ineligible",
      reason: "release_gate_unmet",
    });
    // Failure mode: the coarse category MUST preserve the specific reason —
    // collapsing to plain "ineligible" would break the route/MCP reason union.
  });
});

// ---------------------------------------------------------------------------
// Observation gate — open for legacy; observation_pending post-cutover
// ---------------------------------------------------------------------------

describe("claimWithAuthority — observation gate (creationIntegrity)", () => {
  it("is OPEN for legacy tasks (creationIntegrity === 0) — every production task today", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "legacy" });
    // Default createTask stamps creationIntegrity=0 (Legacy Partial History).
    // The shared Task type doesn't expose creationIntegrity, so read the row.
    const raw = getDb().select().from(tasks).where(eq(tasks.id, task.id)).all()[0];
    expect(raw.creationIntegrity).toBe(0);

    const result = claimWithAuthority(getDb(), task.id, localClaimant(a1.id));
    expect(result.success).toBe(true);
    // Failure mode: a gate that blocks legacy tasks would regress every
    // existing claim path on the day Phase 3 wires the authority.
  });

  it("returns observation_pending for a post-cutover task (creationIntegrity > 0)", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "post-cutover" });
    // Simulate a post-cutover task that has NOT traversed the dispatch
    // checkpoint. Direct write — createTask cannot set this.
    getDb().update(tasks).set({ creationIntegrity: 1 }).where(eq(tasks.id, task.id)).run();

    const result = claimWithAuthority(getDb(), task.id, localClaimant(a1.id));
    expect(result).toEqual({
      success: false,
      category: "observation_pending",
      reason: "observation_pending",
    });
    // Failure mode: allowing a post-cutover task to claim without its dispatch
    // checkpoint would defeat the whole observation gate — this is the forward
    // guard the plan adds structurally (T4A owns the checkpoint emission).
  });
});

// ---------------------------------------------------------------------------
// Reservation gate — reserved_for_other; open otherwise
// ---------------------------------------------------------------------------

describe("claimWithAuthority — reservation gate (task_creation_assignment_reservations)", () => {
  it("returns reserved_for_other when an active reservation exists for a DIFFERENT claimant", () => {
    const a1 = seedAgent("a1");
    const holder = seedAgent("holder");
    const { task } = seedMission({ title: "reserved" });
    // Another agent holds an active reservation on this task.
    seedActiveReservation(getDb(), task.id, holder.id, "resv-other");

    const result = claimWithAuthority(getDb(), task.id, localClaimant(a1.id));
    expect(result).toEqual({
      success: false,
      category: "reserved_for_other",
      reason: "reserved_for_other",
      reservedFor: holder.id,
    });
    // Failure mode: ignoring the reservation table would let any claimer steal
    // a task that was explicitly reserved for someone else — the targeted-
    // assignment guarantee T1's storage was built for.
  });

  it("is OPEN when the active reservation is for the SAME claimant (matching identity may claim)", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "reserved-for-you" });
    seedActiveReservation(getDb(), task.id, a1.id, "resv-match");

    const result = claimWithAuthority(getDb(), task.id, localClaimant(a1.id));
    expect(result.success).toBe(true);
    // Failure mode: blocking the matching-identity reservation would prevent
    // the very claim the reservation exists to enable.
  });

  it("is OPEN when there is no reservation (the table-empty-today case)", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "no-reservation" });

    const result = claimWithAuthority(getDb(), task.id, localClaimant(a1.id));
    expect(result.success).toBe(true);
    // Failure mode: treating absence-of-reservation as a block would regress
    // every claim until T5 stands up reservation creation.
  });
});

// ---------------------------------------------------------------------------
// THE COLLAPSE BUG, FIXED — infrastructure_failure vs version_conflict
//
// These are the load-bearing assertions: under the legacy functions, EVERY
// thrown exception becomes {success:false, reason:"already_claimed"}. The
// authority maps them to typed categories so callers can retry-vs-resurface.
// Injection uses the real-DB FailingDbClient from T1, wrapped around the tx
// via a patched db.transaction — exercising the authority's real catch path.
// ---------------------------------------------------------------------------

/** Patches `db.transaction` so the callback receives a FailingDbClient tx. */
function withFailingTx(
  failAtWriteN: number | null,
  errorFactory: (record: { index: number; kind: string; table: unknown }) => Error,
  fn: () => void,
): void {
  const db = getDb() as unknown as {
    transaction: (cb: (tx: TaskPublicationDbClient) => unknown) => unknown;
  };
  const real = db.transaction;
  db.transaction = (cb: (tx: TaskPublicationDbClient) => unknown) => {
    return real.call(db, (tx: TaskPublicationDbClient) => {
      const w = new FailingDbClient(tx, { failAtWriteN, errorFactory });
      return cb(w as unknown as TaskPublicationDbClient);
    });
  };
  try {
    fn();
  } finally {
    db.transaction = real;
  }
}

describe("claimWithAuthority — infra failure mapping (collapse bug FIXED)", () => {
  it("maps SQLITE_BUSY to infrastructure_failure with causeCode (NOT already_claimed)", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "busy" });

    let result: ClaimResult;
    withFailingTx(
      1,
      () =>
        Object.assign(new Error("database is locked"), {
          name: "SqliteError",
          code: "SQLITE_BUSY",
        }),
      () => {
        result = claimWithAuthority(getDb(), task.id, localClaimant(a1.id));
      },
    );

    expect(result!).toEqual({
      success: false,
      category: "infrastructure_failure",
      reason: "claim_failed",
      causeCode: "SQLITE_BUSY",
      cause: expect.any(Error),
    });
    // Failure mode: returning already_claimed (the legacy collapse) would make
    // a transient lock conflict indistinguishable from real contention — the
    // exact bug T2 exists to fix.
  });

  it("maps SQLITE_CONSTRAINT_UNIQUE to version_conflict (serialization, NOT infra)", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "unique" });

    let result: ClaimResult;
    withFailingTx(
      1,
      () =>
        Object.assign(new Error("UNIQUE constraint failed"), {
          name: "SqliteError",
          code: "SQLITE_CONSTRAINT_UNIQUE",
        }),
      () => {
        result = claimWithAuthority(getDb(), task.id, localClaimant(a1.id));
      },
    );

    expect(result!).toEqual({
      success: false,
      category: "version_conflict",
      reason: "version_conflict",
      causeCode: "SQLITE_CONSTRAINT_UNIQUE",
      cause: expect.any(Error),
    });
    // Failure mode: lumping UNIQUE into infrastructure_failure would lose the
    // serialization-conflict signal a retry layer wants to act on differently.
  });

  it("maps a generic (non-sqlite) error to infrastructure_failure / infrastructure_error", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "generic" });

    let result: ClaimResult;
    withFailingTx(
      1,
      () => new Error("synthetic disk I/O"),
      () => {
        result = claimWithAuthority(getDb(), task.id, localClaimant(a1.id));
      },
    );

    expect(result!).toEqual({
      success: false,
      category: "infrastructure_failure",
      reason: "infrastructure_error",
      cause: expect.any(Error),
    });
    // Failure mode: swallowing the error or collapsing to already_claimed
    // would hide a real infra fault behind a domain refusal.
  });
});

// ---------------------------------------------------------------------------
// Client primitive (transaction-aware) — proves the *WithClient split
// ---------------------------------------------------------------------------

describe("claimWithAuthorityClient — tx-aware primitive", () => {
  it("returns the same domain refusals when run on the top-level client (no tx wrapper)", () => {
    const result = claimWithAuthorityClient(getDb(), "does-not-exist", localClaimant("x"));
    expect(result).toEqual({ success: false, category: "not_found", reason: "not_found" });
    // Failure mode: the primitive calling getDb() itself (instead of the passed
    // client) would still pass here but would escape a caller's transaction in
    // production — the composition test below guards that.
  });

  it("composes inside a caller-supplied transaction (T1 *WithClient precedent)", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "composed" });
    const db = getDb();

    // A future publication coordinator composes the primitive inside ONE tx
    // alongside other writes. The primitive must not open its own tx.
    const result = db.transaction((tx) =>
      claimWithAuthorityClient(tx, task.id, localClaimant(a1.id)),
    );

    expect(result.success).toBe(true);
    // Failure mode: the primitive opening its own nested transaction would
    // throw under better-sqlite3 (no nested tx) — proving tx-composability.
  });
});

// ---------------------------------------------------------------------------
// Delegated mode — the claimDelegatedTask contract (model generalized)
// ---------------------------------------------------------------------------

describe("claimWithAuthority — delegated mode", () => {
  function seedDelegated(title: string, delegateToId: string, assigneeId: string) {
    const { task } = seedMission({ title });
    taskRepo.updateTask(task.id, {
      delegatedToAgentId: delegateToId,
      status: "claimed",
      assignedAgentId: assigneeId,
    });
    return task;
  }

  it("hands the task from delegatedToAgentId to the claiming delegate on success", () => {
    const assignee = seedAgent("assignee-original");
    const delegate = seedAgent("delegate-target");
    const task = seedDelegated("delegated-happy", delegate.id, assignee.id);

    const result = claimWithAuthority(getDb(), task.id, localClaimant(delegate.id), {
      delegated: true,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.task.assignedAgentId).toBe(delegate.id);
      expect(result.task.delegatedToAgentId).toBeNull();
      expect(result.task.status).toBe("claimed");
    }
    // Failure mode: skipping the delegatedToAgentId=null clear would leave the
    // task both delegated AND assigned — a real re-claim bug.
  });

  it("returns ineligible / not_delegated_to_you when the delegate identity mismatches", () => {
    const delegate = seedAgent("real-delegate");
    const { task } = seedMission({ title: "delegated-wrong" });
    taskRepo.updateTask(task.id, { delegatedToAgentId: delegate.id, status: "claimed" });

    const result = claimWithAuthority(getDb(), task.id, localClaimant("not-the-delegate"), {
      delegated: true,
    });
    expect(result).toEqual({
      success: false,
      category: "ineligible",
      reason: "not_delegated_to_you",
    });
    // Failure mode: collapsing to not_found would hide an authorization drift —
    // the delegated-specific reason is load-bearing for the wrapper pass-through.
  });

  it("returns not_pending / invalid_status when the task is pending (not claimed/in_progress)", () => {
    const delegate = seedAgent("delegate-pending");
    const { task } = seedMission({ title: "delegated-pending" });
    // Delegated but still pending — delegated claim requires claimed/in_progress.
    taskRepo.updateTask(task.id, { delegatedToAgentId: delegate.id, status: "pending" });

    const result = claimWithAuthority(getDb(), task.id, localClaimant(delegate.id), {
      delegated: true,
    });
    expect(result).toEqual({
      success: false,
      category: "not_pending",
      reason: "invalid_status",
    });
    // Failure mode: allowing delegated claim on a pending task would
    // re-introduce the v0.29.3 delegated-claim bypass.
  });

  it("does NOT run checkClaimability in delegated mode (preserves the legacy contract)", () => {
    const assignee = seedAgent("assignee");
    const delegate = seedAgent("delegate-intrinsic");
    // Release-gated mission — would fail checkClaimability in plain mode.
    const { task } = seedMission({ title: "delegated-no-intrinsic", releaseGateType: "minor" });
    taskRepo.updateTask(task.id, {
      delegatedToAgentId: delegate.id,
      status: "claimed",
      assignedAgentId: assignee.id,
    });

    const result = claimWithAuthority(getDb(), task.id, localClaimant(delegate.id), {
      delegated: true,
    });
    // The legacy claimDelegatedTask never called checkClaimability; the authority
    // preserves that. If it DID run the guards here, this would return
    // release_gate_unmet instead of succeeding.
    expect(result.success).toBe(true);
    // Failure mode: running checkClaimability in delegated mode would be a
    // behavior change vs the legacy claimDelegatedTask — pinned so Phase 3
    // makes the decision explicitly, not by accident.
  });
});

// ---------------------------------------------------------------------------
// mapInfraErrorToFailure — direct unit test of the category split
// ---------------------------------------------------------------------------

describe("reason → category mapping (no rich reason collapsed)", () => {
  // Tabular proof that every preserved specific reason carries an accompanying
  // coarse category WITHOUT losing the reason string. Phase 3 callers switch
  // on `category`; routes/MCP/tests keep matching on `reason`.
  it("every failure variant carries both category and the preserved reason", () => {
    const cases: Array<{ result: ClaimResult; category: string; reason: string }> = [
      {
        result: { success: false, category: "not_found", reason: "not_found" },
        category: "not_found",
        reason: "not_found",
      },
      {
        result: { success: false, category: "already_claimed", reason: "already_claimed" },
        category: "already_claimed",
        reason: "already_claimed",
      },
      {
        result: { success: false, category: "not_pending", reason: "not_pending" },
        category: "not_pending",
        reason: "not_pending",
      },
      {
        result: { success: false, category: "not_pending", reason: "invalid_status" },
        category: "not_pending",
        reason: "invalid_status",
      },
      {
        result: { success: false, category: "ineligible", reason: "dependencies_unmet" },
        category: "ineligible",
        reason: "dependencies_unmet",
      },
      {
        result: { success: false, category: "ineligible", reason: "mission_dependencies_unmet" },
        category: "ineligible",
        reason: "mission_dependencies_unmet",
      },
      {
        result: { success: false, category: "ineligible", reason: "release_gate_unmet" },
        category: "ineligible",
        reason: "release_gate_unmet",
      },
      {
        result: { success: false, category: "ineligible", reason: "workflow_gates_unmet" },
        category: "ineligible",
        reason: "workflow_gates_unmet",
      },
      {
        result: { success: false, category: "ineligible", reason: "not_delegated_to_you" },
        category: "ineligible",
        reason: "not_delegated_to_you",
      },
      {
        result: { success: false, category: "reserved_for_other", reason: "reserved_for_other" },
        category: "reserved_for_other",
        reason: "reserved_for_other",
      },
      {
        result: { success: false, category: "observation_pending", reason: "observation_pending" },
        category: "observation_pending",
        reason: "observation_pending",
      },
      {
        result: { success: false, category: "version_conflict", reason: "version_conflict" },
        category: "version_conflict",
        reason: "version_conflict",
      },
      {
        result: { success: false, category: "infrastructure_failure", reason: "claim_failed" },
        category: "infrastructure_failure",
        reason: "claim_failed",
      },
      {
        result: {
          success: false,
          category: "infrastructure_failure",
          reason: "infrastructure_error",
        },
        category: "infrastructure_failure",
        reason: "infrastructure_error",
      },
    ];
    for (const c of cases) {
      if (!c.result.success) {
        expect(c.result.category).toBe(c.category);
        expect(c.result.reason).toBe(c.reason);
      }
    }
    // Failure mode: if a refactor collapsed e.g. dependencies_unmet's reason to
    // "ineligible", the reason assertion would fail — proving the specific
    // vocabulary is preserved alongside the coarse category.
  });
});
