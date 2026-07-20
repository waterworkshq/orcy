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
    // T9A-10 M1: the success shape now carries `kind: "aggregate_published"`
    // (the discriminator field added inside `buildOccurrenceRecordParticipant`).
    expect(occurrence.result).toEqual({
      kind: "aggregate_published",
      missionId: result.mission.id,
      taskCount: result.tasks.length,
      attemptIds: expect.arrayContaining([expect.any(String)]),
      coordinationAttemptId: expect.any(String),
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

    // Each per-Task attempt advanced to RECOVERING (`published_pending_observation).
    // T9A-03: filter out the coordination attempt (`attemptKey:"occurrence"`)
    // which is asserted separately below — it shares the occurrence scope.
    const attempts = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.sourceScopeId, occurrenceId))
      .all();
    const perTaskAttempts = attempts.filter((a) => a.attemptKey !== "occurrence");
    expect(perTaskAttempts).toHaveLength(result.tasks.length);
    for (const a of perTaskAttempts) {
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

    // T9A-03: the occurrence-level coordination attempt (`attemptKey:"occurrence"`)
    // terminalized to `created` in-tx with the aggregate. It shares the
    // occurrence scope but is distinguishable by its key + state.
    const coordination = attempts.filter((a) => a.attemptKey === "occurrence");
    expect(coordination).toHaveLength(1);
    expect(coordination[0].state).toBe("created");
    expect(coordination[0].sourceScopeKind).toBe("scheduled_occurrence");
    expect(coordination[0].sourceScopeId).toBe(occurrenceId);
    expect(coordination[0].source).toBe("scheduler");
    expect(coordination[0].publicationKind).toBe("scheduled_occurrence");
    expect(coordination[0].terminalOutcome).toBe("created");
    expect(coordination[0].completedAt).not.toBeNull();
    // The occurrence ROW's `attemptId` carries the coordination attempt id.
    expect(occurrence.attemptId).toBe(coordination[0].id);

    // All counts moved (aggregate + occurrence-state committed together).
    // T9A-03: the coordination attempt was reserved at Phase 2 (counted in
    // `before.attempts`); the publisher adds N per-Task attempts (no new
    // coordination attempt at publication time — it advances the existing one).
    const after = countRows();
    expect(after.missions).toBe(before.missions + 1);
    expect(after.tasks).toBe(before.tasks + result.tasks.length);
    expect(after.events).toBe(before.events + result.tasks.length);
    expect(after.envelopes).toBe(before.envelopes + result.tasks.length);
    expect(after.attempts).toBe(before.attempts + result.tasks.length);
  });

  it("T9A-09: stamps scheduledTasks.lastCreatedMissionId on complete success (atomic with the aggregate)", () => {
    // The plan (`technical-plan:342`) requires `lastCreatedMissionId` to
    // change ONLY after complete success. The occurrence-record participant
    // stamps it INSIDE the milestone-1 publication tx (the same in-tx hook
    // that transitions the occurrence to `published` + links the Mission +
    // advances the coordination attempt). A crash anywhere before commit
    // rolls back BOTH the aggregate AND this stamp → the schedule's
    // lastCreatedMissionId stays null on a failed publication (the negative
    // cases are covered in the vetoed / rejected_validation / guard_mismatch
    // tests below).
    //
    // **Failure mode**: pre-T9A-09 (arc 1 carry-over) the participant left
    // lastCreatedMissionId null — a plan deviation that treated the
    // occurrence row as the sole source of truth. The plan REQUIRES both:
    // the occurrence row (the per-firing record) AND the schedule's
    // lastCreatedMissionId (the schedule's "last successful fire" pointer
    // that legacy `finalizeExecution` stamped). Post-T9A-09 the schedule
    // row carries the Mission id; the assertion would fail pre-fix.
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    const result = publishScheduledOccurrence(baseInput(occurrenceId));
    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") throw new Error("unreachable");

    const schedule = scheduledTaskRepo.getScheduledTaskById(scheduleId)!;
    expect(schedule.lastCreatedMissionId).toBe(result.mission.id);
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
    // publisher runs governance BEFORE opening the tx; T9A-04 all-failures
    // governance returns the full `vetoes` list. The default schedule
    // template has 2 task entries + `veto-all` refuses BOTH → the list
    // carries both decisive Task-level vetoes (the all-failures semantic;
    // the legacy first-veto path would have surfaced only index 0).
    expect(result.outcome).toBe("vetoed");
    if (result.outcome !== "vetoed") throw new Error("unreachable");
    expect(result.vetoes).toHaveLength(2);
    expect(result.vetoes[0].taskIndex).toBe(0);
    expect(result.vetoes[1].taskIndex).toBe(1);
    for (const v of result.vetoes) {
      expect(v.veto.reason).toBe("vetoed by schedule test interceptor");
      expect(v.veto.interceptorKey).toContain("veto-all");
      expect(typeof v.veto.pluginRunId).toBe("string");
    }

    // Occurrence terminal-rejected with the veto details (T9A-04: the
    // occurrence's result carries the FULL `vetoes` list).
    const occurrence = readOccurrence(occurrenceId);
    expect(occurrence.state).toBe("rejected");
    expect(occurrence.leaseOwner).toBeNull(); // retired by terminal transition.
    expect(occurrence.createdMissionId).toBeNull();
    expect(occurrence.result).toEqual({
      reason: "vetoed",
      vetoes: expect.arrayContaining([
        expect.objectContaining({
          taskIndex: 0,
          veto: expect.objectContaining({
            interceptorKey: expect.any(String),
            reason: "vetoed by schedule test interceptor",
          }),
        }),
        expect.objectContaining({
          taskIndex: 1,
          veto: expect.objectContaining({
            interceptorKey: expect.any(String),
            reason: "vetoed by schedule test interceptor",
          }),
        }),
      ]),
    });

    // ZERO partial aggregate: no Mission, no Tasks, no events, no envelopes
    // committed. The tx never opened (governance runs BEFORE the tx in the
    // milestone-1 publisher).
    const after = countRows();
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
    expect(after.events).toBe(before.events);
    expect(after.envelopes).toBe(before.envelopes);

    // T9A-09 (arc 4): the schedule's lastCreatedMissionId is NOT stamped on
    // a vetoed publication — the participant (which owns the stamp) never
    // runs because the milestone-1 publisher governs BEFORE opening the tx.
    // The stamp is gated on complete success; a veto is not success.
    expect(scheduledTaskRepo.getScheduledTaskById(scheduleId)!.lastCreatedMissionId).toBeNull();

    // *** T9A-05 ARC 2 — ALL reserved attempts terminalize on veto ***
    // Arc 2 terminalizes every reserved attempt atomically with the
    // occurrence rejection:
    //   - The N per-Task attempts (reserved at step 6): the vetoed
    //     taskIndexes → terminal `vetoed`; the allowed taskIndexes →
    //     terminal `batch_rejected` (collateral).
    //   - The occurrence-level coordination attempt → terminal `vetoed`.
    // None stay `pending` (the plan's attempt state machine forbids dangling
    // pending attempts on terminal aggregate outcomes).

    // The coordination attempt → terminal `vetoed`.
    const coordinationAttemptId = readOccurrence(occurrenceId).attemptId;
    expect(coordinationAttemptId).not.toBeNull();
    const coordination = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.id, coordinationAttemptId as string))
      .all()[0];
    expect(coordination.state).toBe("vetoed");
    expect(coordination.terminalOutcome).toBe("vetoed");
    expect(coordination.completedAt).not.toBeNull();

    // The N per-Task attempts → ALL terminal `vetoed` (this template's 2
    // Tasks both vetoed). The terminalResult carries each Task-level veto.
    const perTaskAttempts = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.sourceScopeId, occurrenceId))
      .all()
      // Exclude the coordination attempt (its sourceScopeId is also the
      // occurrence id but its attemptKey is "occurrence").
      .filter((a) => a.attemptKey !== "occurrence");
    expect(perTaskAttempts).toHaveLength(2);
    for (const attempt of perTaskAttempts) {
      expect(attempt.state).toBe("vetoed");
      expect(attempt.terminalOutcome).toBe("vetoed");
      expect(attempt.completedAt).not.toBeNull();
      expect(attempt.terminalResult).toMatchObject({
        outcome: "vetoed",
        veto: expect.objectContaining({
          reason: "vetoed by schedule test interceptor",
        }),
      });
    }
  });

  /**
   * T9A-05 multi-veto + collateral terminalization — a 3-Task schedule where
   * Task #0 AND Task #2 veto; Task #1 is allowed (collateral). Proves:
   *   - The `vetoes` list carries BOTH vetoes (T9A-04).
   *   - Vetoed taskIndexes (#0, #2) → per-Task attempts terminal `vetoed`.
   *   - Allowed taskIndex (#1) → per-Task attempt terminal `batch_rejected`.
   *   - Coordination attempt → terminal `vetoed`.
   *   - Occurrence → `rejected` with the full `vetoes` list in `result`.
   */
  it("multi-veto: Task #0 + #2 vetoed, Task #1 allowed (collateral batch_rejected); ALL attempts terminalize atomically", async () => {
    await writePlugin(
      "veto-sched-0",
      `{
        manifest: {
          id: 'veto-sched-0', version: '1.0.0', description: 'veto schedule task 0',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'veto-0', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: {
          'veto-0': (pluginCtx, transition) => {
            const title = transition && transition.context && transition.context.metadata && transition.context.metadata.title;
            if (title === 'VETO-A') return { allow: false, reason: 'vetoed task 0' };
            return { allow: true };
          },
        },
      }`,
    );
    await writePlugin(
      "veto-sched-2",
      `{
        manifest: {
          id: 'veto-sched-2', version: '1.0.0', description: 'veto schedule task 2',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'veto-2', phase: 'pre', event: 'taskCreated', priority: 2, requires: [] },
          ],
        },
        interceptors: {
          'veto-2': (pluginCtx, transition) => {
            const title = transition && transition.context && transition.context.metadata && transition.context.metadata.title;
            if (title === 'VETO-C') return { allow: false, reason: 'vetoed task 2' };
            return { allow: true };
          },
        },
      }`,
    );
    enrollInterceptor(habitatId, "veto-sched-0", "veto-0");
    enrollInterceptor(habitatId, "veto-sched-2", "veto-2");

    // A 3-task template: Tasks #0 + #2 veto; Task #1 is allowed (collateral).
    const template = createMissionTemplate({
      tasksTemplate: [
        { key: "a", title: "VETO-A", order: 0 },
        { key: "b", title: "Allow-B", order: 1 },
        { key: "c", title: "VETO-C", order: 2 },
      ],
    });
    const { id: scheduleId } = createSchedule({ templateId: template.id });
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
    const before = countRows();

    const result = publishScheduledOccurrence(baseInput(occurrenceId));

    expect(result.outcome).toBe("vetoed");
    if (result.outcome !== "vetoed") throw new Error("unreachable");
    expect(result.vetoes).toHaveLength(2);
    expect(result.vetoes[0].taskIndex).toBe(0);
    expect(result.vetoes[0].veto.reason).toBe("vetoed task 0");
    expect(result.vetoes[1].taskIndex).toBe(2);
    expect(result.vetoes[1].veto.reason).toBe("vetoed task 2");

    // Occurrence terminal-rejected.
    const occurrence = readOccurrence(occurrenceId);
    expect(occurrence.state).toBe("rejected");
    expect(occurrence.leaseOwner).toBeNull();
    expect(occurrence.result).toMatchObject({
      reason: "vetoed",
      vetoes: expect.arrayContaining([
        expect.objectContaining({ taskIndex: 0 }),
        expect.objectContaining({ taskIndex: 2 }),
      ]),
    });

    // ZERO partial aggregate.
    const after = countRows();
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
    expect(after.events).toBe(before.events);
    expect(after.envelopes).toBe(before.envelopes);

    // --- T9A-05 attempt terminalization assertions ---
    // Per-Task attempts: 3 total (one per prepared Task). The 2 vetoed
    // taskIndexes → `vetoed`; the 1 allowed taskIndex (#1) → `batch_rejected`
    // (collateral — it was allowed but the aggregate didn't publish).
    const perTaskAttempts = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.sourceScopeId, occurrenceId))
      .all()
      .filter((a) => a.attemptKey !== "occurrence");
    expect(perTaskAttempts).toHaveLength(3);
    const byKey = new Map(perTaskAttempts.map((a) => [a.attemptKey, a]));
    // The attemptKey pattern is `${templateId}-${i}` (the adapter's loop).
    const prefix = `${template.id}-`;
    const attempt0 = byKey.get(`${prefix}0`)!;
    const attempt1 = byKey.get(`${prefix}1`)!;
    const attempt2 = byKey.get(`${prefix}2`)!;
    expect(attempt0.state).toBe("vetoed");
    expect(attempt0.terminalOutcome).toBe("vetoed");
    expect(attempt0.terminalResult).toMatchObject({
      outcome: "vetoed",
      veto: expect.objectContaining({ reason: "vetoed task 0" }),
    });
    // Collateral — allowed but unpublished.
    expect(attempt1.state).toBe("batch_rejected");
    expect(attempt1.terminalOutcome).toBe("batch_rejected");
    expect(attempt1.terminalResult).toMatchObject({ outcome: "batch_rejected" });
    expect(attempt2.state).toBe("vetoed");
    expect(attempt2.terminalOutcome).toBe("vetoed");
    expect(attempt2.terminalResult).toMatchObject({
      outcome: "vetoed",
      veto: expect.objectContaining({ reason: "vetoed task 2" }),
    });
    // None pending.
    for (const a of perTaskAttempts) {
      expect(a.state).not.toBe("pending");
      expect(a.completedAt).not.toBeNull();
    }

    // Coordination attempt → `vetoed`.
    const coordination = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.sourceScopeId, occurrenceId))
      .all()
      .filter((a) => a.attemptKey === "occurrence")[0];
    expect(coordination).toBeDefined();
    expect(coordination.state).toBe("vetoed");
    expect(coordination.terminalOutcome).toBe("vetoed");
    expect(coordination.completedAt).not.toBeNull();
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

    // Capture the coordination attempt id (T9A-03) before publication.
    const beforeOccurrence = readOccurrence(occurrenceId);
    const coordinationAttemptId = beforeOccurrence.attemptId;
    expect(coordinationAttemptId).not.toBeNull();

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

    // T9A-09 (arc 4): the schedule's lastCreatedMissionId is NOT stamped on
    // a rejected_validation publication — the participant never runs
    // (preparation rejected before the publication tx opened). The stamp is
    // gated on complete success; a validation rejection is not success.
    expect(scheduledTaskRepo.getScheduledTaskById(scheduleId)!.lastCreatedMissionId).toBeNull();

    // T9A-03: the coordination attempt terminalized to `rejected_validation`
    // (canonical/scope failure) atomic with the occurrence rejection.
    const coordination = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.id, coordinationAttemptId as string))
      .all()[0];
    expect(coordination.state).toBe("rejected_validation");
    expect(coordination.terminalOutcome).toBe("rejected_validation");
    expect(coordination.completedAt).not.toBeNull();
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

    // T9A-09 (arc 4): the schedule's lastCreatedMissionId is NOT stamped on
    // a schedule_guard_mismatch — the participant's in-tx re-check threw
    // ScheduleGuardMismatch → the whole tx rolled back (including the
    // stamp). The stamp is gated on complete success; a guard mismatch is a
    // resumable failure, not success.
    expect(scheduledTaskRepo.getScheduledTaskById(scheduleId)!.lastCreatedMissionId).toBeNull();
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

  it("T9A-06: {{date}} uses the durable scheduledFor (NOT wall-clock) — a cross-midnight retry renders the SAME date", () => {
    // Discriminating test for the T9A-06 fix. Pre-fix `substituteTokens`
    // formatted `new Date()` (wall-clock now); a retry/recovery crossing
    // midnight would render a DIFFERENT date under the same attempt keys →
    // a different fingerprint → `rejected_fingerprint` on a same-key retry
    // (the plan's token-consistency requirement at `technical-plan:344`).
    // Post-fix it formats the durable `occurrence.scheduledFor`, so the
    // rendered date is stable across retries regardless of when publication
    // actually runs.
    //
    // **Failure mode**: pre-fix, the title would contain TODAY's wall-clock
    // date (whatever date the test runs on), NOT the fixed `scheduledFor`
    // date below. The assertion `2026-07-18` would fail unless the test
    // happened to run on that exact date — which is the whole point.
    const fixedScheduledFor = "2026-07-18T23:30:00.000Z"; // yesterday in the test frame
    const { id: scheduleId } = createSchedule({
      missionTitle: "Daily Standup — {{date}}",
      timezone: "UTC",
    });
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId, {
      scheduledFor: fixedScheduledFor,
    });

    const result = publishScheduledOccurrence(baseInput(occurrenceId));

    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") throw new Error("unreachable");

    // The rendered {{date}} is the scheduledFor date (2026-07-18), NOT
    // today's wall-clock date.
    expect(result.mission.title).toBe("Daily Standup — 2026-07-18");
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
    // The 3rd argument (`coordinationAttemptId`) is `null` — this test
    // isolates the occurrence-ROW atomicity; the T9A-03 coordination-attempt
    // advance has its own dedicated test. The 4th argument (`leaseOwner`)
    // is the worker that acquired the lease above — T9A-08 fencing.
    const realParticipant = buildOccurrenceRecordParticipant(
      occurrenceId,
      occurrence.scheduleRevision,
      null,
      "atomicity-worker",
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
      "schedule_vanished_mid_tx",
      "replayed",
      "rejected_fingerprint",
    ];
    expect(outcomes).toContain(result.outcome);
  });

  it("closed-union exhaustiveness — every result branch is a known outcome", () => {
    // Type-level Check: a default case surfaces an unhandled branch at compile time.
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
        case "schedule_vanished_mid_tx":
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

    // Capture the coordination attempt id (T9A-03) before publication.
    const beforeOccurrence = readOccurrence(occurrenceId);
    const coordinationAttemptId = beforeOccurrence.attemptId;
    expect(coordinationAttemptId).not.toBeNull();

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

    // T9A-03: the coordination attempt terminalized to `batch_rejected`
    // (aggregate-level data anomaly) atomic with the occurrence rejection.
    const coordination = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.id, coordinationAttemptId as string))
      .all()[0];
    expect(coordination.state).toBe("batch_rejected");
    expect(coordination.terminalOutcome).toBe("schedule_missing");
    expect(coordination.completedAt).not.toBeNull();
  });
});

