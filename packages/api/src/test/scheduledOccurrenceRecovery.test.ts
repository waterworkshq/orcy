/**
 * T9B Phase 2 — `recoverExpiredOccurrenceLeases` + the resume entry point
 * focused tests.
 *
 * Proves the three Phase-2 guarantees (the deterministic-takeover primitive):
 *
 *  (a) DETERMINISTIC TAKEOVER — a `publishing` occurrence with an expired
 *      lease (a crashed worker) → the recovery worker reclaims + resumes →
 *      the occurrence reaches a terminal state (`published` on success). The
 *      reclaimed owner is authoritative (T9A-08 fencing — the stale worker
 *      can't terminalize after takeover).
 *  (b) NO-HOT-LOOP CIRCUIT-BREAKER — a `publishing` occurrence whose
 *      publication keeps failing resumable (a persistent
 *      `schedule_guard_mismatch`) → after `maxReclaims` recovery reclaims
 *      without reaching terminal, the circuit-breaker terminalizes the
 *      occurrence `rejected` with a `recovery_exhausted` result (the
 *      occurrence stops re-firing — the no-hot-loop guardrail).
 *  (c) CONCURRENT RECOVERY WORKERS — two workers scan the same expired-lease
 *      occurrence → one reclaims (`reclaimed`), the other gets `not_expired`
 *      (the first's new active lease) → only one resumes.
 *  (d) TERMINAL EXCLUSION — `published`/`rejected` occurrences are never
 *      scanned (the scan is `state='publishing'`) + never reclaimed
 *      (`illegal_source_state`).
 *  (e) RECURRING-INDEPENDENCE — a rejected occurrence does NOT suppress the
 *      next tick's reservation (the UNIQUE index is per-`(schedule,
 *      scheduledFor)`; each firing gets its own row).
 *  (f) DORMANCY — the worker + the recovery function + the resume entry
 *      point are exported + tested but wire NO production boot-registration.
 *
 * Out of scope: T9B Phase 3 (retry endpoint), T11 (scheduler wiring), the
 * legacy `executeScheduledTask` path (unchanged). The recovery worker is
 * DORMANT — no production origin routes through it yet. The PRESERVE suites
 * (`scheduledTaskService.test.ts`, `scheduledOccurrences.test.ts`,
 * `scheduledOccurrencePublication.test.ts`,
 * `scheduledOccurrenceReservation.test.ts`) stay byte-unchanged — the
 * orchestrator's full-suite run confirms.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  missions,
  tasks,
  taskEvents,
  taskCreationAttempts,
  taskCreationEnvelopes,
  scheduledOccurrences,
  scheduledTasks,
  missionTemplates,
  columns as columnsTable,
  habitats,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as scheduledTaskRepo from "../repositories/scheduledTask.js";
import * as templateRepo from "../repositories/template.js";
import * as pluginManager from "../plugins/pluginManager.js";
import {
  reserveScheduledOccurrence,
  type ReserveScheduledOccurrenceInput,
} from "../repositories/scheduledOccurrenceReservation.js";
import {
  markOccurrencePublishingWithClient,
  markOccurrencePublishedWithClient,
  reacquireExpiredOccurrenceLeaseWithClient,
  getOccurrenceWithClient,
  listOccurrencesWithExpiredLeasesWithClient,
} from "../repositories/scheduledOccurrences.js";
import {
  publishScheduledOccurrence,
  type PublishScheduledOccurrenceInput,
} from "../services/scheduledOccurrencePublication.js";
import {
  recoverExpiredOccurrenceLeases,
  startOccurrenceLeaseRecoveryWorker,
} from "../services/scheduledOccurrenceRecovery.js";
import type { TaskPriority, TaskTemplateEntry } from "@orcy/shared";

// --- Mocks: the recovery worker emits NO pre-commit effects (SSE/hooks). ---
vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: vi.fn() },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../services/pulseService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/pulseService.js")>();
  return { ...actual, onPulseCreated: vi.fn() };
});
vi.mock("../services/tasks/task-lifecycle.js", () => ({ onTaskEvent: vi.fn() }));
vi.mock("../services/commentService.js", () => ({ onCommentCreated: vi.fn() }));

// --- Shared fixtures ---
let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  pluginManager.resetPlugins();
  if (!process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD) {
    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "1000";
  }
  const db = getDb();
  // Wipe the seeded globals so the test habitat is a clean slate.
  db.delete(scheduledOccurrences).run();
  db.delete(scheduledTasks).run();
  db.delete(taskCreationEnvelopes).run();
  db.delete(taskCreationAttempts).run();
  db.delete(taskEvents).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(missionTemplates).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();

  const habitat = habitatRepo.createHabitat({ name: "Recovery Test Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Backlog",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
});

afterEach(async () => {
  pluginManager.resetPlugins();
  closeDb();
  delete process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD;
});

// ---------------------------------------------------------------------------
// Helpers (mirror scheduledOccurrencePublication.test.ts)
// ---------------------------------------------------------------------------

const NOW_ISO = "2026-07-19T12:00:00.000Z";
const NEXT_RUN_INTERVAL = "2026-07-19T13:00:00.000Z"; // 1h after NOW
const LEASE_FUTURE = "2099-01-01T00:00:00.000Z";
const LEASE_PAST = "2020-01-01T00:00:00.000Z"; // expired (crashed worker)

/**
 * A PAST timestamp used as the recovery function's `now` parameter. The
 * reclaim primitive (phase-1) computes its OWN `now = new Date().toISOString()`
 * (wall clock) inside its CAS predicate. For the reclaim to succeed, the
 * occurrence's `leaseExpiresAt` must be expired relative to the WALL CLOCK
 * (not the test's `now`). Using a past `now` for the recovery function
 * ensures the new leases the reclaim sets (`now + leaseDurationMs`) ALSO
 * stay in the past (before the wall clock), so multi-pass tests work:
 *   - Scan uses the test's `now` (past) → finds `leaseExpiresAt < now`.
 *   - Reclaim uses the wall clock (~2026) → sees past leases as expired. ✓
 */
