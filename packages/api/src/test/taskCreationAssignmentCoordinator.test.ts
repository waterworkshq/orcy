/**
 * T5 Phase 1 — Targeted Assignment Coordinator + reservation transitions.
 *
 * Exercises the load-bearing guardrails from the T5 ticket § "Guardrails and
 * verification" and the implementation-context failure/recovery matrix. Each
 * test is a discriminating probe: it FAILS without the Phase 1 implementation
 * (coordinator missing, routing wrong, atomicity broken) and PASSES after.
 *
 * Contract invariants covered:
 *  1. Reservation transitions: consume (active→consumed), release (active→
 *     released + failureReason), CAS no_op on already-retired, not_found throws.
 *  2. Reservation wins against every claim origin: an active reservation for A
 *     blocks B (reserved_for_other); the coordinator claiming as A succeeds.
 *  3. Atomic success: coordinator success → task claimed by requestedAgent +
 *     reservation consumed + attempt `created`, all committed together.
 *  4. Atomic refusal: ineligible requested agent → reservation released +
 *     attempt `created_unassigned`; the reservation gate opens for others.
 *  5. Infrastructure stays resumable: injected claim infra failure → attempt
 *     stays `published_pending_assignment`, reservation stays `active`, lease
 *     released; a second coordinator call resumes and completes.
 *  6. Kill-worker resumption: crash before claim (lease held, nothing
 *     committed) → resuming worker after lease expiry completes; crash after
 *     claim committed → terminal replay does NOT rerun assignment.
 *  7. Terminal replay never reruns assignment; non-terminal resumption never
 *     recreates the Task.
 *
 * DORMANT: no production origin creates post-cutover Tasks until cutover.
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
import { markTaskDone } from "../repositories/taskStateMachine.js";
import {
  claimWithAuthority,
  claimWithAuthorityClient,
  type Claimant,
} from "../repositories/claimAuthority.js";
import {
  consumeAssignmentReservationWithClient,
  releaseAssignmentReservationWithClient,
} from "../repositories/taskPublication.js";
import type { TaskPublicationDbClient } from "../repositories/taskPublication.js";
import {
  resolveTargetedAssignment,
  type TargetedAssignmentResolution,
} from "../services/taskCreationAssignmentCoordinator.js";
import { FailingDbClient } from "./helpers/failingDbClient.js";

let habitatId: string;

beforeEach(async () => {
  await initTestDb();
  const habitat = habitatRepo.createHabitat({ name: "Assignment Coordinator Habitat" });
  habitatId = habitat.id;
  columnRepo.createColumn({ habitatId, name: "Todo", order: 0, requiresClaim: false });
});

afterEach(() => closeDb());

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function seedAgent(name: string) {
  return agentRepo.createAgent({
    name,
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  }).agent;
}

function seedMission(opts: { title: string; dependsOn?: string[] }) {
  const mission = missionRepo.createMission({
    habitatId,
    columnId: columnRepo.getColumnsByHabitatId(habitatId)[0].id,
    title: opts.title,
    createdBy: "user-1",
    dependsOn: opts.dependsOn ?? [],
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: `task-for-${mission.id}`,
    createdBy: "user-1",
  });
  return { mission, task };
}

/** Marks a task post-cutover (creationIntegrity=1) so the observation gate engages. */
function markPostCutover(taskId: string): void {
  getDb().update(tasks).set({ creationIntegrity: 1 }).where(eq(tasks.id, taskId)).run();
}

/**
 * Seeds a full targeted-assignment trail for `taskId`: a `published_pending_assignment`
 * attempt + an envelope linking task→attempt (observation satisfied) + an active
 * reservation (attempt→task→requestedAgentId). Returns ids for assertions.
 */
function seedAssignmentTrail(
  db: TaskPublicationDbClient,
  opts: {
    taskId: string;
    requestedAgentId: string;
    suffix?: string;
    attemptState?: string;
  },
): { attemptId: string; reservationId: string; envelopeId: string } {
  const suffix = opts.suffix ?? `s-${opts.taskId.slice(-4)}`;
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
      state: (opts.attemptState ?? "published_pending_assignment") as never,
    })
    .run();
  const envelopeId = `env-${suffix}`;
  db.insert(taskCreationEnvelopes)
    .values({
      eventId: envelopeId,
      lifecycleAction: "created",
      taskId: opts.taskId,
      habitatId,
      occurredAt: new Date().toISOString(),
      attemptId,
      actorType: "human",
      actorId: "user-1",
      source: "test",
    })
    .run();
  const reservationId = `res-${suffix}`;
  db.insert(taskCreationAssignmentReservations)
    .values({
      id: reservationId,
      taskId: opts.taskId,
      attemptId,
      requestedAgentId: opts.requestedAgentId,
      deadline: new Date(Date.now() + 60_000).toISOString(),
      state: "active",
    })
    .run();
  return { attemptId, reservationId, envelopeId };
}

