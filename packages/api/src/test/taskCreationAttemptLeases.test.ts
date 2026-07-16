/**
 * T3A Phase 3 — task-creation attempt worker leases and safe takeover.
 *
 * Exercises the load-bearing lease guardrails against the REAL test DB (sql.js —
 * SQLite compare-and-set semantics behave identically to production
 * better-sqlite3). Each test states the SPECIFIC failure mode that would break
 * its assertion (proving it is not tautological), matching the Phase 1 / Phase 2
 * convention (`taskCreationAttempts.test.ts`, `taskPublicationFailureInjection.test.ts`).
 *
 * Guardrails under test (Technical Plan § "Durable Task Creation Attempts" +
 * § "Failure and Recovery Matrix"):
 *   - Lease expiry transfers work without changing terminal state (safe takeover).
 *   - Concurrent acquire (two workers, one free lease) → exactly one `acquired`.
 *   - A terminal attempt refuses acquire (`terminal_locked`); terminal state +
 *     lease columns untouched (defense in depth alongside the Phase-2 matrix).
 *   - Renew / release by a non-owner → `not_owner` (no mutation).
 *
 * Out of scope: the coordinator that composes lease-acquire + transition (later
 * ticket — T4A), retention, the GET route (Phase 4). The primitives here are
 * DORMANT — no production origin routes through them yet.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { taskCreationAttempts, missions } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import { reserveAttempt, type ReserveAttemptInput } from "../repositories/taskCreationAttempts.js";
import {
  acquireAttemptLease,
  acquireAttemptLeaseWithClient,
  renewAttemptLease,
  renewAttemptLeaseWithClient,
  releaseAttemptLease,
  releaseAttemptLeaseWithClient,
} from "../repositories/taskCreationAttempts.js";
import type { TaskPublicationDbClient } from "../repositories/taskPublication.js";
import type { TaskCreationAttemptRow } from "../repositories/taskCreationAttempts.js";

let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  const habitat = habitatRepo.createHabitat({ name: "Lease Habitat" });
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
function seedMission(title = "lease-mission"): string {
  return missionRepo.createMission({
    habitatId,
    columnId,
    title,
    createdBy: "user-1",
  }).id;
}

/**
 * Reserves a fresh pending attempt and returns its full row. The common fixture
 * for every lease test — a non-terminal, lease-free attempt is the acquire input.
 */
function seedPendingAttempt(key = "key-1"): TaskCreationAttemptRow {
  const result = reserveAttempt(baseInput({ attemptKey: key }));
  if (result.outcome !== "created") throw new Error(`fixture reserve failed: ${result.outcome}`);
  return result.attempt;
}

/** Reads the current attempt row by id (asserts it exists). */
function readAttempt(id: string): TaskCreationAttemptRow {
  const row = getDb()
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.id, id))
    .all()[0];
  if (!row) throw new Error(`attempt ${id} vanished`);
  return row;
}

/** ISO timestamp strictly in the PAST (proves an expired lease is takeable). */
const EXPIRED_ISO = "2020-01-01T00:00:00.000Z";
/** ISO timestamp well in the FUTURE (proves an active lease is NOT takeable). */
const FUTURE_ISO = "2099-01-01T00:00:00.000Z";

/** Stamps the lease columns directly on the attempt row (simulates prior ownership). */
function stampLease(id: string, owner: string | null, expiresAt: string | null): void {
  getDb()
    .update(taskCreationAttempts)
    .set({ leaseOwner: owner, leaseExpiresAt: expiresAt })
    .where(eq(taskCreationAttempts.id, id))
    .run();
}

// ---------------------------------------------------------------------------
// 1. Acquire on a free non-terminal attempt → `acquired`.
// ---------------------------------------------------------------------------

