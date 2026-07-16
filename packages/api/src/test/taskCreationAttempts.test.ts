/**
 * T3A Phase 1 — task-creation attempt reservation, dedup, and replay.
 *
 * Exercises the load-bearing reservation guardrails against the REAL test DB
 * (sql.js — SQLite semantics, including UNIQUE constraints, behave identically
 * to production better-sqlite3). Each test states the SPECIFIC failure mode
 * that would break its assertion (proving it is not tautological), matching
 * the T1 `taskPublicationFailureInjection.test.ts` convention.
 *
 * Out of scope: the transition state matrix (Phase 2), worker leases / GET
 * route / retention (Phase 3). The primitives here are DORMANT — no production
 * origin routes through them yet.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { taskCreationAttempts, missions } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import {
  reserveAttempt,
  reserveAttemptWithClient,
  getAttemptStatus,
  type ReserveAttemptInput,
} from "../repositories/taskCreationAttempts.js";
import type { TaskPublicationDbClient } from "../repositories/taskPublication.js";

let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  const habitat = habitatRepo.createHabitat({ name: "Reservation Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
});

afterEach(() => closeDb());

// ---------------------------------------------------------------------------
// Seeders / fixtures
// ---------------------------------------------------------------------------

/** Canonical reservation input; callers override individual fields. */
function baseInput(overrides: Partial<ReserveAttemptInput> = {}): ReserveAttemptInput {
  return {
    source: "ui",
    sourceScopeKind: "mission",
    sourceScopeId: "m-1",
    attemptKey: "key-1",
    requestFingerprint: "fp-1",
    publicationKind: "create",
    actorType: "human",
    actorId: "user-1",
    ...overrides,
  };
}

/** Seeds a mission row and returns its id. */
function seedMission(title = "reservation-mission"): string {
  return missionRepo.createMission({
    habitatId,
    columnId,
    title,
    createdBy: "user-1",
  }).id;
}

/** Cast a wrapper to the union type accepted by `reserveAttemptWithClient`. */
function asClient<T>(w: T): TaskPublicationDbClient {
  return w as unknown as TaskPublicationDbClient;
}

/**
 * Read-miss wrapper: makes the first N `.select()` chains return an empty
 * result (`.get()` → undefined, `.all()` → []), then delegates everything
 * (inserts / updates / later selects) to the REAL inner client. This
 * deterministically simulates the race window where the reservation pre-check
 * SELECT missed a concurrently-committed same-key row, forcing the INSERT to
 * hit the UNIQUE index and the catch branch to run. Mirrors the philosophy of
 * `FailingDbClient` (write-failure injection) for read-miss injection.
 */
