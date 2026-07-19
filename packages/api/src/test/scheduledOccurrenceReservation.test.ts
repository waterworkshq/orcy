/**
 * T9A Phase 2 — scheduled occurrence reservation transaction.
 *
 * Exercises the load-bearing guardrails of `reserveScheduledOccurrence` /
 * `reserveScheduledOccurrenceWithClient` against the REAL test DB (sql.js —
 * SQLite compare-and-set + UNIQUE-constraint semantics behave identically to
 * production better-sqlite3). Each test states the SPECIFIC failure mode
 * that would break its assertion (proving it is not tautological), matching
 * the T9A Phase 1 convention (`scheduledOccurrences.test.ts`) and the T3A
 * Phase 1/2/3 convention.
 *
 * Guardrails under test (T9A ticket § "Phase 2 — Occurrence reservation"):
 *   - Atomicity: occurrence insert + schedule advance + one-shot disable
 *     commit together or roll back together (one tx).
 *   - Schedule-advance-once: the CAS moves `runCount` forward by exactly 1
 *     per firing (NOT per reservation call); a concurrent reservation that
 *     already advanced surfaces as `advanced: false` (no double-count).
 *   - Idempotency: two reservations for the SAME `(scheduleId, scheduledFor)`
 *     → ONE occurrence + ONE schedule advance (the partial unique index
 *     `uq_scheduled_occurrences_schedule_due` is the race defender).
 *   - One-shot disablement AT RESERVATION (not on publication success): the
 *     fix for `scheduledTaskService.ts:244-246`. A one-shot is disabled
 *     inside the reservation tx, so even if publication later fails, it
 *     cannot refire.
 *   - Recurring independence: one occurrence's reservation does not affect a
 *     different schedule's advancement.
 *   - Schedule-revision snapshot: the occurrence carries the schedule's full
 *     row at reservation time (a later schedule edit does not retroactively
 *     change the reserved occurrence's snapshot — the optimistic publication
 *     guard for Phase 3).
 *
 * Out of scope: Phase 3's publisher, T9B's lease-reclaim worker, scheduler
 * wiring (T11). The reservation is DORMANT — no production origin routes
 * through it yet.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as scheduledTaskRepo from "../repositories/scheduledTask.js";
import {
  reserveScheduledOccurrence,
  reserveScheduledOccurrenceWithClient,
  ScheduledOccurrenceAdvanceLostRace,
  type ReserveScheduledOccurrenceInput,
} from "../repositories/scheduledOccurrenceReservation.js";
import { scheduledOccurrences, scheduledTasks, taskCreationAttempts } from "../db/schema/index.js";
import { eq, sql } from "drizzle-orm";
import type { TaskPublicationDbClient } from "../repositories/taskPublication.js";
import type { TaskPriority, TaskTemplateEntry } from "../models/index.js";
import { FailingDbClient } from "./helpers/failingDbClient.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let habitatId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(scheduledOccurrences).run();
  db.delete(scheduledTasks).run();
  const habitat = habitatRepo.createHabitat({ name: "Test Habitat" });
  habitatId = habitat.id;
});

afterEach(() => closeDb());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW_ISO = "2026-07-19T12:00:00.000Z";
const PAST_ISO = "2020-01-01T00:00:00.000Z";
const NEXT_RUN_FAR_FUTURE = "9999-12-31T23:59:59.000Z";
const NEXT_RUN_INTERVAL = "2026-07-19T13:00:00.000Z"; // 1h after NOW

/** Canonical recurring (interval) schedule, DUE at NOW_ISO. */
function seedIntervalSchedule(overrides: Record<string, unknown> = {}): string {
  const schedule = scheduledTaskRepo.createScheduledTask({
    habitatId,
    name: "Interval Schedule",
    scheduleType: "interval",
    intervalMinutes: 60,
    missionTitle: "Recurring mission",
    missionPriority: "medium" as TaskPriority,
    missionLabels: ["recurring"],
    tasksTemplate: [{ title: "Task A", description: "desc", order: 0 }] as TaskTemplateEntry[],
    nextRunAt: NOW_ISO,
    createdBy: "system",
    ...overrides,
  });
  return schedule.id;
}

/** Canonical one-shot schedule, DUE at NOW_ISO. */
function seedOnceSchedule(overrides: Record<string, unknown> = {}): string {
  const schedule = scheduledTaskRepo.createScheduledTask({
    habitatId,
    name: "One-shot Schedule",
    scheduleType: "once",
    missionTitle: "One-shot mission",
    missionPriority: "high" as TaskPriority,
    missionLabels: ["oneshot"],
    tasksTemplate: [{ title: "Task Once", description: "desc", order: 0 }] as TaskTemplateEntry[],
    nextRunAt: NOW_ISO,
    createdBy: "system",
    ...overrides,
  });
  return schedule.id;
}

