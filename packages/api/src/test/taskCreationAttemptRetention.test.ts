/**
 * T3A Phase 4 — compact-vs-detailed retention for task-creation attempts.
 *
 * Exercises the load-bearing retention guardrails against the REAL test DB
 * (sql.js — SQLite UPDATE semantics behave identically to production
 * better-sqlite3). Each test states the SPECIFIC failure mode that would break
 * its assertion (matching the Phase 1 / Phase 3 convention).
 *
 * Guardrails under test (Technical Plan § "Durable Task Creation Attempts" +
 * § "Retention"):
 *   - Compact nulls the detailed JSON (`details`, `terminalResult`,
 *     `causalContext`) but PRESERVES the compact dedup/recovery identity
 *     (reservation key, fingerprint, state, outcome, committed IDs, lease,
 *     timestamps).
 *   - Compact is idempotent (re-compacting is a no-op).
 *   - **Dedup evidence survives compaction**: after compact, a same-key
 *     `reserveAttempt` still REPLAYS (fingerprint + state + outcome intact),
 *     and `getAttemptStatus` still resolves the recovery surface (without the
 *     detailed payload).
 *
 * Out of scope: the coordinator, scheduled pruner (a later ticket — Phase 4
 * ships the primitive). The compact primitive here is DORMANT — no production
 * origin invokes it yet.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { taskCreationAttempts } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import {
  reserveAttempt,
  compactAttemptDetails,
  compactAttemptDetailsWithClient,
  getAttemptStatus,
  type ReserveAttemptInput,
} from "../repositories/taskCreationAttempts.js";
import type { TaskPublicationDbClient } from "../repositories/taskPublication.js";

let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  const habitat = habitatRepo.createHabitat({ name: "Retention Habitat" });
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
function seedMission(title = "retention-mission"): string {
  return missionRepo.createMission({
    habitatId,
    columnId,
    title,
    createdBy: "user-1",
  }).id;
}

/**
 * Seeds a terminalized attempt: reserve → raw-update to `created` with full
 * detailed fragments (terminalResult + details + causalContext). Mirrors what
 * a later phase's completion would have stamped. Used to prove compaction
 * preserves dedup evidence AND removes detailed fragments.
 */
function seedTerminalizedAttempt(key = "key-1"): string {
  const created = reserveAttempt(
    baseInput({
      attemptKey: key,
      causalContext: {
        root: { type: "user", id: "user-1" },
        hops: [{ type: "rule", id: "r-1" }],
      },
    }),
  );
  if (created.outcome !== "created") {
    throw new Error(`fixture reserve failed: ${created.outcome}`);
  }
  const id = created.attempt.id;
  getDb()
    .update(taskCreationAttempts)
    .set({
      state: "created",
      terminalOutcome: "created",
      terminalResult: { outcome: "created", taskId: "t-1", attemptId: id },
      details: { proposalKind: "create", trace: ["validated", "published"] },
      publishedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-02-02T00:00:00.000Z",
      committedTaskId: "t-1",
      committedMissionId: "m-final",
      envelopeEventId: "evt-1",
      reservationId: "res-1",
      leaseOwner: "worker-1",
      leaseExpiresAt: "2026-03-03T00:00:00.000Z",
    })
    .where(eq(taskCreationAttempts.id, id))
    .run();
  return id;
}

/** Cast a wrapper to the union type accepted by `compactAttemptDetailsWithClient`. */
function asClient<T>(w: T): TaskPublicationDbClient {
  return w as unknown as TaskPublicationDbClient;
}

/** Reads the raw attempt row by id. */
function readRow(id: string) {
  const row = getDb()
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.id, id))
    .all()[0];
  if (!row) throw new Error(`attempt ${id} vanished`);
  return row;
}

// ---------------------------------------------------------------------------
// 1. Compact nulls the detailed JSON and preserves the compact identity.
// ---------------------------------------------------------------------------

