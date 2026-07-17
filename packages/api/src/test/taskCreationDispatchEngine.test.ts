/**
 * Dispatch Engine — observation advancement + lease-based dispatcher invariant
 * tests (T4A Phase 2).
 *
 * DORMANT: no production origin creates post-cutover Tasks until cutover, so no
 * caller drives this engine in production. This test proves the load-bearing
 * invariants the Phase 3 claim gate will rely on. Each test is a discriminating
 * probe: it FAILS without the Phase 2 implementation (matrix edge missing,
 * primitive missing, or wrong policy) and PASSES after.
 *
 * Contract invariants covered:
 *  1. Matrix widening: `published_pending_observation → created` legal;
 *     `→ created_unassigned` rejected; `pending → created` rejected (R1 intact).
 *  2. hasActiveReservationForAttempt: none/active/consumed/other-attempt.
 *  3. satisfyObservationCheckpoint: zero-target fast path (created vs
 *     published_pending_assignment); not_satisfiable; not_at_observation;
 *     all-accepted advance; CAS-race no_op.
 *  4. processEnvelopeDispatch: zero-target fast path; all-accepted via adapter;
 *     unregistered targetKind → attention (Task stays unavailable); idempotent
 *     re-process; lease-protected (held_by_other, no redundant adapter calls);
 *     safe takeover; crash-resumable (accepted target not re-attempted).
 *  5. listAttemptsPendingObservation: filters + bounded (limit/offset).
 *
 * See the T4A ticket § "Phase 2 grounding" and "Contract invariants".
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  taskCreationAttempts,
  taskCreationEnvelopes,
  taskCreationDispatchTargets,
  taskCreationAssignmentReservations,
} from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { TaskPublicationDbClient } from "../repositories/taskPublication.js";
import {
  completeAttemptWithClient,
  hasActiveReservationForAttemptWithClient,
} from "../repositories/taskPublication.js";
import {
  satisfyObservationCheckpointWithClient,
  processEnvelopeDispatchWithClient,
  listAttemptsPendingObservationWithClient,
} from "../services/taskCreationDispatchEngine.js";
import { registerDispatchAdapter } from "../services/taskCreationDispatchRegistry.js";

beforeEach(async () => {
  await initTestDb();
});

afterEach(() => closeDb());

// ---------------------------------------------------------------------------
// Seed helpers (minimal — attempts/envelopes/targets/reservations only;
// envelope.task_id/habitat_id are plain text, no FK to tasks/missions/habitats)
// ---------------------------------------------------------------------------

function seedAttempt(
  db: TaskPublicationDbClient,
  overrides: { id?: string; state?: string; suffix?: string } = {},
): string {
  const id = overrides.id ?? `attempt-${overrides.suffix ?? uuid().slice(0, 8)}`;
  db.insert(taskCreationAttempts)
    .values({
      id,
      source: "test",
      sourceScopeKind: "mission",
      sourceScopeId: "m-dispatch-engine-test",
      attemptKey: `key-${id}`,
      requestFingerprint: `fp-${id}`,
      publicationKind: "create",
      actorType: "human",
      actorId: "user-1",
      state: (overrides.state ?? "published_pending_observation") as never,
    })
    .run();
  return id;
}

function seedEnvelope(
  db: TaskPublicationDbClient,
  opts: { eventId?: string; attemptId: string },
): string {
  const eventId = opts.eventId ?? `evt-${uuid().slice(0, 8)}`;
  db.insert(taskCreationEnvelopes)
    .values({
      eventId,
      lifecycleAction: "created",
      taskId: `task-${eventId}`,
      habitatId: "habitat-dispatch-engine-test",
      occurredAt: new Date().toISOString(),
      attemptId: opts.attemptId,
      actorType: "human",
      actorId: "user-1",
      source: "test",
    })
    .run();
  return eventId;
}

interface SeedTargetOpts {
  id?: string;
  eventId: string;
  targetKind?: string;
  targetKey?: string;
  state?: "pending" | "accepted" | "attention";
}

function seedTarget(db: TaskPublicationDbClient, opts: SeedTargetOpts): string {
  const id = opts.id ?? `target-${uuid()}`;
  db.insert(taskCreationDispatchTargets)
    .values({
      id,
      eventId: opts.eventId,
      targetKind: opts.targetKind ?? "test_kind",
      targetKey: opts.targetKey ?? `key-${id}`,
      state: opts.state ?? "pending",
    })
    .run();
  return id;
}

function seedReservation(
  db: TaskPublicationDbClient,
  opts: { attemptId: string; state?: "active" | "consumed" | "released" | "expired" },
): string {
  const id = `res-${uuid()}`;
  db.insert(taskCreationAssignmentReservations)
    .values({
      id,
      taskId: `task-res-${opts.attemptId}`,
      attemptId: opts.attemptId,
      requestedAgentId: "agent-1",
      deadline: new Date(Date.now() + 60_000).toISOString(),
      state: opts.state ?? "active",
    })
    .run();
  return id;
}

/**
 * Deterministic competing-writer probe (the R5 CAS-race simulation). Mirrors
 * the Phase 1 / T3A pattern: the FIRST `update(...).run()` on the wrapped
 * client invokes `inject()` BEFORE delegating the real UPDATE — reproducing a
 * concurrent writer that mutates the row between the function's in-tx read and
 * its conditional UPDATE. On single-threaded sql.js the read and UPDATE always
 * agree otherwise, so the CAS race is only reachable via this injection.
 */