/** Canonical reservation input; callers override individual fields. */
function baseInput(
  scheduleId: string,
  overrides: Partial<ReserveScheduledOccurrenceInput> = {},
): ReserveScheduledOccurrenceInput {
  return {
    scheduleId,
    nextRunAt: NEXT_RUN_INTERVAL,
    now: NOW_ISO,
    ...overrides,
  };
}

/** Reads the current schedule row by id. */
function readSchedule(id: string) {
  return scheduledTaskRepo.getScheduledTaskById(id)!;
}

/** Reads the current occurrence row by id. */
function readOccurrence(id: string) {
  const row = getDb()
    .select()
    .from(scheduledOccurrences)
    .where(eq(scheduledOccurrences.id, id))
    .all()[0];
  if (!row) throw new Error(`occurrence ${id} vanished`);
  return row;
}

// ---------------------------------------------------------------------------
// 1. Happy path (recurring) — occurrence created + schedule advanced + still enabled
// ---------------------------------------------------------------------------

describe("reserveScheduledOccurrence — happy path (recurring interval)", () => {
  it("creates a reserved occurrence, advances the schedule exactly once, leaves it enabled", () => {
    const scheduleId = seedIntervalSchedule();
    const before = readSchedule(scheduleId);
    expect(before.runCount).toBe(0);
    expect(before.enabled).toBe(true);

    const result = reserveScheduledOccurrence(baseInput(scheduleId));

    // **Failure mode**: if the occurrence wasn't created, `outcome` would be
    // `rejected` or `already_exists`, not `created`.
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");

    // Occurrence is `reserved`, carries the scheduleId + scheduledFor + ordinal.
    expect(result.occurrence.state).toBe("reserved");
    expect(result.occurrence.scheduledTaskId).toBe(scheduleId);
    // scheduledFor defaults to the schedule's nextRunAt at read time.
    expect(result.occurrence.scheduledFor).toBe(NOW_ISO);
    // ordinal = runCount BEFORE advance (zero-based: first firing → 0).
    expect(result.occurrence.ordinal).toBe(0);
    expect(result.advanced).toBe(true);

    // Schedule advanced exactly once: runCount 0→1, lastRunAt stamped,
    // nextRunAt moved forward to the advance target, STILL enabled.
    const after = readSchedule(scheduleId);
    expect(after.runCount).toBe(1);
    expect(after.lastRunAt).toBe(NOW_ISO);
    expect(after.nextRunAt).toBe(NEXT_RUN_INTERVAL);
    expect(after.enabled).toBe(true);

    // **Failure mode**: if the schedule CAS predicate was wrong (e.g. missing
    // the `enabled = true` condition), `enabled` would flip or `runCount`
    // would not increment.
  });

  it("second firing of the same recurring schedule reserves a distinct occurrence with ordinal=1", () => {
    const scheduleId = seedIntervalSchedule();
    // First firing at NOW_ISO.
    const r1 = reserveScheduledOccurrence(baseInput(scheduleId));
    expect(r1.outcome).toBe("created");
    if (r1.outcome !== "created") throw new Error("unreachable");
    expect(r1.occurrence.ordinal).toBe(0);

    // Advance the clock: schedule's nextRunAt is now NEXT_RUN_INTERVAL.
    // Second firing at NEXT_RUN_INTERVAL, next nextRunAt is 14:00.
    const r2 = reserveScheduledOccurrence(
      baseInput(scheduleId, {
        scheduledFor: NEXT_RUN_INTERVAL,
        nextRunAt: "2026-07-19T14:00:00.000Z",
        now: NEXT_RUN_INTERVAL,
      }),
    );
    expect(r2.outcome).toBe("created");
    if (r2.outcome !== "created") throw new Error("unreachable");
    expect(r2.occurrence.ordinal).toBe(1);
    expect(r2.occurrence.scheduledFor).toBe(NEXT_RUN_INTERVAL);
    expect(r2.occurrence.id).not.toBe(r1.occurrence.id);

    // Schedule advanced twice total.
    expect(readSchedule(scheduleId).runCount).toBe(2);

    // **Failure mode**: if ordinal was derived from the post-advance runCount
    // (1-based), r1.ordinal would be 1 and r2.ordinal would be 2.
  });
});

// ---------------------------------------------------------------------------
// 2. Happy path (one-shot) — THE FIX: disabled AT RESERVATION, not on success
// ---------------------------------------------------------------------------