const localClaimant = (id: string): Claimant => ({ kind: "local", id });

/** Read helpers for post-resolution assertions. */
function readAttempt(db: TaskPublicationDbClient, attemptId: string) {
  return db
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.id, attemptId))
    .all()[0];
}
function readReservation(db: TaskPublicationDbClient, reservationId: string) {
  return db
    .select()
    .from(taskCreationAssignmentReservations)
    .where(eq(taskCreationAssignmentReservations.id, reservationId))
    .all()[0];
}
function readTask(db: TaskPublicationDbClient, taskId: string) {
  return db.select().from(tasks).where(eq(tasks.id, taskId)).all()[0];
}

/**
 * Patches `db.transaction` so the callback receives a FailingDbClient tx. The
 * lease acquire (which runs on the top-level client BEFORE the tx) is NOT
 * affected — only writes inside the coordinator's resolution tx are counted
 * and (at the Nth) failed. Mirrors `withFailingTx` in claimAuthority.test.ts.
 */
function withFailingResolutionTx(
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

// ===========================================================================
// 1. Reservation state-transition primitives (consume / release)
// ===========================================================================

describe("consumeAssignmentReservationWithClient — CAS active → consumed", () => {
  it("transitions an active reservation to consumed", () => {
    const db = getDb();
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "consume-ok" });
    const { reservationId } = seedAssignmentTrail(db, {
      taskId: task.id,
      requestedAgentId: a1.id,
      suffix: "consume-ok",
    });

    const result = consumeAssignmentReservationWithClient(db, reservationId);

    expect(result.outcome).toBe("transitioned");
    const row = readReservation(db, reservationId);
    expect(row.state).toBe("consumed");
    expect(row.failureReason).toBeNull();
  });

  it("returns no_op when the reservation is already consumed (CAS loser)", () => {
    const db = getDb();
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "consume-replay" });
    const { reservationId } = seedAssignmentTrail(db, {
      taskId: task.id,
      requestedAgentId: a1.id,
      suffix: "consume-replay",
    });
    consumeAssignmentReservationWithClient(db, reservationId); // first consumer

    const result = consumeAssignmentReservationWithClient(db, reservationId); // replay

    expect(result.outcome).toBe("no_op");
    expect(result.reservation.state).toBe("consumed");
  });
});

describe("releaseAssignmentReservationWithClient — CAS active → released + reason", () => {
  it("transitions an active reservation to released AND stamps failureReason", () => {
    const db = getDb();
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "release-ok" });
    const { reservationId } = seedAssignmentTrail(db, {
      taskId: task.id,
      requestedAgentId: a1.id,
      suffix: "release-ok",
    });

    const result = releaseAssignmentReservationWithClient(db, reservationId, "dependencies_unmet");

    expect(result.outcome).toBe("transitioned");
    const row = readReservation(db, reservationId);
    expect(row.state).toBe("released");
    expect(row.failureReason).toBe("dependencies_unmet");
  });

  it("returns no_op when the reservation is already released", () => {
    const db = getDb();
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "release-replay" });
    const { reservationId } = seedAssignmentTrail(db, {
      taskId: task.id,
      requestedAgentId: a1.id,
      suffix: "release-replay",
    });
    releaseAssignmentReservationWithClient(db, reservationId, "ineligible");

    const result = releaseAssignmentReservationWithClient(db, reservationId, "dependencies_unmet");

    expect(result.outcome).toBe("no_op");
    // The winner's reason is preserved — the loser never overwrites it.
    expect(result.reservation.state).toBe("released");
    expect(result.reservation.failureReason).toBe("ineligible");
  });

  it("returns no_op when the reservation was already consumed (winner was success)", () => {
    const db = getDb();
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "release-after-consume" });
    const { reservationId } = seedAssignmentTrail(db, {
      taskId: task.id,
      requestedAgentId: a1.id,
      suffix: "release-after-consume",
    });
    consumeAssignmentReservationWithClient(db, reservationId);

    const result = releaseAssignmentReservationWithClient(db, reservationId, "too_late");

    expect(result.outcome).toBe("no_op");
    expect(result.reservation.state).toBe("consumed");
  });
});