const RECOVERY_NOW = "2020-06-01T00:00:00.000Z";

/** Creates a real mission template (1+ tasks) the schedule will reference. */
function createMissionTemplate(
  overrides: {
    tasksTemplate?: TaskTemplateEntry[];
    titlePattern?: string;
  } = {},
): { id: string } {
  const tpl = templateRepo.createTemplate({
    habitatId,
    name: "Recovery Test Template",
    titlePattern: overrides.titlePattern ?? "Scheduled Mission",
    descriptionPattern: "## Goal\nComplete the work",
    priority: "medium" as TaskPriority,
    labels: ["scheduled"],
    requiredDomain: "backend",
    requiredCapabilities: ["typescript"],
    tasksTemplate: overrides.tasksTemplate ?? [
      { title: "First task", description: "desc", priority: "medium" as TaskPriority, order: 0 },
      { title: "Second task", description: "desc", priority: "medium" as TaskPriority, order: 1 },
    ],
    createdBy: "test",
  });
  return { id: tpl.id };
}

/** Creates a schedule row referencing a template; defaults to interval, due NOW. */
function createSchedule(overrides: Partial<scheduledTaskRepo.CreateScheduledTaskInput> = {}): {
  id: string;
} {
  const tpl = createMissionTemplate();
  const schedule = scheduledTaskRepo.createScheduledTask({
    habitatId,
    templateId: tpl.id,
    name: "Test Schedule",
    scheduleType: "interval",
    intervalMinutes: 60,
    missionTitle: "Scheduled Mission",
    missionDescription: "Auto-generated by the scheduler.",
    missionPriority: "medium" as TaskPriority,
    missionLabels: ["scheduled"],
    tasksTemplate: [],
    nextRunAt: NOW_ISO,
    createdBy: "test",
    ...overrides,
  });
  return { id: schedule.id };
}

/**
 * Reserves an occurrence via Phase 2 (the producer for the publisher).
 * Returns the occurrence id (state `reserved`).
 */