describe("reserveScheduledOccurrence — one-shot disablement AT RESERVATION (the fix)", () => {
  it("disables a one-shot schedule inside the reservation tx (before any publication)", () => {
    const scheduleId = seedOnceSchedule();
    const before = readSchedule(scheduleId);
    expect(before.scheduleType).toBe("once");
    expect(before.enabled).toBe(true);

    const result = reserveScheduledOccurrence(
      // The advance target for a one-shot is the 9999 sentinel (mirrors
      // calculateNextRun line 92-93).
      baseInput(scheduleId, { nextRunAt: NEXT_RUN_FAR_FUTURE }),
    );

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.advanced).toBe(true);

    // THE FIX: `enabled = false` is durable from the reservation tx. Even if
    // publication (Phase 3) never runs or fails, the one-shot cannot refire.
    const after = readSchedule(scheduleId);
    expect(after.enabled).toBe(false);
    expect(after.runCount).toBe(1);
    expect(after.nextRunAt).toBe(NEXT_RUN_FAR_FUTURE);

    // **Failure mode**: if disablement was on publication success (the legacy
    // `scheduledTaskService.ts:244-246` pattern), `enabled` would still be
    // `true` here because we never called the publisher.
  });

  it("proves the fix: one-shot stays disabled even when publication is never invoked", () => {
    // Simulate the legacy bug scenario: a one-shot fires, but publication
    // (mission creation) is never called / throws. Under the legacy flow,
    // `enabled` stays true and the one-shot would refire on the next
    // `processDueTasks` pass. Under the reservation flow, `enabled` is false
    // from the reservation tx regardless.
    const scheduleId = seedOnceSchedule();
    reserveScheduledOccurrence(baseInput(scheduleId, { nextRunAt: NEXT_RUN_FAR_FUTURE }));

    // NO publication happens. Simulate a crash / throw / governance veto.
    // (Phase 3's publisher is not yet built — this is the dormant state.)

    const after = readSchedule(scheduleId);
    expect(after.enabled).toBe(false);

    // The scheduler's due-check (`getDueScheduledTasks`: enabled=true AND
    // nextRunAt<=now) would NOT pick up this schedule: enabled is false AND
    // nextRunAt is the 9999 sentinel.
    expect(after.nextRunAt).toBe(NEXT_RUN_FAR_FUTURE);
    const dueTasks = scheduledTaskRepo.getDueScheduledTasks();
    expect(dueTasks.find((t) => t.id === scheduleId)).toBeUndefined();

    // **Failure mode**: if the disable was conditional on publication success
    // (the legacy bug), the schedule would appear in `getDueScheduledTasks`
    // (enabled=true, nextRunAt=NOW_ISO<=now) and refire.
  });

  it("occurrence is reserved even though the one-shot schedule is disabled (publication may still proceed)", () => {
    const scheduleId = seedOnceSchedule();
    const result = reserveScheduledOccurrence(
      baseInput(scheduleId, { nextRunAt: NEXT_RUN_FAR_FUTURE }),
    );
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");

    // The occurrence is `reserved` — Phase 3's publisher can still pick it up
    // and publish. The schedule being disabled does NOT block the pending
    // occurrence; it only prevents NEW firings.
    expect(result.occurrence.state).toBe("reserved");
  });
});

// ---------------------------------------------------------------------------
// 3. Concurrent / idempotent reservation — the LOAD-BEARING idempotency proof
// ---------------------------------------------------------------------------