function withCompetingWrite<T extends TaskPublicationDbClient>(realDb: T, inject: () => void): T {
  const wrapBuilder = (builder: unknown, onRun: () => void): unknown =>
    new Proxy(builder as object, {
      get(target, prop) {
        if (prop === "run") {
          return (...args: unknown[]) => {
            onRun();
            return (target as { run: (...a: unknown[]) => unknown }).run(...args);
          };
        }
        const value = (target as Record<string | symbol, unknown>)[prop];
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            const result = (value as (...a: unknown[]) => unknown).apply(target, args);
            return result && typeof result === "object" ? wrapBuilder(result, onRun) : result;
          };
        }
        return value;
      },
    });

  return new Proxy(realDb, {
    get(target, prop) {
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (prop === "update") {
        return (...args: unknown[]) =>
          wrapBuilder((target as { update: (...a: unknown[]) => unknown }).update(...args), inject);
      }
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  }) as T;
}

/** Read the authoritative attempt row for an assertion. */
function readAttempt(db: TaskPublicationDbClient, attemptId: string) {
  return db
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.id, attemptId))
    .all()[0];
}

// ===========================================================================
// 1. Matrix widening (isLegalTerminalForward) — the existing-symbol change
// ===========================================================================

describe("Matrix widening: isLegalTerminalForward (via completeAttemptWithClient)", () => {
  it("published_pending_observation → created is now LEGAL (completed)", () => {
    const db = getDb();
    const id = seedAttempt(db, { state: "published_pending_observation" });

    const result = completeAttemptWithClient(db, id, {
      finalState: "created",
      terminalOutcome: "published",
    });

    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;
    expect(result.attempt.state).toBe("created");
    expect(result.attempt.completedAt).not.toBeNull();
  });

  it("published_pending_observation → created_unassigned is still REJECTED", () => {
    const db = getDb();
    const id = seedAttempt(db, { state: "published_pending_observation" });

    const result = completeAttemptWithClient(db, id, {
      finalState: "created_unassigned",
      terminalOutcome: "published",
    });

    // Without the widening this would ALSO be rejected, but the widening is a
    // STRICT widening: created_unassigned stays illegal (assignment-exhaustion
    // is reached from published_pending_assignment, not observation).
    expect(result.outcome).toBe("rejected_transition");
    if (result.outcome !== "rejected_transition") return;
    expect(result.fromState).toBe("published_pending_observation");
    expect(result.toFinalState).toBe("created_unassigned");
  });

  it("pending → created is still REJECTED (R1 gate-bypass rejection intact)", () => {
    const db = getDb();
    const id = seedAttempt(db, { state: "pending" });

    const result = completeAttemptWithClient(db, id, {
      finalState: "created",
      terminalOutcome: "published",
    });

    expect(result.outcome).toBe("rejected_transition");
    if (result.outcome !== "rejected_transition") return;
    expect(result.fromState).toBe("pending");
  });

  it("pending → created_unassigned is still REJECTED", () => {
    const db = getDb();
    const id = seedAttempt(db, { state: "pending" });

    const result = completeAttemptWithClient(db, id, {
      finalState: "created_unassigned",
      terminalOutcome: "published",
    });

    expect(result.outcome).toBe("rejected_transition");
  });
});