describe("acquire — free non-terminal attempt", () => {
  it("acquires the lease, sets leaseOwner + leaseExpiresAt, and returns the row", () => {
    const attempt = seedPendingAttempt();
    const before = readAttempt(attempt.id);
    expect(before.leaseOwner).toBeNull();
    expect(before.leaseExpiresAt).toBeNull();

    const result = acquireAttemptLease(attempt.id, "worker-A", 60_000);

    expect(result.outcome).toBe("acquired");
    if (result.outcome !== "acquired") return;
    expect(result.attempt.leaseOwner).toBe("worker-A");
    // leaseExpiresAt must be set to a future ISO stamp.
    expect(result.attempt.leaseExpiresAt).toBeTruthy();
    expect(result.attempt.leaseExpiresAt! > new Date().toISOString()).toBe(true);
    // State is unchanged (acquire never transitions).
    expect(result.attempt.state).toBe("pending");

    // **Failure mode**: if the primitive failed to set leaseOwner/leaseExpiresAt,
    // OR mutated state, these assertions would diverge. A NULL leaseOwner after
    // `acquired` would mean the WHERE predicate was wrong or the SET was omitted.
  });

  it("returns not_found for a missing attempt (typed, not a throw)", () => {
    let result: ReturnType<typeof acquireAttemptLease> | undefined;
    expect(() => {
      result = acquireAttemptLease("does-not-exist", "worker-A", 60_000);
    }).not.toThrow();
    expect(result!.outcome).toBe("not_found");

    // **Failure mode**: if acquire threw on not-found (legacy
    // repositoryNotFoundError pattern), `expect().not.toThrow()` would fail. The
    // closed result type needs a typed not-found, not an exception.
  });
});

// ---------------------------------------------------------------------------
// 2. Acquire on an ACTIVE (unexpired) lease held by another → `held_by_other`.
// ---------------------------------------------------------------------------

describe("acquire — active lease held by another", () => {
  it("returns held_by_other and leaves the lease columns UNCHANGED", () => {
    const attempt = seedPendingAttempt();
    // Worker-A already holds an active (future-expiring) lease.
    stampLease(attempt.id, "worker-A", FUTURE_ISO);
    const before = readAttempt(attempt.id);

    const result = acquireAttemptLease(attempt.id, "worker-B", 60_000);

    expect(result.outcome).toBe("held_by_other");
    if (result.outcome !== "held_by_other") return;
    // The lease columns are byte-for-byte unchanged — B did NOT overwrite.
    expect(result.attempt.leaseOwner).toBe("worker-A");
    expect(result.attempt.leaseExpiresAt).toBe(FUTURE_ISO);

    // Re-read from DB to prove no mutation reached storage.
    const after = readAttempt(attempt.id);
    expect(after.leaseOwner).toBe(before.leaseOwner);
    expect(after.leaseExpiresAt).toBe(before.leaseExpiresAt);

    // **Failure mode**: if the WHERE predicate omitted the free-lease condition
    // (`leaseOwner IS NULL OR leaseExpiresAt < now`), B's UPDATE would overwrite
    // → leaseOwner would be "worker-B" and outcome would be "acquired". The
    // unchanged columns prove the predicate blocked the overwrite.
  });
});

// ---------------------------------------------------------------------------
// 3. Safe takeover — acquire on an EXPIRED lease → `acquired` by the new worker.
// ---------------------------------------------------------------------------

describe("safe takeover — expired lease", () => {
  it("acquires an EXPIRED lease for the new worker (old leaseExpiresAt < now)", () => {
    const attempt = seedPendingAttempt();
    // Worker-A held a lease that has since EXPIRED (past timestamp).
    stampLease(attempt.id, "worker-A", EXPIRED_ISO);

    const result = acquireAttemptLease(attempt.id, "worker-B", 60_000);

    expect(result.outcome).toBe("acquired");
    if (result.outcome !== "acquired") return;
    // The new worker now owns the lease.
    expect(result.attempt.leaseOwner).toBe("worker-B");
    // The new expiry is a future stamp (not the stale past one).
    expect(result.attempt.leaseExpiresAt).not.toBe(EXPIRED_ISO);
    expect(result.attempt.leaseExpiresAt! > new Date().toISOString()).toBe(true);

    // **Failure mode**: if the free-lease predicate only checked `leaseOwner IS
    // NULL` (ignoring expiry), an expired lease with a non-null owner would be
    // `held_by_other` — the takeover would fail and worker-A's stale lease would
    // permanently block recovery. This is the "lease expiry transfers work"
    // guardrail from the Technical Plan.
  });

  it("acquires a lease whose owner is NULL but leaseExpiresAt is stale (NULL-owner branch)", () => {
    const attempt = seedPendingAttempt();
    // No owner, but a stale expiry from a prior release that left a dangling
    // timestamp. The NULL-owner branch of the OR must accept this.
    stampLease(attempt.id, null, EXPIRED_ISO);

    const result = acquireAttemptLease(attempt.id, "worker-C", 60_000);

    expect(result.outcome).toBe("acquired");
    if (result.outcome === "acquired") {
      expect(result.attempt.leaseOwner).toBe("worker-C");
    }

    // **Failure mode**: if the predicate required BOTH `leaseOwner IS NULL` AND
    // `leaseExpiresAt < now` (AND instead of OR), a NULL owner with a stale
    // expiry would still match — but a NULL owner with a NULL expiry would also
    // need the OR. This confirms the OR disjunction is present.
  });
});