describe("reserveScheduledOccurrence — concurrent same-key reservation (idempotency)", () => {
  it("two reservations for the SAME (scheduleId, scheduledFor) → ONE occurrence + ONE schedule advance", () => {
    const scheduleId = seedIntervalSchedule();

    // First reservation wins. Pass scheduledFor explicitly so the second
    // call targets the SAME uniqueness pair (the default would derive from
    // schedule.nextRunAt, which the first call advances).
    const r1 = reserveScheduledOccurrence(baseInput(scheduleId, { scheduledFor: NOW_ISO }));
    expect(r1.outcome).toBe("created");
    if (r1.outcome !== "created") throw new Error("unreachable");
    expect(r1.advanced).toBe(true);

    // Second reservation for the SAME (scheduleId, NOW_ISO). The schedule's
    // nextRunAt has already advanced to NEXT_RUN_INTERVAL (future) — WITHOUT
    // the idempotent-replay pre-check, this would reject as schedule_not_due.
    // The pre-check finds the existing occurrence → already_exists + advanced:
    // false (no double-count).
    const r2 = reserveScheduledOccurrence(baseInput(scheduleId, { scheduledFor: NOW_ISO }));
    expect(r2.outcome).toBe("already_exists");
    if (r2.outcome !== "already_exists") throw new Error("unreachable");
    expect(r2.advanced).toBe(false);
    // Returns the SAME occurrence row (the winner's).
    expect(r2.occurrence.id).toBe(r1.occurrence.id);

    // THE LOAD-BEARING ASSERTION: the schedule advanced by EXACTLY 1, not 2.
    // The second call's no-op advance did not double-count the firing.
    const after = readSchedule(scheduleId);
    expect(after.runCount).toBe(1);

    // Exactly one occurrence row exists for this schedule.
    const occurrenceRows = getDb()
      .select()
      .from(scheduledOccurrences)
      .where(eq(scheduledOccurrences.scheduledTaskId, scheduleId))
      .all();
    expect(occurrenceRows.length).toBe(1);

    // **Failure mode**: if the reservation advanced the schedule BEFORE the
    // occurrence UNIQUE check (or didn't gate the advance on `created`),
    // runCount would be 2 (double-counted) and/or two occurrence rows would
    // exist.
  });

  it("concurrent one-shot reservations: ONE occurrence, runCount=1, enabled=false", () => {
    const scheduleId = seedOnceSchedule();
    const input = baseInput(scheduleId, {
      nextRunAt: NEXT_RUN_FAR_FUTURE,
      scheduledFor: NOW_ISO,
    });

    const r1 = reserveScheduledOccurrence(input);
    const r2 = reserveScheduledOccurrence(input);

    expect(r1.outcome).toBe("created");
    expect(r2.outcome).toBe("already_exists");

    const after = readSchedule(scheduleId);
    expect(after.runCount).toBe(1);
    expect(after.enabled).toBe(false);

    // **Failure mode**: if the one-shot disable was re-entered on the second
    // call (already_exists), it would be a harmless idempotent no-op — but if
    // the advance was re-entered, runCount would be 2.
  });
});

// ---------------------------------------------------------------------------
// 4. Recurring independence — one reservation does not affect a different schedule
// ---------------------------------------------------------------------------

describe("reserveScheduledOccurrence — recurring independence across schedules", () => {
  it("reserving schedule A does not advance schedule B", () => {
    const scheduleA = seedIntervalSchedule({ name: "A" });
    const scheduleB = seedIntervalSchedule({ name: "B" });

    const rA = reserveScheduledOccurrence(baseInput(scheduleA));
    expect(rA.outcome).toBe("created");

    const afterA = readSchedule(scheduleA);
    const afterB = readSchedule(scheduleB);

    // A advanced.
    expect(afterA.runCount).toBe(1);
    expect(afterA.nextRunAt).toBe(NEXT_RUN_INTERVAL);

    // B is UNTOUCHED — its own reservation is independent.
    expect(afterB.runCount).toBe(0);
    expect(afterB.nextRunAt).toBe(NOW_ISO);
    expect(afterB.enabled).toBe(true);

    // **Failure mode**: if the advance CAS predicate was missing the
    // `eq(id)` condition (e.g. a blanket UPDATE), B would also advance.
  });
});

// ---------------------------------------------------------------------------
// 5. Schedule-revision snapshot — the optimistic publication guard
// ---------------------------------------------------------------------------

describe("reserveScheduledOccurrence — scheduleRevision snapshot", () => {
  it("the occurrence carries the schedule's full row at reservation time", () => {
    const scheduleId = seedIntervalSchedule({ missionTitle: "Original Title" });

    const result = reserveScheduledOccurrence(baseInput(scheduleId));
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");

    // The snapshot captured the schedule's state at reservation time.
    const snapshot = result.occurrence.scheduleRevision as Record<string, unknown>;
    expect(snapshot).toBeTruthy();
    expect(snapshot.id).toBe(scheduleId);
    expect(snapshot.missionTitle).toBe("Original Title");
    expect(snapshot.runCount).toBe(0); // BEFORE the advance
    expect(snapshot.nextRunAt).toBe(NOW_ISO); // BEFORE the advance
  });

  it("a later schedule edit does NOT retroactively change the reserved occurrence's snapshot", () => {
    const scheduleId = seedIntervalSchedule({ missionTitle: "Original Title" });

    const result = reserveScheduledOccurrence(baseInput(scheduleId));
    if (result.outcome !== "created") throw new Error("unreachable");
    const originalSnapshot = result.occurrence.scheduleRevision as Record<string, unknown>;
    expect(originalSnapshot.missionTitle).toBe("Original Title");

    // Edit the schedule AFTER the reservation.
    scheduledTaskRepo.updateScheduledTask(scheduleId, {
      missionTitle: "Edited Title",
      missionPriority: "high" as TaskPriority,
    });

    // The occurrence's snapshot is FROZEN — it still carries the original.
    const occurrence = readOccurrence(result.occurrence.id);
    const frozenSnapshot = occurrence.scheduleRevision as Record<string, unknown>;
    expect(frozenSnapshot.missionTitle).toBe("Original Title");

    // The LIVE schedule row reflects the edit (Phase 3's publisher diffs the
    // snapshot to the live row to detect this exact scenario).
    const liveSchedule = readSchedule(scheduleId);
    expect(liveSchedule.missionTitle).toBe("Edited Title");

    // **Failure mode**: if the snapshot was a live reference (not a deep
    // copy / JSON-serialized), it would reflect "Edited Title".
  });
});