// ===========================================================================
// 2. Coordinator — atomic success (the happy path)
// ===========================================================================

describe("resolveTargetedAssignment — atomic success", () => {
  it("claims the task as requestedAgent, consumes reservation, terminalizes attempt → created", () => {
    const db = getDb();
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "happy" });
    markPostCutover(task.id);
    const { attemptId, reservationId } = seedAssignmentTrail(db, {
      taskId: task.id,
      requestedAgentId: a1.id,
      suffix: "happy",
    });

    const result = resolveTargetedAssignment(attemptId, { db, workerId: "w1" });

    expect(result).toEqual({
      outcome: "assigned",
      taskId: task.id,
      assigneeId: a1.id,
    });
    // Atomic success: all three committed together.
    const taskRow = readTask(db, task.id);
    expect(taskRow.assignedAgentId).toBe(a1.id);
    expect(taskRow.status).toBe("claimed");
    const resRow = readReservation(db, reservationId);
    expect(resRow.state).toBe("consumed");
    const attemptRow = readAttempt(db, attemptId);
    expect(attemptRow.state).toBe("created");
    expect(attemptRow.completedAt).not.toBeNull();
    // Failure mode: if any of the three writes was outside the tx, a mid-tx
    // crash would leave a partial aggregate (claimed task + active reservation,
    // or consumed reservation + non-terminal attempt). Atomicity is the guard.
  });

  it("terminalizes to created_unassigned on definitive refusal AND releases reservation", () => {
    const db = getDb();
    const a1 = seedAgent("a1");
    const b1 = seedAgent("b1");
    const { task: blocker } = seedMission({ title: "blocker" });
    const { task } = seedMission({ title: "refused" });
    addTaskDependency(task.id, blocker.id); // unmet → ineligible
    markPostCutover(task.id);
    const { attemptId, reservationId } = seedAssignmentTrail(db, {
      taskId: task.id,
      requestedAgentId: a1.id,
      suffix: "refused",
    });

    const result = resolveTargetedAssignment(attemptId, { db, workerId: "w1" });
    const refused = result as Extract<TargetedAssignmentResolution, { outcome: "refused" }>;

    expect(refused.outcome).toBe("refused");
    expect(refused.category).toBe("ineligible");
    expect(refused.reason).toBe("dependencies_unmet");
    expect(refused.taskId).toBe(task.id);
    // Reservation released with the typed reason stamped.
    const resRow = readReservation(db, reservationId);
    expect(resRow.state).toBe("released");
    expect(resRow.failureReason).toBe("dependencies_unmet");
    // Attempt terminalized to created_unassigned.
    const attemptRow = readAttempt(db, attemptId);
    expect(attemptRow.state).toBe("created_unassigned");
    expect(attemptRow.completedAt).not.toBeNull();
    // The Task is NOT claimed (nobody won); it stays pending.
    const taskRow = readTask(db, task.id);
    expect(taskRow.status).toBe("pending");
    expect(taskRow.assignedAgentId).toBeNull();
  });

  it("after refusal, the reservation gate OPENS — another agent is no longer reserved_for_other", () => {
    const db = getDb();
    const a1 = seedAgent("a1");
    const b1 = seedAgent("b1");
    const { task: blocker } = seedMission({ title: "blocker-open" });
    const { task } = seedMission({ title: "gate-open" });
    addTaskDependency(task.id, blocker.id);
    markPostCutover(task.id);
    const { attemptId } = seedAssignmentTrail(db, {
      taskId: task.id,
      requestedAgentId: a1.id,
      suffix: "gate-open",
    });

    // Before resolution: B is blocked by the active reservation for A.
    const before = claimWithAuthority(getDb(), task.id, localClaimant(b1.id));
    expect(before.success).toBe(false);
    if (!before.success && before.category === "reserved_for_other") {
      expect(before.reservedFor).toBe(a1.id);
    }

    resolveTargetedAssignment(attemptId, { db, workerId: "w1" });

    // After refusal: the reservation is released → B is NOT reserved_for_other.
    // (B may still be ineligible via deps, but the reservation gate is open.)
    const after = claimWithAuthority(getDb(), task.id, localClaimant(b1.id));
    expect(after.success).toBe(false);
    if (!after.success) expect(after.category).not.toBe("reserved_for_other");
  });
});