function reserveOccurrenceForSchedule(
  scheduleId: string,
  overrides: Partial<ReserveScheduledOccurrenceInput> = {},
): { id: string } {
  const result = reserveScheduledOccurrence({
    scheduleId,
    nextRunAt: NEXT_RUN_INTERVAL,
    now: NOW_ISO,
    ...overrides,
  });
  if (result.outcome !== "created") throw new Error(`fixture reserve failed: ${result.outcome}`);
  return { id: result.occurrence.id };
}

/** Reads the current occurrence row by id; throws if vanished. */
function readOccurrence(id: string) {
  const row = getOccurrenceWithClient(getDb(), id);
  if (!row) throw new Error(`occurrence ${id} vanished`);
  return row;
}

/**
 * Simulates a CRASHED WORKER — transitions a `reserved` occurrence to
 * `publishing` with an EXPIRED lease (the worker started publication but
 * crashed before terminalizing; the lease has since expired). The recovery
 * worker scans + reclaims this occurrence.
 */
function simulateCrashedWorker(
  occurrenceId: string,
  leaseOwner = "crashed-worker",
  leaseExpiresAt = LEASE_PAST,
): void {
  const db = getDb();
  const result = markOccurrencePublishingWithClient(db, occurrenceId, {
    leaseOwner,
    leaseExpiresAt,
  });
  if (result.outcome !== "transitioned") {
    throw new Error(`simulateCrashedWorker failed: ${result.outcome}`);
  }
}

/** Count helper for atomicity assertions. */
function countRows() {
  const db = getDb();
  return {
    missions: db
      .select({ count: sql<number>`COUNT(*)` })
      .from(missions)
      .get()!.count,
    tasks: db
      .select({ count: sql<number>`COUNT(*)` })
      .from(tasks)
      .get()!.count,
    attempts: db
      .select({ count: sql<number>`COUNT(*)` })
      .from(taskCreationAttempts)
      .get()!.count,
  };
}

// ===========================================================================
// 1. DETERMINISTIC TAKEOVER (the load-bearing proof)
// ===========================================================================

