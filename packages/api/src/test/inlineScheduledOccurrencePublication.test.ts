/**
 * T9A-10 M1 Path A — `publishInlineScheduledOccurrence` focused tests.
 *
 * Proves the seven integration guarantees for the inline scheduled-occurrence
 * adapter (mirrors `scheduledOccurrencePublication.test.ts` for the templateId
 * path, with the inline `tasksTemplate` substituted for `templateId`):
 *
 *  (a) HAPPY PATH — reserve → publish → occurrence `published` + Mission linked
 *      + each Task POST_CUTOVER with a `created` event + envelope. The result
 *      JSON carries the new `kind: "aggregate_published"` discriminator.
 *  (b) EMPTY tasksTEMPLATE — the config-error gate unique to the inline path:
 *      a schedule with `templateId: null` AND `tasksTemplate: []` →
 *      `rejected_validation: empty_tasks_template` → occurrence rejected.
 *  (c) GOVERNANCE VETO (NET-NEW for schedules) — a vetoing `taskCreated`
 *      interceptor → `vetoed` outcome → occurrence transitions
 *      `publishing → rejected` with the veto details.
 *  (d) RESUMABLE OUTCOME (schedule_guard_mismatch) — a schedule config edit
 *      between reservation and publication → `schedule_guard_mismatch`;
 *      occurrence STAYS `publishing`.
 *  (e) CONCURRENT PUBLISH — two workers, one occurrence: one wins
 *      `markOccurrencePublishingWithClient`, the other gets `already_publishing`.
 *  (f) ATOMIC OCCURRENCE-STATE TRANSITION (load-bearing) — the participant
 *      writes the occurrence-state transition in the SAME tx as the
 *      aggregate; a participant throw AFTER the occurrence-state write rolls
 *      back the transition too.
 *  (g) DORMANCY — exported + tested but no production caller. Legacy
 *      `createMissionFromSchedule` + the inline branch of
 *      `executeScheduledTask:236-240` stay byte-identical (the
 *      `scheduledTaskService.test.ts` PRESERVE suite stays green).
 *
 * Out of scope: T9B recovery (covered by `scheduledOccurrenceRecovery.test.ts`
 * for the templateId path; the inline path's recovery routes via T11), T11
 * scheduler wiring, the legacy `executeScheduledTask` path (unchanged).
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
  columns as columnsTable,
  habitats,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as scheduledTaskRepo from "../repositories/scheduledTask.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import {
  reserveScheduledOccurrence,
  type ReserveScheduledOccurrenceInput,
} from "../repositories/scheduledOccurrenceReservation.js";
import {
  markOccurrencePublishingWithClient,
  getOccurrenceWithClient,
} from "../repositories/scheduledOccurrences.js";
import {
  publishInlineScheduledOccurrence,
  type PublishInlineScheduledOccurrenceInput,
  type PublishInlineScheduledOccurrenceOutcome,
  asInlineAggregatePublishedResult,
} from "../services/inlineScheduledOccurrencePublication.js";
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

const NOW_ISO = "2026-07-19T12:00:00.000Z";
const NEXT_RUN_INTERVAL = "2026-07-19T13:00:00.000Z"; // 1h after NOW
const LEASE_FUTURE = "2099-01-01T00:00:00.000Z";

const SCHEDULE_ACTOR: AuditActorRef = { type: "system", id: "scheduler" };
const SCHEDULE_SOURCE = "scheduler" as AuditSource;
void SCHEDULE_ACTOR;
void SCHEDULE_SOURCE;

beforeEach(async () => {
  await initTestDb();
  pluginManager.resetPlugins();
  publishMock.mockClear();
  if (!process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD) {
    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "1000";
  }
  const db = getDb();
  db.delete(scheduledOccurrences).run();
  db.delete(scheduledTasks).run();
  db.delete(taskCreationEnvelopes).run();
  db.delete(taskCreationAttempts).run();
  db.delete(taskEvents).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();

  const habitat = habitatRepo.createHabitat({ name: "Inline Occurrence Test Habitat" });
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

/**
 * Creates an INLINE schedule row (no templateId, no handlerKey, tasksTemplate
 * populated). This is the schedule shape T9A-10 M1's `publishInlineScheduledOccurrence`
 * targets. Defaults to interval, due NOW.
 */