// ===========================================================================
// 10. T9A-03 — occurrence-level coordination attempt lifecycle (failure paths).
// ===========================================================================

describe("publishScheduledOccurrence — T9A-03 rejected_fingerprint terminalization", () => {
  it("per-Task fingerprint mismatch → coordination attempt terminalizes to batch_rejected atomic with occurrence rejection", () => {
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    // Pre-reserve a per-Task attempt with a DIFFERENT fingerprint under the
    // same key the publisher will use (`${templateId}-0`). The publisher's
    // per-Task reservation hits this existing attempt + returns
    // `rejected_fingerprint` deterministically.
    const schedule = scheduledTaskRepo.getScheduledTaskById(scheduleId)!;
    const templateId = schedule.templateId!;
    reserveAttemptWithClient(getDb(), {
      source: SCHEDULE_SOURCE,
      sourceScopeKind: "scheduled_occurrence",
      sourceScopeId: occurrenceId,
      attemptKey: `${templateId}-0`,
      requestFingerprint: "stale-fingerprint-pre-emitted-by-test",
      publicationKind: "scheduled_occurrence",
      habitatId: schedule.habitatId,
      actorType: "system",
      actorId: "scheduler",
      causalContext: { root: { type: "scheduled_occurrence", id: occurrenceId } },
    });

    // Capture the coordination attempt id (T9A-03).
    const coordinationAttemptId = readOccurrence(occurrenceId).attemptId;
    expect(coordinationAttemptId).not.toBeNull();

    const result = publishScheduledOccurrence(baseInput(occurrenceId));

    // **Failure mode**: pre-T9A-03 the occurrence rejected but the
    // coordination attempt stayed `pending`. Post-T9A-03 the coordination
    // attempt terminalizes atomic with the occurrence rejection.
    expect(result.outcome).toBe("rejected_fingerprint");
    if (result.outcome !== "rejected_fingerprint") throw new Error("unreachable");

    expect(readOccurrence(occurrenceId).state).toBe("rejected");

    // T9A-03: coordination attempt terminalized to `batch_rejected`
    // (aggregate-level config drift — the rendered payload changed under
    // the same key set).
    const coordination = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.id, coordinationAttemptId as string))
      .all()[0];
    expect(coordination.state).toBe("batch_rejected");
    expect(coordination.terminalOutcome).toBe("rejected_fingerprint");
    expect(coordination.completedAt).not.toBeNull();
  });
});