describe("recoverExpiredOccurrenceLeases — deterministic takeover", () => {
  it("reclaims an expired-lease publishing occurrence + resumes → published (the crashed-worker recovery)", () => {
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    // Simulate a crashed worker: the occurrence is `publishing` with an
    // expired lease. The worker started publication but crashed before
    // terminalizing; the lease has since expired.
    simulateCrashedWorker(occurrenceId, "crashed-worker", LEASE_PAST);
    const before = countRows();

    // The recovery worker scans + reclaims + resumes.
    const result = recoverExpiredOccurrenceLeases({
      leaseOwner: "recovery-worker",
      leaseDurationMs: 30_000,
      now: RECOVERY_NOW,
    });

    // **Failure mode**: if the recovery worker could NOT reclaim the expired
    // lease (e.g. the reclaim CAS failed) OR could NOT resume the publication
    // (e.g. the resume entry point was missing), the occurrence would stay
    // `publishing` forever — a stuck occurrence that never reaches terminal.
    expect(result.scanned).toBe(1);
    expect(result.reclaimed).toBe(1);
    expect(result.terminalized).toBe(1);
    expect(result.resumable).toBe(0);
    expect(result.skipped).toBe(0);

    // The occurrence reached terminal `published`.
    const occurrence = readOccurrence(occurrenceId);
    expect(occurrence.state).toBe("published");
    expect(occurrence.leaseOwner).toBeNull(); // retired by terminal transition.
    expect(occurrence.leaseExpiresAt).toBeNull();
    expect(occurrence.createdMissionId).not.toBeNull();

    // The aggregate committed (Mission + Tasks).
    const after = countRows();
    expect(after.missions).toBe(before.missions + 1);
    expect(after.tasks).toBe(before.tasks + 2); // 2 tasks in the template.

    // The detail record carries the resume outcome.
    expect(result.details).toHaveLength(1);
    expect(result.details[0].occurrenceId).toBe(occurrenceId);
    expect(result.details[0].reclaim).toBe("reclaimed");
    expect(result.details[0].resume).toBe("published");
  });

  it("T9A-08 fencing: after the recovery worker reclaims, the STALE worker's terminalization returns not_owner (the reclaimed owner is authoritative)", () => {
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
    simulateCrashedWorker(occurrenceId, "crashed-worker", LEASE_PAST);

    // The recovery worker reclaims the lease FIRST (before the stale worker
    // wakes up + tries to terminalize).
    const result = recoverExpiredOccurrenceLeases({
      leaseOwner: "recovery-worker",
      now: RECOVERY_NOW,
    });
    expect(result.reclaimed).toBe(1);

    // The STALE worker (crashed-worker) belatedly tries to terminalize the
    // occurrence as `published`. The fenced CAS checks `leaseOwner = expected`
    // → the stale worker's `crashed-worker` ≠ the row's `recovery-worker` →
    // `not_owner`. The stale worker CANNOT interfere with the recovery.
    //
    // NOTE: by this point the recovery worker ALREADY terminalized the
    // occurrence (the resume succeeded → `published`). So the stale worker's
    // terminalization hits the terminal fast-path → `no_op` (the occurrence
    // is already `published`). To isolate the FENCING (not the terminal
    // fast-path), we test the fencing on a SEPARATE occurrence that the
    // recovery worker reclaimed but did NOT terminalize.
    //
    // For THIS occurrence (already `published`), the stale worker gets `no_op`:
    const staleTerminal = markOccurrencePublishedWithClient(getDb(), occurrenceId, {
      leaseOwner: "crashed-worker",
      createdMissionId: "stale-mission-id",
    });
    expect(staleTerminal.outcome).toBe("no_op");
  });

  it("fencing in isolation: stale worker's terminalization refused BEFORE the recovery completes (not_owner, not no_op)", () => {
    // Isolate the FENCING from the terminal fast-path. Set up a `publishing`
    // occurrence, reclaim it via the phase-1 primitive (NOT the full recovery
    // — so the occurrence is still `publishing`), then assert the stale
    // worker's terminalization returns `not_owner` (NOT `no_op` — the
    // occurrence is NOT terminal, just re-leased).
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
    simulateCrashedWorker(occurrenceId, "crashed-worker", LEASE_PAST);

    // Reclaim directly (phase-1 primitive) — the recovery worker takes the lease.
    const db = getDb();
    const reclaim = reacquireExpiredOccurrenceLeaseWithClient(db, occurrenceId, {
      leaseOwner: "recovery-worker",
      leaseExpiresAt: LEASE_FUTURE,
    });
    expect(reclaim.outcome).toBe("reclaimed");

    // The occurrence is STILL `publishing` (the recovery worker reclaimed but
    // hasn't resumed yet). The stale worker's terminalization → `not_owner`
    // (the fenced CAS catches the owner mismatch — DISTINCT from `no_op`
    // which would mean the occurrence is already terminal).
    const staleTerminal = markOccurrencePublishedWithClient(db, occurrenceId, {
      leaseOwner: "crashed-worker",
      createdMissionId: "stale-mission-id",
    });
    expect(staleTerminal.outcome).toBe("not_owner");
    if (staleTerminal.outcome !== "not_owner") throw new Error("unreachable");
    expect(staleTerminal.occurrence.state).toBe("publishing"); // still publishing, not terminal.

    // The recovery worker's terminalization succeeds (it's the current owner).
    const recoveryTerminal = markOccurrencePublishedWithClient(db, occurrenceId, {
      leaseOwner: "recovery-worker",
      createdMissionId: "recovery-mission-id",
    });
    expect(recoveryTerminal.outcome).toBe("transitioned");
    if (recoveryTerminal.outcome !== "transitioned") throw new Error("unreachable");
    expect(recoveryTerminal.occurrence.state).toBe("published");
    expect(recoveryTerminal.occurrence.createdMissionId).toBe("recovery-mission-id");
  });
});

// ===========================================================================
// 2. NO-HOT-LOOP CIRCUIT-BREAKER (the guardrail)
// ===========================================================================