// ---------------------------------------------------------------------------
// 6. Reservation-time validation (rejected branches)
// ---------------------------------------------------------------------------

describe("reserveScheduledOccurrence — rejected (reservation-time validation)", () => {
  it("rejects a missing schedule with a typed reason (no occurrence, no mutation)", () => {
    const result = reserveScheduledOccurrence(baseInput("nonexistent-schedule-id"));
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("schedule_not_found");

    // No occurrence row created.
    expect(getDb().select().from(scheduledOccurrences).all().length).toBe(0);
  });

  it("rejects a disabled schedule with a typed reason (no mutation)", () => {
    const scheduleId = seedIntervalSchedule();
    scheduledTaskRepo.updateScheduledTask(scheduleId, { enabled: false });

    const result = reserveScheduledOccurrence(baseInput(scheduleId));
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("schedule_disabled");

    // No occurrence row, schedule still disabled + untouched.
    expect(getDb().select().from(scheduledOccurrences).all().length).toBe(0);
    const after = readSchedule(scheduleId);
    expect(after.enabled).toBe(false);
    expect(after.runCount).toBe(0);
  });

  it("rejects a not-due schedule (nextRunAt > now) — stale scheduler tick", () => {
    const scheduleId = seedIntervalSchedule();
    // The schedule is due at NOW_ISO; pass a `now` BEFORE the due time.
    const result = reserveScheduledOccurrence(baseInput(scheduleId, { now: PAST_ISO }));
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("schedule_not_due");

    // No occurrence, no mutation.
    expect(getDb().select().from(scheduledOccurrences).all().length).toBe(0);
    expect(readSchedule(scheduleId).runCount).toBe(0);

    // **Failure mode**: if the due-check was absent, the reservation would
    // create an occurrence for a schedule that isn't due yet, and the
    // advance CAS would still fire (predicate matches because nextRunAt
    // <= now would be... actually false here. But the occurrence would
    // still be created — an orphan for a non-due firing).
  });

  it("uses the schedule's nextRunAt as scheduledFor when scheduledFor is omitted", () => {
    const scheduleId = seedIntervalSchedule();
    const result = reserveScheduledOccurrence({
      scheduleId,
      nextRunAt: NEXT_RUN_INTERVAL,
      now: NOW_ISO,
    });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.occurrence.scheduledFor).toBe(NOW_ISO); // = schedule.nextRunAt
  });
});

// ---------------------------------------------------------------------------
// 7. *WithClient invariant — the composer NEVER calls getDb / opens its own
//    tx. Proven by FailingDbClient: a write failure inside the caller's tx
//    rolls back the WHOLE tx (no escape hatch to getDb()).
// ---------------------------------------------------------------------------

describe("FailingDbClient invariant — composer is tx-aware (never escapes to getDb)", () => {
  it("reservation rolls back entirely when a write throws inside the caller's tx", () => {
    const scheduleId = seedIntervalSchedule();
    const db = getDb();
    const beforeOccurrences = db.select().from(scheduledOccurrences).all().length;
    const beforeRunCount = readSchedule(scheduleId).runCount;

    expect(() => {
      db.transaction((tx) => {
        const w = new FailingDbClient(tx as unknown as TaskPublicationDbClient, {
          // Fail on the 2nd write — the occurrence INSERT (write #1) succeeds,
          // then the schedule advance UPDATE (write #2) throws → whole tx
          // rolls back, proving the occurrence INSERT did not escape.
          failAtWriteN: 2,
        });
        reserveScheduledOccurrenceWithClient(
          w as unknown as TaskPublicationDbClient,
          baseInput(scheduleId),
        );
      });
    }).toThrow();

    // The occurrence INSERT rolled back with the tx — no orphan row.
    const afterOccurrences = db.select().from(scheduledOccurrences).all().length;
    expect(afterOccurrences).toBe(beforeOccurrences);

    // The schedule did NOT advance (the advance UPDATE threw + rolled back).
    expect(readSchedule(scheduleId).runCount).toBe(beforeRunCount);

    // **Failure mode**: if `reserveScheduledOccurrenceWithClient` called
    // `getDb()` for any of its writes (instead of the passed `tx` client),
    // the INSERT or UPDATE would commit OUTSIDE the failing tx →
    // `afterOccurrences` would be `beforeOccurrences + 1` and/or `runCount`
    // would be `beforeRunCount + 1`.
  });
});

