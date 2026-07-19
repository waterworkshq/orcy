/**
 * T9A Phase 1 — scheduled occurrence repository primitives + state machine.
 *
 * Exercises the load-bearing guardrails against the REAL test DB (sql.js —
 * SQLite compare-and-set + UNIQUE-constraint semantics behave identically to
 * production better-sqlite3). Each test states the SPECIFIC failure mode that
 * would break its assertion (proving it is not tautological), matching the
 * T3A Phase 1/2/3 convention (`taskCreationAttempts.test.ts`,
 * `taskCreationAttemptLeases.test.ts`, `taskPublicationFailureInjection.test.ts`).
 *
 * Guardrails under test (T9A ticket § "Phase 1 — Occurrence repository
 * primitives + state machine"):
 *   - Reservation idempotency: same-`(scheduledTaskId, scheduledFor)` → one
 *     occurrence (the partial unique index `uq_scheduled_occurrences_schedule_due`
 *     is the race defender; `reserveOccurrenceWithClient` re-reads on UNIQUE
 *     hit and returns `already_exists`, never throws).
 *   - Legal-transition matrix: every legal edge fires `transitioned`; every
 *     rejected edge (backward, cross-terminal, terminal-exit, same-state
 *     re-mark) is classified correctly.
 *   - Compare-and-set: a concurrent writer that moves state between the
 *     in-tx read and the conditional UPDATE surfaces as `no_op` (NOT a false
 *     `transitioned`); classification is by `SELECT changes() AS n` affected
 *     count, NOT by re-read state.
 *   - Lease semantics: only the current owner renews / releases; a non-owner
 *     is refused without mutation. The lease is RETIRED atomically with the
 *     terminal transition.
 *
 * Out of scope: Phase 2's reservation tx (occurrence insert + schedule
 * advance + one-shot disablement), Phase 3's publisher, T9B's lease-reclaim
 * worker. The primitives here are DORMANT — no production origin routes
 * through them yet.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { scheduledOccurrences } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import {
  reserveOccurrence,
  reserveOccurrenceWithClient,
  markOccurrencePublishingWithClient,
  markOccurrencePublishedWithClient,
  markOccurrenceRejectedWithClient,
  renewOccurrenceLeaseWithClient,
  releaseOccurrenceLeaseWithClient,
  getOccurrenceWithClient,
  getOccurrenceByScheduleAndDueWithClient,
  listOccurrencesInStateWithClient,
  listOccurrencesForScheduleWithClient,
  isLegalOccurrenceForward,
  TERMINAL_OCCURRENCE_STATES,
  type ReserveOccurrenceInput,
  type ScheduledOccurrenceRow,
  type ScheduledOccurrenceState,
} from "../repositories/scheduledOccurrences.js";
import type { TaskPublicationDbClient } from "../repositories/taskPublication.js";
import { FailingDbClient } from "./helpers/failingDbClient.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await initTestDb();
});

afterEach(() => closeDb());

// ---------------------------------------------------------------------------
// Seeders / fixtures
// ---------------------------------------------------------------------------

const NOW_ISO = "2026-07-19T12:00:00.000Z";
const FUTURE_ISO = "2099-01-01T00:00:00.000Z";
const EXPIRED_ISO = "2020-01-01T00:00:00.000Z";

/** Canonical reservation input; callers override individual fields. */
function baseInput(overrides: Partial<ReserveOccurrenceInput> = {}): ReserveOccurrenceInput {
  return {
    scheduledTaskId: "sched-1",
    scheduledFor: NOW_ISO,
    ordinal: 0,
    ...overrides,
  };
}

/**
 * Reserves a fresh `reserved` occurrence and returns its full row. The common
 * fixture for every transition test — a `reserved` occurrence is the input to
 * `markOccurrencePublishingWithClient`.
 */
function seedReserved(overrides: Partial<ReserveOccurrenceInput> = {}): ScheduledOccurrenceRow {
  const result = reserveOccurrence(baseInput(overrides));
  if (result.outcome !== "created") throw new Error(`fixture reserve failed: ${result.outcome}`);
  return result.occurrence;
}

/** Seeds a `publishing` occurrence owned by `worker-A`. */
function seedPublishing(
  overrides: Partial<ReserveOccurrenceInput> = {},
  worker = "worker-A",
): ScheduledOccurrenceRow {
  const occ = seedReserved(overrides);
  const result = markOccurrencePublishingWithClient(getDb(), occ.id, {
    leaseOwner: worker,
    leaseExpiresAt: FUTURE_ISO,
  });
  if (result.outcome !== "transitioned")
    throw new Error(`fixture markPublishing failed: ${result.outcome}`);
  return result.occurrence;
}

/** Reads the current occurrence row by id (asserts it exists). */
function readOccurrence(id: string): ScheduledOccurrenceRow {
  const row = getDb()
    .select()
    .from(scheduledOccurrences)
    .where(eq(scheduledOccurrences.id, id))
    .all()[0];
  if (!row) throw new Error(`occurrence ${id} vanished`);
  return row;
}