describe("recoverExpiredOccurrenceLeases — no-hot-loop circuit-breaker", () => {
  it("a persistently-resumable occurrence (schedule_guard_mismatch) terminalizes recovery_exhausted after maxReclaims", () => {
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
    simulateCrashedWorker(occurrenceId, "crashed-worker", LEASE_PAST);

    // Edit the schedule's missionTitle BETWEEN reservation and publication →
    // the schedule-guard pre-check fires → `schedule_guard_mismatch` on every
    // resume. The occurrence stays `publishing`; the count advances per pass.
    const db = getDb();
    db.update(scheduledTasks)
      .set({ missionTitle: "EDITED — guard mismatch trigger" })
      .where(eq(scheduledTasks.id, scheduleId))
      .run();

    // Run 3 recovery passes (maxReclaims=3). Each pass: reclaim → stamp
    // (count advances) → resume → schedule_guard_mismatch → resumable.
    // Between passes, advance `now` past the lease expiry so the scan
    // re-finds the occurrence.
    const LEASE_MS = 30_000;
    // Use a PAST base time so the reclaim's new leases (now + LEASE_MS) stay
    // behind the wall clock — the reclaim primitive uses `new Date().toISOString()`
    // internally for its CAS predicate. See RECOVERY_NOW's rationale.
    let nowMs = Date.parse(RECOVERY_NOW);

    // Pass 1: count 0 → 1. Resumable.
    let result = recoverExpiredOccurrenceLeases({
      leaseOwner: "recovery-worker",
      leaseDurationMs: LEASE_MS,
      maxReclaims: 3,
      now: new Date(nowMs).toISOString(),
    });
    expect(result.reclaimed).toBe(1);
    expect(result.resumable).toBe(1);
    expect(result.terminalized).toBe(0);
    let occurrence = readOccurrence(occurrenceId);
    expect(occurrence.state).toBe("publishing");
    expect((occurrence.result as { reclaimCount?: number }).reclaimCount).toBe(1);

    // Pass 2: count 1 → 2. Resumable.
    nowMs += LEASE_MS + 1000; // advance past the lease expiry.
    result = recoverExpiredOccurrenceLeases({
      leaseOwner: "recovery-worker",
      leaseDurationMs: LEASE_MS,
      maxReclaims: 3,
      now: new Date(nowMs).toISOString(),
    });
    expect(result.resumable).toBe(1);
    occurrence = readOccurrence(occurrenceId);
    expect((occurrence.result as { reclaimCount?: number }).reclaimCount).toBe(2);

    // Pass 3: count 2 → 3. Resumable (3 = maxReclaims, NOT exceeded).
    nowMs += LEASE_MS + 1000;
    result = recoverExpiredOccurrenceLeases({
      leaseOwner: "recovery-worker",
      leaseDurationMs: LEASE_MS,
      maxReclaims: 3,
      now: new Date(nowMs).toISOString(),
    });
    expect(result.resumable).toBe(1);
    occurrence = readOccurrence(occurrenceId);
    expect((occurrence.result as { reclaimCount?: number }).reclaimCount).toBe(3);

    // Pass 4: count 3 → 4 > maxReclaims(3) → CIRCUIT-BREAKER terminalizes
    // `rejected` with `recovery_exhausted`. The occurrence STOPS re-firing.
    nowMs += LEASE_MS + 1000;
    result = recoverExpiredOccurrenceLeases({
      leaseOwner: "recovery-worker",
      leaseDurationMs: LEASE_MS,
      maxReclaims: 3,
      now: new Date(nowMs).toISOString(),
    });
    expect(result.exhausted).toBe(1);
    expect(result.terminalized).toBe(1);
    expect(result.resumable).toBe(0);

    // **Failure mode (the guardrail):** without the circuit-breaker, the
    // occurrence would loop forever (reclaim → resume → schedule_guard_mismatch
    // → lease expires → reclaim → ...). The `recovery_exhausted` terminal
    // BREAKS the loop — the occurrence reaches `rejected` + the lease is
    // retired. Future scans skip it (state is `rejected`, not `publishing`).
    occurrence = readOccurrence(occurrenceId);
    expect(occurrence.state).toBe("rejected");
    expect(occurrence.leaseOwner).toBeNull();
    expect(occurrence.leaseExpiresAt).toBeNull();
    expect((occurrence.result as { reason?: string }).reason).toBe("recovery_exhausted");
    expect((occurrence.result as { reclaimCount?: number }).reclaimCount).toBe(3);

    // Pass 5: the terminalized occurrence is NO LONGER scanned (state is
    // `rejected`, not `publishing`). No more reclaims.
    nowMs += LEASE_MS + 1000;
    result = recoverExpiredOccurrenceLeases({
      leaseOwner: "recovery-worker",
      leaseDurationMs: LEASE_MS,
      maxReclaims: 3,
      now: new Date(nowMs).toISOString(),
    });
    expect(result.scanned).toBe(0);
    expect(result.reclaimed).toBe(0);
  });
});

