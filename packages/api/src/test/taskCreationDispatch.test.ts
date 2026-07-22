/**
 * Dispatch-Target State Primitives — invariant tests (T4A Phase 1).
 *
 * These primitives are DORMANT (no production callers). This test proves the
 * load-bearing invariants that the Phase 2 worker and Phase 3 claim gate will
 * rely on. Each test is a discriminating probe: it FAILS without the primitive
 * (import / not-found) and PASSES after implementation.
 *
 * Contract invariants covered:
 *  1. `pending → accepted` CAS: one transition, `acceptedAt` stamped; re-accept = `no_op`.
 *  2. `pending → attention`: `lastError` set + `attemptCount` incremented.
 *  3. `attention` retry: reset-to-pending-then-advance = `transitioned`.
 *  4. `allDispatchTargetsAccepted`: zero → true; pending → false; all-accepted → true; mix → false.
 *  5. Concurrent double-advance: only one `transitioned`, the other `no_op` (CAS).
 *  6. R5 CAS-race: a losing CAS reports `no_op` (classifies by `SELECT changes()`, not re-read).
 *  7. Adapter registry: register + resolve + unknown → undefined.
 *
 * See the T4A ticket § "Phase 1 grounding" and "Contract invariants".
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  taskCreationAttempts,
  taskCreationEnvelopes,
  taskCreationDispatchTargets,
} from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { TaskPublicationDbClient } from "../repositories/taskPublication.js";
import {
  listDispatchTargetsForEnvelopeWithClient,
  advanceDispatchTargetWithClient,
  allDispatchTargetsAcceptedWithClient,
} from "../repositories/taskCreationDispatch.js";
import {
  registerDispatchAdapter,
  resolveDispatchAdapter,
  type DispatchTargetAdapter,
} from "../services/taskCreationDispatchRegistry.js";

beforeEach(async () => {
  await initTestDb();
});

afterEach(() => closeDb());

// ---------------------------------------------------------------------------
// Seed helpers (minimal — attempts/envelopes/targets only; no FK to tasks/
// missions/habitats since envelope.task_id/habitat_id are plain text)
// ---------------------------------------------------------------------------

function seedAttempt(db: TaskPublicationDbClient, suffix = "1"): string {
  const id = `attempt-${suffix}`;
  db.insert(taskCreationAttempts)
    .values({
      id,
      source: "test",
      sourceScopeKind: "mission",
      sourceScopeId: "m-dispatch-test",
      attemptKey: `key-${suffix}`,
      requestFingerprint: `fp-${suffix}`,
      publicationKind: "create",
      actorType: "human",
      actorId: "user-1",
      state: "pending",
    })
    .run();
  return id;
}

function seedEnvelope(
  db: TaskPublicationDbClient,
  eventId = "evt-1",
  attemptId = "attempt-1",
): void {
  db.insert(taskCreationEnvelopes)
    .values({
      eventId,
      lifecycleAction: "created",
      taskId: `task-${eventId}`,
      habitatId: "habitat-dispatch-test",
      occurredAt: new Date().toISOString(),
      attemptId,
      actorType: "human",
      actorId: "user-1",
      source: "test",
    })
    .run();
}

interface SeedTargetOpts {
  id?: string;
  eventId?: string;
  targetKind?: string;
  targetKey?: string;
  state?: "pending" | "accepted" | "attention";
  attemptCount?: number;
  lastError?: string | null;
  acceptedAt?: string | null;
}

function seedTarget(db: TaskPublicationDbClient, opts: SeedTargetOpts = {}): string {
  const id = opts.id ?? `target-${uuid()}`;
  db.insert(taskCreationDispatchTargets)
    .values({
      id,
      eventId: opts.eventId ?? "evt-1",
      targetKind: opts.targetKind ?? "test_kind",
      targetKey: opts.targetKey ?? `key-${id}`,
      state: opts.state ?? "pending",
      attemptCount: opts.attemptCount ?? 0,
      lastError: opts.lastError ?? null,
      acceptedAt: opts.acceptedAt ?? null,
    })
    .run();
  return id;
}

/** Full seed chain: attempt → envelope → single pending target. Returns targetId. */
function seedEnvelopeWithTarget(
  db: TaskPublicationDbClient,
  eventId = "evt-1",
  targetState: "pending" | "accepted" | "attention" = "pending",
): string {
  seedAttempt(db);
  seedEnvelope(db, eventId);
  return seedTarget(db, { eventId, state: targetState });
}