// ===========================================================================
// 11. T9A-01 (arc 3) — schedule-guard BYPASS proofs (CRITICAL).
//
// The original Q5 guard excluded `enabled` + `nextRunAt` from the diff
// (treated as "operational"). BOTH are user-mutable via `updateScheduledTask`
// (`scheduledTask.ts:150/152`), so a user disable/reschedule between
// reservation + publication was invisible → the stale occurrence published
// against the user's edit. The fix (T9A-01) stamps `_expectedPostReservation`
// on the snapshot at reservation time + the guard compares the live row to
// those EXPECTED values (not the pre-reservation snapshot, which always
// mismatches because the reservation itself mutates them).
//
// These tests prove: (a) the bypass is closed (disable + reschedule fire the
// guard); (b) the reservation's OWN mutations stay invisible (recurring +
// one-shot happy paths pass); (c) the `runCount` gate avoids false positives
// on a subsequent different-occurrence reservation's normal advance; (d) the
// defensive fallback (no `_expectedPostReservation`) skips the operational
// check (backward compat).
// ===========================================================================

describe("publishScheduledOccurrence — T9A-01 schedule-guard bypass proofs", () => {
  it("user DISABLES a recurring schedule after reservation → schedule_guard_mismatch (live enabled ≠ expected enabled)", () => {
    // **Failure mode (pre-fix)**: the guard excluded `enabled`, so a user
    // `updateScheduledTask({enabled:false})` between reservation + publication
    // was invisible. The stale occurrence published against the user's
    // disable. Post-fix: the operational check compares live `enabled` to
    // `_expectedPostReservation.enabled` → mismatch → guard fires.
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
    const before = countRows();

    // Simulate the user disable AFTER reservation.
    scheduledTaskRepo.updateScheduledTask(scheduleId, { enabled: false });

    const result = publishScheduledOccurrence(baseInput(occurrenceId));

    expect(result.outcome).toBe("schedule_guard_mismatch");
    if (result.outcome !== "schedule_guard_mismatch") throw new Error("unreachable");
    expect(result.fields).toContain("enabled");

    // Q4: occurrence STAYS `publishing` (resumable — T9B recovers).
    const occurrence = readOccurrence(occurrenceId);
    expect(occurrence.state).toBe("publishing");
    expect(occurrence.leaseOwner).toBe("worker-test");

    // Nothing committed (the pre-check fires before prepare / reserve).
    const after = countRows();
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
    expect(after.attempts).toBe(before.attempts);
  });

  it("user RESCHEDULES a recurring schedule after reservation → schedule_guard_mismatch (live nextRunAt ≠ expected nextRunAt)", () => {
    // **Failure mode (pre-fix)**: the guard excluded `nextRunAt`, so a user
    // `updateScheduledTask({nextRunAt:...})` between reservation + publication
    // was invisible. Post-fix: the operational check compares live `nextRunAt`
    // to `_expectedPostReservation.nextRunAt` (gated by `runCount` — see the
    // next test) → mismatch → guard fires.
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
    const before = countRows();

    // Simulate the user reschedule AFTER reservation. The new value differs
    // from the reservation's advance target (NEXT_RUN_INTERVAL).
    const RESCHEDULED = "2027-12-31T23:59:59.000Z";
    scheduledTaskRepo.updateScheduledTask(scheduleId, { nextRunAt: RESCHEDULED });

    const result = publishScheduledOccurrence(baseInput(occurrenceId));

    expect(result.outcome).toBe("schedule_guard_mismatch");
    if (result.outcome !== "schedule_guard_mismatch") throw new Error("unreachable");
    expect(result.fields).toContain("nextRunAt");

    // Q4: occurrence STAYS `publishing`.
    expect(readOccurrence(occurrenceId).state).toBe("publishing");

    // Nothing committed.
    const after = countRows();
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
    expect(after.attempts).toBe(before.attempts);
  });

  it("reservation's OWN advance mutation stays INVISIBLE (recurring schedule → publish immediately → published)", () => {
    // **Failure mode (if the fix compared to the PRE-reservation snapshot)**:
    // every publish would fire the guard because the reservation advanced
    // `nextRunAt` from NOW_ISO to NEXT_RUN_INTERVAL. The fix compares to the
    // EXPECTED post-reservation values → the reservation's own advance
    // matches → guard passes.
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    // Confirm the schedule was advanced at reservation.
    const schedule = scheduledTaskRepo.getScheduledTaskById(scheduleId)!;
    expect(schedule.nextRunAt).toBe(NEXT_RUN_INTERVAL); // advance target.
    expect(schedule.enabled).toBe(true); // recurring stays enabled.
    expect(schedule.runCount).toBe(1); // advanced once.

    const result = publishScheduledOccurrence(baseInput(occurrenceId));

    // The guard PASSES — the live `nextRunAt` (NEXT_RUN_INTERVAL) matches
    // `_expectedPostReservation.nextRunAt`; the live `enabled` (true) matches
    // `_expectedPostReservation.enabled`; the live `runCount` (1) matches
    // `_expectedPostReservation.runCount` → the nextRunAt check runs + passes.
    expect(result.outcome).toBe("published");
  });

  it("reservation's OWN one-shot disable + advance mutations stay INVISIBLE (one-shot → publish → published)", () => {
    // The one-shot case is the trickiest: the reservation BOTH advances
    // (`nextRunAt` = NEXT_RUN_FAR_FUTURE) AND disables (`enabled` = false).
    // Both must be invisible to the guard. The fix's
    // `_expectedPostReservation` captures `enabled:false` for a one-shot →
    // the live `enabled:false` matches.
    const { id: scheduleId } = createSchedule({ scheduleType: "once" });
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId, {
      nextRunAt: NEXT_RUN_FAR_FUTURE,
    });

    // Confirm the one-shot was advanced + disabled at reservation.
    const schedule = scheduledTaskRepo.getScheduledTaskById(scheduleId)!;
    expect(schedule.enabled).toBe(false);
    expect(schedule.nextRunAt).toBe(NEXT_RUN_FAR_FUTURE);
    expect(schedule.runCount).toBe(1);

    const result = publishScheduledOccurrence(baseInput(occurrenceId));

    // The guard PASSES — both the operational (`enabled`, `nextRunAt`) +
    // the config checks match the expected / snapshot values.
    expect(result.outcome).toBe("published");
  });

  it("`runCount` gate: a subsequent different-occurrence reservation's normal advance does NOT fire the guard", () => {
    // **False-positive scenario (without the gate)**: O1 reserves at T0
    // (advances schedule to T1, runCount=1). O2 reserves at T1 (advances
    // schedule to T2, runCount=2). O1 publishes — its `_expectedPostReservation
    // .nextRunAt` is T1, but live `nextRunAt` is T2 (O2's advance) → guard
    // would fire falsely. The `runCount` gate skips the `nextRunAt` check
    // when `live.runCount > expected.runCount` (a subsequent reservation
    // won; the live `nextRunAt` is THAT reservation's target, not a user
    // edit). The `enabled` check still runs unconditionally.
    const { id: scheduleId } = createSchedule();

    // O1: reserve at T0 (NOW_ISO). Schedule advances to T1 (NEXT_RUN_INTERVAL).
    const r1 = reserveOccurrenceForSchedule(scheduleId);

    // O2: reserve at T1 (NEXT_RUN_INTERVAL). Schedule advances to T2.
    const T2 = "2026-07-19T14:00:00.000Z";
    const r2 = reserveOccurrenceForSchedule(scheduleId, {
      scheduledFor: NEXT_RUN_INTERVAL,
      nextRunAt: T2,
      now: NEXT_RUN_INTERVAL,
    });

    // Confirm the schedule was advanced twice.
    const schedule = scheduledTaskRepo.getScheduledTaskById(scheduleId)!;
    expect(schedule.runCount).toBe(2);
    expect(schedule.nextRunAt).toBe(T2); // O2's advance target.

    // Publish O1. Its snapshot's _expectedPostReservation.nextRunAt is T1
    // (NEXT_RUN_INTERVAL); live nextRunAt is T2. The runCount gate skips
    // the nextRunAt check (live runCount=2 > expected runCount=1). The
    // `enabled` check passes (recurring stays enabled). The guard passes
    // → publish proceeds.
    const result = publishScheduledOccurrence(baseInput(r1.id));

    expect(result.outcome).toBe("published");

    // Sanity: O2 still publishes cleanly too.
    const result2 = publishScheduledOccurrence(baseInput(r2.id));
    expect(result2.outcome).toBe("published");
  });

  it("backward compat: a snapshot WITHOUT `_expectedPostReservation` skips the operational check (config-only diff)", () => {
    // Defensive fallback: a pre-T9A-01-fix occurrence (no
    // `_expectedPostReservation` in its snapshot) → the operational check
    // is skipped; only the config diff runs. A user disable that would
    // otherwise fire the operational check is INVISIBLE for these legacy
    // snapshots. The config diff still catches config edits. (The arc is
    // dormant — no production occurrences exist — but the fallback is
    // handled cleanly.)
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    // Strip `_expectedPostReservation` to simulate a pre-fix snapshot.
    const occurrence = readOccurrence(occurrenceId);
    const strippedSnapshot = { ...occurrence.scheduleRevision } as Record<string, unknown>;
    delete strippedSnapshot._expectedPostReservation;
    getDb()
      .update(scheduledOccurrences)
      .set({ scheduleRevision: strippedSnapshot })
      .where(eq(scheduledOccurrences.id, occurrenceId))
      .run();

    // User disables the schedule (operational change). With the snapshot
    // stripped, the operational check is skipped → the disable is invisible
    // (the legacy behavior). The publish proceeds.
    scheduledTaskRepo.updateScheduledTask(scheduleId, { enabled: false });

    const result = publishScheduledOccurrence(baseInput(occurrenceId));

    // The guard does NOT fire (no `_expectedPostReservation` → operational
    // check skipped; no config edit → config check passes). Publish proceeds.
    // This proves the defensive fallback: legacy snapshots are not broken
    // by the fix; they just don't benefit from the operational check.
    expect(result.outcome).toBe("published");
  });

  it("snapshot carries `_expectedPostReservation` at reservation time (Phase 2 stamps it)", () => {
    // Prove the Phase-2 reservation stamps `_expectedPostReservation` on the
    // snapshot. This is the contract the Phase-3 guard depends on.
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    const occurrence = readOccurrence(occurrenceId);
    const snapshot = occurrence.scheduleRevision as Record<string, unknown>;
    const expected = snapshot._expectedPostReservation as Record<string, unknown> | undefined;
    expect(expected).toBeDefined();
    expect(typeof expected).toBe("object");
    expect(expected!.nextRunAt).toBe(NEXT_RUN_INTERVAL); // the advance target.
    expect(expected!.enabled).toBe(true); // recurring stays enabled.
    expect(expected!.runCount).toBe(1); // ordinal(0) + 1.
  });

  it("snapshot's `_expectedPostReservation.enabled` is `false` for a one-shot reservation", () => {
    // The one-shot disable-at-reservation is captured as
    // `_expectedPostReservation.enabled = false`. The Phase-3 guard compares
    // the live `enabled` to this expected value.
    const { id: scheduleId } = createSchedule({ scheduleType: "once" });
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId, {
      nextRunAt: NEXT_RUN_FAR_FUTURE,
    });

    const occurrence = readOccurrence(occurrenceId);
    const snapshot = occurrence.scheduleRevision as Record<string, unknown>;
    const expected = snapshot._expectedPostReservation as Record<string, unknown>;
    expect(expected.enabled).toBe(false); // one-shot disabled at reservation.
    expect(expected.nextRunAt).toBe(NEXT_RUN_FAR_FUTURE);
    expect(expected.runCount).toBe(1);
  });
});