// ---------------------------------------------------------------------------
// 4. Concurrent acquire — two workers, one free lease → exactly one `acquired`.
//    (Compare-and-set proof: SQLite serializes writers, so sequential calls
//    prove the WHERE predicate prevents double-acquire.)
// ---------------------------------------------------------------------------

describe("concurrent acquire — compare-and-set", () => {
  it("two workers acquire sequentially: exactly one `acquired`, the other `held_by_other`", () => {
    const attempt = seedPendingAttempt();

    // SQLite serializes writers on a single connection, so these run strictly
    // one after the other: worker-A's conditional UPDATE commits first, then
    // worker-B's conditional UPDATE no-ops (A's active lease violates the
    // free-lease predicate).
    const a = acquireAttemptLease(attempt.id, "worker-A", 60_000);
    const b = acquireAttemptLease(attempt.id, "worker-B", 60_000);

    // Exactly one acquired.
    expect(a.outcome).toBe("acquired");
    expect(b.outcome).toBe("held_by_other");

    // The surviving lease belongs to the FIRST worker — B did NOT overwrite.
    const final = readAttempt(attempt.id);
    expect(final.leaseOwner).toBe("worker-A");
    if (a.outcome === "acquired") {
      expect(final.leaseExpiresAt).toBe(a.attempt.leaseExpiresAt);
    }

    // **Failure mode**: if the WHERE predicate omitted the free-lease condition,
    // BOTH UPDATEs would match (unconditional on lease state) → B would overwrite
    // A → b.outcome would be "acquired" and final.leaseOwner would be "worker-B".
    // The single `acquired` + A's surviving ownership proves the compare-and-set.
  });

  it("the WHERE predicate is load-bearing: a held lease blocks a second acquire inside one tx", () => {
    // Prove the compare-and-set holds WITHIN a single transaction (the shape the
    // later coordinator will use): A acquires on the tx, then B tries on the SAME
    // tx — B's conditional UPDATE must no-op because A's lease is visible on tx.
    const attempt = seedPendingAttempt();
    const db = getDb();

    const outcomes = db.transaction((tx) => {
      const a = acquireAttemptLeaseWithClient(tx, attempt.id, "worker-A", 60_000);
      const b = acquireAttemptLeaseWithClient(tx, attempt.id, "worker-B", 60_000);
      return { a: a.outcome, b: b.outcome };
    });

    expect(outcomes).toEqual({ a: "acquired", b: "held_by_other" });
    // After commit, A owns the lease.
    expect(readAttempt(attempt.id).leaseOwner).toBe("worker-A");

    // **Failure mode**: if the re-read classification ignored the WHERE result
    // and just returned `acquired` whenever the row existed, B would also report
    // `acquired`. The `held_by_other` outcome proves the re-read sees A's
    // committed lease and the predicate prevented B's write.
  });
});

// ---------------------------------------------------------------------------
// 5. Terminal attempt refuses acquire → `terminal_locked`.
//    Two cases that DISCRIMINATE the state-set terminal check from a
//    completedAt-only check.
// ---------------------------------------------------------------------------