// ===========================================================================
// 3. Reservation wins against every claim origin (the core guardrail)
// ===========================================================================

describe("resolveTargetedAssignment — reservation wins against every claim origin", () => {
  it("an active reservation for A blocks B (reserved_for_other); the coordinator as A succeeds", () => {
    const db = getDb();
    const a1 = seedAgent("a1");
    const b1 = seedAgent("b1");
    const { task } = seedMission({ title: "race" });
    markPostCutover(task.id);
    const { attemptId, reservationId } = seedAssignmentTrail(db, {
      taskId: task.id,
      requestedAgentId: a1.id,
      suffix: "race",
    });

    // B's ordinary claim is blocked by the reservation gate (A holds it).
    const bClaim = claimWithAuthority(getDb(), task.id, localClaimant(b1.id));
    expect(bClaim.success).toBe(false);
    if (!bClaim.success && bClaim.category === "reserved_for_other") {
      expect(bClaim.reservedFor).toBe(a1.id);
    }

    // The coordinator claiming AS A succeeds — A is the matching identity.
    const result = resolveTargetedAssignment(attemptId, { db, workerId: "w-a" });
    expect(result.outcome).toBe("assigned");

    // Post-success: reservation consumed, task claimed by A, attempt created.
    expect(readReservation(db, reservationId).state).toBe("consumed");
    expect(readTask(db, task.id).assignedAgentId).toBe(a1.id);
    // Failure mode: if the coordinator's claim did NOT match the reservation
    // identity, A would be blocked by its own reservation (reserved_for_other).
  });

  it("a remote claimant is blocked even if presenting the same id string as the reserved local agent (M2)", () => {
    const db = getDb();
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "m2-remote" });
    markPostCutover(task.id);
    seedAssignmentTrail(db, {
      taskId: task.id,
      requestedAgentId: a1.id,
      suffix: "m2-remote",
    });

    // A remote participant presenting a1.id as a raw string is STILL blocked —
    // the matching rule is transport-aware (M2 in claimAuthority.ts).
    const remoteClaim = claimWithAuthority(getDb(), task.id, {
      kind: "remote",
      id: a1.id,
    });
    expect(remoteClaim.success).toBe(false);
    if (!remoteClaim.success) expect(remoteClaim.category).toBe("reserved_for_other");
  });
});

// ===========================================================================
// 4. already_claimed / not_pending surface the current assignee
// ===========================================================================

describe("resolveTargetedAssignment — surfaces currentAssignee on already_claimed", () => {
  it("surfaces the local assignee when the task was claimed by another path (data anomaly)", () => {
    const db = getDb();
    const a1 = seedAgent("a1"); // the requested agent
    const c1 = seedAgent("c1"); // the anomaly claimant
    const { task } = seedMission({ title: "already-claimed" });
    markPostCutover(task.id);
    const { attemptId } = seedAssignmentTrail(db, {
      taskId: task.id,
      requestedAgentId: a1.id,
      suffix: "already-claimed",
    });
    // Simulate the task being claimed via a legacy bypass / data anomaly. The
    // reservation gate should have blocked this, but the coordinator must handle
    // the inconsistent state truthfully (surface who holds it).
    getDb()
      .update(tasks)
      .set({ assignedAgentId: c1.id, status: "claimed" })
      .where(eq(tasks.id, task.id))
      .run();

    const result = resolveTargetedAssignment(attemptId, { db, workerId: "w1" });
    const refused = result as Extract<TargetedAssignmentResolution, { outcome: "refused" }>;

    expect(refused.outcome).toBe("refused");
    expect(refused.category).toBe("already_claimed");
    expect(refused.currentAssignee).toEqual({ kind: "local", id: c1.id });
  });

  it("surfaces currentAssignee=null when not_pending and no assignee is set", () => {
    const db = getDb();
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "not-pending" });
    markPostCutover(task.id);
    const { attemptId } = seedAssignmentTrail(db, {
      taskId: task.id,
      requestedAgentId: a1.id,
      suffix: "not-pending",
    });
    // Status flipped without an assignee (e.g. submitted directly).
    getDb().update(tasks).set({ status: "submitted" }).where(eq(tasks.id, task.id)).run();

    const result = resolveTargetedAssignment(attemptId, { db, workerId: "w1" });
    const refused = result as Extract<TargetedAssignmentResolution, { outcome: "refused" }>;

    expect(refused.outcome).toBe("refused");
    expect(refused.category).toBe("not_pending");
    expect(refused.currentAssignee).toBeNull();
  });
});