// ===========================================================================
// 12. T9A-07 (arc 3) — in-tx missing-schedule throws (rolls back aggregate).
//
// The participant's in-tx schedule re-read (`buildOccurrenceRecordParticipant`)
// — the comment USED TO say a missing `liveSchedule` should throw to roll
// back, but the code's `if (liveSchedule) { ... }` fell through on undefined
// → the participant marked the occurrence `published` with NO schedule
// context. A schedule delete between the pre-check + the tx → orphan
// published occurrence.
//
// The fix: `else { throw new ScheduleVanishedMidTx(...) }`. The throw rolls
// back the whole aggregate. The outer catch maps the sentinel to the
// resumable `schedule_vanished_mid_tx` outcome (the occurrence stays
// `publishing`; T9B recovers).
//
// This test proves the load-bearing claim via a wrapped participant that
// deletes the schedule on the tx client BEFORE the real participant re-reads
// it (the test hook the ticket suggests). The pre-check ran on the root
// client BEFORE the tx opened → the schedule was present at pre-check. The
// in-tx re-read finds the schedule missing → throws → aggregate rolls back.
// ===========================================================================

describe("publishScheduledOccurrence — T9A-07 in-tx schedule vanishing", () => {
  it("schedule deleted between pre-check and participant → participant throws → aggregate rolls back; occurrence stays publishing", () => {
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    // Mark the occurrence publishing manually so the participant's
    // `markOccurrencePublishedWithClient` would have the right source state
    // IF it reached that line (it should not — the throw precedes it).
    markOccurrencePublishingWithClient(getDb(), occurrenceId, {
      leaseOwner: "vanish-worker",
      leaseExpiresAt: LEASE_FUTURE,
    });
    const occurrence = readOccurrence(occurrenceId);
    expect(occurrence.state).toBe("publishing");

    // Prepare the aggregate + reserve attempts directly (bypassing
    // `publishScheduledOccurrence` so we can inject the wrapped participant
    // into the milestone-1 publisher — same shape as the atomicity test in
    // section 7).
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

    // The wrapped participant: deletes the schedule ON THE TX CLIENT (so
    // the delete is part of the tx state) BEFORE the real participant runs
    // its in-tx re-read. The real participant's `db.select(...).get()` then
    // returns undefined → throws ScheduleVanishedMidTx.
    //
    // This simulates a schedule delete between the pre-check (which ran on
    // the root client above — the schedule was present) + the participant's
    // in-tx re-check. The wrap is the test hook the ticket suggests.
    const realParticipant = buildOccurrenceRecordParticipant(
      occurrenceId,
      occurrence.scheduleRevision,
      null, // isolate the schedule-vanish path; coordination attempt tested elsewhere.
      "vanish-worker", // T9A-08 fencing — the worker that acquired the lease above.
    );
    const wrappedParticipant = (
      db: Parameters<typeof realParticipant>[0],
      ctx: TemplateAggregateParticipantContext,
    ) => {
      // Delete the schedule on the tx client — the in-tx re-read will miss.
      db.delete(scheduledTasks).where(eq(scheduledTasks.id, scheduleId)).run();
      // Now the real participant re-reads the schedule → undefined → throws.
      realParticipant(db, ctx);
    };

    const before = countRows();

    // **Failure mode (pre-fix)**: the participant's `if (liveSchedule) { ... }`
    // fell through on undefined → the participant marked the occurrence
    // `published` despite the schedule being gone → orphan published
    // occurrence with no schedule context. Post-fix: the participant throws
    // ScheduleVanishedMidTx → the milestone-1 tx rolls back.
    expect(() =>
      publishTemplateAggregateWithClient(getDb(), {
        attemptIds,
        prepared: prepared.aggregate,
        participants: wrappedParticipant,
      }),
    ).toThrow(/vanish/i);

    // The aggregate rolled back — occurrence STAYS `publishing` (the
    // `publishing → published` transition the participant would have made
    // did NOT commit). The lease is intact (rolled back to the
    // post-`markOccurrencePublishing` state).
    const afterOccurrence = readOccurrence(occurrenceId);
    expect(afterOccurrence.state).toBe("publishing");
    expect(afterOccurrence.createdMissionId).toBeNull();
    expect(afterOccurrence.leaseOwner).toBe("vanish-worker");

    // ZERO aggregate committed (Mission/Tasks/events/envelopes all unchanged).
    const after = countRows();
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
    expect(after.events).toBe(before.events);
    expect(after.envelopes).toBe(before.envelopes);

    // The schedule delete inside the wrapped participant's tx ROLLED BACK
    // too (the whole tx aborted) — the schedule row is still present.
    // (Otherwise a participant that deletes + throws would leave the
    // schedule missing for the retry.)
    const scheduleAfter = scheduledTaskRepo.getScheduledTaskById(scheduleId);
    expect(scheduleAfter).not.toBeNull();
  });
});