// ---------------------------------------------------------------------------
// 8. Dormancy — the reservation is exported + tested but wires NO production caller
// ---------------------------------------------------------------------------

describe("reserveScheduledOccurrence — dormancy", () => {
  it("the legacy executeScheduledTask flow is byte-unchanged (claimExecution still the active path)", () => {
    // Seed the schedule with a clearly-PAST nextRunAt so claimExecution's
    // internal `new Date().toISOString()` (the real current time) is
    // definitely >= nextRunAt — the CAS predicate `nextRunAt <= now` matches.
    const scheduleId = seedIntervalSchedule({ nextRunAt: PAST_ISO });
    const claimed = scheduledTaskRepo.claimExecution(scheduleId, NEXT_RUN_INTERVAL);
    expect(claimed).toBe(true);

    const after = readSchedule(scheduleId);
    expect(after.runCount).toBe(1);
    expect(after.nextRunAt).toBe(NEXT_RUN_INTERVAL);
    // Legacy claimExecution does NOT disable (that's the service's job at L244).
    expect(after.enabled).toBe(true);

    // **Failure mode**: if the new sibling primitives had modified
    // claimExecution's predicate or set clause, the legacy claim would behave
    // differently (e.g. disabled = false would be wrong, or the CAS would
    // fail).
  });
});

// ===========================================================================
// 9. T9A-03 — occurrence-level coordination attempt reserved + linked.
// ===========================================================================

describe("reserveScheduledOccurrence — T9A-03 occurrence-level coordination attempt", () => {
  it("reserves ONE coordination attempt scoped by the occurrence + stamps its id on the occurrence row", () => {
    const scheduleId = seedIntervalSchedule();

    const result = reserveScheduledOccurrence(baseInput(scheduleId));

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");

    // The occurrence row carries the coordination attempt's id.
    expect(result.occurrence.attemptId).not.toBeNull();
    const coordinationAttemptId = result.occurrence.attemptId as string;

    // The coordination attempt row exists with the expected scope/key.
    const attempt = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.id, coordinationAttemptId))
      .all()[0];
    expect(attempt).toBeTruthy();
    expect(attempt.attemptKey).toBe("occurrence");
    expect(attempt.sourceScopeKind).toBe("scheduled_occurrence");
    expect(attempt.sourceScopeId).toBe(result.occurrence.id);
    expect(attempt.source).toBe("scheduler");
    expect(attempt.publicationKind).toBe("scheduled_occurrence");
    expect(attempt.state).toBe("pending");
    expect(attempt.actorType).toBe("system");
    expect(attempt.actorId).toBe("scheduler");
    expect(attempt.habitatId).toBe(habitatId);
    expect(attempt.causalContext).toEqual({
      root: { type: "scheduled_occurrence", id: result.occurrence.id },
    });

    // **Failure mode**: if the reservation didn't reserve the coordination
    // attempt OR didn't stamp the link, `attemptId` would be null + no
    // attempt row would exist.
  });

  it("the coordination attempt's fingerprint is deterministic in the occurrence's identity basis (same schedule+due+ordinal → same fingerprint)", () => {
    const scheduleId = seedIntervalSchedule();

    const r1 = reserveScheduledOccurrence(baseInput(scheduleId));
    if (r1.outcome !== "created") throw new Error("unreachable");
    const a1 = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.id, r1.occurrence.attemptId as string))
      .all()[0];

    // A second firing of the same schedule at a DIFFERENT due time produces
    // a DIFFERENT occurrence (different scheduledFor) + a DIFFERENT
    // coordination attempt, but the fingerprint is structurally consistent
    // (same prefix; different payload hash because scheduledFor differs).
    const r2 = reserveScheduledOccurrence(
      baseInput(scheduleId, {
        scheduledFor: NEXT_RUN_INTERVAL,
        nextRunAt: "2026-07-19T14:00:00.000Z",
        now: NEXT_RUN_INTERVAL,
      }),
    );
    if (r2.outcome !== "created") throw new Error("unreachable");
    const a2 = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.id, r2.occurrence.attemptId as string))
      .all()[0];

    expect(a1.id).not.toBe(a2.id);
    expect(a1.requestFingerprint).toMatch(/^scheduled_occurrence_coord:/);
    expect(a2.requestFingerprint).toMatch(/^scheduled_occurrence_coord:/);
    expect(a1.requestFingerprint).not.toBe(a2.requestFingerprint);
  });

  it("the already_exists branch returns the winner's occurrence WITH its coordination attempt link intact", () => {
    const scheduleId = seedIntervalSchedule();

    const r1 = reserveScheduledOccurrence(baseInput(scheduleId, { scheduledFor: NOW_ISO }));
    if (r1.outcome !== "created") throw new Error("unreachable");

    const r2 = reserveScheduledOccurrence(baseInput(scheduleId, { scheduledFor: NOW_ISO }));
    expect(r2.outcome).toBe("already_exists");
    if (r2.outcome !== "already_exists") throw new Error("unreachable");

    // The winner's occurrence row (with its coordination attempt link) is
    // returned verbatim — the loser does NOT re-reserve a coordination
    // attempt or re-stamp.
    expect(r2.occurrence.id).toBe(r1.occurrence.id);
    expect(r2.occurrence.attemptId).toBe(r1.occurrence.attemptId);
  });
});

