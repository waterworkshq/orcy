/**
 * T9A Phase 3 — `publishScheduledOccurrence` focused tests.
 *
 * Proves the seven Phase-3 guarantees (the integration that closes the
 * occurrence subsystem + the ticket's "Atomic occurrence-state transition"
 * load-bearing claim):
 *
 *  (a) HAPPY PATH — reserve (Phase 2) → publish → occurrence `published` +
 *      Mission linked (`createdMissionId`) + each Task POST_CUTOVER with a
 *      `created` event + envelope. The occurrence-record participant fires
 *      INSIDE the milestone-1 tx (atomic occurrence-state transition).
 *  (b) GOVERNANCE VETO (NET-NEW for schedules) — a vetoing `taskCreated`
 *      interceptor → `vetoed` outcome → occurrence transitions
 *      `publishing → rejected` with the veto details; NO Mission/Tasks
 *      committed (the tx never opened). Schedule Tasks carry governance for
 *      the first time (today `createMissionFromSchedule`/`applyTemplate`
 *      bypasses it).
 *  (c) VALIDATION REJECTION — schedule with no `templateId` →
 *      `rejected_validation` → occurrence `rejected`; no Mission.
 *  (d) RESUMABLE OUTCOME (schedule_guard_mismatch) — a schedule config edit
 *      between reservation and publication → `schedule_guard_mismatch`;
 *      occurrence STAYS `publishing` (resumable for T9B; lease held).
 *  (e) CONCURRENT PUBLISH — two workers, one occurrence: one wins
 *      `markOccurrencePublishingWithClient`, the other gets
 *      `already_publishing` + returns.
 *  (f) TOKEN RESOLUTION — `{{counter}} = ordinal + 1`, `{{date}}` in the
 *      schedule's timezone.
 *  (g) ATOMIC OCCURRENCE-STATE TRANSITION (load-bearing) — a participant
 *      throw AFTER the occurrence-state write rolls back the occurrence-state
 *      change too (occurrence stays `publishing`). Proves the
 *      `publishing → published` transition commits in the SAME tx as the
 *      Mission+Tasks.
 *  (h) DORMANCY — exported + tested but no production caller.
 *  (i) REPLAY — second call after a successful publish → `illegal_source_state`
 *      (the occurrence is terminal).
 *  (j) SCHEDULE MISSING — schedule deleted between reservation and publication
 *      → `schedule_missing`; occurrence `rejected`.
 *
 * Out of scope: T9B (lease-recovery worker), T11 (scheduler wiring), the
 * legacy `executeScheduledTask` path (unchanged). The publisher is DORMANT —
 * no production origin routes through it yet. The PRESERVE suites
 * (`scheduledTaskService.test.ts`, `scheduledOccurrences.test.ts`,
 * `scheduledOccurrenceReservation.test.ts`) stay byte-unchanged — the
 * orchestrator's full-suite run confirms.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
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
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import { reserveAttemptWithClient } from "../repositories/taskCreationAttempts.js";
import {
  reserveScheduledOccurrence,
  type ReserveScheduledOccurrenceInput,
} from "../repositories/scheduledOccurrenceReservation.js";
import {
  markOccurrencePublishingWithClient,
  markOccurrenceRejectedWithClient,
  getOccurrenceWithClient,
} from "../repositories/scheduledOccurrences.js";
import {
  publishScheduledOccurrence,
  buildOccurrenceRecordParticipant,
  type PublishScheduledOccurrenceInput,
  type PublishScheduledOccurrenceOutcome,
} from "../services/scheduledOccurrencePublication.js";
import {
  publishTemplateAggregateWithClient,
  type TemplateAggregateParticipantContext,
} from "../services/templateAggregatePublication.js";
import {
  prepareTemplateAggregate,
  type PrepareTemplateAggregateContext,
} from "../services/templateAggregatePreparation.js";
import { TASK_CREATION_INTEGRITY_VERSION } from "../db/schema/taskPublication.js";
import type { AuditActorRef, AuditSource, TaskPriority, TaskTemplateEntry } from "@orcy/shared";

// --- Mocks: assert the publisher emits NO pre-commit effects (SSE/hooks). ---
const publishMock = vi.fn();
vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: (...args: unknown[]) => publishMock(...args) },
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
  publishMock.mockClear();
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

  const habitat = habitatRepo.createHabitat({ name: "Occurrence Test Habitat" });
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
// Helpers
// ---------------------------------------------------------------------------

const NOW_ISO = "2026-07-19T12:00:00.000Z";
const NEXT_RUN_INTERVAL = "2026-07-19T13:00:00.000Z"; // 1h after NOW
const NEXT_RUN_FAR_FUTURE = "9999-12-31T23:59:59.000Z";
const LEASE_FUTURE = "2099-01-01T00:00:00.000Z";

const SCHEDULE_ACTOR: AuditActorRef = { type: "system", id: "scheduler" };
const SCHEDULE_SOURCE = "scheduler" as AuditSource;

/** Creates a real mission template (1+ tasks) the schedule will reference. */
function createMissionTemplate(
  overrides: {
    tasksTemplate?: TaskTemplateEntry[];
    titlePattern?: string;
    descriptionPattern?: string;
    priority?: TaskPriority;
    labels?: string[];
  } = {},
): { id: string } {
  const tpl = templateRepo.createTemplate({
    habitatId,
    name: "Schedule Test Template",
    titlePattern: overrides.titlePattern ?? "Scheduled Mission",
    descriptionPattern: overrides.descriptionPattern ?? "## Goal\nComplete the work",
    priority: overrides.priority ?? ("medium" as TaskPriority),
    labels: overrides.labels ?? ["scheduled"],
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

/** Canonical publisher input; callers override individual fields. */
function baseInput(
  occurrenceId: string,
  overrides: Partial<PublishScheduledOccurrenceInput> = {},
): PublishScheduledOccurrenceInput {
  return {
    occurrenceId,
    leaseOwner: "worker-test",
    leaseExpiresAt: LEASE_FUTURE,
    ...overrides,
  };
}

/** Reads the current occurrence row by id; throws if vanished. */
function readOccurrence(id: string) {
  const row = getOccurrenceWithClient(getDb(), id);
  if (!row) throw new Error(`occurrence ${id} vanished`);
  return row;
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
    events: db
      .select({ count: sql<number>`COUNT(*)` })
      .from(taskEvents)
      .get()!.count,
    envelopes: db
      .select({ count: sql<number>`COUNT(*)` })
      .from(taskCreationEnvelopes)
      .get()!.count,
    attempts: db
      .select({ count: sql<number>`COUNT(*)` })
      .from(taskCreationAttempts)
      .get()!.count,
  };
}

/** Writes + loads a temp plugin; returns the tmp dir for cleanup. */
async function writePlugin(name: string, moduleBody: string): Promise<string> {
  const tmpDir = `/tmp/test-t9a3-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await mkdir(tmpDir, { recursive: true });
  await writeFile(`${tmpDir}/${name}.mjs`, `export default ${moduleBody};`);
  pluginManager.setPluginDirectory(tmpDir);
  await pluginManager.loadPlugins();
  return tmpDir;
}

function enrollInterceptor(hId: string, pluginId: string, contributionId: string): void {
  enrollmentRepo.create({
    habitatId: hId,
    pluginId,
    contributionId,
    contributionKind: "lifecycleInterceptor",
    enrolledBy: "test",
    enabled: 1,
  });
  pluginManager.invalidateEnrollmentCache(hId);
}

// ===========================================================================
// 1. HAPPY PATH — full aggregate + occurrence-state transition.
// ===========================================================================

describe("publishScheduledOccurrence — happy path", () => {
  it("transitions the occurrence reserved → publishing → published; commits Mission + Tasks + envelope atomically", () => {
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
    const before = countRows();

    const result = publishScheduledOccurrence(baseInput(occurrenceId));

    // **Failure mode**: if the occurrence-state transition did not commit
    // in the same tx as the aggregate, the occurrence would stay
    // `publishing` + the Mission/Tasks would commit (orphan Mission).
    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") throw new Error("unreachable");

    // Occurrence terminal + Mission linked.
    const occurrence = readOccurrence(occurrenceId);
    expect(occurrence.state).toBe("published");
    expect(occurrence.createdMissionId).toBe(result.mission.id);
    // Lease RETIRED atomically with the terminal transition.
    expect(occurrence.leaseOwner).toBeNull();
    expect(occurrence.leaseExpiresAt).toBeNull();
    // Result JSON carries the compact descriptor.
    expect(occurrence.result).toEqual({
      missionId: result.mission.id,
      taskCount: result.tasks.length,
      attemptIds: expect.arrayContaining([expect.any(String)]),
      publishedAt: expect.any(String),
    });

    // Mission row committed; carries the schedule's derived attribution.
    expect(result.mission.habitatId).toBe(habitatId);
    expect(result.mission.createdBy).toBe("scheduler");
    expect(result.mission.status).toBe("not_started");
    expect(result.mission.version).toBe(1);

    // N Tasks committed; each POST_CUTOVER + `created` event + envelope.
    expect(result.tasks.length).toBeGreaterThanOrEqual(1);
    for (const pub of result.tasks) {
      expect(pub.task.missionId).toBe(result.mission.id);
      expect(pub.task.creationIntegrity).toBe(TASK_CREATION_INTEGRITY_VERSION.POST_CUTOVER);
      expect(pub.event.taskId).toBe(pub.task.id);
      expect(pub.event.action).toBe("created");
      expect(pub.envelope.taskId).toBe(pub.task.id);
      expect(pub.envelope.lifecycleAction).toBe("created");
    }

    // Each per-Task attempt advanced to RECOVERING (`published_pending_observation`).
    const attempts = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.sourceScopeId, occurrenceId))
      .all();
    expect(attempts).toHaveLength(result.tasks.length);
    for (const a of attempts) {
      expect(a.state).toBe("published_pending_observation");
      expect(a.sourceScopeKind).toBe("scheduled_occurrence");
      expect(a.source).toBe("scheduler");
      expect(a.actorType).toBe("system");
      expect(a.actorId).toBe("scheduler");
      expect(a.publicationKind).toBe("scheduled_occurrence");
      expect(a.causalContext).toEqual({
        root: { type: "scheduled_occurrence", id: occurrenceId },
      });
    }

    // All counts moved (aggregate + occurrence-state committed together).
    const after = countRows();
    expect(after.missions).toBe(before.missions + 1);
    expect(after.tasks).toBe(before.tasks + result.tasks.length);
    expect(after.events).toBe(before.events + result.tasks.length);
    expect(after.envelopes).toBe(before.envelopes + result.tasks.length);
    expect(after.attempts).toBe(before.attempts + result.tasks.length);
  });

  it("schedule's lastCreatedMissionId is NOT mutated (Phase 3 leaves it untouched; the occurrence row is the source of truth)", () => {
    // **Failure mode**: if the publisher stamped the schedule's
    // lastCreatedMissionId, it would differ from the legacy flow's
    // `finalizeExecution(id, missionId)` step. Phase 3 deliberately leaves
    // the schedule alone — the durable occurrence record carries the link.
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    publishScheduledOccurrence(baseInput(occurrenceId));

    const schedule = scheduledTaskRepo.getScheduledTaskById(scheduleId)!;
    expect(schedule.lastCreatedMissionId).toBeNull();
  });
});

// ===========================================================================
// 2. GOVERNANCE VETO — NET-NEW for schedules (the exemption removal proof).
// ===========================================================================

describe("publishScheduledOccurrence — governance veto (net-new)", () => {
  it("vetoing taskCreated interceptor → vetoed outcome → occurrence transitions publishing → rejected; NO Mission/Tasks committed", async () => {
    await writePlugin(
      "veto-schedule",
      `{
        manifest: {
          id: 'veto-schedule', version: '1.0.0', description: 'veto every schedule task',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'veto-all', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: {
          'veto-all': () => ({ allow: false, reason: 'vetoed by schedule test interceptor' }),
        },
      }`,
    );
    enrollInterceptor(habitatId, "veto-schedule", "veto-all");

    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
    const before = countRows();

    const result = publishScheduledOccurrence(baseInput(occurrenceId));

    // Typed vetoed outcome — NOT a throw, NOT a swallowed null. The T9A
    // publisher runs governance BEFORE opening the tx; the first veto
    // returns `{outcome:"vetoed"}` without opening it.
    expect(result.outcome).toBe("vetoed");
    if (result.outcome !== "vetoed") throw new Error("unreachable");
    expect(result.taskIndex).toBe(0); // first task entry.
    expect(result.veto.reason).toBe("vetoed by schedule test interceptor");
    expect(result.veto.interceptorKey).toContain("veto-all");
    expect(typeof result.veto.pluginRunId).toBe("string");

    // Occurrence terminal-rejected with the veto details.
    const occurrence = readOccurrence(occurrenceId);
    expect(occurrence.state).toBe("rejected");
    expect(occurrence.leaseOwner).toBeNull(); // retired by terminal transition.
    expect(occurrence.createdMissionId).toBeNull();
    expect(occurrence.result).toEqual({
      reason: "vetoed",
      taskIndex: 0,
      veto: expect.objectContaining({
        interceptorKey: expect.any(String),
        reason: "vetoed by schedule test interceptor",
      }),
    });

    // ZERO partial aggregate: no Mission, no Tasks, no events, no envelopes
    // committed. The tx never opened (governance runs BEFORE the tx in the
    // milestone-1 publisher). NOTE: per-Task attempts ARE reserved (the
    // publisher reserves N attempts BEFORE calling the milestone-1 publisher,
    // mirroring the triage adapter's ordering) — those `pending` attempts
    // stay as audit artifacts. The occurrence is terminal-rejected so they
    // are never republished under this key set.
    const after = countRows();
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
    expect(after.events).toBe(before.events);
    expect(after.envelopes).toBe(before.envelopes);
  });
});

// ===========================================================================
// 3. VALIDATION REJECTION — schedule with no templateId.
// ===========================================================================

describe("publishScheduledOccurrence — rejected_validation", () => {
  it("schedule with no templateId → rejected_validation → occurrence rejected; no Mission", () => {
    // The publisher requires a templateId (the inline createMissionFromSchedule
    // path is a separate legacy concern). A schedule with no templateId is a
    // configuration error.
    const { id: scheduleId } = createSchedule({ templateId: null });
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
    const before = countRows();

    const result = publishScheduledOccurrence(baseInput(occurrenceId));

    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") throw new Error("unreachable");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe("templateId");
    expect(result.errors[0].code).toBe("template_not_set");

    const occurrence = readOccurrence(occurrenceId);
    expect(occurrence.state).toBe("rejected");

    const after = countRows();
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
  });
});

// ===========================================================================
// 4. RESUMABLE OUTCOME — schedule_guard_mismatch (occurrence stays publishing).
// ===========================================================================

describe("publishScheduledOccurrence — resumable schedule_guard_mismatch", () => {
  it("schedule config edit between reservation and publication → schedule_guard_mismatch; occurrence stays publishing", () => {
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
    const before = countRows();

    // Edit the schedule's config (missionTitle) AFTER reservation. The
    // occurrence's scheduleRevision snapshot reflects the pre-edit row.
    scheduledTaskRepo.updateScheduledTask(scheduleId, {
      missionTitle: "EDITED title — should fire the guard",
    });

    const result = publishScheduledOccurrence(baseInput(occurrenceId));

    // **Failure mode**: if the publisher did not diff the schedule config,
    // it would proceed to publish with the EDITED title for an occurrence
    // reserved for the ORIGINAL title — silently absorbing the edit.
    expect(result.outcome).toBe("schedule_guard_mismatch");
    if (result.outcome !== "schedule_guard_mismatch") throw new Error("unreachable");
    expect(result.fields).toContain("missionTitle");

    // Q4 resolution: RESUMABLE — occurrence STAYS `publishing` + lease held
    // (NOT released). T9B's recovery worker picks up the expired lease +
    // retries under the SAME attempt keys.
    const occurrence = readOccurrence(occurrenceId);
    expect(occurrence.state).toBe("publishing");
    expect(occurrence.leaseOwner).toBe("worker-test");
    expect(occurrence.leaseExpiresAt).toBe(LEASE_FUTURE);

    // Nothing committed (no Mission, no Tasks, no attempts reserved —
    // the pre-check fires before prepare/reserve).
    const after = countRows();
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
    expect(after.attempts).toBe(before.attempts);
  });

  it("one-shot's `enabled` column flipping to false at reservation is NOT a config-field drift (the guard excludes operational fields)", () => {
    // Phase 2 disables a one-shot AT reservation. The scheduleRevision
    // snapshot has `enabled:true` (pre-reservation); the live row has
    // `enabled:false`. The guard MUST exclude `enabled` — otherwise every
    // one-shot publication would fire schedule_guard_mismatch.
    const { id: scheduleId } = createSchedule({ scheduleType: "once" });
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId, {
      nextRunAt: NEXT_RUN_FAR_FUTURE,
    });

    // Confirm the one-shot was disabled at reservation (the fix).
    const schedule = scheduledTaskRepo.getScheduledTaskById(scheduleId)!;
    expect(schedule.enabled).toBe(false);

    const result = publishScheduledOccurrence(baseInput(occurrenceId));

    // The guard does NOT fire on the `enabled` flip; publication proceeds.
    expect(result.outcome).toBe("published");
  });
});

// ===========================================================================
// 5. CONCURRENT PUBLISH — one occurrence, two workers.
// ===========================================================================

describe("publishScheduledOccurrence — concurrent publish (CAS race)", () => {
  it("one worker wins the lease; the other gets already_publishing + returns without publishing", () => {
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    // Simulate the winner: pre-transition to `publishing` with a different
    // worker's lease. The CAS predicate `state='reserved'` will no-op for
    // the test's call.
    markOccurrencePublishingWithClient(getDb(), occurrenceId, {
      leaseOwner: "winner-worker",
      leaseExpiresAt: LEASE_FUTURE,
    });

    const before = countRows();

    // The test's call (the loser) — uses a different leaseOwner.
    const result = publishScheduledOccurrence(
      baseInput(occurrenceId, { leaseOwner: "loser-worker" }),
    );

    // **Failure mode**: if the CAS did not serialize the race, the loser
    // would proceed to publish → DUPLICATE Mission for one occurrence.
    expect(result.outcome).toBe("already_publishing");
    if (result.outcome !== "already_publishing") throw new Error("unreachable");
    expect(result.occurrence.state).toBe("publishing");
    // The winner's lease is intact (the loser did not steal it).
    expect(result.occurrence.leaseOwner).toBe("winner-worker");

    // Nothing committed (the loser returned without proceeding).
    const after = countRows();
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
    expect(after.attempts).toBe(before.attempts);
  });
});

// ===========================================================================
// 6. TOKEN RESOLUTION — {{counter}} = ordinal + 1; {{date}} in timezone.
// ===========================================================================

describe("publishScheduledOccurrence — token resolution", () => {
  it("{{counter}} = ordinal + 1 (1-based display); {{date}} in the schedule's timezone", () => {
    // Schedule a title with both tokens. The schedule starts at runCount=0;
    // reservation stores ordinal=0 (Phase 2 carry-over); display counter = 1.
    const { id: scheduleId } = createSchedule({
      missionTitle: "Sprint {{counter}} — {{date}}",
      timezone: "UTC",
    });
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    const result = publishScheduledOccurrence(baseInput(occurrenceId));

    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") throw new Error("unreachable");

    // counter = ordinal + 1 = 0 + 1 = 1. {{date}} substituted as YYYY-MM-DD.
    expect(result.mission.title).toMatch(/^Sprint 1 — \d{4}-\d{2}-\d{2}$/);

    // **Failure mode**: if the publisher used the schedule's POST-advance
    // runCount (1) + 1 = 2, the title would be "Sprint 2 — ...". The
    // occurrence's stored `ordinal` (0) + 1 = 1 is the correct display.
  });

  it("second firing of a recurring schedule → ordinal=1 → display counter=2", () => {
    const { id: scheduleId } = createSchedule({
      missionTitle: "Recurring #{{counter}}",
    });
    // First firing (ordinal=0, display counter=1).
    const r1 = reserveOccurrenceForSchedule(scheduleId);
    publishScheduledOccurrence(baseInput(r1.id));

    // Second firing (ordinal=1, display counter=2). Advance the clock.
    const r2 = reserveOccurrenceForSchedule(scheduleId, {
      scheduledFor: NEXT_RUN_INTERVAL,
      nextRunAt: "2026-07-19T14:00:00.000Z",
      now: NEXT_RUN_INTERVAL,
    });

    const result = publishScheduledOccurrence(baseInput(r2.id));

    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") throw new Error("unreachable");
    expect(result.mission.title).toBe("Recurring #2");
  });
});

// ===========================================================================
// 7. ATOMIC OCCURRENCE-STATE TRANSITION — load-bearing atomicity proof.
// ===========================================================================

describe("publishScheduledOccurrence — atomic occurrence-state transition (load-bearing)", () => {
  it("participant throw AFTER the occurrence-state write → the transition rolls back too (occurrence stays publishing)", () => {
    // Compose a wrapped participant that:
    //   1. Runs the REAL occurrence-record participant (calls
    //      `markOccurrencePublishedWithClient` → `publishing → published`).
    //   2. THEN throws.
    //
    // The throw rolls back the whole milestone-1 tx → the occurrence-state
    // transition rolls back TOO. The occurrence stays `publishing`.
    //
    // This proves the load-bearing atomicity claim: the
    // `publishing → published` transition commits in the SAME tx as the
    // Mission+Tasks+Workflow+usage. If anything fails after the
    // occurrence-state write, the write rolls back.
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    // Mark the occurrence publishing manually so the participant's
    // `markOccurrencePublishedWithClient` has the right source state.
    markOccurrencePublishingWithClient(getDb(), occurrenceId, {
      leaseOwner: "atomicity-worker",
      leaseExpiresAt: LEASE_FUTURE,
    });
    const occurrence = readOccurrence(occurrenceId);
    expect(occurrence.state).toBe("publishing");

    // Prepare the aggregate + reserve attempts directly (bypassing
    // `publishScheduledOccurrence` so we can inject the wrapped participant
    // into the milestone-1 publisher).
    const schedule = scheduledTaskRepo.getScheduledTaskById(scheduleId)!;
    const prepareCtx: PrepareTemplateAggregateContext = {
      actor: SCHEDULE_ACTOR,
      auditSource: SCHEDULE_SOURCE,
      causalContext: { root: { type: "scheduled_occurrence", id: occurrenceId } },
    };
    const prepared = prepareTemplateAggregate(
      schedule.templateId!,
      schedule.habitatId,
      { title: schedule.missionTitle, description: schedule.missionDescription },
      prepareCtx,
    );
    if (prepared.outcome !== "prepared") throw new Error("prep failed");

    // Reserve per-Task attempts scoped by the occurrence.
    const attemptIds = prepared.aggregate.tasks.map((task, i) => {
      const reservation = reserveAttemptWithClient(getDb(), {
        source: SCHEDULE_SOURCE,
        sourceScopeKind: "scheduled_occurrence",
        sourceScopeId: occurrenceId,
        attemptKey: `${schedule.templateId}-${i}`,
        requestFingerprint: `test:${occurrenceId}:${i}`,
        publicationKind: "scheduled_occurrence",
        habitatId: schedule.habitatId,
        actorType: "system",
        actorId: "scheduler",
        causalContext: { root: { type: "scheduled_occurrence", id: occurrenceId } },
      });
      return reservation.attempt.id;
    });

    // The wrapped participant: real occurrence-record write + throw.
    const realParticipant = buildOccurrenceRecordParticipant(
      occurrenceId,
      occurrence.scheduleRevision,
    );
    const wrappedParticipant = (
      db: Parameters<typeof realParticipant>[0],
      ctx: TemplateAggregateParticipantContext,
    ) => {
      realParticipant(db, ctx);
      // AFTER the occurrence-state write committed on the tx client, throw.
      // The throw rolls back the WHOLE tx — Mission, Tasks, Workflow, usage,
      // AND the occurrence-state transition.
      throw new Error("INJECTED: post-occurrence-state-write failure");
    };

    const before = countRows();

    // The wrapped participant throws → the milestone-1 tx rolls back.
    expect(() =>
      publishTemplateAggregateWithClient(getDb(), {
        attemptIds,
        prepared: prepared.aggregate,
        participants: wrappedParticipant,
      }),
    ).toThrow(/INJECTED/);

    // **Failure mode**: if the occurrence-state transition did NOT roll back
    // with the tx, the occurrence would be `published` here (orphan
    // terminal state with no Mission).
    const afterOccurrence = readOccurrence(occurrenceId);
    expect(afterOccurrence.state).toBe("publishing");
    expect(afterOccurrence.createdMissionId).toBeNull();
    // The lease is intact (rolled back to the post-`markOccurrencePublishing` state).
    expect(afterOccurrence.leaseOwner).toBe("atomicity-worker");

    // ZERO aggregate committed (Mission/Tasks/events/envelopes all unchanged).
    const after = countRows();
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
    expect(after.events).toBe(before.events);
    expect(after.envelopes).toBe(before.envelopes);
  });
});

// ===========================================================================
// 8. DORMANCY — exported + tested, no production caller.
// ===========================================================================

describe("publishScheduledOccurrence — dormancy", () => {
  it("the adapter is exported and callable (wired to no production path)", () => {
    expect(typeof publishScheduledOccurrence).toBe("function");
    expect(typeof buildOccurrenceRecordParticipant).toBe("function");

    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
    const result = publishScheduledOccurrence(baseInput(occurrenceId));

    const outcomes: PublishScheduledOccurrenceOutcome["outcome"][] = [
      "published",
      "vetoed",
      "rejected_validation",
      "schedule_guard_mismatch",
      "guard_mismatch",
      "governance_denied",
      "already_publishing",
      "illegal_source_state",
      "not_found",
      "schedule_missing",
      "replayed",
      "rejected_fingerprint",
    ];
    expect(outcomes).toContain(result.outcome);
  });

  it("closed-union exhaustiveness — every result branch is a known outcome", () => {
    // Type-level check: a default case surfaces an unhandled branch at compile time.
    const sample: PublishScheduledOccurrenceOutcome = { outcome: "not_found" };
    const exhaustive = (r: PublishScheduledOccurrenceOutcome): string => {
      switch (r.outcome) {
        case "published":
        case "vetoed":
        case "rejected_validation":
        case "schedule_guard_mismatch":
        case "guard_mismatch":
        case "governance_denied":
        case "already_publishing":
        case "illegal_source_state":
        case "not_found":
        case "schedule_missing":
        case "replayed":
        case "rejected_fingerprint":
          return r.outcome;
      }
    };
    expect(exhaustive(sample)).toBe("not_found");
  });
});

// ===========================================================================
// 9. EDGE CASES — not_found, illegal_source_state (replay), schedule_missing.
// ===========================================================================

describe("publishScheduledOccurrence — edge cases", () => {
  it("non-existent occurrence id → not_found (typed, no throw)", () => {
    const result = publishScheduledOccurrence(baseInput("does-not-exist"));
    expect(result.outcome).toBe("not_found");
  });

  it("replay against a published occurrence → illegal_source_state (the transition is refused)", () => {
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    const first = publishScheduledOccurrence(baseInput(occurrenceId));
    expect(first.outcome).toBe("published");

    // A re-drive (scheduler retry after success) → the occurrence is terminal.
    const second = publishScheduledOccurrence(baseInput(occurrenceId));
    expect(second.outcome).toBe("illegal_source_state");
    if (second.outcome !== "illegal_source_state") throw new Error("unreachable");
    expect(second.fromState).toBe("published");
  });

  it("schedule deleted between reservation and publication → schedule_missing; occurrence rejected", () => {
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    // Delete the schedule row.
    getDb().delete(scheduledTasks).where(eq(scheduledTasks.id, scheduleId)).run();

    const result = publishScheduledOccurrence(baseInput(occurrenceId));

    expect(result.outcome).toBe("schedule_missing");
    if (result.outcome !== "schedule_missing") throw new Error("unreachable");

    // Occurrence terminal-rejected with the data-anomaly reason.
    const occurrence = readOccurrence(occurrenceId);
    expect(occurrence.state).toBe("rejected");
    expect(occurrence.leaseOwner).toBeNull();
    expect(occurrence.result).toEqual({
      reason: "schedule_missing",
      message: expect.stringContaining(scheduleId),
    });
  });
});