/** Stamps the state + lease columns directly on the row (simulates prior state). */
function stampState(
  id: string,
  state: ScheduledOccurrenceState,
  lease: { owner: string | null; expiresAt: string | null } = { owner: null, expiresAt: null },
): void {
  getDb()
    .update(scheduledOccurrences)
    .set({ state, leaseOwner: lease.owner, leaseExpiresAt: lease.expiresAt })
    .where(eq(scheduledOccurrences.id, id))
    .run();
}

// ---------------------------------------------------------------------------
// 1. Legal-transition matrix — pure function (every legal edge + every
//    rejected edge). The matrix IS the state machine; bugs here cascade into
//    every transition primitive.
// ---------------------------------------------------------------------------

describe("isLegalOccurrenceForward — state machine matrix", () => {
  describe("legal edges (forward-only)", () => {
    it("reserved → publishing (begin publication)", () => {
      expect(isLegalOccurrenceForward("reserved", "publishing")).toBe(true);
    });
    it("reserved → rejected (pre-publication validation failure)", () => {
      expect(isLegalOccurrenceForward("reserved", "rejected")).toBe(true);
    });
    it("publishing → published (success)", () => {
      expect(isLegalOccurrenceForward("publishing", "published")).toBe(true);
    });
    it("publishing → rejected (publication failure)", () => {
      expect(isLegalOccurrenceForward("publishing", "rejected")).toBe(true);
    });
  });

  describe("rejected edges (every other pair)", () => {
    it("same-state re-mark is illegal in EVERY state (no publish→publish)", () => {
      // `publishing → publishing` re-mark would let a publisher re-stamp the
      // lease indefinitely; the matrix forbids it (caller must use renew).
      expect(isLegalOccurrenceForward("reserved", "reserved")).toBe(false);
      expect(isLegalOccurrenceForward("publishing", "publishing")).toBe(false);
    });
    it("backward transitions are illegal", () => {
      expect(isLegalOccurrenceForward("publishing", "reserved")).toBe(false);
      expect(isLegalOccurrenceForward("published", "publishing")).toBe(false);
      expect(isLegalOccurrenceForward("rejected", "publishing")).toBe(false);
    });
    it("cross-terminal transitions are illegal (no published↔rejected)", () => {
      expect(isLegalOccurrenceForward("published", "rejected")).toBe(false);
      expect(isLegalOccurrenceForward("rejected", "published")).toBe(false);
    });
    it("terminal-state exit is illegal in EVERY direction (one-way door)", () => {
      expect(isLegalOccurrenceForward("published", "reserved")).toBe(false);
      expect(isLegalOccurrenceForward("published", "publishing")).toBe(false);
      expect(isLegalOccurrenceForward("rejected", "reserved")).toBe(false);
    });
    it("reserved → published is illegal (must go through publishing first)", () => {
      // The success terminal is reachable ONLY via `publishing` — a direct
      // `reserved → published` jump would bypass publication entirely.
      expect(isLegalOccurrenceForward("reserved", "published")).toBe(false);
    });
  });

  it("TERMINAL_OCCURRENCE_STATES covers exactly published + rejected", () => {
    expect(TERMINAL_OCCURRENCE_STATES.has("published")).toBe(true);
    expect(TERMINAL_OCCURRENCE_STATES.has("rejected")).toBe(true);
    expect(TERMINAL_OCCURRENCE_STATES.has("reserved")).toBe(false);
    expect(TERMINAL_OCCURRENCE_STATES.has("publishing")).toBe(false);
    expect(TERMINAL_OCCURRENCE_STATES.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Reservation — created + idempotent already_exists on UNIQUE hit.
// ---------------------------------------------------------------------------

describe("reserveOccurrenceWithClient — reservation + UNIQUE idempotency", () => {
  it("creates a fresh reserved occurrence with all input fields stamped", () => {
    const result = reserveOccurrence(
      baseInput({
        scheduleRevision: { templateId: "tpl-1", version: 3 },
        ordinal: 7,
      }),
    );

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    expect(result.occurrence.scheduledTaskId).toBe("sched-1");
    expect(result.occurrence.scheduledFor).toBe(NOW_ISO);
    expect(result.occurrence.ordinal).toBe(7);
    expect(result.occurrence.state).toBe("reserved");
    expect(result.occurrence.scheduleRevision).toEqual({ templateId: "tpl-1", version: 3 });
    expect(result.occurrence.leaseOwner).toBeNull();
    expect(result.occurrence.leaseExpiresAt).toBeNull();
    expect(result.occurrence.createdMissionId).toBeNull();
    expect(result.occurrence.attemptId).toBeNull();

    // **Failure mode**: if the primitive forgot to stamp `state="reserved"`
    // (relying on the column default), or omitted any of the input fields,
    // the corresponding `.toBe(...)` would diverge.
  });

  it("accepts a caller-supplied id (the Phase 2 reservation tx needs this)", () => {
    const result = reserveOccurrence(baseInput({ id: "caller-minted-id-123" }));
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    expect(result.occurrence.id).toBe("caller-minted-id-123");

    // **Failure mode**: if the primitive ignored the caller's id and minted a
    // uuid, Phase 2's reservation tx couldn't pre-stage writes keyed by the
    // id (the schedule-advance CAS, etc.).
  });

  it("mints a fresh uuid when id is omitted (byte-identical to legacy callers)", () => {
    const result = reserveOccurrence(baseInput());
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    expect(result.occurrence.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("fast-path: re-reserve the same pair → already_exists (pre-check SELECT fires)", () => {
    const first = reserveOccurrence(baseInput());
    expect(first.outcome).toBe("created");

    const second = reserveOccurrence(baseInput());
    expect(second.outcome).toBe("already_exists");
    if (second.outcome !== "already_exists") return;
    // The same row is returned verbatim — no new row, no side effect.
    expect(second.occurrence.id).toBe(first.occurrence.id);

    // **Failure mode**: if the pre-check SELECT was missing, every same-pair
    // reserve would throw through the UNIQUE catch — `already_exists` proves
    // the fast path resolved without an exception.
  });

  it("race path: pre-check miss + UNIQUE catch → already_exists (PreCheckMissClient)", () => {
    // Force the pre-check SELECT to miss, so the INSERT hits the unique index
    // and the catch branch runs (mirrors `taskCreationAttempts.test.ts`'s
    // PreCheckMissClient pattern). This is the concurrent-reservation shape.
    const first = reserveOccurrence(baseInput());
    expect(first.outcome).toBe("created");

    const db = getDb();
    const w = new PreCheckMissDbClient(db, 1); // miss the first SELECT
    const result = reserveOccurrenceWithClient(
      w as unknown as TaskPublicationDbClient,
      baseInput(),
    );

    expect(result.outcome).toBe("already_exists");
    if (result.outcome !== "already_exists") return;
    expect(result.occurrence.id).toBe(first.occurrence.id);

    // **Failure mode**: if the UNIQUE-violation catch was missing (or didn't
    // re-read), the primitive would throw a generic create-error instead of
    // returning `already_exists`. This is the load-bearing race-defender.
  });

  it("returns already_exists for an occurrence that has SINCE ADVANCED to publishing", () => {
    // Phase 2 cares about the CURRENT state of a same-key reservation: a
    // concurrent reservation may have already begun publication. The row is
    // returned with its live state so the caller can decide to no-op.
    const reserved = seedReserved();
    stampState(reserved.id, "publishing", { owner: "other-worker", expiresAt: FUTURE_ISO });

    const result = reserveOccurrence(baseInput());

    expect(result.outcome).toBe("already_exists");
    if (result.outcome !== "already_exists") return;
    expect(result.occurrence.id).toBe(reserved.id);
    expect(result.occurrence.state).toBe("publishing");
    expect(result.occurrence.leaseOwner).toBe("other-worker");

    // **Failure mode**: if the primitive re-stamped state on a same-key
    // reserve (instead of returning the row verbatim), the concurrent
    // publication's state would be corrupted back to "reserved".
  });

  it("different scheduledFor → independent occurrences (idempotency is per-pair)", () => {
    const a = reserveOccurrence(baseInput({ scheduledFor: "2026-07-19T12:00:00.000Z" }));
    const b = reserveOccurrence(baseInput({ scheduledFor: "2026-07-20T12:00:00.000Z" }));
    expect(a.outcome).toBe("created");
    expect(b.outcome).toBe("created");
    if (a.outcome !== "created" || b.outcome !== "created") return;
    expect(a.occurrence.id).not.toBe(b.occurrence.id);

    // **Failure mode**: if the unique predicate collapsed on `scheduledTaskId`
    // alone (ignoring `scheduledFor`), the second reserve would be
    // `already_exists` — the schedule's history would lose its 2nd firing.
  });

  it("different scheduledTaskId → independent occurrences", () => {
    const a = reserveOccurrence(baseInput({ scheduledTaskId: "sched-A" }));
    const b = reserveOccurrence(baseInput({ scheduledTaskId: "sched-B" }));
    expect(a.outcome).toBe("created");
    expect(b.outcome).toBe("created");
  });
});

// ---------------------------------------------------------------------------
// 3. markOccurrencePublishingWithClient — the fused transition + lease-acquire.
// ---------------------------------------------------------------------------

describe("markOccurrencePublishingWithClient — fused transition + lease acquire", () => {
  it("transitioned: reserved → publishing + lease installed for the caller", () => {
    const occ = seedReserved();
    const result = markOccurrencePublishingWithClient(getDb(), occ.id, {
      leaseOwner: "worker-A",
      leaseExpiresAt: FUTURE_ISO,
    });

    expect(result.outcome).toBe("transitioned");
    if (result.outcome !== "transitioned") return;
    expect(result.occurrence.state).toBe("publishing");
    expect(result.occurrence.leaseOwner).toBe("worker-A");
    expect(result.occurrence.leaseExpiresAt).toBe(FUTURE_ISO);

    // **Failure mode**: if the primitive forgot to install the lease, or
    // transitioned state without acquiring the lease columns, the
    // corresponding assertions would diverge.
  });

  it("stamps attemptId when supplied (the coordination handle — design Q1)", () => {
    const occ = seedReserved();
    const result = markOccurrencePublishingWithClient(getDb(), occ.id, {
      leaseOwner: "worker-A",
      leaseExpiresAt: FUTURE_ISO,
      attemptId: "attempt-coord-1",
    });
    if (result.outcome !== "transitioned") throw new Error("not transitioned");
    expect(result.occurrence.attemptId).toBe("attempt-coord-1");

    // **Failure mode**: if attemptId was dropped, the Phase 3 coordination
    // surface would have no handle to read.
  });

  it("leaves attemptId NULL when omitted", () => {
    const occ = seedReserved();
    const result = markOccurrencePublishingWithClient(getDb(), occ.id, {
      leaseOwner: "worker-A",
      leaseExpiresAt: FUTURE_ISO,
    });
    if (result.outcome !== "transitioned") throw new Error("not transitioned");
    expect(result.occurrence.attemptId).toBeNull();
  });

  it("already_publishing: concurrent worker owns the lease → caller does NOT proceed", () => {
    const occ = seedReserved();
    // First worker wins.
    const a = markOccurrencePublishingWithClient(getDb(), occ.id, {
      leaseOwner: "worker-A",
      leaseExpiresAt: FUTURE_ISO,
    });
    expect(a.outcome).toBe("transitioned");

    // Second worker loses the race.
    const b = markOccurrencePublishingWithClient(getDb(), occ.id, {
      leaseOwner: "worker-B",
      leaseExpiresAt: FUTURE_ISO,
    });

    expect(b.outcome).toBe("already_publishing");
    if (b.outcome !== "already_publishing") return;
    // The lease is UNCHANGED — A's, not B's.
    expect(b.occurrence.leaseOwner).toBe("worker-A");
    expect(b.occurrence.leaseExpiresAt).toBe(FUTURE_ISO);

    const after = readOccurrence(occ.id);
    expect(after.leaseOwner).toBe("worker-A");

    // **Failure mode**: if the second call's CAS predicate was missing the
    // `state='reserved'` guard (or the result collapsed to a false
    // `transitioned`), B would overwrite A's lease → `leaseOwner` would be
    // "worker-B". The unchanged ownership proves the CAS.
  });

  it("illegal_source_state: terminal occurrence refuses the transition", () => {
    const occ = seedReserved();
    stampState(occ.id, "published", { owner: null, expiresAt: null });

    const result = markOccurrencePublishingWithClient(getDb(), occ.id, {
      leaseOwner: "worker-A",
      leaseExpiresAt: FUTURE_ISO,
    });

    expect(result.outcome).toBe("illegal_source_state");
    if (result.outcome !== "illegal_source_state") return;
    expect(result.occurrence.state).toBe("published");
    expect(result.fromState).toBe("published");

    // **Failure mode**: if the primitive didn't classify terminal source
    // states, a published occurrence would be re-transitioned to publishing —
    // violating the one-way terminal door.
  });

  it("not_found for a missing occurrence (typed, not a throw)", () => {
    let result: ReturnType<typeof markOccurrencePublishingWithClient> | undefined;
    expect(() => {
      result = markOccurrencePublishingWithClient(getDb(), "does-not-exist", {
        leaseOwner: "worker-A",
        leaseExpiresAt: FUTURE_ISO,
      });
    }).not.toThrow();
    expect(result!.outcome).toBe("not_found");

    // **Failure mode**: if the primitive threw on not-found (legacy
    // repositoryNotFoundError pattern), the `expect().not.toThrow()` would
    // fail. The closed result type needs a typed not-found, not an exception.
  });

  it("compare-and-set: two workers in one tx → exactly one transitioned", () => {
    const occ = seedReserved();
    const db = getDb();

    const outcomes = db.transaction((tx) => {
      const a = markOccurrencePublishingWithClient(tx, occ.id, {
        leaseOwner: "worker-A",
        leaseExpiresAt: FUTURE_ISO,
      });
      const b = markOccurrencePublishingWithClient(tx, occ.id, {
        leaseOwner: "worker-B",
        leaseExpiresAt: FUTURE_ISO,
      });
      return { a: a.outcome, b: b.outcome };
    });

    expect(outcomes).toEqual({ a: "transitioned", b: "already_publishing" });
    expect(readOccurrence(occ.id).leaseOwner).toBe("worker-A");

    // **Failure mode**: if the CAS predicate didn't include `state='reserved'`,
    // B's UPDATE would match the row that A just moved to `publishing` (if
    // `state='publishing'` was the predicate, or no state predicate at all)
    // → B would steal the lease. The single `transitioned` + A's surviving
    // ownership proves the compare-and-set.
  });
});

// ---------------------------------------------------------------------------
// 4. markOccurrencePublishedWithClient — terminal success.
// ---------------------------------------------------------------------------

describe("markOccurrencePublishedWithClient — terminal published", () => {
  it("transitioned: publishing → published + createdMissionId + result + lease RETIRED", () => {
    const occ = seedPublishing();
    const result = markOccurrencePublishedWithClient(getDb(), occ.id, {
      createdMissionId: "mission-1",
      result: { durationMs: 1500, taskCount: 3 },
    });

    expect(result.outcome).toBe("transitioned");
    if (result.outcome !== "transitioned") return;
    expect(result.occurrence.state).toBe("published");
    expect(result.occurrence.createdMissionId).toBe("mission-1");
    expect(result.occurrence.result).toEqual({ durationMs: 1500, taskCount: 3 });
    // The lease was RETIRED atomically with the terminal transition.
    expect(result.occurrence.leaseOwner).toBeNull();
    expect(result.occurrence.leaseExpiresAt).toBeNull();

    // **Failure mode**: if the primitive forgot to retire the lease, the
    // terminal occurrence would carry a stale `leaseOwner` — T9B's reclaim
    // path would later try to "reclaim" a lease on an already-published
    // occurrence.
  });

  it("stamps attemptId when supplied (the coordination handle)", () => {
    const occ = seedPublishing();
    const result = markOccurrencePublishedWithClient(getDb(), occ.id, {
      createdMissionId: "mission-1",
      attemptId: "attempt-coord-final",
    });
    if (result.outcome !== "transitioned") throw new Error("not transitioned");
    expect(result.occurrence.attemptId).toBe("attempt-coord-final");
  });

  it("result defaults to NULL when omitted (caller may stamp later)", () => {
    const occ = seedPublishing();
    const result = markOccurrencePublishedWithClient(getDb(), occ.id, {
      createdMissionId: "mission-1",
    });
    if (result.outcome !== "transitioned") throw new Error("not transitioned");
    expect(result.occurrence.result).toBeNull();
  });

  it("no_op: already published → idempotent (concurrent publish won)", () => {
    const occ = seedPublishing();
    const first = markOccurrencePublishedWithClient(getDb(), occ.id, {
      createdMissionId: "mission-winner",
      result: { winner: true },
    });
    expect(first.outcome).toBe("transitioned");

    const second = markOccurrencePublishedWithClient(getDb(), occ.id, {
      createdMissionId: "mission-loser", // different! loser must NOT overwrite
      result: { winner: false },
    });

    expect(second.outcome).toBe("no_op");
    if (second.outcome !== "no_op") return;
    // The winner's row is returned UNCHANGED — the loser's Mission id + result
    // did NOT overwrite.
    expect(second.occurrence.createdMissionId).toBe("mission-winner");
    expect(second.occurrence.result).toEqual({ winner: true });

    // **Failure mode**: if the CAS predicate was missing `state` (or used
    // `state='published'` from a prior read), the loser's UPDATE would
    // overwrite → `createdMissionId` would be "mission-loser".
  });

  it("illegal_source_state: reserved → published is forbidden (must go through publishing)", () => {
    const occ = seedReserved(); // never transitioned to publishing
    const result = markOccurrencePublishedWithClient(getDb(), occ.id, {
      createdMissionId: "mission-1",
    });

    expect(result.outcome).toBe("illegal_source_state");
    if (result.outcome !== "illegal_source_state") return;
    expect(result.fromState).toBe("reserved");
    expect(result.occurrence.state).toBe("reserved"); // unchanged

    // **Failure mode**: if the matrix allowed `reserved → published`, an
    // occurrence that never entered publication would be terminalized —
    // bypassing the lease + publication work entirely.
  });

  it("illegal_source_state: rejected → published is forbidden (cross-terminal)", () => {
    const occ = seedPublishing();
    stampState(occ.id, "rejected", { owner: null, expiresAt: null });

    const result = markOccurrencePublishedWithClient(getDb(), occ.id, {
      createdMissionId: "mission-1",
    });

    expect(result.outcome).toBe("illegal_source_state");
    if (result.outcome !== "illegal_source_state") return;
    expect(result.occurrence.state).toBe("rejected");
  });

  it("not_found for a missing occurrence", () => {
    const result = markOccurrencePublishedWithClient(getDb(), "missing", {
      createdMissionId: "m",
    });
    expect(result.outcome).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// 5. markOccurrenceRejectedWithClient — terminal rejected (from publishing OR reserved).
// ---------------------------------------------------------------------------

describe("markOccurrenceRejectedWithClient — terminal rejected", () => {
  it("transitioned from publishing: lease RETIRED + result stamped", () => {
    const occ = seedPublishing();
    const result = markOccurrenceRejectedWithClient(getDb(), occ.id, {
      result: { errors: ["task-1 invalid"], vetoedBy: "interceptor-X" },
    });

    expect(result.outcome).toBe("transitioned");
    if (result.outcome !== "transitioned") return;
    expect(result.occurrence.state).toBe("rejected");
    expect(result.occurrence.result).toEqual({
      errors: ["task-1 invalid"],
      vetoedBy: "interceptor-X",
    });
    expect(result.occurrence.leaseOwner).toBeNull();
    expect(result.occurrence.leaseExpiresAt).toBeNull();

    // **Failure mode**: if the primitive didn't retire the lease on rejection,
    // a rejected occurrence would carry a stale lease — the recovery worker
    // would later think it's still being worked on.
  });

  it("transitioned from reserved: the reservation-time validation failure exit", () => {
    // The `reserved → rejected` edge is the key design decision: a
    // reservation tx that detects a validation failure (template missing,
    // schedule disabled mid-tx) can terminalize WITHOUT forcing a bogus
    // publish attempt.
    const occ = seedReserved();
    const result = markOccurrenceRejectedWithClient(getDb(), occ.id, {
      result: { reason: "template_missing" },
    });

    expect(result.outcome).toBe("transitioned");
    if (result.outcome !== "transitioned") return;
    expect(result.occurrence.state).toBe("rejected");
    expect(result.occurrence.result).toEqual({ reason: "template_missing" });

    // **Failure mode**: if the matrix forbade `reserved → rejected`, this
    // would be `illegal_source_state` — forcing every validation failure to
    // go through `publishing` (a bogus publication attempt on an occurrence
    // already known to be invalid).
  });

  it("no_op: already rejected → idempotent (concurrent reject won)", () => {
    const occ = seedPublishing();
    const first = markOccurrenceRejectedWithClient(getDb(), occ.id, {
      result: { winner: true },
    });
    expect(first.outcome).toBe("transitioned");

    const second = markOccurrenceRejectedWithClient(getDb(), occ.id, {
      result: { winner: false }, // different! loser must NOT overwrite
    });

    expect(second.outcome).toBe("no_op");
    if (second.outcome !== "no_op") return;
    expect(second.occurrence.result).toEqual({ winner: true });

    // **Failure mode**: if the CAS predicate was missing, the loser would
    // overwrite → result would be `{ winner: false }`.
  });

  it("illegal_source_state: published → rejected is forbidden (cross-terminal)", () => {
    const occ = seedPublishing();
    stampState(occ.id, "published", { owner: null, expiresAt: null });

    const result = markOccurrenceRejectedWithClient(getDb(), occ.id, {
      result: { reason: "too-late" },
    });

    expect(result.outcome).toBe("illegal_source_state");
    if (result.outcome !== "illegal_source_state") return;
    expect(result.occurrence.state).toBe("published");

    // **Failure mode**: if cross-terminal was allowed, a published occurrence
    // could be re-classified as rejected — corrupting audit history.
  });

  it("not_found for a missing occurrence", () => {
    const result = markOccurrenceRejectedWithClient(getDb(), "missing", {
      result: { reason: "x" },
    });
    expect(result.outcome).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// 6. Renew — owner extends; non-owner refused.
// ---------------------------------------------------------------------------

describe("renewOccurrenceLeaseWithClient", () => {
  it("owner renews → renewed with extended leaseExpiresAt", () => {
    const occ = seedPublishing(undefined, "worker-A");
    // Short initial expiry (set by markPublishing); renew to a longer one.
    getDb()
      .update(scheduledOccurrences)
      .set({ leaseExpiresAt: "2026-07-19T12:00:01.000Z" })
      .where(eq(scheduledOccurrences.id, occ.id))
      .run();

    const result = renewOccurrenceLeaseWithClient(getDb(), occ.id, {
      leaseOwner: "worker-A",
      leaseExpiresAt: FUTURE_ISO,
    });

    expect(result.outcome).toBe("renewed");
    if (result.outcome !== "renewed") return;
    expect(result.occurrence.leaseOwner).toBe("worker-A");
    expect(result.occurrence.leaseExpiresAt).toBe(FUTURE_ISO);

    // **Failure mode**: if renew was missing the `leaseOwner = caller`
    // predicate, ANY worker could extend any lease — defeating the no-steal
    // invariant.
  });

  it("non-owner renew → not_owner (no mutation)", () => {
    const occ = seedPublishing(undefined, "worker-A");

    const result = renewOccurrenceLeaseWithClient(getDb(), occ.id, {
      leaseOwner: "worker-B",
      leaseExpiresAt: FUTURE_ISO,
    });

    expect(result.outcome).toBe("not_owner");
    if (result.outcome !== "not_owner") return;
    // A's lease is UNCHANGED.
    expect(result.occurrence.leaseOwner).toBe("worker-A");

    const after = readOccurrence(occ.id);
    expect(after.leaseOwner).toBe("worker-A");

    // **Failure mode**: if renew's predicate was missing the `leaseOwner =
    // caller` guard, B would extend A's lease.
  });

  it("renew on a terminal occurrence → not_owner (lease was retired on terminalize)", () => {
    const occ = seedPublishing(undefined, "worker-A");
    markOccurrencePublishedWithClient(getDb(), occ.id, { createdMissionId: "m-1" });

    // worker-A tries to renew — but the lease was retired on terminalize.
    const result = renewOccurrenceLeaseWithClient(getDb(), occ.id, {
      leaseOwner: "worker-A",
      leaseExpiresAt: FUTURE_ISO,
    });

    expect(result.outcome).toBe("not_owner");
    if (result.outcome !== "not_owner") return;
    expect(result.occurrence.leaseOwner).toBeNull();

    // **Failure mode**: if the terminal transitions didn't retire the lease,
    // worker-A could "renew" a lease on a published occurrence — a stale
    // lease on terminal work.
  });

  it("not_found for a missing occurrence", () => {
    const result = renewOccurrenceLeaseWithClient(getDb(), "missing", {
      leaseOwner: "worker-A",
      leaseExpiresAt: FUTURE_ISO,
    });
    expect(result.outcome).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// 7. Release — owner clears; non-owner refused.
// ---------------------------------------------------------------------------

describe("releaseOccurrenceLeaseWithClient", () => {
  it("owner releases → released with leaseOwner/leaseExpiresAt cleared", () => {
    const occ = seedPublishing(undefined, "worker-A");
    expect(readOccurrence(occ.id).leaseOwner).toBe("worker-A");

    const result = releaseOccurrenceLeaseWithClient(getDb(), occ.id, "worker-A");

    expect(result.outcome).toBe("released");
    if (result.outcome !== "released") return;
    expect(result.occurrence.leaseOwner).toBeNull();
    expect(result.occurrence.leaseExpiresAt).toBeNull();

    const after = readOccurrence(occ.id);
    expect(after.leaseOwner).toBeNull();
    expect(after.leaseExpiresAt).toBeNull();

    // **Failure mode**: if release cleared unconditionally (no ownership
    // check), any worker could clear any lease — defeating the no-steal
    // invariant from the other direction.
  });

  it("non-owner release → not_owner (lease UNCHANGED)", () => {
    const occ = seedPublishing(undefined, "worker-A");

    const result = releaseOccurrenceLeaseWithClient(getDb(), occ.id, "worker-B");

    expect(result.outcome).toBe("not_owner");
    if (result.outcome !== "not_owner") return;
    expect(result.occurrence.leaseOwner).toBe("worker-A");

    // **Failure mode**: if release cleared unconditionally, B would clear A's
    // lease → `leaseOwner` would be NULL.
  });

  it("release on an already-clear lease → not_owner (idempotent refusal)", () => {
    const occ = seedPublishing(undefined, "worker-A");
    releaseOccurrenceLeaseWithClient(getDb(), occ.id, "worker-A"); // first release clears

    const result = releaseOccurrenceLeaseWithClient(getDb(), occ.id, "worker-A");

    expect(result.outcome).toBe("not_owner");
    if (result.outcome !== "not_owner") return;
    expect(result.occurrence.leaseOwner).toBeNull();

    // **Failure mode**: if release reported "released" whenever the post-call
    // leaseOwner was NULL (without proving the caller owned it), this would
    // be a false-positive "released".
  });

  it("not_found for a missing occurrence", () => {
    const result = releaseOccurrenceLeaseWithClient(getDb(), "missing", "worker-A");
    expect(result.outcome).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// 8. Reads.
// ---------------------------------------------------------------------------

describe("reads", () => {
  it("getOccurrenceWithClient by id", () => {
    const occ = seedReserved({ scheduledTaskId: "sched-X" });
    const got = getOccurrenceWithClient(getDb(), occ.id);
    expect(got?.id).toBe(occ.id);
    expect(got?.scheduledTaskId).toBe("sched-X");

    const missing = getOccurrenceWithClient(getDb(), "no-such-id");
    expect(missing).toBeUndefined();
  });

  it("getOccurrenceByScheduleAndDueWithClient by the uniqueness pair", () => {
    seedReserved({ scheduledTaskId: "sched-Y", scheduledFor: "2026-08-01T00:00:00.000Z" });
    const got = getOccurrenceByScheduleAndDueWithClient(
      getDb(),
      "sched-Y",
      "2026-08-01T00:00:00.000Z",
    );
    expect(got?.scheduledTaskId).toBe("sched-Y");

    const missing = getOccurrenceByScheduleAndDueWithClient(
      getDb(),
      "sched-Y",
      "2026-09-01T00:00:00.000Z", // different due
    );
    expect(missing).toBeUndefined();
  });

  it("listOccurrencesInStateWithClient filters by state + orders by createdAt ASC", () => {
    // Reserve 3 occurrences; the FIRST reserved is the OLDEST (scan order).
    const first = seedReserved({ scheduledTaskId: "s1", scheduledFor: "2026-07-19T10:00:00.000Z" });
    // small delay so createdAt differs (sql.js timestamp resolution = seconds)
    // — use direct stamps to force ordering.
    getDb()
      .update(scheduledOccurrences)
      .set({ createdAt: "2026-07-19T10:00:00.000Z" })
      .where(eq(scheduledOccurrences.id, first.id))
      .run();

    const second = seedReserved({
      scheduledTaskId: "s2",
      scheduledFor: "2026-07-19T11:00:00.000Z",
    });
    getDb()
      .update(scheduledOccurrences)
      .set({ createdAt: "2026-07-19T11:00:00.000Z" })
      .where(eq(scheduledOccurrences.id, second.id))
      .run();

    const third = seedPublishing({
      scheduledTaskId: "s3",
      scheduledFor: "2026-07-19T12:00:00.000Z",
    });
    getDb()
      .update(scheduledOccurrences)
      .set({ createdAt: "2026-07-19T12:00:00.000Z" })
      .where(eq(scheduledOccurrences.id, third.id))
      .run();

    const reservedRows = listOccurrencesInStateWithClient(getDb(), "reserved");
    expect(reservedRows.map((r) => r.id)).toEqual([first.id, second.id]);

    const publishingRows = listOccurrencesInStateWithClient(getDb(), "publishing");
    expect(publishingRows.map((r) => r.id)).toEqual([third.id]);

    // **Failure mode**: if the state filter was missing, all 3 rows would
    // appear in both lists. If ordering was DESC, `[second.id, first.id]`.
  });

  it("listOccurrencesInStateWithClient respects limit + offset (pagination)", () => {
    for (let i = 0; i < 5; i++) {
      const occ = seedReserved({
        scheduledTaskId: `pag-${i}`,
        scheduledFor: `2026-07-19T0${i}:00:00.000Z`,
      });
      getDb()
        .update(scheduledOccurrences)
        .set({ createdAt: `2026-07-19T0${i}:00:00.000Z` })
        .where(eq(scheduledOccurrences.id, occ.id))
        .run();
    }
    const page1 = listOccurrencesInStateWithClient(getDb(), "reserved", { limit: 2, offset: 0 });
    const page2 = listOccurrencesInStateWithClient(getDb(), "reserved", { limit: 2, offset: 2 });
    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
    expect(page1.map((r) => r.id)).not.toEqual(expect.arrayContaining(page2.map((r) => r.id)));

    // **Failure mode**: if limit/offset were ignored, both pages would
    // contain all 5 rows + the disjointness assertion would fail.
  });

  it("listOccurrencesForScheduleWithClient filters by schedule + orders by scheduledFor ASC", () => {
    const earlier = seedReserved({
      scheduledTaskId: "sched-Z",
      scheduledFor: "2026-07-19T09:00:00.000Z",
    });
    const later = seedReserved({
      scheduledTaskId: "sched-Z",
      scheduledFor: "2026-07-20T09:00:00.000Z",
    });
    seedReserved({ scheduledTaskId: "sched-OTHER", scheduledFor: "2026-07-19T09:00:00.000Z" });

    const rows = listOccurrencesForScheduleWithClient(getDb(), "sched-Z");
    expect(rows.map((r) => r.id)).toEqual([earlier.id, later.id]);

    // **Failure mode**: if ordering was DESC or filter was missing, the
    // returned ids would not be exactly `[earlier, later]`.
  });

  it("list defaults to limit=100 when opts omitted (matches listByHabitatBetween)", () => {
    // Seed 3 rows; default returns all 3 (under the 100 cap).
    seedReserved({ scheduledTaskId: "def-1" });
    seedReserved({ scheduledTaskId: "def-2" });
    seedReserved({ scheduledTaskId: "def-3" });
    const rows = listOccurrencesInStateWithClient(getDb(), "reserved");
    expect(rows.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 9. *WithClient invariant — the primitives NEVER call getDb / open their own
//    tx. Proven by FailingDbClient: a write failure inside the caller's tx
//    rolls back the WHOLE tx (no escape hatch to getDb()).
//    (Mirrors `taskPublicationFailureInjection.test.ts`.)
// ---------------------------------------------------------------------------

describe("FailingDbClient invariant — primitives are tx-aware (never escape to getDb)", () => {
  it("reserveOccurrenceWithClient rolls back when its INSERT throws inside the caller's tx", () => {
    const db = getDb();
    // Count rows BEFORE: the rolled-back INSERT must leave zero new rows.
    const before = db.select().from(scheduledOccurrences).all().length;

    expect(() => {
      db.transaction((tx) => {
        const w = new FailingDbClient(tx as unknown as TaskPublicationDbClient, {
          failAtWriteN: 1, // fail on the first write (the INSERT)
        });
        reserveOccurrenceWithClient(w as unknown as TaskPublicationDbClient, baseInput());
      });
    }).toThrow();

    const after = db.select().from(scheduledOccurrences).all().length;
    expect(after).toBe(before); // no row escaped — the tx rolled back

    // **Failure mode**: if `reserveOccurrenceWithClient` called `getDb()`
    // instead of the passed `tx` client, the INSERT would commit OUTSIDE the
    // failing tx → `after` would be `before + 1`. The unchanged count proves
    // the primitive is tx-bound.
  });

  it("markOccurrencePublishingWithClient rolls back when its UPDATE throws", () => {
    const occ = seedReserved();
    const db = getDb();
    const beforeState = readOccurrence(occ.id).state;

    expect(() => {
      db.transaction((tx) => {
        const w = new FailingDbClient(tx as unknown as TaskPublicationDbClient, {
          failAtWriteN: 1,
        });
        markOccurrencePublishingWithClient(w as unknown as TaskPublicationDbClient, occ.id, {
          leaseOwner: "worker-A",
          leaseExpiresAt: FUTURE_ISO,
        });
      });
    }).toThrow();

    expect(readOccurrence(occ.id).state).toBe(beforeState); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read-miss wrapper — makes the first N `.select()` chains return an empty
 * result, then delegates everything (inserts / updates / later selects) to
 * the REAL inner client. Used to force the reservation's UNIQUE-catch branch.
 * Mirrors `taskCreationAttempts.test.ts`'s `PreCheckMissClient`.
 */
class PreCheckMissDbClient {
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
      miss.offset = () => miss;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(...args: any[]): any {
    return (this.inner as unknown as { get: (...a: unknown[]) => unknown }).get(...args);
  }
}
