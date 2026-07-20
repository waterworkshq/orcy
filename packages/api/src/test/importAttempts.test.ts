/**
 * T10A Milestone 1 — import-attempt repository primitives + state machine.
 *
 * Exercises the load-bearing guardrails against the REAL test DB (sql.js —
 * SQLite compare-and-set + UNIQUE-constraint semantics behave identically to
 * production better-sqlite3). Mirrors the T9A Phase-1
 * `scheduledOccurrences.test.ts` convention: every test states the SPECIFIC
 * failure mode that would break its assertion (proving it is not tautological).
 *
 * Guardrails under test (T10A M1 ticket § "Verification expectations"):
 *   - Legal-transition matrix: every legal edge fires `transitioned`; every
 *     rejected edge (backward, cross-terminal, terminal-exit, same-state
 *     re-mark) is classified correctly via `illegal_source_state`.
 *   - Compare-and-set: a concurrent writer that moves state between the
 *     in-tx read and the conditional UPDATE surfaces as `no_op` (NOT a false
 *     `transitioned`); classification is by `SELECT changes() AS n` affected
 *     count, NOT by re-read state.
 *   - Lease semantics (T9A-08 fencing): only the current owner may publish /
 *     reject; a stale owner is refused with `not_owner` (a T10B recovery
 *     takeover happened). The lease is RETIRED atomically with the terminal
 *     transition.
 *   - The `leaseOwner` CAS rejects a stale owner with `not_owner` (the
 *     ticket's explicit verification expectation).
 *
 * Out of scope (later milestones / tickets):
 *   - M4's `reserveImportAttempt` wrapper that owns its own tx.
 *   - T10B's `publishImportAggregateWithClient` (atomic transaction).
 *   - The recovery worker that drives `reacquireExpiredImportAttemptLeaseWithClient`.
 *
 * DORMANT: no production origin routes through this module yet. The
 * primitives here are exercised only by tests until T10B + T11.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { importAttempts } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import {
  reserveImportAttemptWithClient,
  setImportAttemptCoordinationAttemptIdWithClient,
  markImportAttemptPublishingWithClient,
  markImportAttemptPublishedWithClient,
  markImportAttemptRejectedWithClient,
  reacquireExpiredImportAttemptLeaseWithClient,
  getImportAttemptWithClient,
  listImportAttemptsInStateWithClient,
  listImportAttemptsForHabitatWithClient,
  isLegalImportAttemptForward,
  TERMINAL_IMPORT_ATTEMPT_STATES,
  type ReserveImportAttemptInput,
  type ImportAttemptRow,
  type ImportAttemptState,
} from "../repositories/importAttempts.js";

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
function baseInput(overrides: Partial<ReserveImportAttemptInput> = {}): ReserveImportAttemptInput {
  return {
    habitatId: "hab-1",
    mode: "new",
    identityPolicy: "remap",
    manifestDigest: "sha256:digest-abc",
    manifestSummary: { counts: { missions: 0, tasks: 0 } },
    actorType: "human",
    actorId: "user-1",
    ...overrides,
  };
}

/**
 * Reserves a fresh `reserved` import attempt and returns its full row. The
 * common fixture for every transition test — a `reserved` attempt is the
 * input to `markImportAttemptPublishingWithClient`.
 */
function seedReserved(
  overrides: Partial<ReserveImportAttemptInput> = {},
): ImportAttemptRow {
  const result = reserveImportAttemptWithClient(getDb(), baseInput(overrides));
  if (result.outcome !== "created") throw new Error(`fixture reserve failed: ${result.outcome}`);
  return result.attempt;
}

/** Seeds a `publishing` import attempt owned by `worker-A`. */
function seedPublishing(
  overrides: Partial<ReserveImportAttemptInput> = {},
  worker = "worker-A",
): ImportAttemptRow {
  const attempt = seedReserved(overrides);
  const result = markImportAttemptPublishingWithClient(getDb(), attempt.id, {
    leaseOwner: worker,
    leaseExpiresAt: FUTURE_ISO,
  });
  if (result.outcome !== "transitioned")
    throw new Error(`fixture markPublishing failed: ${result.outcome}`);
  return result.attempt;
}

/** Reads the current import attempt row by id (asserts it exists). */
function readAttempt(id: string): ImportAttemptRow {
  const row = getDb()
    .select()
    .from(importAttempts)
    .where(eq(importAttempts.id, id))
    .all()[0];
  if (!row) throw new Error(`attempt ${id} vanished`);
  return row;
}