// ===========================================================================
// 2. hasActiveReservationForAttemptWithClient
// ===========================================================================

describe("hasActiveReservationForAttemptWithClient", () => {
  it("returns false when no reservation exists", () => {
    const db = getDb();
    const attemptId = seedAttempt(db);
    expect(hasActiveReservationForAttemptWithClient(db, attemptId)).toBe(false);
  });

  it("returns true when an active reservation exists for the attempt", () => {
    const db = getDb();
    const attemptId = seedAttempt(db);
    seedReservation(db, { attemptId, state: "active" });

    expect(hasActiveReservationForAttemptWithClient(db, attemptId)).toBe(true);
  });

  it("returns false when the reservation is consumed (not active)", () => {
    const db = getDb();
    const attemptId = seedAttempt(db);
    seedReservation(db, { attemptId, state: "consumed" });

    expect(hasActiveReservationForAttemptWithClient(db, attemptId)).toBe(false);
  });

  it("returns false when the active reservation is for a DIFFERENT attempt", () => {
    const db = getDb();
    const attemptA = seedAttempt(db);
    const attemptB = seedAttempt(db);
    seedReservation(db, { attemptId: attemptA, state: "active" });

    expect(hasActiveReservationForAttemptWithClient(db, attemptB)).toBe(false);
  });
});

// ===========================================================================
// 3. satisfyObservationCheckpointWithClient
// ===========================================================================

describe("satisfyObservationCheckpointWithClient", () => {
  it("zero-target fast path, NO reservation → advanced to created", () => {
    const db = getDb();
    const attemptId = seedAttempt(db);
    seedEnvelope(db, { attemptId }); // zero targets

    const result = satisfyObservationCheckpointWithClient(db, attemptId);

    expect(result.outcome).toBe("advanced");
    if (result.outcome !== "advanced") return;
    expect(result.transition.outcome).toBe("completed");
    expect(readAttempt(db, attemptId).state).toBe("created");
  });

  it("zero-target fast path, ACTIVE reservation → advanced to published_pending_assignment", () => {
    const db = getDb();
    const attemptId = seedAttempt(db);
    seedEnvelope(db, { attemptId });
    seedReservation(db, { attemptId, state: "active" });

    const result = satisfyObservationCheckpointWithClient(db, attemptId);

    expect(result.outcome).toBe("advanced");
    if (result.outcome !== "advanced") return;
    expect(result.transition.outcome).toBe("transitioned");
    expect(readAttempt(db, attemptId).state).toBe("published_pending_assignment");
  });

  it("one pending target → not_satisfiable (no advance)", () => {
    const db = getDb();
    const attemptId = seedAttempt(db);
    const eventId = seedEnvelope(db, { attemptId });
    seedTarget(db, { eventId, state: "pending" });

    const result = satisfyObservationCheckpointWithClient(db, attemptId);

    expect(result.outcome).toBe("not_satisfiable");
    expect(readAttempt(db, attemptId).state).toBe("published_pending_observation");
  });

  it("one attention target → not_satisfiable (no advance)", () => {
    const db = getDb();
    const attemptId = seedAttempt(db);
    const eventId = seedEnvelope(db, { attemptId });
    seedTarget(db, { eventId, state: "attention" });

    const result = satisfyObservationCheckpointWithClient(db, attemptId);

    expect(result.outcome).toBe("not_satisfiable");
  });

  it("all targets accepted → advanced", () => {
    const db = getDb();
    const attemptId = seedAttempt(db);
    const eventId = seedEnvelope(db, { attemptId });
    seedTarget(db, { eventId, targetKind: "a", state: "accepted" });
    seedTarget(db, { eventId, targetKind: "b", state: "accepted" });

    const result = satisfyObservationCheckpointWithClient(db, attemptId);

    expect(result.outcome).toBe("advanced");
    expect(readAttempt(db, attemptId).state).toBe("created");
  });

  it("not at observation (already at published_pending_assignment) + all accepted → not_at_observation", () => {
    const db = getDb();
    const attemptId = seedAttempt(db, { state: "published_pending_assignment" });
    const eventId = seedEnvelope(db, { attemptId });
    seedTarget(db, { eventId, state: "accepted" });

    const result = satisfyObservationCheckpointWithClient(db, attemptId);

    expect(result.outcome).toBe("not_at_observation");
    expect(readAttempt(db, attemptId).state).toBe("published_pending_assignment");
  });

  it("CAS-race: a concurrent writer advances the attempt first → no_op", () => {
    const db = getDb();
    const attemptId = seedAttempt(db);
    seedEnvelope(db, { attemptId });
    seedReservation(db, { attemptId, state: "active" });

    let injected = false;
    const probed = withCompetingWrite(db, () => {
      // A concurrent worker checkpoints the attempt to
      // published_pending_assignment BEFORE this call's CAS UPDATE fires.
      injected = true;
      db.update(taskCreationAttempts)
        .set({ state: "published_pending_assignment" })
        .where(eq(taskCreationAttempts.id, attemptId))
        .run();
    });

    const result = satisfyObservationCheckpointWithClient(probed, attemptId);

    expect(injected).toBe(true);
    // The checkpoint CAS matched zero rows (state is no longer
    // published_pending_observation) → the primitive returns no_op.
    expect(result.outcome).toBe("no_op");
  });

  it("M1 guard: TWO envelopes for one attempt → throws (no silent wrong-envelope pick)", () => {
    const db = getDb();
    const attemptId = seedAttempt(db);
    seedEnvelope(db, { attemptId });
    seedEnvelope(db, { attemptId }); // second envelope — a data-integrity anomaly

    // Failure mode this catches: without the envelopeForAttempt uniqueness
    // guard, the engine silently resolves `.all()[0]` (the first row) and
    // processes only it — a future second-envelope writer would be invisible.
    expect(() => satisfyObservationCheckpointWithClient(db, attemptId)).toThrow(
      /data-integrity anomaly \(M1 guard\)/,
    );
  });
});