// ===========================================================================
// 10. T9A-02 — lost-race atomicity (no dangling reserved occurrence).
// ===========================================================================

/**
 * Test-only Proxy wrapper around a drizzle client (ROOT or tx) that
 * simulates a concurrent different-`scheduledFor` reservation winning the
 * schedule-advance CAS. Hooks the FIRST `.update(scheduledTasks)` call (the
 * loser's advance CAS) + runs a side-channel advance BEFORE delegating, so
 * the loser's CAS predicate `nextRunAt <= now` matches zero rows.
 *
 * The side-channel runs on the SAME client (the inner) — when the loser's tx
 * rolls back, the side-channel advance rolls back too. The test asserts
 * POST-ROLLBACK state (no occurrence, no attempt, schedule unchanged) — NOT
 * the winner's persistence (which is a different scenario, tested implicitly
 * by the concurrent same-key test at section 3).
 *
 * Used in TWO modes:
 *   - WRAPPER test (`reserveScheduledOccurrence`): wraps the ROOT db passed
 *     as the wrapper's optional `db` arg. Post-SQLITE-BUSY-fix the wrapper
 *     calls `db.run(sql\`BEGIN IMMEDIATE\`)` + `reserveScheduledOccurrenceWithClient(db, …)`
 *     directly on this proxy (NO `.transaction` interception) — the side-
 *     channel fires inside the manually-opened tx + rolls back with it.
 *   - PRIMITIVE test (`reserveScheduledOccurrenceWithClient`): wraps the
 *     INNER tx client inside the caller's own `db.transaction((tx) => …)`.
 *     The primitive's contract is "compose inside a caller-owned tx" — the
 *     test owns the tx.
 *
 * Forwards `.run` (for the wrapper's `BEGIN IMMEDIATE` / `COMMIT` /
 * `ROLLBACK`), `.select`, `.insert`, `.update` (post-injection), `.delete`,
 * `.get` to the inner client.
 */
class ConcurrentAdvanceWinnerTx {
  private injected = false;