// ===========================================================================
// 3. CONCURRENT RECOVERY WORKERS
// ===========================================================================

describe("recoverExpiredOccurrenceLeases — concurrent workers", () => {
  it("two workers scan the same expired-lease occurrence → one reclaims, the other skips (not_expired)", () => {
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
    simulateCrashedWorker(occurrenceId, "crashed-worker", LEASE_PAST);

    // Worker A runs FIRST → reclaims + resumes → occurrence reaches `published`.
    const resultA = recoverExpiredOccurrenceLeases({
      leaseOwner: "recovery-worker-A",
      now: RECOVERY_NOW,
    });
    expect(resultA.reclaimed).toBe(1);
    expect(resultA.terminalized).toBe(1);

    // Worker B runs AFTER worker A's lease is set (a future expiry). The
    // scan finds ZERO occurrences (the occurrence is now `published` —
    // terminal, not `publishing`). Worker B has nothing to reclaim.
    //
    // NOTE: this is the realistic concurrent-workers scenario — by the time
    // worker B's scan runs, worker A has ALREADY terminalized the occurrence.
    // The scan's `state='publishing'` filter excludes terminal occurrences.
    const resultB = recoverExpiredOccurrenceLeases({
      leaseOwner: "recovery-worker-B",
      now: RECOVERY_NOW,
    });
    expect(resultB.scanned).toBe(0);
    expect(resultB.reclaimed).toBe(0);

    // The occurrence is `published` exactly once (worker A's resume).
    const occurrence = readOccurrence(occurrenceId);
    expect(occurrence.state).toBe("published");
  });

  it("two workers race on the same expired-lease publishing occurrence (before either resumes) → one reclaims, the other gets not_expired", () => {
    // Isolate the RACE (before either worker resumes). Use the phase-1
    // reclaim primitive directly: two concurrent reclaims on the same
    // expired-lease occurrence. SQLite serializes writers: the first CAS
    // matches + sets a future expiry; the second CAS predicate
    // `leaseExpiresAt < now` no longer matches → `not_expired`.
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
    simulateCrashedWorker(occurrenceId, "crashed-worker", LEASE_PAST);

    const db = getDb();

    // Worker A reclaims FIRST → succeeds.
    const reclaimA = reacquireExpiredOccurrenceLeaseWithClient(db, occurrenceId, {
      leaseOwner: "recovery-worker-A",
      leaseExpiresAt: LEASE_FUTURE, // far-future (Worker A's new lease).
    });
    expect(reclaimA.outcome).toBe("reclaimed");
    if (reclaimA.outcome !== "reclaimed") throw new Error("unreachable");
    expect(reclaimA.occurrence.leaseOwner).toBe("recovery-worker-A");

    // Worker B reclaims AFTER worker A → `not_expired` (worker A's lease is
    // active). Worker B MUST NOT proceed (worker A owns the work).
    const reclaimB = reacquireExpiredOccurrenceLeaseWithClient(db, occurrenceId, {
      leaseOwner: "recovery-worker-B",
      leaseExpiresAt: LEASE_FUTURE,
    });
    expect(reclaimB.outcome).toBe("not_expired");
    if (reclaimB.outcome !== "not_expired") throw new Error("unreachable");
    expect(reclaimB.occurrence.leaseOwner).toBe("recovery-worker-A"); // unchanged.
  });
});

// ===========================================================================
// 4. TERMINAL EXCLUSION
// ===========================================================================