describe("compactAttemptDetails — detailed nulls + compact preserved", () => {
  it("nulls details/terminalResult/causalContext and preserves the compact dedup identity", () => {
    const id = seedTerminalizedAttempt();

    const result = compactAttemptDetails(id);

    expect(result.outcome).toBe("compacted");
    if (result.outcome !== "compacted") return;

    const { attempt } = result;

    // Detailed columns: NULL.
    expect(attempt.details).toBeNull();
    expect(attempt.terminalResult).toBeNull();
    expect(attempt.causalContext).toBeNull();

    // Compact dedup identity: PRESERVED (reservation key + fingerprint).
    expect(attempt.source).toBe("ui");
    expect(attempt.sourceScopeKind).toBe("mission");
    expect(attempt.sourceScopeId).toBe("m-1");
    expect(attempt.attemptKey).toBe("key-1");
    expect(attempt.requestFingerprint).toBe("fp-1");

    // Compact recovery surface: PRESERVED (state + outcome + committed IDs +
    // envelope/reservation IDs + lease + timestamps).
    expect(attempt.state).toBe("created");
    expect(attempt.terminalOutcome).toBe("created");
    expect(attempt.committedTaskId).toBe("t-1");
    expect(attempt.committedMissionId).toBe("m-final");
    expect(attempt.envelopeEventId).toBe("evt-1");
    expect(attempt.reservationId).toBe("res-1");
    expect(attempt.leaseOwner).toBe("worker-1");
    expect(attempt.leaseExpiresAt).toBe("2026-03-03T00:00:00.000Z");
    expect(attempt.publishedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(attempt.completedAt).toBe("2026-02-02T00:00:00.000Z");

    // **Failure mode**: if the primitive dropped ANY compact column, the
    // corresponding assertion fails — dedup evidence would be gone, and the
    // later retention automation could not prove the guardrail.
  });

  it("reflects the compaction in storage (re-read confirms persistence, not just the returned row)", () => {
    const id = seedTerminalizedAttempt();

    compactAttemptDetails(id);

    const stored = readRow(id);
    expect(stored.details).toBeNull();
    expect(stored.terminalResult).toBeNull();
    expect(stored.causalContext).toBeNull();
    expect(stored.state).toBe("created");
    expect(stored.requestFingerprint).toBe("fp-1");
    expect(stored.terminalOutcome).toBe("created");
    expect(stored.committedTaskId).toBe("t-1");
    expect(stored.leaseOwner).toBe("worker-1");

    // **Failure mode**: if the primitive mutated only the returned row (not the
    // stored one), a subsequent reserve or GET would still see the detailed
    // fragments. The re-read from the DB proves the write hit storage.
  });
});

// ---------------------------------------------------------------------------
// 2. Idempotency — re-compacting is a no-op.
// ---------------------------------------------------------------------------

describe("compactAttemptDetails — idempotency", () => {
  it("compacting an already-compact row is a no-op (no throw, same outcome)", () => {
    const id = seedTerminalizedAttempt();

    // First compact: detailed → null.
    const first = compactAttemptDetails(id);
    expect(first.outcome).toBe("compacted");

    // Second compact: already-null detailed columns; must still report
    // `compacted` (not throw, not silently no-op without classifying).
    let second: ReturnType<typeof compactAttemptDetails> | undefined;
    expect(() => {
      second = compactAttemptDetails(id);
    }).not.toThrow();
    expect(second!.outcome).toBe("compacted");
    if (second!.outcome !== "compacted") return;
    // The compact identity is unchanged across the second compact.
    expect(second!.attempt.state).toBe("created");
    expect(second!.attempt.requestFingerprint).toBe("fp-1");
    expect(second!.attempt.terminalOutcome).toBe("created");
    expect(second!.attempt.details).toBeNull();
    expect(second!.attempt.terminalResult).toBeNull();
    expect(second!.attempt.causalContext).toBeNull();

    // **Failure mode**: if the primitive threw on already-null columns (a
    // naive "must be non-null to null" guard), `expect().not.toThrow()` would
    // fail. Idempotency is load-bearing — retention automation may run on rows
    // that were partially compacted by an earlier cycle.
  });

  it("compacting a freshly-reserved attempt (no detailed fragments) is a no-op", () => {
    // Fresh reservation has no details/terminalResult/causalContext set —
    // they are NULL by default. Compact must classify as `compacted`, not
    // throw or return `not_found`.
    const created = reserveAttempt(baseInput({ attemptKey: "key-fresh" }));
    const id = created.outcome === "created" ? created.attempt.id : "";

    const result = compactAttemptDetails(id);

    expect(result.outcome).toBe("compacted");
    if (result.outcome !== "compacted") return;
    expect(result.attempt.state).toBe("pending");
    expect(result.attempt.details).toBeNull();
    expect(result.attempt.terminalResult).toBeNull();
    expect(result.attempt.causalContext).toBeNull();

    // **Failure mode**: if compact required detailed columns to be non-null
    // (a defensive guard that breaks idempotency), it would misclassify a
    // freshly-reserved attempt as `not_found`.
  });
});

// ---------------------------------------------------------------------------
// 3. Not-found contract — typed, not a throw.
// ---------------------------------------------------------------------------

describe("compactAttemptDetails — not_found", () => {
  it("returns not_found for a missing attemptId (typed, not a throw)", () => {
    let result: ReturnType<typeof compactAttemptDetails> | undefined;
    expect(() => {
      result = compactAttemptDetails("does-not-exist");
    }).not.toThrow();
    expect(result!.outcome).toBe("not_found");

    // **Failure mode**: if compact threw on not-found (legacy
    // repositoryNotFoundError pattern), `expect().not.toThrow()` would fail.
    // The retention automation needs a typed not-found to skip-and-log, not a
    // crash.
  });
});

// ---------------------------------------------------------------------------
// 4. Dedup-survives-compaction — the load-bearing guardrail.
//    reserve → terminalize → compact → reserve-same-key still REPLAYS,
//    and getAttemptStatus still resolves the recovery surface.
// ---------------------------------------------------------------------------

describe("dedup survives compaction", () => {
  it("after compact, a same-key reserve still REPLAYS the stored terminal state", () => {
    const id = seedTerminalizedAttempt();

    // Compact (drops detailed fragments).
    const compacted = compactAttemptDetails(id);
    expect(compacted.outcome).toBe("compacted");

    // Same-key + same-fingerprint reserve MUST replay — fingerprint + state +
    // outcome are intact, so dedup evidence survives compaction.
    const replayed = reserveAttempt(baseInput());

    expect(replayed.outcome).toBe("replayed");
    if (replayed.outcome !== "replayed") return;
    // Same row, same state, same fingerprint, same outcome — the compact
    // identity survived.
    expect(replayed.attempt.id).toBe(id);
    expect(replayed.attempt.state).toBe("created");
    expect(replayed.attempt.requestFingerprint).toBe("fp-1");
    expect(replayed.attempt.terminalOutcome).toBe("created");
    expect(replayed.attempt.terminalResult).toBeNull(); // compacted
    expect(replayed.attempt.details).toBeNull(); // compacted
    expect(replayed.attempt.causalContext).toBeNull(); // compacted

    // **Failure mode**: if compact had dropped the fingerprint / state /
    // outcome, the replay would either reject (mismatched fingerprint would
    // cause `rejected_fingerprint`) or re-create (no matching row → `created`).
    // Either would break the dedup window.
  });

  it("after compact, getAttemptStatus still resolves the recovery surface", () => {
    const id = seedTerminalizedAttempt();
    compactAttemptDetails(id);

    // The recovery-surface read (the Phase-4 GET route's primary input) must
    // still resolve — only the detailed payload is gone.
    const result = getAttemptStatus(id);

    expect(result.found).toBe(true);
    if (!result.found) return;
    const { status } = result;
    expect(status.attemptId).toBe(id);
    expect(status.state).toBe("created");
    expect(status.terminalOutcome).toBe("created");
    expect(status.terminalResult).toBeNull(); // compacted
    expect(status.committedTaskId).toBe("t-1");
    expect(status.committedMissionId).toBe("m-final");
    expect(status.envelopeEventId).toBe("evt-1");
    expect(status.reservationId).toBe("res-1");
    expect(status.leaseOwner).toBe("worker-1");
    expect(status.leaseExpiresAt).toBe("2026-03-03T00:00:00.000Z");
    expect(status.publishedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(status.completedAt).toBe("2026-02-02T00:00:00.000Z");

    // **Failure mode**: if the status projection depended on the (now-null)
    // detailed JSON, it would either throw or surface a broken status object.
    // The route consumes this surface; a broken read would 500 the GET.
  });

  it("after compact, a same-key reserve with a DIFFERENT fingerprint is still rejected (compact did not lift the guardrail)", () => {
    const id = seedTerminalizedAttempt();
    compactAttemptDetails(id);

    // Different fingerprint → rejected_fingerprint (NOT replay, NOT created).
    const mismatched = reserveAttempt(baseInput({ requestFingerprint: "fp-CHANGED" }));

    expect(mismatched.outcome).toBe("rejected_fingerprint");
    if (mismatched.outcome !== "rejected_fingerprint") return;
    expect(mismatched.reservedFingerprint).toBe("fp-1");
    expect(mismatched.attempt.id).toBe(id);

    // **Failure mode**: if compact had erased the fingerprint (a naive
    // "null everything compact" implementation), the reservation layer could
    // no longer reject mismatched same-key reserves — a dedup-evasion bug.
  });

  it("end-to-end: reserve → terminalize → compact → reserve-replays terminal + status-resolves", () => {
    // 1. Reserve
    const first = reserveAttempt(baseInput());
    expect(first.outcome).toBe("created");
    const id = first.outcome === "created" ? first.attempt.id : "";
    const fingerprint = first.outcome === "created" ? first.attempt.requestFingerprint : "";

    // 2. Terminalize via raw update (simulating a later phase's completion).
    getDb()
      .update(taskCreationAttempts)
      .set({
        state: "created",
        terminalOutcome: "created",
        terminalResult: { outcome: "created", taskId: "t-e2e", attemptId: id },
        details: { proposalKind: "create" },
        causalContext: { root: { type: "user", id: "u" } },
        committedTaskId: "t-e2e",
        committedMissionId: "m-e2e",
        completedAt: "2026-02-02T00:00:00.000Z",
      })
      .where(eq(taskCreationAttempts.id, id))
      .run();

    // 3. Compact
    const compacted = compactAttemptDetails(id);
    expect(compacted.outcome).toBe("compacted");

    // 4. Same-key reserve REPLAYS the terminal state (dedup evidence intact).
    const replayed = reserveAttempt(baseInput());
    expect(replayed.outcome).toBe("replayed");
    if (replayed.outcome !== "replayed") return;
    expect(replayed.attempt.id).toBe(id);
    expect(replayed.attempt.state).toBe("created");
    expect(replayed.attempt.terminalOutcome).toBe("created");
    expect(replayed.attempt.terminalResult).toBeNull();
    expect(replayed.attempt.requestFingerprint).toBe(fingerprint);

    // 5. getAttemptStatus RESOLVES the recovery surface (without detailed payload).
    const status = getAttemptStatus(id);
    expect(status.found).toBe(true);
    if (!status.found) return;
    expect(status.status.state).toBe("created");
    expect(status.status.terminalResult).toBeNull();
    expect(status.status.committedTaskId).toBe("t-e2e");
    expect(status.status.completedAt).toBe("2026-02-02T00:00:00.000Z");

    // **Failure mode**: any break in the reserve→terminalize→compact→replay
    // chain (dropped fingerprint, dropped state, dropped outcome, dropped
    // committed IDs) would surface as a replay-classification mismatch or a
    // status not_found. This end-to-end test is the load-bearing proof that
    // the guardrail holds.
  });
});

// ---------------------------------------------------------------------------
// 5. *WithClient contract — no getDb, no nested tx, idempotent under caller
//    tx composition.
// ---------------------------------------------------------------------------

describe("compactAttemptDetailsWithClient — *WithClient contract", () => {
  it("compacts via the caller-supplied client (no getDb inside, no nested tx)", () => {
    const id = seedTerminalizedAttempt();
    const db = getDb();

    // Compose inside a caller-owned short tx; primitive must accept the
    // caller-supplied client without re-calling getDb.
    const result = db.transaction((tx) => compactAttemptDetailsWithClient(tx, id));

    expect(result.outcome).toBe("compacted");
    if (result.outcome !== "compacted") return;
    expect(result.attempt.details).toBeNull();
    expect(result.attempt.terminalResult).toBeNull();
    expect(result.attempt.causalContext).toBeNull();
    // Compact identity preserved.
    expect(result.attempt.state).toBe("created");
    expect(result.attempt.requestFingerprint).toBe("fp-1");

    // **Failure mode**: if compactAttemptDetailsWithClient called getDb()
    // internally (the *WithClient contract violation), the call would still
    // succeed on the happy path (both clients point at the same DB), but
    // the row-level isolation guarantee — atomic with surrounding writes —
    // would be broken. This test does not detect that directly; it documents
    // the contract by using the pattern.
  });

  it("compacting twice inside the same tx returns compacted both times (idempotent under tx composition)", () => {
    const id = seedTerminalizedAttempt();
    const db = getDb();

    const results = db.transaction((tx) => {
      const a = compactAttemptDetailsWithClient(tx, id);
      const b = compactAttemptDetailsWithClient(tx, id);
      return [a, b] as const;
    });

    expect(results[0].outcome).toBe("compacted");
    expect(results[1].outcome).toBe("compacted");
    if (results[0].outcome !== "compacted" || results[1].outcome !== "compacted") return;
    expect(results[1].attempt.details).toBeNull();
    expect(results[1].attempt.terminalResult).toBeNull();
    expect(results[1].attempt.causalContext).toBeNull();

    // **Failure mode**: if compact held some implicit "first compact" state,
    // a second call inside the same tx would diverge. Both calls classify as
    // `compacted` and the row is unchanged.
  });

  it("returns not_found via the caller-supplied client when the id does not exist", () => {
    const db = getDb();

    const result = db.transaction((tx) =>
      compactAttemptDetailsWithClient(tx, "does-not-exist"),
    );

    expect(result.outcome).toBe("not_found");

    // **Failure mode**: if the *WithClient variant threw on not-found (legacy
    // repositoryNotFoundError pattern), the tx would surface the error and
    // this test would fail.
  });
});