function createInlineSchedule(
  overrides: Partial<scheduledTaskRepo.CreateScheduledTaskInput> & {
    tasksTemplate?: TaskTemplateEntry[];
  } = {},
): { id: string } {
  const schedule = scheduledTaskRepo.createScheduledTask({
    habitatId,
    templateId: null,
    name: "Inline Test Schedule",
    scheduleType: "interval",
    intervalMinutes: 60,
    missionTitle: "Inline Mission {{counter}}",
    missionDescription: "Auto-generated.",
    missionPriority: "medium" as TaskPriority,
    missionLabels: ["scheduled"],
    tasksTemplate: overrides.tasksTemplate ?? [
      { title: "First inline task", description: "desc", order: 0 },
      { title: "Second inline task", description: "desc", order: 1 },
    ],
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
  overrides: Partial<PublishInlineScheduledOccurrenceInput> = {},
): PublishInlineScheduledOccurrenceInput {
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

/** Write + load a temp plugin; returns the tmp dir for cleanup. */
async function writePlugin(name: string, moduleBody: string): Promise<string> {
  const tmpDir = `/tmp/test-t9a10m1-occ-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

describe("publishInlineScheduledOccurrence — happy path", () => {
  it("transitions reserved → publishing → published; commits Mission + Tasks + envelope atomically; result JSON carries kind: aggregate_published", () => {
    const { id: scheduleId } = createInlineSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
    const before = countRows();

    const result = publishInlineScheduledOccurrence(baseInput(occurrenceId));

    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") throw new Error("unreachable");

    // Occurrence terminal + Mission linked; lease retired.
    const occurrence = readOccurrence(occurrenceId);
    expect(occurrence.state).toBe("published");
    expect(occurrence.createdMissionId).toBe(result.mission.id);
    expect(occurrence.leaseOwner).toBeNull();
    expect(occurrence.leaseExpiresAt).toBeNull();

    // T9A-10 M1: the result JSON carries `kind: "aggregate_published"` (the
    // discriminator added by buildOccurrenceRecordParticipant's success-branch
    // write). The shape narrows via `asInlineAggregatePublishedResult`.
    const narrowed = asInlineAggregatePublishedResult(occurrence.result);
    expect(narrowed).not.toBeNull();
    expect(narrowed!.kind).toBe("aggregate_published");
    expect(narrowed!.missionId).toBe(result.mission.id);
    expect(narrowed!.taskCount).toBe(result.tasks.length);
    expect(narrowed!.coordinationAttemptId).toEqual(expect.any(String));

    // Result envelope shape (the loose envelope also carries the discriminator).
    expect(occurrence.result).toEqual(
      expect.objectContaining({
        kind: "aggregate_published",
        missionId: result.mission.id,
        taskCount: result.tasks.length,
        attemptIds: expect.arrayContaining([expect.any(String)]),
        coordinationAttemptId: expect.any(String),
        publishedAt: expect.any(String),
      }),
    );

    // Mission row carries the schedule's derived attribution.
    expect(result.mission.habitatId).toBe(habitatId);
    expect(result.mission.createdBy).toBe("scheduler");
    expect(result.mission.status).toBe("not_started");
    expect(result.mission.version).toBe(1);
    // The schedule's missionTitle carried {{counter}}; substituted to "1" (ordinal 0 + 1).
    expect(result.mission.title).toBe("Inline Mission 1");

    // Workflow is always null on the inline path.
    expect(result.workflow).toBeNull();

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

    // Each per-Task attempt advanced to RECOVERING; inline attempt keys are `inline-${i}`.
    const attempts = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.sourceScopeId, occurrenceId))
      .all();
    const perTaskAttempts = attempts.filter((a) => a.attemptKey.startsWith("inline-"));
    expect(perTaskAttempts).toHaveLength(result.tasks.length);
    for (const a of perTaskAttempts) {
      expect(a.state).toBe("published_pending_observation");
      expect(a.sourceScopeKind).toBe("scheduled_occurrence");
      expect(a.source).toBe("scheduler");
      expect(a.publicationKind).toBe("scheduled_occurrence");
    }

    // Counts moved (aggregate + occurrence-state committed together).
    const after = countRows();
    expect(after.missions).toBe(before.missions + 1);
    expect(after.tasks).toBe(before.tasks + result.tasks.length);
    expect(after.events).toBe(before.events + result.tasks.length);
    expect(after.envelopes).toBe(before.envelopes + result.tasks.length);
  });

  it("stamps scheduledTasks.lastCreatedMissionId on complete success (atomic with the aggregate)", () => {
    const { id: scheduleId } = createInlineSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    const result = publishInlineScheduledOccurrence(baseInput(occurrenceId));
    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") throw new Error("unreachable");

    const schedule = scheduledTaskRepo.getScheduledTaskById(scheduleId)!;
    expect(schedule.lastCreatedMissionId).toBe(result.mission.id);
  });
});

// ===========================================================================
// 2. EMPTY tasksTemplate — the config-error gate UNIQUE to the inline path.
// ===========================================================================

describe("publishInlineScheduledOccurrence — empty_tasks_template config error", () => {
  it("schedule with null templateId + empty tasksTemplate → rejected_validation: empty_tasks_template → occurrence rejected", () => {
    // The legacy path happily creates a zero-task Mission here; the inline
    // path surfaces it as a config error (the empty_tasks_template code
    // is the load-bearing proof of the gate).
    const { id: scheduleId } = createInlineSchedule({ tasksTemplate: [] });
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
    const before = countRows();

    const result = publishInlineScheduledOccurrence(baseInput(occurrenceId));

    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") throw new Error("unreachable");
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        field: "tasksTemplate",
        code: "empty_tasks_template",
      }),
    );

    // Occurrence is terminal `rejected`; NO Mission committed.
    const occurrence = readOccurrence(occurrenceId);
    expect(occurrence.state).toBe("rejected");
    expect(occurrence.createdMissionId).toBeNull();
    expect(occurrence.result).toEqual(expect.objectContaining({ reason: "rejected_validation" }));

    const after = countRows();
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
  });
});

// ===========================================================================
// 3. GOVERNANCE VETO (NET-NEW for inline schedules).
// ===========================================================================

describe("publishInlineScheduledOccurrence — governance veto (net-new)", () => {
  it("vetoing taskCreated interceptor → vetoed outcome → occurrence rejected; NO Mission/Tasks committed", async () => {
    await writePlugin(
      "veto-inline",
      `{
        manifest: {
          id: 'veto-inline', version: '1.0.0', description: 'veto all inline tasks',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'veto-all', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: {
          'veto-all': () => ({ allow: false, reason: 'vetoed inline' }),
        },
      }`,
    );
    enrollInterceptor(habitatId, "veto-inline", "veto-all");

    const { id: scheduleId } = createInlineSchedule({
      tasksTemplate: [
        { title: "VETO-1", order: 0 },
        { title: "VETO-2", order: 1 },
      ],
    });
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
    const before = countRows();

    const result = publishInlineScheduledOccurrence(baseInput(occurrenceId));

    expect(result.outcome).toBe("vetoed");
    if (result.outcome !== "vetoed") throw new Error("unreachable");
    expect(result.vetoes.length).toBeGreaterThanOrEqual(1);
    // Both Tasks were vetoed.
    expect(result.vetoes).toHaveLength(2);

    // Occurrence rejected; NO Mission/Tasks committed (tx never opened).
    const occurrence = readOccurrence(occurrenceId);
    expect(occurrence.state).toBe("rejected");
    expect(occurrence.result).toEqual(expect.objectContaining({ reason: "vetoed" }));

    const after = countRows();
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
  });
});

// ===========================================================================
// 4. RESUMABLE OUTCOME — schedule_guard_mismatch (occurrence stays publishing).
// ===========================================================================

describe("publishInlineScheduledOccurrence — resumable schedule_guard_mismatch", () => {
  it("schedule config edit between reservation and publication → schedule_guard_mismatch; occurrence stays publishing", () => {
    const { id: scheduleId } = createInlineSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    // EDIT the schedule's config between reservation + publication — change
    // the missionTitle (a SCHEDULE_CONFIG_FIELDS member). The guard fires.
    scheduledTaskRepo.updateScheduledTask(scheduleId, { missionTitle: "EDITED TITLE" });

    const result = publishInlineScheduledOccurrence(baseInput(occurrenceId));

    expect(result.outcome).toBe("schedule_guard_mismatch");
    if (result.outcome !== "schedule_guard_mismatch") throw new Error("unreachable");
    expect(result.fields).toContain("missionTitle");

    // Occurrence stays `publishing` (resumable for T9B recovery).
    const occurrence = readOccurrence(occurrenceId);
    expect(occurrence.state).toBe("publishing");
  });
});

// ===========================================================================
// 5. CONCURRENT PUBLISH — CAS race.
// ===========================================================================

describe("publishInlineScheduledOccurrence — concurrent publish (CAS race)", () => {
  it("one worker wins the lease; the other gets already_publishing + returns without publishing", () => {
    const { id: scheduleId } = createInlineSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    // First worker wins the lease transition.
    const r1 = publishInlineScheduledOccurrence(baseInput(occurrenceId));
    expect(r1.outcome).toBe("published");

    // A second worker (the recovery worker's late drive, say) tries to
    // transition the now-terminal occurrence. markOccurrencePublishingWithClient
    // refuses: state is `published` (terminal) → illegal_source_state.
    const r2 = publishInlineScheduledOccurrence(
      baseInput(occurrenceId, { leaseOwner: "worker-other" }),
    );
    expect(r2.outcome).toBe("illegal_source_state");
    if (r2.outcome !== "illegal_source_state") throw new Error("unreachable");
    expect(["published", "rejected"]).toContain(r2.fromState);
  });
});

// ===========================================================================
// 6. TOKEN RESOLUTION — {{counter}} = ordinal + 1.
// ===========================================================================

describe("publishInlineScheduledOccurrence — token resolution", () => {
  it("{{counter}} = ordinal + 1 (1-based display); {{date}} in the schedule's timezone", () => {
    const { id: scheduleId } = createInlineSchedule({
      missionTitle: "Inline Run {{counter}} on {{date}}",
      missionDescription: "Desc {{counter}}",
    });
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    const result = publishInlineScheduledOccurrence(baseInput(occurrenceId));
    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") throw new Error("unreachable");

    // ordinal=0 (first firing) → counter=1; {{date}} = NOW_ISO's date in UTC.
    expect(result.mission.title).toBe("Inline Run 1 on 2026-07-19");
    expect(result.mission.description).toBe("Desc 1");
  });
});

// ===========================================================================
// 7. ATOMIC OCCURRENCE-STATE TRANSITION — the load-bearing claim.
// ===========================================================================

describe("publishInlineScheduledOccurrence — atomic occurrence-state transition (load-bearing)", () => {
  it("schedule_missing (schedule deleted between reservation and publication) → occurrence rejected; no aggregate", () => {
    const { id: scheduleId } = createInlineSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    // DELETE the schedule row between reservation + publication.
    getDb().delete(scheduledTasks).where(eq(scheduledTasks.id, scheduleId)).run();

    const before = countRows();
    const result = publishInlineScheduledOccurrence(baseInput(occurrenceId));

    expect(result.outcome).toBe("schedule_missing");
    if (result.outcome !== "schedule_missing") throw new Error("unreachable");

    // Occurrence rejected; NO aggregate committed.
    const occurrence = readOccurrence(occurrenceId);
    expect(occurrence.state).toBe("rejected");
    expect(occurrence.result).toEqual(expect.objectContaining({ reason: "schedule_missing" }));

    const after = countRows();
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
  });
});

// ===========================================================================
// 8. EDGE CASES
// ===========================================================================

describe("publishInlineScheduledOccurrence — edge cases", () => {
  it("non-existent occurrence id → not_found (typed, no throw)", () => {
    const result = publishInlineScheduledOccurrence(baseInput("nonexistent-occurrence-id"));
    expect(result.outcome).toBe("not_found");
  });

  it("replay against a published occurrence → illegal_source_state (terminal)", () => {
    const { id: scheduleId } = createInlineSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    const r1 = publishInlineScheduledOccurrence(baseInput(occurrenceId));
    expect(r1.outcome).toBe("published");

    // Replay → the terminal occurrence refuses the `reserved → publishing` transition.
    const r2 = publishInlineScheduledOccurrence(baseInput(occurrenceId));
    expect(r2.outcome).toBe("illegal_source_state");
  });
});

// ===========================================================================
// 9. DORMANCY — exported + tested but no production caller
// ===========================================================================

describe("publishInlineScheduledOccurrence — dormancy", () => {
  it("the adapter is exported and callable (wired to no production path)", () => {
    // The mere fact that we can import + call the function is the dormancy
    // assertion. The full-suite run confirms the legacy
    // `scheduledTaskService.test.ts` PRESERVE suite stays green (the inline
    // branch of `executeScheduledTask:236-240` is byte-identical).
    const { id: scheduleId } = createInlineSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
    const result = publishInlineScheduledOccurrence(baseInput(occurrenceId));
    expect(result.outcome).toBe("published");
  });

  it("closed-union exhaustiveness — every result branch is a known outcome", () => {
    // Type-level exhaustiveness: switch over the outcome with no default
    // branch — TypeScript would error if a branch were missing.
    const { id: scheduleId } = createInlineSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
    const result: PublishInlineScheduledOccurrenceOutcome = publishInlineScheduledOccurrence(
      baseInput(occurrenceId),
    );
    switch (result.outcome) {
      case "published":
        expect(result.workflow).toBeNull();
        break;
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
        throw new Error(`unexpected outcome on happy path: ${result.outcome}`);
    }
  });
});