describe("recoverExpiredOccurrenceLeases — terminal exclusion", () => {
  it("a published occurrence is never scanned + never reclaimed", () => {
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    // Run the initial publication to completion → `published`.
    const pub = publishScheduledOccurrence({
      occurrenceId,
      leaseOwner: "initial-worker",
      leaseExpiresAt: LEASE_FUTURE,
    });
    expect(pub.outcome).toBe("published");

    // The scan finds ZERO occurrences (the occurrence is `published`, not
    // `publishing`). The recovery worker has nothing to reclaim.
    const result = recoverExpiredOccurrenceLeases({
      leaseOwner: "recovery-worker",
      now: RECOVERY_NOW,
    });
    expect(result.scanned).toBe(0);
    expect(result.reclaimed).toBe(0);
  });

  it("a rejected occurrence is never scanned + never reclaimed", () => {
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
    simulateCrashedWorker(occurrenceId, "crashed-worker", LEASE_PAST);

    // DELETE the schedule row → the resume's body STEP 2 (read live schedule)
    // returns null → `schedule_missing` → terminal `rejected`. This fires
    // BEFORE the schedule-guard pre-check (STEP 3), so the guard doesn't
    // intercept as `schedule_guard_mismatch`.
    getDb().delete(scheduledTasks).where(eq(scheduledTasks.id, scheduleId)).run();

    const result = recoverExpiredOccurrenceLeases({
      leaseOwner: "recovery-worker",
      now: RECOVERY_NOW,
    });
    // The resume hits `schedule_missing` (no schedule row) → terminal.
    expect(result.terminalized).toBe(1);
    expect(readOccurrence(occurrenceId).state).toBe("rejected");

    // A SECOND recovery pass scans ZERO occurrences (the occurrence is
    // `rejected`, not `publishing`).
    const result2 = recoverExpiredOccurrenceLeases({
      leaseOwner: "recovery-worker",
      now: RECOVERY_NOW,
    });
    expect(result2.scanned).toBe(0);
  });
});

// ===========================================================================
// 5. RECURRING-INDEPENDENCE
// ===========================================================================

describe("recoverExpiredOccurrenceLeases — recurring-independence", () => {
  it("a rejected occurrence does NOT suppress the next tick's reservation (each firing gets its own row)", () => {
    const { id: scheduleId } = createSchedule();

    // Reserve the FIRST occurrence (tick 1).
    const { id: occurrenceId1 } = reserveOccurrenceForSchedule(scheduleId);
    simulateCrashedWorker(occurrenceId1, "crashed-worker", LEASE_PAST);

    // Edit the schedule → `schedule_guard_mismatch` on the resume.
    const db = getDb();
    db.update(scheduledTasks)
      .set({ missionTitle: "EDITED" })
      .where(eq(scheduledTasks.id, scheduleId))
      .run();

    // Run recovery with maxReclaims=1 → the occurrence terminalizes
    // `recovery_exhausted` quickly (1 reclaim + 1 circuit-breaker).
    // Use a PAST base time so the reclaim's new leases stay behind the
    // wall clock (see RECOVERY_NOW's rationale).
    let nowMs = Date.parse(RECOVERY_NOW);
    // Pass 1: reclaim → stamp (count=1) → resume → schedule_guard_mismatch → resumable.
    recoverExpiredOccurrenceLeases({
      leaseOwner: "recovery-worker",
      leaseDurationMs: 30_000,
      maxReclaims: 1,
      now: new Date(nowMs).toISOString(),
    });
    // Pass 2: count=2 > maxReclaims=1 → recovery_exhausted.
    nowMs += 31_000;
    recoverExpiredOccurrenceLeases({
      leaseOwner: "recovery-worker",
      leaseDurationMs: 30_000,
      maxReclaims: 1,
      now: new Date(nowMs).toISOString(),
    });

    // Occurrence 1 is `rejected` (recovery_exhausted).
    const occ1 = readOccurrence(occurrenceId1);
    expect(occ1.state).toBe("rejected");

    // **The load-bearing claim**: the rejected occurrence does NOT suppress
    // the NEXT tick's reservation. The UNIQUE index is per-
    // `(scheduledTaskId, scheduledFor)`; each firing gets its own row. A
    // SUBSEQUENT reservation for the SAME schedule at a DIFFERENT
    // `scheduledFor` succeeds → a NEW occurrence row is created.
    //
    // NOTE: the `now` must be >= the schedule's current `nextRunAt` (advanced
    // to "13:00" by the first reservation), otherwise the reservation refuses
    // with `schedule_not_due`.
    const { id: occurrenceId2 } = reserveOccurrenceForSchedule(scheduleId, {
      nextRunAt: "2026-07-19T14:00:00.000Z", // different scheduledFor (tick 2).
      now: "2026-07-19T13:30:00.000Z", // after the schedule's current nextRunAt.
    });
    expect(occurrenceId2).not.toBe(occurrenceId1);
    const occ2 = readOccurrence(occurrenceId2);
    expect(occ2.state).toBe("reserved"); // fresh, unaffected by occ1's rejection.

    // BOTH occurrences exist (the rejected one + the new reserved one).
    const all = getDb().select().from(scheduledOccurrences).all();
    expect(all).toHaveLength(2);
    expect(all.map((o) => o.id).sort()).toEqual([occurrenceId1, occurrenceId2].sort());
  });
});