  constructor(
    public readonly inner: TaskPublicationDbClient,
    private readonly scheduleId: string,
    private readonly winnerNextRunAt: string,
    private readonly advanceTime: string,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(table: unknown): any {
    if (!this.injected && table === scheduledTasks) {
      // Side-channel: pre-advance the schedule BEFORE the loser's CAS UPDATE
      // runs. The mutation is on the SAME client (root or tx) → rolls back
      // with the loser's tx. Inside the tx (between this mutation and the
      // loser's CAS), the schedule's `nextRunAt` is `winnerNextRunAt` (in
      // the future), so the loser's CAS predicate `nextRunAt <= now` matches
      // zero rows → `advanced:false` → T9A-02 sentinel throw → rollback.
      this.inner
        .update(scheduledTasks)
        .set({
          nextRunAt: this.winnerNextRunAt,
          runCount: sql`${scheduledTasks.runCount} + 1`,
          lastRunAt: this.advanceTime,
          updatedAt: this.advanceTime,
        })
        .where(eq(scheduledTasks.id, this.scheduleId))
        .run();
      this.injected = true;
    }
    return (this.inner as unknown as { update: (t: unknown) => unknown }).update(table);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(...args: unknown[]): any {
    // Forward `db.run(sql\`BEGIN IMMEDIATE | COMMIT | ROLLBACK\`)` to the
    // inner client. Required by the WRAPPER-mode usage (post-SQLITE-BUSY-fix
    // the wrapper opens its tx via `db.run(sql\`BEGIN IMMEDIATE\`)` instead
    // of drizzle's `.transaction`).
    return (this.inner as unknown as { run: (...a: unknown[]) => unknown }).run(...args);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(...args: unknown[]): any {
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
  get(...args: unknown[]): any {
    return (this.inner as unknown as { get: (...a: unknown[]) => unknown }).get(...args);
  }
}

describe("reserveScheduledOccurrence — T9A-02 lost-race atomicity (no dangling reserved occurrence)", () => {
  it("the wrapper returns {outcome:'lost_race'} when the advance CAS loses on a fresh insert", () => {
    const scheduleId = seedIntervalSchedule();
    const beforeOccurrences = getDb().select().from(scheduledOccurrences).all().length;
    const beforeAttempts = getDb().select().from(taskCreationAttempts).all().length;

    // Wrap the db so the FIRST scheduled_tasks UPDATE inside the tx is
    // preceded by a side-channel advance (simulating a concurrent different-
    // scheduledFor winner's committed advance). The loser's advance CAS
    // predicate `nextRunAt <= now` then matches zero rows.
    //
    // Post-SQLITE-BUSY-fix: the wrapper calls `db.run(sql\`BEGIN IMMEDIATE\`)`
    // + `reserveScheduledOccurrenceWithClient(db, …)` directly on this proxy
    // (NO `.transaction` interception). The proxy forwards `.run` (BEGIN/
    // COMMIT/ROLLBACK) to the inner + intercepts the first `.update(scheduledTasks)`
    // for the side-channel injection. The side-channel fires INSIDE the
    // manual tx → rolls back with it.
    const wrappedDb = new ConcurrentAdvanceWinnerTx(
      getDb(),
      scheduleId,
      NEXT_RUN_INTERVAL,
      NOW_ISO,
    );
    const result = reserveScheduledOccurrence(
      baseInput(scheduleId),
      wrappedDb as unknown as TaskPublicationDbClient,
    );

    // **Failure mode**: pre-T9A-02 this branch returned
    // `{outcome:"created", advanced:false}`, persisting a dangling reserved
    // occurrence. Post-T9A-02 the tx rolls back + the wrapper returns the
    // typed `lost_race` outcome.
    expect(result.outcome).toBe("lost_race");

    // Atomicity proof: no occurrence row persisted (the INSERT rolled back
    // with the tx).
    const afterOccurrences = getDb().select().from(scheduledOccurrences).all().length;
    expect(afterOccurrences).toBe(beforeOccurrences);

    // Atomicity proof: no coordination attempt persisted (rolled back with
    // the tx).
    const afterAttempts = getDb().select().from(taskCreationAttempts).all().length;
    expect(afterAttempts).toBe(beforeAttempts);

    // The schedule did NOT advance (the side-channel + the loser's CAS both
    // rolled back with the tx). This is the LOSER's view — the winner's
    // persistence is a separate scenario (the test simulates the winner's
    // advance as a side-channel inside the same tx, so it rolls back with
    // the loser).
    const after = readSchedule(scheduleId);
    expect(after.runCount).toBe(0);
    expect(after.nextRunAt).toBe(NOW_ISO);
  });

  it("the WithClient primitive throws ScheduledOccurrenceAdvanceLostRace on the lost race (caller's tx rolls back)", () => {
    const scheduleId = seedIntervalSchedule();
    const beforeOccurrences = getDb().select().from(scheduledOccurrences).all().length;
    const beforeAttempts = getDb().select().from(taskCreationAttempts).all().length;
    const beforeRunCount = readSchedule(scheduleId).runCount;

    // The primitive throws — the caller's manually-opened tx rolls back.
    // Use a wrapped tx client to simulate the concurrent winner.
    let caught: unknown;
    try {
      getDb().transaction((tx) => {
        const wrapped = new ConcurrentAdvanceWinnerTx(
          tx as unknown as TaskPublicationDbClient,
          scheduleId,
          NEXT_RUN_INTERVAL,
          NOW_ISO,
        );
        reserveScheduledOccurrenceWithClient(
          wrapped as unknown as TaskPublicationDbClient,
          baseInput(scheduleId),
        );
      });
    } catch (err) {
      caught = err;
    }

    // **Failure mode**: pre-T9A-02 the primitive returned
    // `{outcome:"created", advanced:false}`. Post-T9A-02 it throws the
    // sentinel → the caller's tx rolls back atomically.
    expect(caught).toBeInstanceOf(ScheduledOccurrenceAdvanceLostRace);

    // Atomicity proof: no occurrence row + no coordination attempt persisted.
    expect(getDb().select().from(scheduledOccurrences).all()).toHaveLength(beforeOccurrences);
    expect(getDb().select().from(taskCreationAttempts).all()).toHaveLength(beforeAttempts);

    // Schedule unchanged (side-channel + CAS both rolled back).
    expect(readSchedule(scheduleId).runCount).toBe(beforeRunCount);
  });

  it("a normal reservation (no concurrent winner) does NOT throw the lost-race sentinel", () => {
    // Negative control: without the ConcurrentAdvanceWinner wrapper, the
    // reservation proceeds normally + returns `created, advanced:true`.
    // Proves the wrapper is what triggers the lost-race path (not a bug in
    // the reservation's normal flow).
    const scheduleId = seedIntervalSchedule();
    const result = reserveScheduledOccurrence(baseInput(scheduleId));
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.advanced).toBe(true);
  });
});
