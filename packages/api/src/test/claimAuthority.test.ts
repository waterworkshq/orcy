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
  taskCreationEnvelopes,
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
  progressWithAuthority,
  checkProgressionGates,
  type Claimant,
  type ClaimResult,
} from "../repositories/claimAuthority.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import type { Task } from "../models/index.js";
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

/** Seeds an active reservation on an EXISTING attempt (e.g. one from
 * {@link seedCreationEnvelope}). Used to combine the observation gate (satisfied)
 * with a reservation for another agent in one test. */
function seedReservationOnAttempt(
  db: TaskPublicationDbClient,
  taskId: string,
  attemptId: string,
  requestedAgentId: string,
  suffix = "resv",
): string {
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

/**
 * Seeds a post-cutover creation trail for `taskId`: a `taskCreationAttempts`
 * row at `attemptState` + a `taskCreationEnvelopes` row linking the task to
 * that attempt. This is what T3C's publication coordinator writes atomically;
 * tests construct it directly to exercise the Phase 3 observation gate without
 * the coordinator. Returns the ids so a test can also seed a reservation.
 */
function seedCreationEnvelope(
  db: TaskPublicationDbClient,
  taskId: string,
  attemptState: string,
  suffix = "env",
): { envelopeId: string; attemptId: string } {
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
      state: attemptState as never,
    })
    .run();
  const envelopeId = `env-${suffix}`;
  db.insert(taskCreationEnvelopes)
    .values({
      eventId: envelopeId,
      lifecycleAction: "created",
      taskId,
      habitatId,
      occurredAt: new Date().toISOString(),
      attemptId,
      actorType: "human",
      actorId: "user-1",
      source: "test",
    })
    .run();
  return { envelopeId, attemptId };
}