/**
 * Deterministic competing-writer probe (the R5 CAS-race simulation).
 *
 * Wraps a real drizzle client so the FIRST `update(...).run()` on the wrapped
 * client invokes `inject()` BEFORE delegating the real UPDATE — reproducing a
 * concurrent writer that mutates the row between the function's in-tx read and
 * its conditional UPDATE. On single-threaded sql.js the in-tx read and the
 * UPDATE otherwise always agree, so the CAS race (UPDATE matches zero rows
 * while the re-read sees the target) is only reachable via this injection.
 *
 * Copied from `taskPublicationPrimitives.test.ts` (the established pattern).
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

// ---------------------------------------------------------------------------
// 1. listDispatchTargetsForEnvelopeWithClient
// ---------------------------------------------------------------------------

describe("listDispatchTargetsForEnvelopeWithClient", () => {
  it("returns all targets for an envelope", () => {
    const db = getDb();
    seedAttempt(db);
    seedEnvelope(db, "evt-list");
    seedTarget(db, { eventId: "evt-list", targetKind: "a", targetKey: "k1" });
    seedTarget(db, { eventId: "evt-list", targetKind: "b", targetKey: "k2" });

    const targets = listDispatchTargetsForEnvelopeWithClient(db, "evt-list");
    expect(targets).toHaveLength(2);
    expect(targets.every((t) => t.state === "pending")).toBe(true);
  });

  it("returns an empty array for an envelope with no targets (dormant zero-target case)", () => {
    const db = getDb();
    seedAttempt(db);
    seedEnvelope(db, "evt-empty");

    const targets = listDispatchTargetsForEnvelopeWithClient(db, "evt-empty");
    expect(targets).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. advanceDispatchTargetWithClient — pending → accepted
// ---------------------------------------------------------------------------

describe("advanceDispatchTargetWithClient: pending → accepted", () => {
  it("transitions to accepted and stamps acceptedAt on first advance", () => {
    const db = getDb();
    const targetId = seedEnvelopeWithTarget(db, "evt-accept", "pending");

    const result = advanceDispatchTargetWithClient(db, {
      targetId,
      outcome: "accepted",
    });

    expect(result.outcome).toBe("transitioned");
    expect(result.target.state).toBe("accepted");
    expect(result.target.acceptedAt).not.toBeNull();
    expect(result.target.lastError).toBeNull();
    expect(result.target.attemptCount).toBe(1);
    expect(result.target.lastAttemptAt).not.toBeNull();
  });

  it("re-accepting an already-accepted target is no_op (idempotent, acceptedAt not re-stamped)", () => {
    const db = getDb();
    const targetId = seedEnvelopeWithTarget(db, "evt-reaccept", "pending");

    const first = advanceDispatchTargetWithClient(db, { targetId, outcome: "accepted" });
    expect(first.outcome).toBe("transitioned");
    const stampedAt = first.target.acceptedAt;

    const second = advanceDispatchTargetWithClient(db, { targetId, outcome: "accepted" });
    expect(second.outcome).toBe("no_op");
    expect(second.target.state).toBe("accepted");
    // acceptedAt is NOT re-stamped on the idempotent re-accept.
    expect(second.target.acceptedAt).toBe(stampedAt);
    // attemptCount is NOT incremented on no_op.
    expect(second.target.attemptCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. advanceDispatchTargetWithClient — pending → attention
// ---------------------------------------------------------------------------

describe("advanceDispatchTargetWithClient: pending → attention", () => {
  it("sets lastError and increments attemptCount", () => {
    const db = getDb();
    const targetId = seedEnvelopeWithTarget(db, "evt-attention", "pending");

    const result = advanceDispatchTargetWithClient(db, {
      targetId,
      outcome: "attention",
      lastError: "downstream timeout",
    });

    expect(result.outcome).toBe("transitioned");
    expect(result.target.state).toBe("attention");
    expect(result.target.lastError).toBe("downstream timeout");
    expect(result.target.acceptedAt).toBeNull();
    expect(result.target.attemptCount).toBe(1);
    expect(result.target.lastAttemptAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. advanceDispatchTargetWithClient — attention retry
// ---------------------------------------------------------------------------

describe("advanceDispatchTargetWithClient: attention retry", () => {
  it("resets attention to pending-then-advances to accepted (transitioned, attemptCount incremented)", () => {
    const db = getDb();
    // Seed a target already in attention with attemptCount=1 from a prior failure.
    const targetId = seedEnvelopeWithTarget(db, "evt-retry", "attention");
    db.update(taskCreationDispatchTargets)
      .set({ attemptCount: 1, lastError: "prior failure" })
      .where(eq(taskCreationDispatchTargets.id, targetId))
      .run();

    const result = advanceDispatchTargetWithClient(db, {
      targetId,
      outcome: "accepted",
    });

    expect(result.outcome).toBe("transitioned");
    expect(result.target.state).toBe("accepted");
    expect(result.target.acceptedAt).not.toBeNull();
    // attemptCount incremented once on the retry-advance (1 → 2).
    expect(result.target.attemptCount).toBe(2);
    // lastError cleared on accepted.
    expect(result.target.lastError).toBeNull();
  });

  it("re-attention with a new error updates lastError and increments attemptCount", () => {
    const db = getDb();
    const targetId = seedEnvelopeWithTarget(db, "evt-reattention", "attention");
    db.update(taskCreationDispatchTargets)
      .set({ attemptCount: 1, lastError: "first error" })
      .where(eq(taskCreationDispatchTargets.id, targetId))
      .run();

    const result = advanceDispatchTargetWithClient(db, {
      targetId,
      outcome: "attention",
      lastError: "second error",
    });

    expect(result.outcome).toBe("transitioned");
    expect(result.target.state).toBe("attention");
    expect(result.target.lastError).toBe("second error");
    expect(result.target.attemptCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. advanceDispatchTargetWithClient — CAS guarantees
// ---------------------------------------------------------------------------

describe("advanceDispatchTargetWithClient: CAS guarantees", () => {
  it("concurrent double-advance on the same target: only one transitioned, the other no_op", () => {
    const db = getDb();
    const targetId = seedEnvelopeWithTarget(db, "evt-double", "pending");

    // First advance wins.
    const first = advanceDispatchTargetWithClient(db, {
      targetId,
      outcome: "accepted",
    });
    expect(first.outcome).toBe("transitioned");

    // Second advance on the now-accepted target loses (CAS state='pending'
    // matches zero rows).
    const second = advanceDispatchTargetWithClient(db, {
      targetId,
      outcome: "accepted",
    });
    expect(second.outcome).toBe("no_op");
    expect(second.target.state).toBe("accepted");
  });

  it("R5: a losing CAS reports no_op, not transitioned (classifies by SELECT changes(), not re-read)", () => {
    const db = getDb();
    const targetId = seedEnvelopeWithTarget(db, "evt-r5", "pending");

    let injected = false;
    const probed = withCompetingWrite(db, () => {
      // Simulate a concurrent writer accepting the target BEFORE this call's
      // CAS UPDATE executes. The conditional WHERE (state = 'pending') now
      // matches ZERO rows, but the re-read sees 'accepted'. OLD code
      // (classify by re-read state) would return "transitioned"; NEW code
      // (SELECT changes() affected-row count) returns "no_op".
      injected = true;
      db.update(taskCreationDispatchTargets)
        .set({ state: "accepted", acceptedAt: new Date().toISOString() })
        .where(eq(taskCreationDispatchTargets.id, targetId))
        .run();
    });

    const result = advanceDispatchTargetWithClient(probed, {
      targetId,
      outcome: "accepted",
    });
    expect(injected).toBe(true);
    expect(result.outcome).toBe("no_op");
    if (result.outcome !== "no_op") return;
    // The winner's (concurrent writer's) row is returned unchanged.
    expect(result.target.state).toBe("accepted");
  });

  it("throws notFound for an unknown targetId", () => {
    const db = getDb();
    seedAttempt(db);
    seedEnvelope(db, "evt-missing");

    expect(() =>
      advanceDispatchTargetWithClient(db, {
        targetId: "no-such-target",
        outcome: "accepted",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. allDispatchTargetsAcceptedWithClient
// ---------------------------------------------------------------------------

describe("allDispatchTargetsAcceptedWithClient", () => {
  it("returns true for zero targets (vacuous — dormant common case)", () => {
    const db = getDb();
    seedAttempt(db);
    seedEnvelope(db, "evt-vacuous");

    expect(allDispatchTargetsAcceptedWithClient(db, "evt-vacuous")).toBe(true);
  });

  it("returns false for one pending target", () => {
    const db = getDb();
    seedEnvelopeWithTarget(db, "evt-one-pending", "pending");

    expect(allDispatchTargetsAcceptedWithClient(db, "evt-one-pending")).toBe(false);
  });

  it("returns true for one accepted target", () => {
    const db = getDb();
    seedEnvelopeWithTarget(db, "evt-one-accepted", "accepted");

    expect(allDispatchTargetsAcceptedWithClient(db, "evt-one-accepted")).toBe(true);
  });

  it("returns false for one attention target", () => {
    const db = getDb();
    seedEnvelopeWithTarget(db, "evt-one-attention", "attention");

    expect(allDispatchTargetsAcceptedWithClient(db, "evt-one-attention")).toBe(false);
  });

  it("returns false for a mix of accepted and pending", () => {
    const db = getDb();
    seedAttempt(db);
    seedEnvelope(db, "evt-mix");
    seedTarget(db, { eventId: "evt-mix", targetKind: "a", targetKey: "k1", state: "accepted" });
    seedTarget(db, { eventId: "evt-mix", targetKind: "b", targetKey: "k2", state: "pending" });

    expect(allDispatchTargetsAcceptedWithClient(db, "evt-mix")).toBe(false);
  });

  it("returns true when all targets are accepted", () => {
    const db = getDb();
    seedAttempt(db);
    seedEnvelope(db, "evt-all");
    seedTarget(db, { eventId: "evt-all", targetKind: "a", targetKey: "k1", state: "accepted" });
    seedTarget(db, { eventId: "evt-all", targetKind: "b", targetKey: "k2", state: "accepted" });

    expect(allDispatchTargetsAcceptedWithClient(db, "evt-all")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. DispatchTargetAdapter registry
// ---------------------------------------------------------------------------

describe("DispatchTargetAdapter registry", () => {
  it("registers and resolves an adapter by targetKind", () => {
    const kind = `test-adapter-${uuid()}`;
    const adapter: DispatchTargetAdapter = {
      targetKind: kind,
      attempt: async () => ({ outcome: "accepted" }),
    };
    registerDispatchAdapter(adapter);

    const resolved = resolveDispatchAdapter(kind);
    expect(resolved).toBe(adapter);
  });

  it("returns undefined for an unregistered targetKind", () => {
    expect(resolveDispatchAdapter(`unknown-${uuid()}`)).toBeUndefined();
  });

  it("last registration for a targetKind wins (overwrite)", () => {
    const kind = `overwrite-${uuid()}`;
    const first: DispatchTargetAdapter = {
      targetKind: kind,
      attempt: async () => ({ outcome: "accepted" }),
    };
    const second: DispatchTargetAdapter = {
      targetKind: kind,
      attempt: async () => ({ outcome: "attention", error: "replaced" }),
    };
    registerDispatchAdapter(first);
    registerDispatchAdapter(second);

    const resolved = resolveDispatchAdapter(kind);
    expect(resolved).toBe(second);
  });

  it("adapter attempt outcomes carry the accepted/attention contract", async () => {
    const kind = `outcome-${uuid()}`;
    const acceptedAdapter: DispatchTargetAdapter = {
      targetKind: kind,
      attempt: async () => ({ outcome: "accepted" }),
    };
    registerDispatchAdapter(acceptedAdapter);
    const adapter = resolveDispatchAdapter(kind)!;
    expect((await adapter.attempt(null as never, null as never)).outcome).toBe("accepted");

    const errKind = `err-${uuid()}`;
    const attentionAdapter: DispatchTargetAdapter = {
      targetKind: errKind,
      attempt: async () => ({ outcome: "attention", error: "timeout" }),
    };
    registerDispatchAdapter(attentionAdapter);
    const errAdapter = resolveDispatchAdapter(errKind)!;
    const result = await errAdapter.attempt(null as never, null as never);
    expect(result.outcome).toBe("attention");
    if (result.outcome === "attention") {
      expect(result.error).toBe("timeout");
    }
  });
});