describe("terminal attempt refuses acquire", () => {
  it("a `created` attempt WITH completedAt → terminal_locked (lease + state untouched)", () => {
    const attempt = seedPendingAttempt();
    // Terminalize as `created` with completedAt set (the completeAttempt path).
    getDb()
      .update(taskCreationAttempts)
      .set({
        state: "created",
        completedAt: "2026-02-02T00:00:00.000Z",
        terminalOutcome: "created",
        leaseOwner: "worker-prior",
        leaseExpiresAt: FUTURE_ISO,
      })
      .where(eq(taskCreationAttempts.id, attempt.id))
      .run();
    const before = readAttempt(attempt.id);

    const result = acquireAttemptLease(attempt.id, "worker-new", 60_000);

    expect(result.outcome).toBe("terminal_locked");
    if (result.outcome !== "terminal_locked") return;
    // Terminal state + lease columns UNCHANGED — the guardrail.
    expect(result.attempt.state).toBe("created");
    expect(result.attempt.completedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(result.attempt.leaseOwner).toBe(before.leaseOwner);
    expect(result.attempt.leaseExpiresAt).toBe(before.leaseExpiresAt);

    const after = readAttempt(attempt.id);
    expect(after.state).toBe("created");
    expect(after.leaseOwner).toBe("worker-prior");

    // **Failure mode**: if the terminal check were missing, the acquire would
    // match the free-lease/no-terminal predicate and overwrite the lease →
    // outcome would be "acquired". The guardrail "lease expiry transfers work
    // WITHOUT changing terminal state" depends on this refusal.
  });

  it("a `rejected_validation` attempt with NULL completedAt → terminal_locked (state-set check, not completedAt-only)", () => {
    const attempt = seedPendingAttempt();
    // rejected_validation is reachable DIRECTLY from pending (validation failure)
    // WITHOUT going through completeAttemptWithClient — so completedAt is NULL.
    // This DISCRIMINATES: a completedAt-only terminal check would WRONGLY acquire.
    getDb()
      .update(taskCreationAttempts)
      .set({ state: "rejected_validation", completedAt: null })
      .where(eq(taskCreationAttempts.id, attempt.id))
      .run();
    const before = readAttempt(attempt.id);

    const result = acquireAttemptLease(attempt.id, "worker-new", 60_000);

    expect(result.outcome).toBe("terminal_locked");
    if (result.outcome !== "terminal_locked") return;
    expect(result.attempt.state).toBe("rejected_validation");
    expect(result.attempt.completedAt).toBeNull();
    // Lease columns untouched (they were NULL — no overwrite).
    expect(result.attempt.leaseOwner).toBe(before.leaseOwner);

    // **Failure mode**: if the terminal check ONLY inspected `completedAt`
    // (ignoring the state set), this attempt (completedAt NULL) would be
    // `acquired` — violating the guardrail. The `terminal_locked` outcome proves
    // the state-set check (TERMINAL_ATTEMPT_STATES) is the load-bearing signal,
    // shared with the Phase-2 transition matrix.
  });
});

// ---------------------------------------------------------------------------
// 6. Renew — owner extends; non-owner refused.
// ---------------------------------------------------------------------------

describe("renew", () => {
  it("owner renews → renewed with extended leaseExpiresAt", () => {
    const attempt = seedPendingAttempt();
    acquireAttemptLease(attempt.id, "worker-A", 1_000); // short 1s lease
    const afterAcquire = readAttempt(attempt.id);
    expect(afterAcquire.leaseExpiresAt).toBeTruthy();

    const result = renewAttemptLease(attempt.id, "worker-A", 300_000); // extend to 5min

    expect(result.outcome).toBe("renewed");
    if (result.outcome !== "renewed") return;
    expect(result.attempt.leaseOwner).toBe("worker-A");
    // The expiry moved forward (renewed, not the original short lease).
    expect(result.attempt.leaseExpiresAt! > afterAcquire.leaseExpiresAt!).toBe(true);

    // **Failure mode**: if renew overwrote leaseOwner (instead of only
    // leaseExpiresAt), or didn't extend the expiry, the ownership / ordering
    // checks would diverge.
  });

  it("non-owner renew → not_owner (no mutation of leaseExpiresAt)", () => {
    const attempt = seedPendingAttempt();
    acquireAttemptLease(attempt.id, "worker-A", 300_000);
    const before = readAttempt(attempt.id);

    const result = renewAttemptLease(attempt.id, "worker-B", 60_000);

    expect(result.outcome).toBe("not_owner");
    if (result.outcome !== "not_owner") return;
    // The conditional UPDATE (WHERE leaseOwner = workerId) did not match → no
    // mutation. leaseOwner + leaseExpiresAt are A's, unchanged.
    expect(result.attempt.leaseOwner).toBe("worker-A");
    expect(result.attempt.leaseExpiresAt).toBe(before.leaseExpiresAt);

    const after = readAttempt(attempt.id);
    expect(after.leaseExpiresAt).toBe(before.leaseExpiresAt);

    // **Failure mode**: if renew used an unconditional UPDATE (WHERE id only),
    // worker-B would extend A's lease → leaseExpiresAt would differ. The
    // unchanged timestamp proves the ownership predicate.
  });

  it("renew on a missing attempt → not_found", () => {
    const result = renewAttemptLease("does-not-exist", "worker-A", 60_000);
    expect(result.outcome).toBe("not_found");

    // **Failure mode**: if renew threw on not-found, this would error instead of
    // returning a typed result.
  });
});

// ---------------------------------------------------------------------------
// 7. Release — owner clears; non-owner refused.
// ---------------------------------------------------------------------------

describe("release", () => {
  it("owner releases → released with leaseOwner/leaseExpiresAt cleared", () => {
    const attempt = seedPendingAttempt();
    acquireAttemptLease(attempt.id, "worker-A", 300_000);
    expect(readAttempt(attempt.id).leaseOwner).toBe("worker-A");

    const result = releaseAttemptLease(attempt.id, "worker-A");

    expect(result.outcome).toBe("released");
    if (result.outcome !== "released") return;
    expect(result.attempt.leaseOwner).toBeNull();
    expect(result.attempt.leaseExpiresAt).toBeNull();

    const after = readAttempt(attempt.id);
    expect(after.leaseOwner).toBeNull();
    expect(after.leaseExpiresAt).toBeNull();

    // **Failure mode**: if release failed to clear the columns, or cleared them
    // unconditionally (ignoring ownership), the NULL assertions would diverge.
  });

  it("non-owner release → not_owner (lease UNCHANGED)", () => {
    const attempt = seedPendingAttempt();
    acquireAttemptLease(attempt.id, "worker-A", 300_000);
    const before = readAttempt(attempt.id);

    const result = releaseAttemptLease(attempt.id, "worker-B");

    expect(result.outcome).toBe("not_owner");
    if (result.outcome !== "not_owner") return;
    // A's lease survives B's release attempt.
    expect(result.attempt.leaseOwner).toBe("worker-A");
    expect(result.attempt.leaseExpiresAt).toBe(before.leaseExpiresAt);

    const after = readAttempt(attempt.id);
    expect(after.leaseOwner).toBe("worker-A");

    // **Failure mode**: if release used an unconditional UPDATE (WHERE id only),
    // B would clear A's lease → leaseOwner would be NULL and outcome "released".
    // The surviving ownership proves the ownership predicate.
  });

  it("release on a missing attempt → not_found", () => {
    const result = releaseAttemptLease("does-not-exist", "worker-A");
    expect(result.outcome).toBe("not_found");

    // **Failure mode**: if release threw on not-found, this would error.
  });

  it("release on an already-clear lease → not_owner (idempotent refusal, not a false released)", () => {
    const attempt = seedPendingAttempt();
    // No lease held by anyone (leaseOwner NULL from reservation).
    const result = releaseAttemptLease(attempt.id, "worker-A");

    expect(result.outcome).toBe("not_owner");
    if (result.outcome !== "not_owner") return;
    expect(result.attempt.leaseOwner).toBeNull();

    // **Failure mode**: if release reported "released" whenever leaseOwner was
    // NULL (without proving the caller owned it), this would be "released" — a
    // false positive. The pre-read disambiguation ensures only the TRUE owner
    // gets "released".
  });
});

// ---------------------------------------------------------------------------
// 8. Lease lifecycle + interaction with state — release then re-acquire, and
//    the release→takeover handoff that the recovery coordinator will compose.
// ---------------------------------------------------------------------------

describe("lifecycle", () => {
  it("acquire → release → re-acquire by a DIFFERENT worker (the handoff shape)", () => {
    const attempt = seedPendingAttempt();

    const a = acquireAttemptLease(attempt.id, "worker-A", 300_000);
    expect(a.outcome).toBe("acquired");

    const rel = releaseAttemptLease(attempt.id, "worker-A");
    expect(rel.outcome).toBe("released");

    // After release the lease is free → a different worker can acquire.
    const b = acquireAttemptLease(attempt.id, "worker-B", 300_000);
    expect(b.outcome).toBe("acquired");
    if (b.outcome === "acquired") {
      expect(b.attempt.leaseOwner).toBe("worker-B");
    }

    // **Failure mode**: if release didn't actually clear the columns, or the
    // free-lease predicate didn't accept a NULL owner, B's acquire would be
    // `held_by_other`. This is the clean handoff the recovery coordinator
    // (later ticket) will compose from these primitives.
  });

  it("renew extends the CURRENT owner's lease (not a re-acquire)", () => {
    const attempt = seedPendingAttempt();
    acquireAttemptLease(attempt.id, "worker-A", 1_000);
    const before = readAttempt(attempt.id);

    // A renews — expiry extends, owner unchanged.
    const renewed = renewAttemptLease(attempt.id, "worker-A", 600_000);
    expect(renewed.outcome).toBe("renewed");
    const after = readAttempt(attempt.id);
    expect(after.leaseOwner).toBe("worker-A");
    expect(after.leaseExpiresAt! > before.leaseExpiresAt!).toBe(true);

    // **Failure mode**: if renew re-acquired (overwriting via acquire logic)
    // instead of extending, the owner might change or the expiry semantics would
    // differ. The unchanged owner + extended expiry proves renew is pure
    // extension of the existing lease.
  });
});