// ===========================================================================
// 4. processEnvelopeDispatchWithClient
// ===========================================================================

describe("processEnvelopeDispatchWithClient", () => {
  it("zero-target fast path, NO reservation → dispatched + observation advanced to created", () => {
    const db = getDb();
    const attemptId = seedAttempt(db);
    seedEnvelope(db, { attemptId });

    const result = processEnvelopeDispatchWithClient(db, attemptId);

    expect(result.outcome).toBe("dispatched");
    if (result.outcome !== "dispatched") return;
    expect(result.targets).toHaveLength(0);
    expect(result.observation.outcome).toBe("advanced");
    expect(readAttempt(db, attemptId).state).toBe("created");
  });

  it("all targets accepted via a registered adapter → observation advanced", () => {
    const db = getDb();
    const attemptId = seedAttempt(db);
    const eventId = seedEnvelope(db, { attemptId });
    const kind = `accept-${uuid()}`;
    seedTarget(db, { eventId, targetKind: kind, state: "pending" });
    registerDispatchAdapter({
      targetKind: kind,
      attempt: () => ({ outcome: "accepted" }),
    });

    const result = processEnvelopeDispatchWithClient(db, attemptId);

    expect(result.outcome).toBe("dispatched");
    if (result.outcome !== "dispatched") return;
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].outcome).toBe("transitioned");
    expect(result.targets[0].target.state).toBe("accepted");
    expect(result.observation.outcome).toBe("advanced");
    expect(readAttempt(db, attemptId).state).toBe("created");
  });

  it("unregistered targetKind → attention; Task stays unavailable (observation not_satisfiable)", () => {
    const db = getDb();
    const attemptId = seedAttempt(db);
    const eventId = seedEnvelope(db, { attemptId });
    const unknownKind = `unknown-${uuid()}`;
    seedTarget(db, { eventId, targetKind: unknownKind, state: "pending" });

    const result = processEnvelopeDispatchWithClient(db, attemptId);

    expect(result.outcome).toBe("dispatched");
    if (result.outcome !== "dispatched") return;
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].outcome).toBe("transitioned");
    expect(result.targets[0].target.state).toBe("attention");
    expect(result.targets[0].target.lastError).toContain(unknownKind);
    // The target is NOT accepted → observation cannot be satisfied → the Task
    // stays UNAVAILABLE (NO silent claimability).
    expect(result.observation.outcome).toBe("not_satisfiable");
    expect(readAttempt(db, attemptId).state).toBe("published_pending_observation");
  });

  it("registered adapter returning attention → attention recorded; observation not_satisfiable", () => {
    const db = getDb();
    const attemptId = seedAttempt(db);
    const eventId = seedEnvelope(db, { attemptId });
    const kind = `fail-${uuid()}`;
    seedTarget(db, { eventId, targetKind: kind, state: "pending" });
    registerDispatchAdapter({
      targetKind: kind,
      attempt: () => ({ outcome: "attention", error: "downstream timeout" }),
    });

    const result = processEnvelopeDispatchWithClient(db, attemptId);

    if (result.outcome !== "dispatched") throw new Error("expected dispatched");
    expect(result.targets[0].target.state).toBe("attention");
    expect(result.targets[0].target.lastError).toBe("downstream timeout");
    expect(result.observation.outcome).toBe("not_satisfiable");
  });

  it("idempotent: re-processing an all-accepted envelope (reservation path) is a no-op on the second pass", () => {
    const db = getDb();
    const attemptId = seedAttempt(db);
    const eventId = seedEnvelope(db, { attemptId });
    const kind = `idem-${uuid()}`;
    seedTarget(db, { eventId, targetKind: kind, state: "pending" });
    seedReservation(db, { attemptId, state: "active" });
    let calls = 0;
    registerDispatchAdapter({
      targetKind: kind,
      attempt: () => {
        calls += 1;
        return { outcome: "accepted" };
      },
    });

    // First pass: adapter accepts the target → observation advances to
    // published_pending_assignment (non-terminal, reservation path).
    const first = processEnvelopeDispatchWithClient(db, attemptId);
    if (first.outcome !== "dispatched") throw new Error("expected dispatched");
    expect(first.observation.outcome).toBe("advanced");
    expect(calls).toBe(1);
    expect(readAttempt(db, attemptId).state).toBe("published_pending_assignment");

    // Second pass: the target is already accepted (NOT re-attempted); the
    // attempt is no longer at observation (no re-advance).
    const second = processEnvelopeDispatchWithClient(db, attemptId);
    if (second.outcome !== "dispatched") throw new Error("expected dispatched");
    expect(second.targets).toHaveLength(0);
    expect(second.observation.outcome).toBe("not_at_observation");
    expect(calls).toBe(1); // adapter NOT called again
    expect(readAttempt(db, attemptId).state).toBe("published_pending_assignment");
  });

  it("lease-protected: a second worker on an active lease → lease_unavailable (held_by_other, no adapter call)", () => {
    const db = getDb();
    const attemptId = seedAttempt(db);
    const eventId = seedEnvelope(db, { attemptId });
    const kind = `held-${uuid()}`;
    seedTarget(db, { eventId, targetKind: kind, state: "pending" });
    let calls = 0;
    registerDispatchAdapter({
      targetKind: kind,
      attempt: () => {
        calls += 1;
        return { outcome: "accepted" };
      },
    });

    // Worker A holds an ACTIVE (unexpired) lease — emulate an in-flight worker
    // by writing the lease columns directly (worker A is mid-process, not yet
    // released).
    const future = new Date(Date.now() + 60_000).toISOString();
    db.update(taskCreationAttempts)
      .set({ leaseOwner: "worker-A", leaseExpiresAt: future })
      .where(eq(taskCreationAttempts.id, attemptId))
      .run();

    // Worker B tries to process → the lease is not free → held_by_other.
    const result = processEnvelopeDispatchWithClient(db, attemptId, { workerId: "worker-B" });

    expect(result.outcome).toBe("lease_unavailable");
    if (result.outcome !== "lease_unavailable") return;
    expect(result.acquire.outcome).toBe("held_by_other");
    expect(calls).toBe(0); // NO adapter call — no redundant work
    // Attempt untouched.
    expect(readAttempt(db, attemptId).state).toBe("published_pending_observation");
  });

  it("safe takeover: an EXPIRED lease is taken over by worker B → dispatched", () => {
    const db = getDb();
    const attemptId = seedAttempt(db);
    const eventId = seedEnvelope(db, { attemptId });
    const kind = `takeover-${uuid()}`;
    seedTarget(db, { eventId, targetKind: kind, state: "pending" });
    registerDispatchAdapter({
      targetKind: kind,
      attempt: () => ({ outcome: "accepted" }),
    });

    // Worker A held the lease but it has EXPIRED (backdate to the past).
    const past = new Date(Date.now() - 60_000).toISOString();
    db.update(taskCreationAttempts)
      .set({ leaseOwner: "worker-A", leaseExpiresAt: past })
      .where(eq(taskCreationAttempts.id, attemptId))
      .run();

    // Worker B takes over the expired lease (safe takeover).
    const result = processEnvelopeDispatchWithClient(db, attemptId, { workerId: "worker-B" });

    expect(result.outcome).toBe("dispatched");
    if (result.outcome !== "dispatched") return;
    expect(result.observation.outcome).toBe("advanced");
    expect(readAttempt(db, attemptId).state).toBe("created");
  });

  it("crash-resumable: a target accepted before the crash is NOT re-attempted; observation advances on resume", () => {
    const db = getDb();
    const attemptId = seedAttempt(db);
    const eventId = seedEnvelope(db, { attemptId });
    const kindA = `crash-a-${uuid()}`;
    const kindB = `crash-b-${uuid()}`;
    const tA = seedTarget(db, { eventId, targetKind: kindA, state: "pending" });
    seedTarget(db, { eventId, targetKind: kindB, state: "pending" });
    let calls = 0;
    registerDispatchAdapter({
      targetKind: kindA,
      attempt: () => {
        calls += 1;
        return { outcome: "accepted" };
      },
    });
    registerDispatchAdapter({
      targetKind: kindB,
      attempt: () => ({ outcome: "accepted" }),
    });

    // Simulate a crash AFTER target A was accepted (but before the engine ran):
    // manually accept target A as if a prior worker had processed it.
    db.update(taskCreationDispatchTargets)
      .set({ state: "accepted", acceptedAt: new Date().toISOString() })
      .where(eq(taskCreationDispatchTargets.id, tA))
      .run();

    // Resume: the engine processes the remaining target B, then advances.
    const result = processEnvelopeDispatchWithClient(db, attemptId);

    if (result.outcome !== "dispatched") throw new Error("expected dispatched");
    // Only target B was outstanding (A is accepted → skipped → NOT re-attempted).
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].target.targetKind).toBe(kindB);
    expect(calls).toBe(0); // adapter for A was NOT called on resume
    expect(result.observation.outcome).toBe("advanced");
    expect(readAttempt(db, attemptId).state).toBe("created");
  });

  it("not_found: an unknown attemptId → not_found", () => {
    const db = getDb();
    const result = processEnvelopeDispatchWithClient(db, "no-such-attempt");
    expect(result.outcome).toBe("not_found");
  });
});