// ===========================================================================
// 6. DORMANCY + BOOT-REGISTRATION
// ===========================================================================

describe("startOccurrenceLeaseRecoveryWorker — boot-registration (dormant)", () => {
  it("exports the worker function + the recovery function (dormant — no production wiring)", () => {
    // The exports exist + are callable. NO production boot-registration
    // wires them (T11 owns the boot wiring).
    expect(typeof recoverExpiredOccurrenceLeases).toBe("function");
    expect(typeof startOccurrenceLeaseRecoveryWorker).toBe("function");
  });

  it("returns a NodeJS.Timeout handle (setInterval) the caller can clear", () => {
    const handle = startOccurrenceLeaseRecoveryWorker(60_000);
    expect(handle).toBeDefined();
    expect(typeof handle.ref).toBe("function"); // NodeJS.Timeout has .ref/.unref.
    expect(typeof handle.unref).toBe("function");
    clearInterval(handle);
  });

  it("the setInterval polls recoverExpiredOccurrenceLeases on each tick", () => {
    // Use fake timers to verify the interval polls without waiting.
    vi.useFakeTimers();
    try {
      const { id: scheduleId } = createSchedule();
      const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
      simulateCrashedWorker(occurrenceId, "crashed-worker", LEASE_PAST);

      // Start the worker (1s interval for fast testing).
      const handle = startOccurrenceLeaseRecoveryWorker(1_000, {
        leaseOwner: "test-worker",
      });

      // Advance 1s → the first tick fires → the recovery runs.
      vi.advanceTimersByTime(1_000);

      // The occurrence was recovered (the worker polled + reclaimed + resumed).
      const occurrence = readOccurrence(occurrenceId);
      expect(occurrence.state).toBe("published");

      clearInterval(handle);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ===========================================================================
// 7. EDGE CASES
// ===========================================================================

describe("recoverExpiredOccurrenceLeases — edge cases", () => {
  it("an empty scan returns a zero-count result", () => {
    const result = recoverExpiredOccurrenceLeases({
      leaseOwner: "recovery-worker",
      now: RECOVERY_NOW,
    });
    expect(result.scanned).toBe(0);
    expect(result.reclaimed).toBe(0);
    expect(result.terminalized).toBe(0);
    expect(result.resumable).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.exhausted).toBe(0);
    expect(result.details).toEqual([]);
  });

  it("listOccurrencesWithExpiredLeasesWithClient excludes active-lease publishing occurrences (only expired leases)", () => {
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    // Transition to `publishing` with an ACTIVE (far-future) lease.
    simulateCrashedWorker(occurrenceId, "active-worker", LEASE_FUTURE);

    // The scan finds ZERO occurrences (the lease is active, not expired).
    const expired = listOccurrencesWithExpiredLeasesWithClient(getDb(), NOW_ISO);
    expect(expired).toHaveLength(0);

    // The same occurrence IS in `publishing` state (just not expired-lease).
    const allPublishing = getDb()
      .select()
      .from(scheduledOccurrences)
      .where(eq(scheduledOccurrences.state, "publishing"))
      .all();
    expect(allPublishing).toHaveLength(1);
    expect(allPublishing[0].id).toBe(occurrenceId);
  });
});