class PreCheckMissClient {
  selectCount = 0;
  constructor(
    public readonly inner: TaskPublicationDbClient,
    public readonly missFirstNSelects = 1,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(...args: any[]): any {
    this.selectCount += 1;
    if (this.selectCount <= this.missFirstNSelects) {
      const miss: Record<string, unknown> = {};
      miss.from = () => miss;
      miss.where = () => miss;
      miss.groupBy = () => miss;
      miss.orderBy = () => miss;
      miss.limit = () => miss;
      miss.get = () => undefined;
      miss.all = () => [];
      return miss;
    }
    return (this.inner as unknown as { select: (...a: unknown[]) => unknown }).select(...args);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(t: any): any {
    return (this.inner as unknown as { insert: (t: unknown) => unknown }).insert(t);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(t: any): any {
    return (this.inner as unknown as { update: (t: unknown) => unknown }).update(t);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete(t: any): any {
    return (this.inner as unknown as { delete: (t: unknown) => unknown }).delete(t);
  }
}

/** Counts attempts rows currently in the DB (used for no-new-row assertions). */
function attemptRowCount(): number {
  return getDb().select().from(taskCreationAttempts).all().length;
}

// ---------------------------------------------------------------------------
// 1. Fresh reservation → pending attempt, reservedAt set, unique key.
// ---------------------------------------------------------------------------

describe("fresh reservation", () => {
  it("creates a pending attempt with reservedAt set and the reservation key stored verbatim", () => {
    const before = attemptRowCount();
    const result = reserveAttempt(baseInput());

    expect(result.outcome).toBe("created");
    const { attempt } = result;
    expect(attempt.state).toBe("pending");
    expect(attempt.source).toBe("ui");
    expect(attempt.sourceScopeKind).toBe("mission");
    expect(attempt.sourceScopeId).toBe("m-1");
    expect(attempt.attemptKey).toBe("key-1");
    expect(attempt.requestFingerprint).toBe("fp-1");
    expect(attempt.publicationKind).toBe("create");
    expect(attempt.actorType).toBe("human");
    expect(attempt.actorId).toBe("user-1");
    // reservedAt is stamped by the DB default (datetime('now')) — must be set.
    expect(attempt.reservedAt).toBeTruthy();
    // A freshly reserved attempt has no checkpoint / committed / terminal data.
    expect(attempt.publishedAt).toBeNull();
    expect(attempt.committedTaskId).toBeNull();
    expect(attempt.terminalOutcome).toBeNull();
    expect(attempt.completedAt).toBeNull();
    // Exactly one new row.
    expect(attemptRowCount()).toBe(before + 1);

    // **Failure mode that breaks this assertion**: if the primitive failed to
    // set state="pending" / stamp reservedAt / store the reservation key, OR
    // inserted more than one row, the state/reservedAt/key/row-count checks
    // would diverge.
  });

  it("persists causalContext when supplied and leaves it null when omitted", () => {
    const withCtx = reserveAttempt(
      baseInput({
        attemptKey: "key-ctx",
        causalContext: {
          root: { type: "user", id: "user-1" },
          hops: [{ type: "rule", id: "r-1" }],
        },
      }),
    );
    expect(withCtx.outcome).toBe("created");
    if (withCtx.outcome === "created") {
      expect(withCtx.attempt.causalContext?.root).toEqual({ type: "user", id: "user-1" });
      expect(withCtx.attempt.causalContext?.hops).toHaveLength(1);
    }

    const withoutCtx = reserveAttempt(baseInput({ attemptKey: "key-no-ctx" }));
    expect(withoutCtx.outcome).toBe("created");
    if (withoutCtx.outcome === "created") {
      expect(withoutCtx.attempt.causalContext).toBeNull();
    }

    // **Failure mode**: if the primitive dropped causalContext or defaulted it
    // to `{}` instead of NULL, these would mismatch.
  });
});

// ---------------------------------------------------------------------------
// 2. Same key + same fingerprint → REPLAY (no new row, no side effect).
// ---------------------------------------------------------------------------

describe("same-key same-fingerprint → replay", () => {
  it("returns the existing attempt verbatim and performs NO new insert / no state mutation", () => {
    // Reserve once.
    const first = reserveAttempt(baseInput());
    expect(first.outcome).toBe("created");
    const firstId = first.outcome === "created" ? first.attempt.id : "";
    const afterFirst = attemptRowCount();

    // Reserve AGAIN with the same key + same fingerprint.
    const second = reserveAttempt(baseInput());

    expect(second.outcome).toBe("replayed");
    if (second.outcome !== "replayed") return;
    // Verbatim: same id, same state, same fingerprint, same reservedAt.
    expect(second.attempt.id).toBe(firstId);
    expect(second.attempt.state).toBe("pending");
    expect(second.attempt.requestFingerprint).toBe("fp-1");
    expect(second.attempt.reservedAt).toBe(
      first.outcome === "created" ? first.attempt.reservedAt : "",
    );

    // NO new row, NO state transition, NO timestamp mutation.
    expect(attemptRowCount()).toBe(afterFirst);

    // **Failure mode that breaks this assertion**: if the primitive re-inserted
    // on same-key (row count would rise), OR re-transitioned state, OR
    // re-stamped reservedAt, the row-count / state / reservedAt checks would
    // diverge. The replay MUST be side-effect-free.
  });

  it("replays an in-flight (published_pending_observation) attempt without re-transitioning", () => {
    // Reserve, then advance to an in-flight state via the T1 checkpoint
    // primitive (simulating a later phase's work). This is the realistic
    // status-poll replay case.
    const first = reserveAttempt(baseInput());
    const id = first.outcome === "created" ? first.attempt.id : "";
    getDb()
      .update(taskCreationAttempts)
      .set({ state: "published_pending_observation", publishedAt: "2026-01-01T00:00:00.000Z" })
      .where(eq(taskCreationAttempts.id, id))
      .run();

    const second = reserveAttempt(baseInput());

    expect(second.outcome).toBe("replayed");
    if (second.outcome !== "replayed") return;
    // Replay returns the CURRENT (in-flight) state verbatim — no demotion to
    // pending, no publishedAt mutation.
    expect(second.attempt.id).toBe(id);
    expect(second.attempt.state).toBe("published_pending_observation");
    expect(second.attempt.publishedAt).toBe("2026-01-01T00:00:00.000Z");

    // **Failure mode**: if replay re-transitioned back to pending or cleared
    // publishedAt, state would be "pending" / publishedAt would be null.
  });
});

// ---------------------------------------------------------------------------
// 3. Same key + DIFFERENT fingerprint → deterministically REJECTED (not thrown).
// ---------------------------------------------------------------------------

describe("same-key different-fingerprint → rejected_fingerprint", () => {
  it("returns rejected_fingerprint (not a throw) with the reserved fingerprint for context", () => {
    const first = reserveAttempt(baseInput({ requestFingerprint: "fp-original" }));
    expect(first.outcome).toBe("created");
    const afterFirst = attemptRowCount();

    // Same key, DIFFERENT fingerprint — must NOT throw.
    let second: ReturnType<typeof reserveAttempt> | undefined;
    expect(() => {
      second = reserveAttempt(baseInput({ requestFingerprint: "fp-DIFFERENT" }));
    }).not.toThrow();

    expect(second!.outcome).toBe("rejected_fingerprint");
    if (second!.outcome !== "rejected_fingerprint") return;
    expect(second!.reservedFingerprint).toBe("fp-original");
    // The stored attempt is returned read-only for context.
    expect(second!.attempt.requestFingerprint).toBe("fp-original");
    // No new row, no mutation of the stored fingerprint.
    expect(attemptRowCount()).toBe(afterFirst);
    const stored = getDb().select().from(taskCreationAttempts).all()[0];
    expect(stored.requestFingerprint).toBe("fp-original");

    // **Failure mode that breaks this assertion**: if the primitive THREW on
    // mismatch (the `expect().not.toThrow()` would fail), OR overwrote the
    // stored fingerprint with the new one (stored.requestFingerprint would be
    // "fp-DIFFERENT"), OR inserted a new row (row count would rise), this test
    // fails. The rejection must be deterministic and side-effect-free.
  });
});

// ---------------------------------------------------------------------------
// 4. Concurrent same-key → exactly one attempt. Plus the UNIQUE-violation
//    catch branch exercised directly via a read-miss wrapper.
// ---------------------------------------------------------------------------

describe("concurrent same-key → one attempt", () => {
  it("two reserveAttempt calls with the same key+fingerprint → exactly one row; the second replays", () => {
    const input = baseInput();
    const before = attemptRowCount();

    // SQLite serializes writers on a single connection, so the two calls run
    // one after the other: the first creates, the second's pre-check SELECT
    // observes the first's committed row and replays.
    const first = reserveAttempt(input);
    const second = reserveAttempt(input);

    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("replayed");
    expect(attemptRowCount()).toBe(before + 1);
    const firstId = first.outcome === "created" ? first.attempt.id : "";
    if (second.outcome === "replayed") expect(second.attempt.id).toBe(firstId);

    // **Failure mode**: if the pre-check SELECT escaped to a different client
    // than the INSERT (so it couldn't see the first's row), or the unique
    // index were missing, the second call would create a SECOND row → row
    // count would be before+2 and second.outcome would be "created".
  });

  it("UNIQUE-violation catch branch: pre-check SELECT misses → INSERT conflicts → catch re-select → replay", () => {
    const db = getDb();
    // Seed a same-key row directly (committed on the real client) so the INSERT
    // below WILL conflict. This is the row the racing writer committed.
    db.insert(taskCreationAttempts)
      .values({
        id: "attempt-raced",
        source: "ui",
        sourceScopeKind: "mission",
        sourceScopeId: "m-raced",
        attemptKey: "key-raced",
        requestFingerprint: "fp-raced",
        publicationKind: "create",
        actorType: "human",
        actorId: "user-1",
        state: "pending",
      })
      .run();
    const afterSeed = attemptRowCount();

    // Wrap the real client so the FIRST select (the reservation pre-check)
    // misses — simulating the race window where the pre-check SELECT ran
    // before the concurrent commit landed. The INSERT then flows through the
    // real client, hits the unique index, and the catch branch re-selects
    // (select #2, through the real client) → finds the raced row → replays.
    const w = new PreCheckMissClient(db, /* missFirstNSelects */ 1);
    const result = reserveAttemptWithClient(
      asClient(w),
      baseInput({
        sourceScopeId: "m-raced",
        attemptKey: "key-raced",
        requestFingerprint: "fp-raced",
      }),
    );

    // The catch branch replayed the raced row.
    expect(result.outcome).toBe("replayed");
    if (result.outcome !== "replayed") return;
    expect(result.attempt.id).toBe("attempt-raced");
    // Exactly one pre-check miss happened, and the catch re-select ran.
    expect(w.selectCount).toBe(2);
    // NO new row — the INSERT was rolled back by the unique violation and we
    // never re-inserted; we replayed the existing row.
    expect(attemptRowCount()).toBe(afterSeed);

    // **Failure mode that breaks this assertion**: if the catch branch did NOT
    // re-select on UNIQUE violation (it would re-throw → test errors), OR
    // re-inserted after the catch (row count would rise), OR the
    // isUniqueConstraintViolation detector failed on sql.js's message-only
    // error shape (catch would not trigger → the raw UNIQUE error would
    // propagate and `result` would never be assigned), this test fails. The
    // wrapper proves the catch branch — not the pre-check — produced the replay.
  });

  it("UNIQUE-violation catch branch surfaces fingerprint mismatch when the raced row differs", () => {
    const db = getDb();
    // Seed a same-key row with fingerprint "fp-A".
    db.insert(taskCreationAttempts)
      .values({
        id: "attempt-raced-b",
        source: "ui",
        sourceScopeKind: "mission",
        sourceScopeId: "m-raced-b",
        attemptKey: "key-raced-b",
        requestFingerprint: "fp-A",
        publicationKind: "create",
        actorType: "human",
        actorId: "user-1",
        state: "pending",
      })
      .run();

    // Pre-check misses → INSERT conflicts → catch re-select → fingerprint
    // mismatch → rejected_fingerprint.
    const w = new PreCheckMissClient(db, 1);
    const result = reserveAttemptWithClient(
      asClient(w),
      baseInput({
        sourceScopeId: "m-raced-b",
        attemptKey: "key-raced-b",
        requestFingerprint: "fp-B",
      }),
    );

    expect(result.outcome).toBe("rejected_fingerprint");
    if (result.outcome !== "rejected_fingerprint") return;
    expect(result.reservedFingerprint).toBe("fp-A");

    // **Failure mode**: if the catch branch returned a generic replay on
    // mismatch (outcome would be "replayed"), or threw on mismatch, this fails.
  });
});

// ---------------------------------------------------------------------------
// 5. Terminal replay — a terminal attempt is returned verbatim, never
//    re-transitioned back to active work.
// ---------------------------------------------------------------------------

describe("terminal replay cannot re-transition", () => {
  it("reserving against a terminal attempt returns the stored terminal state + result verbatim", () => {
    // Reserve, then terminalize via the T1 completeAttempt primitive
    // (simulating a later phase completing the attempt as `created`).
    const first = reserveAttempt(baseInput());
    const id = first.outcome === "created" ? first.attempt.id : "";
    const terminalPayload = {
      terminalOutcome: "created",
      finalState: "created" as const,
      terminalResult: { outcome: "created", taskId: "t-1", attemptId: id },
    };
    getDb()
      .update(taskCreationAttempts)
      .set({
        state: "created",
        terminalOutcome: "created",
        terminalResult: { outcome: "created", taskId: "t-1", attemptId: id },
        completedAt: "2026-02-02T00:00:00.000Z",
      })
      .where(eq(taskCreationAttempts.id, id))
      .run();
    const before = attemptRowCount();

    // Same key + same fingerprint → must REPLAY the terminal state verbatim.
    const second = reserveAttempt(baseInput());

    expect(second.outcome).toBe("replayed");
    if (second.outcome !== "replayed") return;
    // The terminal state + result + completedAt are returned UNCHANGED.
    expect(second.attempt.id).toBe(id);
    expect(second.attempt.state).toBe("created");
    expect(second.attempt.terminalOutcome).toBe("created");
    expect(second.attempt.terminalResult).toEqual(terminalPayload.terminalResult);
    expect(second.attempt.completedAt).toBe("2026-02-02T00:00:00.000Z");
    // No new row, no re-transition.
    expect(attemptRowCount()).toBe(before);

    // **Failure mode that breaks this assertion**: if the reservation layer
    // re-opened a terminal attempt (resetting state to "pending" / clearing
    // terminalResult / overwriting completedAt), state would not be "created"
    // and terminalResult/completedAt would diverge. This is the M4/T3A
    // "terminal replay cannot transition back to active work" guardrail,
    // enforced at the reservation layer by returning the stored row verbatim.
  });
});

// ---------------------------------------------------------------------------
// 6. Habitat-delete survival — the attempt row + its committed references
//    survive habitat replacement (re-asserts T1's non-cascade invariant for
//    the attempt family at the reservation layer).
// ---------------------------------------------------------------------------

describe("habitat-delete survival", () => {
  it("an attempt reserved against a mission survives habitat deletion with its committedMissionId intact", () => {
    const missionId = seedMission("survival-mission");
    // Reserve an attempt whose scope references the mission.
    const result = reserveAttempt(
      baseInput({ sourceScopeId: missionId, attemptKey: "key-survive" }),
    );
    const id = result.outcome === "created" ? result.attempt.id : "";
    // Simulate a later phase stamping the committed mission id (plain text,
    // NO FK by T1 design). This is what the observation checkpoint will do.
    getDb()
      .update(taskCreationAttempts)
      .set({ committedMissionId: missionId })
      .where(eq(taskCreationAttempts.id, id))
      .run();
    expect(getDb().select().from(missions).where(eq(missions.id, missionId)).all()).toHaveLength(1);

    // Replace the habitat — delete cascades Habitat → Mission → Task.
    habitatRepo.deleteHabitat(habitatId);

    // The mission row is GONE (cascaded).
    expect(getDb().select().from(missions).where(eq(missions.id, missionId)).all()).toHaveLength(0);
    // BUT the attempt row SURVIVES — it has NO FK to the habitat/mission chain
    // (committed_mission_id is plain text). Its committed reference is now a
    // deliberately-dangling audit pointer, which is the intended invariant.
    const surviving = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.id, id))
      .all();
    expect(surviving).toHaveLength(1);
    expect(surviving[0].committedMissionId).toBe(missionId);
    expect(surviving[0].state).toBe("pending");
    // The attempt is STILL replayable by its reservation key.
    const replay = reserveAttempt(
      baseInput({ sourceScopeId: missionId, attemptKey: "key-survive" }),
    );
    expect(replay.outcome).toBe("replayed");
    if (replay.outcome === "replayed") expect(replay.attempt.id).toBe(id);

    // **Failure mode that breaks this assertion**: if the schema had
    // accidentally added a cascade FK on attempts.committed_mission_id (or
    // source_scope_id), the habitat delete would cascade through and delete
    // the attempt row → surviving would be empty and the replay would
    // re-create instead of replaying. The test proves the non-cascade design
    // holds at the reservation layer for an attempt produced by THIS module.
  });
});

// ---------------------------------------------------------------------------
// 7. getAttemptStatus — authorized recovery-surface read.
// ---------------------------------------------------------------------------

describe("getAttemptStatus", () => {
  it("returns { found: false } for a missing attempt (typed, not a throw)", () => {
    let result: ReturnType<typeof getAttemptStatus> | undefined;
    expect(() => {
      result = getAttemptStatus("does-not-exist");
    }).not.toThrow();
    expect(result!.found).toBe(false);

    // **Failure mode**: if getAttemptStatus threw on not-found (the legacy
    // repositoryNotFoundError pattern), the `expect().not.toThrow()` would
    // fail. The recovery route needs a typed not-found to map to 404 cleanly.
  });

  it("returns the full recovery surface for a reserved attempt", () => {
    const created = reserveAttempt(
      baseInput({ causalContext: { root: { type: "user", id: "u" } } }),
    );
    const id = created.outcome === "created" ? created.attempt.id : "";

    const result = getAttemptStatus(id);

    expect(result.found).toBe(true);
    if (!result.found) return;
    const { status } = result;
    expect(status.attemptId).toBe(id);
    expect(status.state).toBe("pending");
    expect(status.reservedAt).toBeTruthy();
    expect(status.committedTaskId).toBeNull();
    expect(status.committedMissionId).toBeNull();
    expect(status.envelopeEventId).toBeNull();
    expect(status.reservationId).toBeNull();
    expect(status.terminalOutcome).toBeNull();
    expect(status.terminalResult).toBeNull();
    expect(status.leaseOwner).toBeNull();
    expect(status.leaseExpiresAt).toBeNull();
    expect(status.publishedAt).toBeNull();
    expect(status.completedAt).toBeNull();

    // **Failure mode**: if the status projection dropped or mis-mapped any
    // recovery field, the corresponding assertion would diverge. The shape is
    // the contract the Phase-3 GET route will expose verbatim.
  });

  it("reflects committed identifiers, terminal result, and lease after later phases mutate the row", () => {
    const created = reserveAttempt(baseInput());
    const id = created.outcome === "created" ? created.attempt.id : "";
    // Simulate later-phase work: checkpoint, committed ids, lease, terminalization.
    getDb()
      .update(taskCreationAttempts)
      .set({
        state: "created_unassigned",
        committedTaskId: "t-7",
        committedMissionId: "m-7",
        envelopeEventId: "evt-7",
        reservationId: "res-7",
        terminalOutcome: "created_unassigned",
        terminalResult: {
          outcome: "created_unassigned",
          taskId: "t-7",
          assignmentFailure: { reason: "no_orcy" },
        },
        leaseOwner: "worker-1",
        leaseExpiresAt: "2026-03-03T00:00:00.000Z",
        publishedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-02-02T00:00:00.000Z",
      })
      .where(eq(taskCreationAttempts.id, id))
      .run();

    const result = getAttemptStatus(id);
    expect(result.found).toBe(true);
    if (!result.found) return;
    const { status } = result;
    expect(status.state).toBe("created_unassigned");
    expect(status.committedTaskId).toBe("t-7");
    expect(status.committedMissionId).toBe("m-7");
    expect(status.envelopeEventId).toBe("evt-7");
    expect(status.reservationId).toBe("res-7");
    expect(status.terminalOutcome).toBe("created_unassigned");
    expect(status.terminalResult?.taskId).toBe("t-7");
    expect(status.terminalResult?.assignmentFailure).toEqual({ reason: "no_orcy" });
    expect(status.leaseOwner).toBe("worker-1");
    expect(status.leaseExpiresAt).toBe("2026-03-03T00:00:00.000Z");
    expect(status.publishedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(status.completedAt).toBe("2026-02-02T00:00:00.000Z");

    // **Failure mode**: if the status projection missed any field the recovery
    // route needs (lease for takeover, committed ids for client redirect,
    // terminal result for replay display), the corresponding assertion fails.
  });
});