// ===========================================================================
// 5. listAttemptsPendingObservationWithClient
// ===========================================================================

describe("listAttemptsPendingObservationWithClient", () => {
  it("returns only attempts at published_pending_observation", () => {
    const db = getDb();
    const obs1 = seedAttempt(db, { state: "published_pending_observation" });
    seedAttempt(db, { state: "pending" });
    seedAttempt(db, { state: "created" });
    const obs2 = seedAttempt(db, { state: "published_pending_observation" });

    const result = listAttemptsPendingObservationWithClient(db);

    const ids = result.map((r) => r.id);
    expect(ids).toContain(obs1);
    expect(ids).toContain(obs2);
    expect(result.every((r) => r.state === "published_pending_observation")).toBe(true);
  });

  it("bounded: limit caps the page size", () => {
    const db = getDb();
    seedAttempt(db, { state: "published_pending_observation" });
    seedAttempt(db, { state: "published_pending_observation" });
    seedAttempt(db, { state: "published_pending_observation" });

    const result = listAttemptsPendingObservationWithClient(db, { limit: 2 });
    expect(result).toHaveLength(2);
  });

  it("offset paginates past earlier rows", () => {
    const db = getDb();
    seedAttempt(db, { state: "published_pending_observation" });
    seedAttempt(db, { state: "published_pending_observation" });
    seedAttempt(db, { state: "published_pending_observation" });

    const page1 = listAttemptsPendingObservationWithClient(db, { limit: 2, offset: 0 });
    const page2 = listAttemptsPendingObservationWithClient(db, { limit: 2, offset: 2 });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(1);
    // No overlap between pages.
    const page1Ids = new Set(page1.map((r) => r.id));
    expect(page2.every((r) => !page1Ids.has(r.id))).toBe(true);
  });

  it("returns an empty array when no attempts are at observation", () => {
    const db = getDb();
    seedAttempt(db, { state: "pending" });

    expect(listAttemptsPendingObservationWithClient(db)).toEqual([]);
  });
});