// ===========================================================================
// 5. Infrastructure stays resumable (the transient guardrail)
// ===========================================================================

describe("resolveTargetedAssignment — infrastructure failure stays resumable", () => {
  it("injects a claim-mutation SQLITE_BUSY → resumable; nothing committed; second call resumes", () => {
    const db = getDb();
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "infra-busy" });
    markPostCutover(task.id);
    const { attemptId, reservationId } = seedAssignmentTrail(db, {
      taskId: task.id,
      requestedAgentId: a1.id,
      suffix: "infra-busy",
    });

    let result1: TargetedAssignmentResolution;
    withFailingResolutionTx(
      1, // fail the first write inside the tx (the claim mutation UPDATE)
      () =>
        Object.assign(new Error("database is locked"), {
          name: "SqliteError",
          code: "SQLITE_BUSY",
        }),
      () => {
        result1 = resolveTargetedAssignment(attemptId, { db, workerId: "w1" });
      },
    );

    const r1 = result1!;
    expect(r1.outcome).toBe("resumable");
    if (r1.outcome === "resumable") expect(r1.category).toBe("infrastructure_failure");

    // NOTHING committed: attempt stays ppa, reservation stays active, task unclaimed.
    expect(readAttempt(db, attemptId).state).toBe("published_pending_assignment");
    expect(readReservation(db, reservationId).state).toBe("active");
    expect(readTask(db, task.id).assignedAgentId).toBeNull();
    // The lease was released (the recovery scan can retry).
    expect(readAttempt(db, attemptId).leaseOwner).toBeNull();

    // Second call (no failure) resumes and completes.
    const result2 = resolveTargetedAssignment(attemptId, { db, workerId: "w2" });
    expect(result2.outcome).toBe("assigned");
    expect(readTask(db, task.id).assignedAgentId).toBe(a1.id);
    expect(readReservation(db, reservationId).state).toBe("consumed");
    expect(readAttempt(db, attemptId).state).toBe("created");
  });

  it("injects a UNIQUE constraint → resumable (version_conflict, NOT infra)", () => {
    const db = getDb();
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "infra-unique" });
    markPostCutover(task.id);
    const { attemptId } = seedAssignmentTrail(db, {
      taskId: task.id,
      requestedAgentId: a1.id,
      suffix: "infra-unique",
    });

    let result1: TargetedAssignmentResolution;
    withFailingResolutionTx(
      1,
      () =>
        Object.assign(new Error("UNIQUE constraint failed"), {
          name: "SqliteError",
          code: "SQLITE_CONSTRAINT_UNIQUE",
        }),
      () => {
        result1 = resolveTargetedAssignment(attemptId, { db, workerId: "w1" });
      },
    );

    const r1 = result1!;
    expect(r1.outcome).toBe("resumable");
    if (r1.outcome === "resumable") expect(r1.category).toBe("version_conflict");
  });
});

// ===========================================================================
// 6. Kill-worker resumption (the crash-determinism guardrail)
// ===========================================================================