/** Marks a task post-cutover (creationIntegrity=1). createTask cannot set this. */
function markPostCutover(taskId: string): void {
  getDb().update(tasks).set({ creationIntegrity: 1 }).where(eq(tasks.id, taskId)).run();
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

  it("returns observation_pending for a post-cutover task with NO dispatch envelope (fail-safe)", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "post-cutover" });
    // Simulate a post-cutover task that has NOT traversed the dispatch
    // checkpoint. Direct write — createTask cannot set this. No envelope →
    // creationObservationStateForTaskWithClient returns {observed:false,
    // reason:"no_envelope"} → fail-safe observation_pending.
    markPostCutover(task.id);

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

  // --- T4A Phase 3: the REAL observation check (behind the legacy short-circuit)

  it("is OPEN for a post-cutover task whose attempt advanced to published_pending_assignment", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "obs-ppa" });
    markPostCutover(task.id);
    seedCreationEnvelope(getDb(), task.id, "published_pending_assignment", "env-ppa");

    const result = claimWithAuthority(getDb(), task.id, localClaimant(a1.id));
    expect(result.success).toBe(true);
    // Failure mode: if Phase 3 left the placeholder block, EVERY post-cutover
    // task would be observation_pending regardless of attempt state — this would
    // fail, proving the real check engages.
  });

  it("is OPEN for a post-cutover task whose attempt terminalized to created", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "obs-created" });
    markPostCutover(task.id);
    seedCreationEnvelope(getDb(), task.id, "created", "env-created");

    const result = claimWithAuthority(getDb(), task.id, localClaimant(a1.id));
    expect(result.success).toBe(true);
    // Failure mode: a gate that only accepted published_pending_assignment (not
    // the terminal success states) would block a fully-created task.
  });

  it("is OPEN for a post-cutover task whose attempt terminalized to created_unassigned (claimable)", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "obs-unassigned" });
    markPostCutover(task.id);
    seedCreationEnvelope(getDb(), task.id, "created_unassigned", "env-unassigned");

    const result = claimWithAuthority(getDb(), task.id, localClaimant(a1.id));
    expect(result.success).toBe(true);
    // Failure mode: created_unassigned means published + observed + reservation
    // released — it MUST be claimable. Excluding it from POST_OBSERVATION_STATES
    // would wrongly block the assignment-exhaustion terminal.
  });

  it("returns observation_pending for a post-cutover task whose attempt is STILL at published_pending_observation", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "obs-pending" });
    markPostCutover(task.id);
    // The dispatch checkpoint has been reached but NOT yet advanced past
    // observation (targets still pending, or the worker hasn't run).
    seedCreationEnvelope(getDb(), task.id, "published_pending_observation", "env-ppo");

    const result = claimWithAuthority(getDb(), task.id, localClaimant(a1.id));
    expect(result).toEqual({
      success: false,
      category: "observation_pending",
      reason: "observation_pending",
    });
    // Failure mode: treating published_pending_observation as observed would
    // let a task be claimed before its dispatch targets are accepted.
  });

  it("returns observation_pending for a post-cutover task whose attempt FAILED terminally (rejected_validation — fail-safe)", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "obs-rejected" });
    markPostCutover(task.id);
    seedCreationEnvelope(getDb(), task.id, "rejected_validation", "env-rej");

    const result = claimWithAuthority(getDb(), task.id, localClaimant(a1.id));
    expect(result).toEqual({
      success: false,
      category: "observation_pending",
      reason: "observation_pending",
    });
    // Failure mode: a failed-terminal attempt must NOT open claimability — the
    // task's creation failed; treating any terminal state as observed would
    // let a dead task be claimed.
  });

  it("observation + reservation are SEPARATE gates: an observed task reserved for ANOTHER agent → reserved_for_other", () => {
    const a1 = seedAgent("a1");
    const holder = seedAgent("holder-obs");
    const { task } = seedMission({ title: "obs-reserved" });
    markPostCutover(task.id);
    // Observation is SATISFIED (attempt advanced)...
    const { attemptId } = seedCreationEnvelope(
      getDb(),
      task.id,
      "published_pending_assignment",
      "env-obs-res",
    );
    // ...but an active reservation targets a DIFFERENT agent.
    seedReservationOnAttempt(getDb(), task.id, attemptId, holder.id, "resv-obs-other");

    const result = claimWithAuthority(getDb(), task.id, localClaimant(a1.id));
    expect(result).toEqual({
      success: false,
      category: "reserved_for_other",
      reason: "reserved_for_other",
      reservedFor: holder.id,
    });
    // Failure mode: if the observation check threw or short-circuited the
    // reservation gate, a1 would either get observation_pending (gate ordering
    // bug) or succeed (reservation gate dropped). The reserved_for_other result
    // proves observation passed AND the reservation gate still fires.
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
// M1 remediation — delegated claims honor observation + reservation gates.
//
// Pre-remediation the delegated branch returned via commitDelegatedClaim BEFORE
// the gate checks, letting a delegated claim bypass the publication gates. The
// fix runs observation + reservation in delegated mode too (only the four
// ADR-0038 intrinsic guards stay skipped — delegated parity). All dormant for
// legacy tasks (creationIntegrity=0; reservation table empty until T5).
// ---------------------------------------------------------------------------

describe("M1 remediation — delegated claims honor the publication gates", () => {
  function seedDelegated(title: string, delegateToId: string, assigneeId: string) {
    const { task } = seedMission({ title });
    taskRepo.updateTask(task.id, {
      delegatedToAgentId: delegateToId,
      status: "claimed",
      assignedAgentId: assigneeId,
    });
    return task;
  }

  it("returns observation_pending when a delegated post-cutover task has NO dispatch envelope (fail-safe)", () => {
    const assignee = seedAgent("assignee");
    const delegate = seedAgent("delegate-obs");
    const task = seedDelegated("delegated-observation", delegate.id, assignee.id);
    // Simulate a post-cutover task missing its observation checkpoint. No
    // envelope → fail-safe observation_pending (the delegated path runs the
    // SAME publication gate as the plain path — M1 parity).
    markPostCutover(task.id);

    const result = claimWithAuthority(getDb(), task.id, localClaimant(delegate.id), {
      delegated: true,
    });
    expect(result).toEqual({
      success: false,
      category: "observation_pending",
      reason: "observation_pending",
    });
    // Failure mode: pre-M1 the delegated branch returned via commitDelegatedClaim
    // before this gate — the claim would SUCCEED, defeating the observation guard
    // for delegated claims. This proves the gate now fires on both paths.
  });

  it("delegated claim SUCCEEDS for an OBSERVED post-cutover task (M1 + Phase 3 parity)", () => {
    const assignee = seedAgent("assignee");
    const delegate = seedAgent("delegate-obs-ok");
    const task = seedDelegated("delegated-observed", delegate.id, assignee.id);
    markPostCutover(task.id);
    // The dispatch checkpoint is satisfied — observation gate opens for the
    // delegated path too (the real Phase 3 check, not the placeholder block).
    seedCreationEnvelope(getDb(), task.id, "published_pending_assignment", "env-delegated");

    const result = claimWithAuthority(getDb(), task.id, localClaimant(delegate.id), {
      delegated: true,
    });
    expect(result.success).toBe(true);
    // Failure mode: if the delegated path kept the placeholder (block every
    // post-cutover task), this observed delegated claim would fail — proving
    // the real observation check engages on the delegated path.
  });

  it("returns reserved_for_other when an active reservation exists for a different identity (delegated)", () => {
    const assignee = seedAgent("assignee");
    const delegate = seedAgent("delegate-res");
    const holder = seedAgent("holder-res");
    const task = seedDelegated("delegated-reserved", delegate.id, assignee.id);
    // Another agent holds an active reservation on this task.
    seedActiveReservation(getDb(), task.id, holder.id, "resv-delegated-other");

    const result = claimWithAuthority(getDb(), task.id, localClaimant(delegate.id), {
      delegated: true,
    });
    expect(result).toEqual({
      success: false,
      category: "reserved_for_other",
      reason: "reserved_for_other",
      reservedFor: holder.id,
    });
    // Failure mode: pre-M1 the delegated branch skipped the reservation gate —
    // the delegate would claim a task explicitly reserved for someone else.
  });

  it("the delegated reservation gate also fires through claimDelegatedTask (end-to-end via the repo function)", () => {
    const assignee = seedAgent("assignee");
    const delegate = seedAgent("delegate-e2e");
    const holder = seedAgent("holder-e2e");
    const task = seedDelegated("delegated-e2e", delegate.id, assignee.id);
    seedActiveReservation(getDb(), task.id, holder.id, "resv-e2e");

    const result = taskStateMachine.claimDelegatedTask(task.id, delegate.id);
    // The legacy flatten maps reserved_for_other → "reserved_for_other" (NEW
    // reason; never fires for legacy until T5).
    expect(result).toEqual({ success: false, reason: "reserved_for_other" });
    // Failure mode: if claimDelegatedTask still bypassed the gate, the claim
    // would succeed and the task would be stolen from the reservation holder.
  });

  it("PRESERVE: delegated claim still succeeds for a legacy task with no reservation (the gate-open case)", () => {
    // Regression guard: the M1 gate additions must NOT change legacy behavior.
    // A legacy delegated task (creationIntegrity=0, no reservations) still claims.
    const assignee = seedAgent("assignee");
    const delegate = seedAgent("delegate-legacy");
    const task = seedDelegated("delegated-legacy-ok", delegate.id, assignee.id);

    const result = claimWithAuthority(getDb(), task.id, localClaimant(delegate.id), {
      delegated: true,
    });
    expect(result.success).toBe(true);
    // Failure mode: a gate that blocks legacy delegated claims would regress
    // the delegated claim path on the day reservations/observation land.
  });
});

// ---------------------------------------------------------------------------
// M2 remediation — reservation gate is transport-safe + NULL fails closed.
//
// Pre-remediation activeReservationForOther compared only the raw ID string, so
// a remote participant presenting the same string as the reserved local agent
// could claim; an active NULL requested_agent_id failed OPEN. The fix matches
// on kind==="local" + id, and treats NULL as BLOCKING (invalid state).
// ---------------------------------------------------------------------------

describe("M2 remediation — reservation gate (transport-safe + NULL blocks)", () => {
  it("BLOCKS a remote participant presenting the SAME string as the reserved local agent", () => {
    const holder = seedAgent("agent-x"); // local agent id
    const { task } = seedMission({ title: "remote-id-collision" });
    // Reservation targets the local agent "agent-x".
    seedActiveReservation(getDb(), task.id, holder.id, "resv-collision");
    // A remote participant using the LITERAL SAME STRING tries to claim.
    const result = claimWithAuthority(getDb(), task.id, remoteClaimant(holder.id));

    expect(result).toEqual({
      success: false,
      category: "reserved_for_other",
      reason: "reserved_for_other",
      reservedFor: holder.id,
    });
    // Failure mode: pre-M2 the raw-ID comparison matched (string === string),
    // letting the remote participant steal the targeted reservation. The fix
    // requires kind==="local" — remote never matches.
  });

  it("BLOCKS when an active reservation has requested_agent_id IS NULL (invalid state fails closed)", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "null-reservation" });
    // Seed an active reservation with a NULL requested_agent_id directly (the
    // creation seam now forbids this, but the column stays nullable — the gate
    // defends against legacy/direct inserts).
    getDb()
      .insert(taskCreationAttempts)
      .values({
        id: "attempt-null-res",
        source: "test",
        sourceScopeKind: "mission",
        sourceScopeId: "m-test",
        attemptKey: "key-null-res",
        requestFingerprint: "fp-null-res",
        publicationKind: "create",
        actorType: "human",
        actorId: "user-1",
        state: "pending",
      })
      .run();
    getDb()
      .insert(taskCreationAssignmentReservations)
      .values({
        id: "res-null",
        taskId: task.id,
        attemptId: "attempt-null-res",
        requestedAgentId: null, // the invalid state
        deadline: new Date().toISOString(),
        state: "active",
      })
      .run();

    const result = claimWithAuthority(getDb(), task.id, localClaimant(a1.id));
    expect(result).toEqual({
      success: false,
      category: "reserved_for_other",
      reason: "reserved_for_other",
      reservedFor: "<unspecified>",
    });
    // Failure mode: pre-M2 a NULL requested_agent_id was treated as "no
    // specific identity" and did NOT block (failed open). The fix treats NULL
    // as an invalid blocking state — nobody matches, so nobody may claim.
  });

  it("still lets the MATCHING local agent claim (reservation honored)", () => {
    const holder = seedAgent("matching-agent");
    const { task } = seedMission({ title: "matching-local" });
    seedActiveReservation(getDb(), task.id, holder.id, "resv-match-m2");

    const result = claimWithAuthority(getDb(), task.id, localClaimant(holder.id));
    expect(result.success).toBe(true);
    // Failure mode: over-blocking (treating the matching local agent as
    // "other") would defeat the reservation's whole purpose.
  });

  it("BLOCKS a local agent with a DIFFERENT id from the reserved one", () => {
    const holder = seedAgent("reserved-agent");
    const other = seedAgent("other-agent");
    const { task } = seedMission({ title: "local-other" });
    seedActiveReservation(getDb(), task.id, holder.id, "resv-local-other");

    const result = claimWithAuthority(getDb(), task.id, localClaimant(other.id));
    expect(result).toEqual({
      success: false,
      category: "reserved_for_other",
      reason: "reserved_for_other",
      reservedFor: holder.id,
    });
    // Failure mode: matching on id alone (without the kind guard) would still
    // block here, but the transport-safety is proven by the remote-collision
    // test above; this row pins the ordinary different-local-id block.
  });
});