/** Stamps the state + lease columns directly on the row (simulates prior state). */
function stampState(
  id: string,
  state: ImportAttemptState,
  lease: { owner: string | null; expiresAt: string | null } = { owner: null, expiresAt: null },
): void {
  getDb()
    .update(importAttempts)
    .set({ state, leaseOwner: lease.owner, leaseExpiresAt: lease.expiresAt })
    .where(eq(importAttempts.id, id))
    .run();
}

// ---------------------------------------------------------------------------
// 1. Legal-transition matrix — pure function (every legal edge + every
//    rejected edge). The matrix IS the state machine; bugs here cascade into
//    every transition primitive.
// ---------------------------------------------------------------------------

describe("isLegalImportAttemptForward — state machine matrix", () => {
  describe("legal edges (forward-only)", () => {
    it("reserved → publishing (begin publication)", () => {
      expect(isLegalImportAttemptForward("reserved", "publishing")).toBe(true);
    });
    it("reserved → rejected (preflight-time validation failure)", () => {
      expect(isLegalImportAttemptForward("reserved", "rejected")).toBe(true);
    });
    it("publishing → published (success)", () => {
      expect(isLegalImportAttemptForward("publishing", "published")).toBe(true);
    });
    it("publishing → rejected (publication failure)", () => {
      expect(isLegalImportAttemptForward("publishing", "rejected")).toBe(true);
    });
  });

  describe("rejected edges (every other pair)", () => {
    it("same-state re-mark is illegal in EVERY state (no publish→publish)", () => {
      // `publishing → publishing` re-mark would let a publisher re-stamp the
      // lease indefinitely; the matrix forbids it (caller must use renew).
      expect(isLegalImportAttemptForward("reserved", "reserved")).toBe(false);
      expect(isLegalImportAttemptForward("publishing", "publishing")).toBe(false);
    });
    it("backward transitions are illegal", () => {
      expect(isLegalImportAttemptForward("publishing", "reserved")).toBe(false);
      expect(isLegalImportAttemptForward("published", "publishing")).toBe(false);
      expect(isLegalImportAttemptForward("rejected", "publishing")).toBe(false);
    });
    it("cross-terminal transitions are illegal (no published↔rejected)", () => {
      expect(isLegalImportAttemptForward("published", "rejected")).toBe(false);
      expect(isLegalImportAttemptForward("rejected", "published")).toBe(false);
    });
    it("terminal-state exit is illegal in EVERY direction (one-way door)", () => {
      expect(isLegalImportAttemptForward("published", "reserved")).toBe(false);
      expect(isLegalImportAttemptForward("published", "publishing")).toBe(false);
      expect(isLegalImportAttemptForward("rejected", "reserved")).toBe(false);
    });
    it("reserved → published is illegal (must go through publishing first)", () => {
      // The success terminal is reachable ONLY via `publishing` — a direct
      // `reserved → published` jump would bypass publication entirely.
      expect(isLegalImportAttemptForward("reserved", "published")).toBe(false);
    });
  });

  it("TERMINAL_IMPORT_ATTEMPT_STATES covers exactly published + rejected", () => {
    expect(TERMINAL_IMPORT_ATTEMPT_STATES.has("published")).toBe(true);
    expect(TERMINAL_IMPORT_ATTEMPT_STATES.has("rejected")).toBe(true);
    expect(TERMINAL_IMPORT_ATTEMPT_STATES.has("reserved")).toBe(false);
    expect(TERMINAL_IMPORT_ATTEMPT_STATES.has("publishing")).toBe(false);
    expect(TERMINAL_IMPORT_ATTEMPT_STATES.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Reservation — creates a fresh reserved attempt + accepts caller id.
//    The `import_attempts` table has no compound uniqueness coordinate —
//    `id` is the sole uniqueness key — so there's no `already_exists` happy
//    path. A same-id reservation surfaces as `already_exists` via the
//    PRIMARY KEY UNIQUE-violation catch (a programmer-error indicator).
// ---------------------------------------------------------------------------

describe("reserveImportAttemptWithClient — reservation + UNIQUE catch", () => {
  it("creates a fresh reserved attempt with all input fields stamped", () => {
    const result = reserveImportAttemptWithClient(
      getDb(),
      baseInput({
        mode: "replacement",
        identityPolicy: "restore",
        sourceLineage: { sourceHabitatId: "hab-source", sourceExportedAt: NOW_ISO },
        manifestDigest: "sha256:digest-xyz",
      }),
    );

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    expect(result.attempt.habitatId).toBe("hab-1");
    expect(result.attempt.mode).toBe("replacement");
    expect(result.attempt.identityPolicy).toBe("restore");
    expect(result.attempt.sourceLineage).toEqual({
      sourceHabitatId: "hab-source",
      sourceExportedAt: NOW_ISO,
    });
    expect(result.attempt.manifestDigest).toBe("sha256:digest-xyz");
    expect(result.attempt.state).toBe("reserved");
    expect(result.attempt.leaseOwner).toBeNull();
    expect(result.attempt.leaseExpiresAt).toBeNull();
    expect(result.attempt.createdHabitatId).toBeNull();
    expect(result.attempt.attemptId).toBeNull();
    expect(result.attempt.actorType).toBe("human");
    expect(result.attempt.actorId).toBe("user-1");

    // **Failure mode**: if the primitive forgot to stamp `state="reserved"`
    // (relying on the column default), or omitted any of the input fields,
    // the corresponding `.toBe(...)` would diverge.
  });

  it("accepts a caller-supplied id (M4's reservation tx needs this)", () => {
    const result = reserveImportAttemptWithClient(
      getDb(),
      baseInput({ id: "caller-minted-id-123" }),
    );
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    expect(result.attempt.id).toBe("caller-minted-id-123");

    // **Failure mode**: if the primitive ignored the caller's id and minted a
    // uuid, M4's reservation tx couldn't pre-stage writes keyed by the id
    // (the coordination-attempt link + the prepared-basis stamp).
  });

  it("mints a fresh uuid when id is omitted (byte-identical to legacy callers)", () => {
    const result = reserveImportAttemptWithClient(getDb(), baseInput());
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    expect(result.attempt.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("sourceLineage defaults to NULL when omitted (legacy v1 inputs carry none)", () => {
    const result = reserveImportAttemptWithClient(getDb(), baseInput());
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.attempt.sourceLineage).toBeNull();

    // **Failure mode**: if the primitive emitted an empty {} for sourceLineage,
    // the preflight's `restore`-lineage proof check would treat it as a
    // defined-but-empty object (vs. a missing lineage → null → refused).
  });

  it("UNIQUE catch: same-id reservation → already_exists (programmer error indicator)", () => {
    // M4 always allocates fresh ids from outside the primitive, so a same-id
    // reservation indicates a duplicate-id allocation bug. The PRIMARY KEY
    // UNIQUE-violation catch returns `already_exists` (the same shape as the
    // occurrence primitive's race path) so the caller's closed-discriminated-
    // union contract holds.
    const first = reserveImportAttemptWithClient(getDb(), baseInput({ id: "dup-id" }));
    expect(first.outcome).toBe("created");

    const second = reserveImportAttemptWithClient(getDb(), baseInput({ id: "dup-id" }));
    expect(second.outcome).toBe("already_exists");
    if (second.outcome !== "already_exists") return;
    // The same row is returned verbatim — no new row, no side effect.
    expect(second.attempt.id).toBe(first.attempt.id);

    // **Failure mode**: if the UNIQUE-violation catch was missing (or didn't
    // re-read), the primitive would throw a generic create-error instead of
    // returning `already_exists`. The closed-discriminated-union contract
    // is the load-bearing invariant.
  });
});

// ---------------------------------------------------------------------------
// 3. setImportAttemptCoordinationAttemptIdWithClient — M4's coordination-
//    attempt link (parallel to T9A-03's setOccurrenceAttemptIdWithClient).
// ---------------------------------------------------------------------------

describe("setImportAttemptCoordinationAttemptIdWithClient — coordination-attempt link", () => {
  it("stamps the attemptId on a fresh attempt (attemptId NULL → linked)", () => {
    const attempt = seedReserved();
    expect(attempt.attemptId).toBeNull();

    const result = setImportAttemptCoordinationAttemptIdWithClient(
      getDb(),
      attempt.id,
      "attempt-coord-1",
    );
    expect(result.outcome).toBe("stamped");
    if (result.outcome !== "stamped") throw new Error("unreachable");
    expect(result.attempt.attemptId).toBe("attempt-coord-1");

    // The link is durable (re-read).
    expect(getImportAttemptWithClient(getDb(), attempt.id)!.attemptId).toBe("attempt-coord-1");

    // **Failure mode**: if the conditional UPDATE missed the `id` predicate,
    // it would stamp the wrong row; if it missed the `attemptId IS NULL`
    // predicate, the `already_stamped` test below would fail.
  });

  it("refuses a re-stamp (already_stamped) — the link is one-shot", () => {
    const attempt = seedReserved();

    const first = setImportAttemptCoordinationAttemptIdWithClient(
      getDb(),
      attempt.id,
      "attempt-A",
    );
    expect(first.outcome).toBe("stamped");

    const second = setImportAttemptCoordinationAttemptIdWithClient(
      getDb(),
      attempt.id,
      "attempt-B",
    );
    expect(second.outcome).toBe("already_stamped");
    if (second.outcome !== "already_stamped") throw new Error("unreachable");
    // The original link is intact (the loser never overwrites the winner).
    expect(second.attempt.attemptId).toBe("attempt-A");

    // **Failure mode**: if the primitive did an unconditional UPDATE, the
    // second stamp would overwrite the first → `second.attempt.attemptId`
    // would be "attempt-B" (data corruption).
  });

  it("returns not_found when the import-attempt row does not exist", () => {
    const result = setImportAttemptCoordinationAttemptIdWithClient(
      getDb(),
      "nonexistent-attempt",
      "attempt-X",
    );
    expect(result.outcome).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// 4. markImportAttemptPublishingWithClient — the fused transition + lease-acquire.
// ---------------------------------------------------------------------------

describe("markImportAttemptPublishingWithClient — fused transition + lease acquire", () => {
  it("transitioned: reserved → publishing + lease installed for the caller", () => {
    const attempt = seedReserved();
    const result = markImportAttemptPublishingWithClient(getDb(), attempt.id, {
      leaseOwner: "worker-A",
      leaseExpiresAt: FUTURE_ISO,
    });

    expect(result.outcome).toBe("transitioned");
    if (result.outcome !== "transitioned") return;
    expect(result.attempt.state).toBe("publishing");
    expect(result.attempt.leaseOwner).toBe("worker-A");
    expect(result.attempt.leaseExpiresAt).toBe(FUTURE_ISO);

    // **Failure mode**: if the primitive forgot to install the lease, or
    // transitioned state without acquiring the lease columns, the
    // corresponding assertions would diverge.
  });

  it("stamps attemptId when supplied (the coordination handle)", () => {
    const attempt = seedReserved();
    const result = markImportAttemptPublishingWithClient(getDb(), attempt.id, {
      leaseOwner: "worker-A",
      leaseExpiresAt: FUTURE_ISO,
      attemptId: "attempt-coord-1",
    });
    if (result.outcome !== "transitioned") throw new Error("not transitioned");
    expect(result.attempt.attemptId).toBe("attempt-coord-1");
  });

  it("leaves attemptId NULL when omitted", () => {
    const attempt = seedReserved();
    const result = markImportAttemptPublishingWithClient(getDb(), attempt.id, {
      leaseOwner: "worker-A",
      leaseExpiresAt: FUTURE_ISO,
    });
    if (result.outcome !== "transitioned") throw new Error("not transitioned");
    expect(result.attempt.attemptId).toBeNull();
  });

  it("already_publishing: concurrent worker owns the lease → caller does NOT proceed", () => {
    const attempt = seedReserved();
    // First worker wins.
    const a = markImportAttemptPublishingWithClient(getDb(), attempt.id, {
      leaseOwner: "worker-A",
      leaseExpiresAt: FUTURE_ISO,
    });
    expect(a.outcome).toBe("transitioned");

    // Second worker loses the race.
    const b = markImportAttemptPublishingWithClient(getDb(), attempt.id, {
      leaseOwner: "worker-B",
      leaseExpiresAt: FUTURE_ISO,
    });

    expect(b.outcome).toBe("already_publishing");
    if (b.outcome !== "already_publishing") return;
    // The lease is UNCHANGED — A's, not B's.
    expect(b.attempt.leaseOwner).toBe("worker-A");
    expect(b.attempt.leaseExpiresAt).toBe(FUTURE_ISO);

    const after = readAttempt(attempt.id);
    expect(after.leaseOwner).toBe("worker-A");

    // **Failure mode**: if the second call's CAS predicate was missing the
    // `state='reserved'` guard, B would overwrite A's lease → `leaseOwner`
    // would be "worker-B". The unchanged ownership proves the CAS.
  });

  it("illegal_source_state: terminal attempt refuses the transition", () => {
    const attempt = seedReserved();
    stampState(attempt.id, "published", { owner: null, expiresAt: null });

    const result = markImportAttemptPublishingWithClient(getDb(), attempt.id, {
      leaseOwner: "worker-A",
      leaseExpiresAt: FUTURE_ISO,
    });

    expect(result.outcome).toBe("illegal_source_state");
    if (result.outcome !== "illegal_source_state") return;
    expect(result.attempt.state).toBe("published");
    expect(result.fromState).toBe("published");

    // **Failure mode**: if the primitive didn't classify terminal source
    // states, a published attempt would be re-transitioned to publishing —
    // violating the one-way terminal door.
  });

  it("not_found for a missing attempt (typed, not a throw)", () => {
    let result: ReturnType<typeof markImportAttemptPublishingWithClient> | undefined;
    expect(() => {
      result = markImportAttemptPublishingWithClient(getDb(), "does-not-exist", {
        leaseOwner: "worker-A",
        leaseExpiresAt: FUTURE_ISO,
      });
    }).not.toThrow();
    expect(result!.outcome).toBe("not_found");
  });

  it("compare-and-set: two workers in one tx → exactly one transitioned", () => {
    const attempt = seedReserved();
    const db = getDb();

    const outcomes = db.transaction((tx) => {
      const a = markImportAttemptPublishingWithClient(tx, attempt.id, {
        leaseOwner: "worker-A",
        leaseExpiresAt: FUTURE_ISO,
      });
      const b = markImportAttemptPublishingWithClient(tx, attempt.id, {
        leaseOwner: "worker-B",
        leaseExpiresAt: FUTURE_ISO,
      });
      return { a: a.outcome, b: b.outcome };
    });

    expect(outcomes).toEqual({ a: "transitioned", b: "already_publishing" });
    expect(readAttempt(attempt.id).leaseOwner).toBe("worker-A");
  });
});

// ---------------------------------------------------------------------------
// 5. markImportAttemptPublishedWithClient — terminal success.
// ---------------------------------------------------------------------------

describe("markImportAttemptPublishedWithClient — terminal published", () => {
  it("transitioned: publishing → published + createdHabitatId + result + lease RETIRED", () => {
    const attempt = seedPublishing();
    const result = markImportAttemptPublishedWithClient(getDb(), attempt.id, {
      leaseOwner: "worker-A",
      createdHabitatId: "hab-new-1",
      result: { kind: "import_published", habitatId: "hab-new-1", publishedAt: NOW_ISO },
    });

    expect(result.outcome).toBe("transitioned");
    if (result.outcome !== "transitioned") return;
    expect(result.attempt.state).toBe("published");
    expect(result.attempt.createdHabitatId).toBe("hab-new-1");
    expect(result.attempt.result).toEqual({
      kind: "import_published",
      habitatId: "hab-new-1",
      publishedAt: NOW_ISO,
    });
    // The lease was RETIRED atomically with the terminal transition.
    expect(result.attempt.leaseOwner).toBeNull();
    expect(result.attempt.leaseExpiresAt).toBeNull();

    // **Failure mode**: if the primitive forgot to retire the lease, the
    // terminal attempt would carry a stale `leaseOwner` — a T10B recovery
    // path would later try to "reclaim" a lease on an already-published
    // attempt.
  });

  it("no_op: already published → idempotent (concurrent publish won)", () => {
    const attempt = seedPublishing();
    const first = markImportAttemptPublishedWithClient(getDb(), attempt.id, {
      leaseOwner: "worker-A",
      createdHabitatId: "hab-winner",
      result: { kind: "import_published", habitatId: "hab-winner", publishedAt: NOW_ISO },
    });
    expect(first.outcome).toBe("transitioned");

    const second = markImportAttemptPublishedWithClient(getDb(), attempt.id, {
      leaseOwner: "worker-A", // the terminal fast-path returns BEFORE the CAS
      createdHabitatId: "hab-loser", // different! loser must NOT overwrite
      result: { kind: "import_published", habitatId: "hab-loser", publishedAt: NOW_ISO },
    });

    expect(second.outcome).toBe("no_op");
    if (second.outcome !== "no_op") return;
    expect(second.attempt.createdHabitatId).toBe("hab-winner");

    // **Failure mode**: if the CAS predicate was missing `state`, the loser's
    // UPDATE would overwrite → `createdHabitatId` would be "hab-loser".
  });

  it("illegal_source_state: reserved → published is forbidden (must go through publishing)", () => {
    const attempt = seedReserved(); // never transitioned to publishing
    const result = markImportAttemptPublishedWithClient(getDb(), attempt.id, {
      leaseOwner: null, // a `reserved` attempt carries no lease
      createdHabitatId: "hab-new-1",
    });

    expect(result.outcome).toBe("illegal_source_state");
    if (result.outcome !== "illegal_source_state") return;
    expect(result.fromState).toBe("reserved");
    expect(result.attempt.state).toBe("reserved");
  });

  it("illegal_source_state: rejected → published is forbidden (cross-terminal)", () => {
    const attempt = seedPublishing();
    stampState(attempt.id, "rejected", { owner: null, expiresAt: null });

    const result = markImportAttemptPublishedWithClient(getDb(), attempt.id, {
      leaseOwner: null,
      createdHabitatId: "hab-new-1",
    });

    expect(result.outcome).toBe("illegal_source_state");
    if (result.outcome !== "illegal_source_state") return;
    expect(result.fromState).toBe("rejected");
  });

  it("not_found for a missing attempt", () => {
    const result = markImportAttemptPublishedWithClient(getDb(), "missing", {
      leaseOwner: null,
      createdHabitatId: "hab-1",
    });
    expect(result.outcome).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// 6. markImportAttemptRejectedWithClient — terminal rejected (from publishing
//    OR reserved). The `reserved → rejected` edge is the preflight-time
//    validation failure exit — a `reserved` attempt carries no lease; the
//    directive passes `leaseOwner: null` (the CAS's `isNull(leaseOwner)`
//    predicate matches the row's NULL).
// ---------------------------------------------------------------------------

describe("markImportAttemptRejectedWithClient — terminal rejected", () => {
  it("transitioned from publishing: lease RETIRED + result + rejection_reason stamped", () => {
    const attempt = seedPublishing();
    const result = markImportAttemptRejectedWithClient(getDb(), attempt.id, {
      leaseOwner: "worker-A",
      rejectionReason: "task_invalid",
      result: { errors: ["task-1 invalid"], vetoedBy: "interceptor-X" },
    });

    expect(result.outcome).toBe("transitioned");
    if (result.outcome !== "transitioned") return;
    expect(result.attempt.state).toBe("rejected");
    expect(result.attempt.rejectionReason).toBe("task_invalid");
    // The result.reason is stamped ALONGSIDE the explicit rejection_reason
    // (the result.reason is the downstream-reader signal).
    expect(result.attempt.result).toEqual({
      reason: "task_invalid",
      errors: ["task-1 invalid"],
      vetoedBy: "interceptor-X",
    });
    // The lease was RETIRED atomically.
    expect(result.attempt.leaseOwner).toBeNull();
    expect(result.attempt.leaseExpiresAt).toBeNull();
  });

  it("transitioned from reserved: the preflight-time validation failure exit", () => {
    // The `reserved → rejected` edge is the key design decision: the M4
    // reservation tx that detects a preflight validation failure can
    // terminalize WITHOUT forcing a bogus publish attempt. A `reserved`
    // attempt carries no lease → the directive passes `leaseOwner: null`
    // (the CAS's `isNull(leaseOwner)` predicate matches the row's NULL).
    const attempt = seedReserved();
    const result = markImportAttemptRejectedWithClient(getDb(), attempt.id, {
      leaseOwner: null,
      rejectionReason: "restore_missing_lineage",
      result: { errors: ["identityPolicy:restore requires sourceHabitatId"] },
    });

    expect(result.outcome).toBe("transitioned");
    if (result.outcome !== "transitioned") return;
    expect(result.attempt.state).toBe("rejected");
    expect(result.attempt.rejectionReason).toBe("restore_missing_lineage");
    expect(result.attempt.result).toEqual({
      reason: "restore_missing_lineage",
      errors: ["identityPolicy:restore requires sourceHabitatId"],
    });
  });

  it("no_op: already rejected → idempotent (concurrent reject won)", () => {
    const attempt = seedPublishing();
    const first = markImportAttemptRejectedWithClient(getDb(), attempt.id, {
      leaseOwner: "worker-A",
      rejectionReason: "first_reason",
      result: { winner: true },
    });
    expect(first.outcome).toBe("transitioned");

    const second = markImportAttemptRejectedWithClient(getDb(), attempt.id, {
      leaseOwner: "worker-A",
      rejectionReason: "second_reason",
      result: { winner: false },
    });

    expect(second.outcome).toBe("no_op");
    if (second.outcome !== "no_op") return;
    expect(second.attempt.rejectionReason).toBe("first_reason");
    expect(second.attempt.result).toEqual({ reason: "first_reason", winner: true });
  });

  it("illegal_source_state: published → rejected is forbidden (cross-terminal)", () => {
    const attempt = seedPublishing();
    stampState(attempt.id, "published", { owner: null, expiresAt: null });

    const result = markImportAttemptRejectedWithClient(getDb(), attempt.id, {
      leaseOwner: null,
      rejectionReason: "late_reject",
      result: { error: "should not land" },
    });

    expect(result.outcome).toBe("illegal_source_state");
    if (result.outcome !== "illegal_source_state") return;
    expect(result.fromState).toBe("published");
  });

  it("not_found for a missing attempt", () => {
    const result = markImportAttemptRejectedWithClient(getDb(), "missing", {
      leaseOwner: null,
      rejectionReason: "noop",
      result: {},
    });
    expect(result.outcome).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// 7. FENCING (T9A-08 discipline — carried over from the occurrence repo).
//    The terminal directives REQUIRE `leaseOwner: string | null` (NULL-safe
//    for the `reserved → rejected` edge). A stale owner (post-T10B-takeover)
//    is refused with `not_owner`.
// ---------------------------------------------------------------------------

describe("T9A-08 fencing — the leaseOwner CAS rejects a stale owner with not_owner", () => {
  it("not_owner: stale worker whose lease was taken over by a T10B recovery pass", () => {
    // 1. Seed a publishing attempt owned by worker-A.
    const attempt = seedPublishing({}, "worker-A");

    // 2. Simulate a T10B recovery pass reclaiming the lease for worker-B.
    //    (We stamp the lease columns directly here to mirror what
    //    reacquireExpiredImportAttemptLeaseWithClient does — the reclaim
    //    primitive's own test below covers its full CAS.)
    stampState(attempt.id, "publishing", { owner: "worker-B", expiresAt: FUTURE_ISO });

    // 3. The STALE owner (worker-A) tries to terminalize → not_owner.
    const result = markImportAttemptPublishedWithClient(getDb(), attempt.id, {
      leaseOwner: "worker-A", // the stale worker's id
      createdHabitatId: "hab-new-1",
    });

    expect(result.outcome).toBe("not_owner");
    if (result.outcome !== "not_owner") return;
    // The row is still in `publishing` (the takeover did NOT terminalize it).
    expect(result.attempt.state).toBe("publishing");
    // The new owner (worker-B) is preserved UNCHANGED.
    expect(result.attempt.leaseOwner).toBe("worker-B");
    expect(result.attempt.leaseExpiresAt).toBe(FUTURE_ISO);

    // **Failure mode**: if the fenced CAS predicate was missing
    // `leaseOwner = expected`, worker-A's terminalization would overwrite
    // worker-B's lease → `state` would be "published" + `leaseOwner` would
    // be "worker-A" (data corruption; the new owner's work is destroyed).
  });

  it("not_owner on the rejected branch — a stale worker's reject is refused", () => {
    const attempt = seedPublishing({}, "worker-A");
    // Simulate T10B reclaim.
    stampState(attempt.id, "publishing", { owner: "worker-B", expiresAt: FUTURE_ISO });

    const result = markImportAttemptRejectedWithClient(getDb(), attempt.id, {
      leaseOwner: "worker-A", // the stale worker's id
      rejectionReason: "stale_reject",
      result: { error: "should not land" },
    });

    expect(result.outcome).toBe("not_owner");
    if (result.outcome !== "not_owner") return;
    expect(result.attempt.state).toBe("publishing");
    expect(result.attempt.leaseOwner).toBe("worker-B");
  });

  it("NULL-safe fencing: reserved → rejected accepts leaseOwner:null (no lease to fence)", () => {
    // The `reserved → rejected` edge — a `reserved` attempt carries no lease.
    // The directive passes `leaseOwner: null`; the CAS predicate switches to
    // `isNull(leaseOwner)` to match the row's NULL. This proves the
    // NULL-safe fencing (drizzle's `eq` cannot compare NULL — the
    // `isNull` branch is the load-bearing detail).
    const attempt = seedReserved();
    expect(attempt.leaseOwner).toBeNull();

    const result = markImportAttemptRejectedWithClient(getDb(), attempt.id, {
      leaseOwner: null,
      rejectionReason: "preflight_failed",
      result: { errors: ["ambiguous title"] },
    });

    expect(result.outcome).toBe("transitioned");
    if (result.outcome !== "transitioned") throw new Error("unreachable");
    expect(result.attempt.state).toBe("rejected");

    // **Failure mode**: if the NULL-safe switch (`isNull(leaseOwner)` when
    // expected is null) were missing — i.e. the predicate was unconditionally
    // `eq(leaseOwner, expected)` even when `expected === null` — the CAS
    // would never match (`NULL = NULL` is NULL, not TRUE) → the
    // `reserved → rejected` edge would always return `no_op`, refusing the
    // legitimate preflight-time failure exit.
  });

  it("transitioned: the CURRENT owner (worker-B post-takeover) terminalizes successfully", () => {
    // The fenced CAS rejects ONLY stale owners; the current owner
    // (post-takeover) proceeds normally. This proves the fencing is
    // bidirectional — the new owner's terminalization works.
    const attempt = seedPublishing({}, "worker-A");
    stampState(attempt.id, "publishing", { owner: "worker-B", expiresAt: FUTURE_ISO });

    const result = markImportAttemptPublishedWithClient(getDb(), attempt.id, {
      leaseOwner: "worker-B", // the current (post-takeover) owner
      createdHabitatId: "hab-new-1",
    });

    expect(result.outcome).toBe("transitioned");
    if (result.outcome !== "transitioned") throw new Error("unreachable");
    expect(result.attempt.state).toBe("published");
    expect(result.attempt.createdHabitatId).toBe("hab-new-1");
    // Lease RETIRED atomically.
    expect(result.attempt.leaseOwner).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. reacquireExpiredImportAttemptLeaseWithClient — T10B-recovery precedent.
//    The recovery worker's takeover path; M1 ships the primitive, T10B drives.
// ---------------------------------------------------------------------------

describe("reacquireExpiredImportAttemptLeaseWithClient — expired-lease reclaim", () => {
  it("reclaimed: publishing + expired lease → new owner installed", () => {
    const attempt = seedPublishing({}, "worker-A");
    // Backdate the lease.
    stampState(attempt.id, "publishing", { owner: "worker-A", expiresAt: EXPIRED_ISO });

    const result = reacquireExpiredImportAttemptLeaseWithClient(getDb(), attempt.id, {
      leaseOwner: "worker-B",
      leaseExpiresAt: FUTURE_ISO,
    });

    expect(result.outcome).toBe("reclaimed");
    if (result.outcome !== "reclaimed") return;
    expect(result.attempt.leaseOwner).toBe("worker-B");
    expect(result.attempt.leaseExpiresAt).toBe(FUTURE_ISO);
  });

  it("not_expired: publishing + active lease → current owner preserved", () => {
    const attempt = seedPublishing({}, "worker-A");
    // Lease is FUTURE_ISO (active).

    const result = reacquireExpiredImportAttemptLeaseWithClient(getDb(), attempt.id, {
      leaseOwner: "worker-B",
      leaseExpiresAt: FUTURE_ISO,
    });

    expect(result.outcome).toBe("not_expired");
    if (result.outcome !== "not_expired") return;
    // The current owner's lease is preserved UNCHANGED.
    expect(result.attempt.leaseOwner).toBe("worker-A");
    expect(result.attempt.leaseExpiresAt).toBe(FUTURE_ISO);

    // **Failure mode**: if the reclaim's CAS predicate didn't include
    // `leaseExpiresAt < now`, the reclaim would succeed on an active lease
    // → the current owner would be silently kicked out (data corruption).
  });

  it("illegal_source_state: terminal attempts are never reclaimable", () => {
    const attempt = seedReserved();
    stampState(attempt.id, "published", { owner: null, expiresAt: null });

    const result = reacquireExpiredImportAttemptLeaseWithClient(getDb(), attempt.id, {
      leaseOwner: "worker-B",
      leaseExpiresAt: FUTURE_ISO,
    });

    expect(result.outcome).toBe("illegal_source_state");
    if (result.outcome !== "illegal_source_state") return;
    expect(result.fromState).toBe("published");
  });

  it("not_found for a missing attempt", () => {
    const result = reacquireExpiredImportAttemptLeaseWithClient(getDb(), "missing", {
      leaseOwner: "worker-B",
      leaseExpiresAt: FUTURE_ISO,
    });
    expect(result.outcome).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// 9. Reads — getImportAttemptWithClient + listImportAttemptsInStateWithClient
//    + listImportAttemptsForHabitatWithClient.
// ---------------------------------------------------------------------------

describe("Reads — get + list primitives", () => {
  it("getImportAttemptWithClient returns undefined for missing id (typed not-found)", () => {
    const row = getImportAttemptWithClient(getDb(), "does-not-exist");
    expect(row).toBeUndefined();
  });

  it("getImportAttemptWithClient returns the full row for an existing id", () => {
    const seeded = seedReserved();
    const row = getImportAttemptWithClient(getDb(), seeded.id);
    expect(row).toBeDefined();
    expect(row!.id).toBe(seeded.id);
  });

  it("listImportAttemptsInStateWithClient filters by state + orders by createdAt asc", async () => {
    // Seed three attempts in distinct states; the reserved ones should be
    // returned by the in-state query in createdAt order.
    const a = seedReserved();
    await new Promise((r) => setTimeout(r, 5)); // ensure distinct createdAt
    const b = seedReserved();
    await new Promise((r) => setTimeout(r, 5));
    const c = seedPublishing({}, "worker-A"); // publishing — should NOT appear

    const reservedRows = listImportAttemptsInStateWithClient(getDb(), "reserved");
    expect(reservedRows.map((r) => r.id)).toEqual([a.id, b.id]);
    expect(reservedRows.some((r) => r.id === c.id)).toBe(false);
  });

  it("listImportAttemptsForHabitatWithClient filters by habitat + orders by createdAt asc", async () => {
    const a = seedReserved({ habitatId: "hab-A" });
    await new Promise((r) => setTimeout(r, 5));
    const b = seedReserved({ habitatId: "hab-A" });
    await new Promise((r) => setTimeout(r, 5));
    // Different habitat — should NOT appear.
    seedReserved({ habitatId: "hab-B" });

    const habitatARows = listImportAttemptsForHabitatWithClient(getDb(), "hab-A");
    expect(habitatARows.map((r) => r.id)).toEqual([a.id, b.id]);
    expect(habitatARows.some((r) => r.habitatId === "hab-B")).toBe(false);
  });
});