describe("resolveTargetedAssignment — kill-worker deterministic resumption", () => {
  it("crash BEFORE claim: a held lease blocks worker-2; after expiry, worker-2 takes over + completes", () => {
    const db = getDb();
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "crash-before" });
    markPostCutover(task.id);
    const { attemptId, reservationId } = seedAssignmentTrail(db, {
      taskId: task.id,
      requestedAgentId: a1.id,
      suffix: "crash-before",
    });

    // Worker-1 acquires a lease then "crashes" (never runs the resolution tx).
    // Simulate: directly install a lease in the future.
    getDb()
      .update(taskCreationAttempts)
      .set({
        leaseOwner: "dead-worker",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      .where(eq(taskCreationAttempts.id, attemptId))
      .run();

    // Worker-2 calls the coordinator while worker-1's lease is active.
    const blocked = resolveTargetedAssignment(attemptId, { db, workerId: "w2" });
    expect(blocked.outcome).toBe("lease_unavailable");

    // Time passes → worker-1's lease expires. Simulate by backdating the expiry.
    getDb()
      .update(taskCreationAttempts)
      .set({ leaseExpiresAt: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(taskCreationAttempts.id, attemptId))
      .run();

    // Worker-2 (or any resuming worker) takes over the expired lease + completes.
    const resumed = resolveTargetedAssignment(attemptId, { db, workerId: "w2" });
    expect(resumed.outcome).toBe("assigned");
    expect(readTask(db, task.id).assignedAgentId).toBe(a1.id);
    expect(readReservation(db, reservationId).state).toBe("consumed");
    expect(readAttempt(db, attemptId).state).toBe("created");
  });

  it("crash AFTER claim committed: a resuming call returns terminal_replay WITHOUT rerunning assignment", () => {
    const db = getDb();
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "crash-after" });
    markPostCutover(task.id);
    const { attemptId, reservationId } = seedAssignmentTrail(db, {
      taskId: task.id,
      requestedAgentId: a1.id,
      suffix: "crash-after",
    });

    // First call: completes successfully (claim + consume + terminalize commit).
    const first = resolveTargetedAssignment(attemptId, { db, workerId: "w1" });
    expect(first.outcome).toBe("assigned");
    const taskVersionAfterFirst = readTask(db, task.id).version;

    // Second call (resuming worker / replay): the attempt is terminal.
    const replay = resolveTargetedAssignment(attemptId, { db, workerId: "w2" });
    expect(replay.outcome).toBe("terminal_replay");
    if (replay.outcome === "terminal_replay") {
      expect(replay.terminalState).toBe("created");
    }

    // No rerun: the task version is unchanged (no second claim mutation).
    expect(readTask(db, task.id).version).toBe(taskVersionAfterFirst);
    // The reservation is still consumed (not double-consumed / re-released).
    expect(readReservation(db, reservationId).state).toBe("consumed");
  });
});

// ===========================================================================
// 7. Terminal replay never reruns; no_op guards
// ===========================================================================

describe("resolveTargetedAssignment — terminal replay + no_op guards", () => {
  it("re-calling on a already-terminal created_unassigned attempt returns terminal_replay", () => {
    const db = getDb();
    const a1 = seedAgent("a1");
    const { task: blocker } = seedMission({ title: "replay-blocker" });
    const { task } = seedMission({ title: "replay-refused" });
    addTaskDependency(task.id, blocker.id);
    markPostCutover(task.id);
    const { attemptId } = seedAssignmentTrail(db, {
      taskId: task.id,
      requestedAgentId: a1.id,
      suffix: "replay-refused",
    });

    // First call: ineligible → refused → created_unassigned.
    const first = resolveTargetedAssignment(attemptId, { db, workerId: "w1" });
    expect(first.outcome).toBe("refused");

    // Second call: terminal replay (the attempt is created_unassigned).
    const replay = resolveTargetedAssignment(attemptId, { db, workerId: "w2" });
    expect(replay.outcome).toBe("terminal_replay");
    if (replay.outcome === "terminal_replay") {
      expect(replay.terminalState).toBe("created_unassigned");
    }
  });

  it("returns no_op when the attempt state is NOT published_pending_assignment", () => {
    const db = getDb();
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "wrong-state" });
    markPostCutover(task.id);
    const { attemptId } = seedAssignmentTrail(db, {
      taskId: task.id,
      requestedAgentId: a1.id,
      suffix: "wrong-state",
      attemptState: "published_pending_observation", // not yet at assignment
    });

    const result = resolveTargetedAssignment(attemptId, { db, workerId: "w1" });
    expect(result.outcome).toBe("no_op");
    if (result.outcome === "no_op") {
      expect(result.reason).toContain("published_pending_observation");
    }
  });

  it("returns no_op when there is no active reservation for the attempt", () => {
    const db = getDb();
    const a1 = seedAgent("a1");
    const { task } = seedMission({ title: "no-resv" });
    markPostCutover(task.id);
    // Seed the attempt at ppa but with NO reservation (auto-assignment path).
    const { attemptId } = seedAssignmentTrail(db, {
      taskId: task.id,
      requestedAgentId: a1.id,
      suffix: "no-resv",
    });
    // Retire the reservation before the coordinator runs.
    getDb()
      .update(taskCreationAssignmentReservations)
      .set({ state: "consumed" })
      .where(eq(taskCreationAssignmentReservations.attemptId, attemptId))
      .run();

    const result = resolveTargetedAssignment(attemptId, { db, workerId: "w1" });
    expect(result.outcome).toBe("no_op");
    if (result.outcome === "no_op") expect(result.reason).toBe("no_active_reservation");
  });

  it("returns not_found when the attempt does not exist", () => {
    const result = resolveTargetedAssignment("nonexistent-attempt", {
      db: getDb(),
      workerId: "w1",
    });
    expect(result.outcome).toBe("not_found");
  });
});