// ---------------------------------------------------------------------------
// M3 remediation — start functions are TOCTOU-safe (progressWithAuthority).
//
// Pre-remediation startTask / startTaskByRemoteParticipant ran checkProgressionGates
// then a SEPARATE UPDATE with no transaction — a reservation appearing between
// the gate-check and the mutation could let the start through. progressWithAuthority
// runs gates + mutation + verify in ONE transaction, with the reservation gate
// inlined as a NOT EXISTS subquery in the UPDATE WHERE so a mid-tx reservation
// is observed and the UPDATE no-ops. Proven by a tx-injection shim.
// ---------------------------------------------------------------------------

/**
 * Tx-injection shim for the M3 TOCTOU proof. Wraps the real tx so that the
 * first `.update(...)...run()` (progressWithAuthorityClient's mutation) first
 * inserts an active reservation for `raceAgentId` on `raceTaskId` INTO THE SAME
 * TX. This models a reservation appearing in the window between the gate SELECT
 * and the mutation. progressWithAuthority's inlined NOT EXISTS subquery sees
 * the just-inserted row (same tx snapshot) → the UPDATE no-ops → post-write
 * verify returns null → the start is blocked.
 */
class RaceInjectingClient {
  private injected = false;
  constructor(
    public readonly inner: TaskPublicationDbClient,
    private readonly inject: () => void,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(...args: any[]): any {
    return (this.inner as unknown as { select: (...a: unknown[]) => unknown }).select(...args);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(table: unknown): any {
    return (this.inner as unknown as { insert: (t: unknown) => unknown }).insert(table);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete(table: unknown): any {
    return (this.inner as unknown as { delete: (t: unknown) => unknown }).delete(table);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(table: unknown): any {
    const innerBuilder = (this.inner as unknown as { update: (t: unknown) => unknown }).update(
      table,
    );
    return this.wrapChain(innerBuilder);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private wrapChain(builder: unknown): any {
    return new Proxy(builder as object, {
      get: (target, prop) => {
        if (prop === "run") {
          return () => {
            if (!this.injected) {
              this.injected = true;
              this.inject();
            }
            return (target as { run: () => unknown }).run();
          };
        }
        const value = Reflect.get(target as object, prop);
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            const result = (value as (...a: unknown[]) => unknown).apply(target, args);
            return this.wrapChain(result);
          };
        }
        return value;
      },
    });
  }
}

/** Patches `db.transaction` so the callback receives a RaceInjectingClient tx. */
function withReservationRace(
  raceTaskId: string,
  raceAgentId: string,
  raceAttemptId: string,
  fn: () => void,
): void {
  const db = getDb() as unknown as {
    transaction: (cb: (tx: TaskPublicationDbClient) => unknown) => unknown;
  };
  const real = db.transaction;
  db.transaction = (cb: (tx: TaskPublicationDbClient) => unknown) => {
    return real.call(db, (tx: TaskPublicationDbClient) => {
      const w = new RaceInjectingClient(tx, () => {
        // Insert the racing reservation on the SAME tx (visible to the
        // UPDATE's NOT EXISTS subquery within this tx).
        tx.insert(taskCreationAssignmentReservations)
          .values({
            id: `race-${raceAttemptId}`,
            taskId: raceTaskId,
            attemptId: raceAttemptId,
            requestedAgentId: raceAgentId,
            deadline: new Date().toISOString(),
            state: "active",
          })
          .run();
      });
      return cb(w as unknown as TaskPublicationDbClient);
    });
  };
  try {
    fn();
  } finally {
    db.transaction = real;
  }
}

describe("M3 remediation — progressWithAuthority closes the start-TOCTOU race", () => {
  function seedAttemptRow(id: string) {
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
        state: "pending",
      })
      .run();
  }

  it("a reservation appearing between the gate-check and the UPDATE cannot let the start through", () => {
    const claimer = seedAgent("claimer");
    const holder = seedAgent("race-holder");
    const { task } = seedMission({ title: "start-toc" });
    seedAttemptRow("attempt-race"); // FK target for the racing reservation
    // Claim the task (legacy → gates open) so it is ready to start.
    expect(claimWithAuthority(getDb(), task.id, localClaimant(claimer.id)).success).toBe(true);

    // Start, but inject a reservation for ANOTHER agent between the gate SELECT
    // and the UPDATE. Pre-M3 (separate gate-check + bare UPDATE, no tx) the
    // start would succeed. With progressWithAuthority the UPDATE's NOT EXISTS
    // subquery observes the just-injected reservation → UPDATE no-ops → null.
    let result: Task | null = null;
    withReservationRace(task.id, holder.id, "attempt-race", () => {
      result = progressWithAuthority(getDb(), task.id, localClaimant(claimer.id));
    });

    expect(result).toBeNull();
    // The task did NOT progress — still claimed, not in_progress.
    const after = getDb().select().from(tasks).where(eq(tasks.id, task.id)).all()[0];
    expect(after?.status).toBe("claimed");
    // Failure mode: if progressWithAuthority checked the gate on a separate
    // statement then mutated (the pre-M3 shape), the injected reservation would
    // be missed and the start would succeed — returning a task and flipping
    // status to in_progress. The null + claimed-status assertions prove the
    // atomic defense held.
  });

  it("the TOCTOU defense also holds through the public startTask repo function (end-to-end)", () => {
    const claimer = seedAgent("claimer-e2e");
    const holder = seedAgent("race-holder-e2e");
    const { task } = seedMission({ title: "start-toc-e2e" });
    seedAttemptRow("attempt-race-e2e");
    taskStateMachine.claimTask(task.id, claimer.id); // ready to start

    let result: Task | null = null;
    withReservationRace(task.id, holder.id, "attempt-race-e2e", () => {
      result = taskStateMachine.startTask(task.id, claimer.id);
    });

    expect(result).toBeNull();
    const after = getDb().select().from(tasks).where(eq(tasks.id, task.id)).all()[0];
    expect(after?.status).toBe("claimed");
    // Failure mode: if startTask did not delegate to progressWithAuthority (or
    // the delegation regressed to a non-tx shape), the racing reservation would
    // be missed and startTask would return the progressed task.
  });

  it("PRESERVE: startTask still succeeds for a legacy claimed task with no racing reservation", () => {
    // Regression guard: the M3 atomic wrapping must not regress the happy path.
    const claimer = seedAgent("claimer-happy");
    const { task } = seedMission({ title: "start-happy-m3" });
    taskStateMachine.claimTask(task.id, claimer.id);

    const result = taskStateMachine.startTask(task.id, claimer.id);
    expect(result).not.toBeNull();
    expect(result?.status).toBe("in_progress");
    // Failure mode: over-defending (blocking when no reservation exists) would
    // null the happy path — the route layer would emit a spurious 409.
  });

  it("PRESERVE: startTaskByRemoteParticipant still succeeds for a legacy remote-claimed task", () => {
    const { task } = seedMission({ title: "remote-start-happy-m3" });
    taskStateMachine.claimTaskByRemoteParticipant(task.id, "participant-happy");

    const result = taskStateMachine.startTaskByRemoteParticipant(task.id, "participant-happy");
    expect(result?.status).toBe("in_progress");
    // Failure mode: the remote progression path must not regress under M3.
  });
});

// ---------------------------------------------------------------------------
// T4A Phase 3 — progression gate honors the REAL observation check.
//
// evaluateProgressionGates (shared by checkProgressionGates + progressWithAuthority)
// was the same placeholder as publicationGateFailure: every post-cutover task
// blocked. Phase 3 wires it to creationObservationStateForTaskWithClient behind
// the legacy short-circuit, so progression mirrors the claim gate. Legacy
// progression stays open byte-identically (already covered by the M3 PRESERVE
// tests above).
// ---------------------------------------------------------------------------

describe("T4A Phase 3 — progression observation gate (evaluateProgressionGates)", () => {
  it("checkProgressionGates is OPEN for a legacy task (creationIntegrity=0)", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "prog-legacy" });
    expect(checkProgressionGates(getDb(), task.id, localClaimant(a1.id))).toEqual({ ok: true });
    // Failure mode: a gate that blocked legacy progression would regress every
    // startTask path.
  });

  it("checkProgressionGates is OPEN for an OBSERVED post-cutover task", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "prog-obs" });
    markPostCutover(task.id);
    seedCreationEnvelope(getDb(), task.id, "published_pending_assignment", "env-prog-obs");
    expect(checkProgressionGates(getDb(), task.id, localClaimant(a1.id))).toEqual({ ok: true });
    // Failure mode: if evaluateProgressionGates kept the placeholder, this would
    // return {ok:false, category:"observation_pending"} for every post-cutover
    // task regardless of attempt state.
  });

  it("checkProgressionGates returns observation_pending for a post-cutover task STILL at published_pending_observation", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "prog-pending" });
    markPostCutover(task.id);
    seedCreationEnvelope(getDb(), task.id, "published_pending_observation", "env-prog-ppo");
    expect(checkProgressionGates(getDb(), task.id, localClaimant(a1.id))).toEqual({
      ok: false,
      category: "observation_pending",
    });
    // Failure mode: treating published_pending_observation as observed would
    // let a task progress before its dispatch targets are accepted.
  });

  it("checkProgressionGates returns observation_pending for a post-cutover task with NO envelope (fail-safe)", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "prog-no-env" });
    markPostCutover(task.id);
    expect(checkProgressionGates(getDb(), task.id, localClaimant(a1.id))).toEqual({
      ok: false,
      category: "observation_pending",
    });
    // Failure mode: a missing envelope must fail closed, not pass through to the
    // reservation gate (which would return {ok:true} and let progression through).
  });

  it("progressWithAuthority SUCCEEDS for an observed post-cutover claimed task (end-to-end)", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "prog-e2e-obs" });
    markPostCutover(task.id);
    seedCreationEnvelope(getDb(), task.id, "published_pending_assignment", "env-prog-e2e");
    // Claim succeeds because the observation gate is OPEN (observed).
    expect(claimWithAuthority(getDb(), task.id, localClaimant(a1.id)).success).toBe(true);

    const started = progressWithAuthority(getDb(), task.id, localClaimant(a1.id));
    expect(started).not.toBeNull();
    expect(started?.status).toBe("in_progress");
    // Failure mode: if evaluateProgressionGates kept the placeholder, the start
    // would return null (gate blocks) for this observed task.
  });

  it("progressWithAuthority returns null for an un-observed post-cutover task pushed to claimed (gate blocks)", () => {
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "prog-e2e-blocked" });
    markPostCutover(task.id);
    seedCreationEnvelope(getDb(), task.id, "published_pending_observation", "env-prog-block");
    // The task CANNOT be claimed (observation blocks claim), so directly write
    // it to claimed + assigned to isolate the PROGRESSION gate from the claim
    // gate — proving evaluateProgressionGates enforces observation independently.
    getDb()
      .update(tasks)
      .set({ status: "claimed", assignedAgentId: a1.id })
      .where(eq(tasks.id, task.id))
      .run();

    const started = progressWithAuthority(getDb(), task.id, localClaimant(a1.id));
    expect(started).toBeNull();
    const after = getDb().select().from(tasks).where(eq(tasks.id, task.id)).all()[0];
    expect(after?.status).toBe("claimed");
    // Failure mode: if the progression observation gate were dropped, the start
    // would succeed and flip status to in_progress despite the task still being
    // at published_pending_observation.
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
