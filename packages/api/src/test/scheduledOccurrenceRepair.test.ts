/**
 * T9B Phase 3 — `repairScheduledOccurrence` focused tests.
 *
 * Proves the Phase-3 Repair-and-Retry guarantees (the authorized retry of a
 * TERMINAL `rejected` occurrence — option (b) of the load-bearing design
 * question; the occurrence ROW stays `rejected`):
 *
 *  (a) HAPPY PATH (REPAIRED) — a `rejected` occurrence → retry with a
 *      corrected schedule → the retry publishes a new Mission + stamps a
 *      `retryHistory` entry. The occurrence STAYS `rejected` (the terminal
 *      one-way door holds — option (b)). Prior failure history retained.
 *  (b) RETRY FAILS AGAIN — the retry's latest governance also vetoes →
 *      `retry_failed_vetoed`; retryHistory stamped with the failure; no
 *      Mission. The operator can retry again (retryNumber increments).
 *  (c) LATEST-SCHEDULE USAGE — the retry uses the CURRENT schedule (NOT
 *      the reservation-time snapshot); a schedule EDIT between the
 *      original failure + the retry is reflected in the retry's Mission.
 *  (d) TOKEN CONSISTENCY — the retry's `{{date}}`/`{{counter}}` use the
 *      occurrence's preserved `scheduledFor`/`ordinal` (T9A-06 — a retry
 *      days after the original firing renders the SAME date).
 *  (e) SCHEDULE MISSING — the schedule was deleted between the original
 *      failure + the retry → `retry_failed_schedule_missing`; retryHistory
 *      stamped.
 *  (f) ILLEGAL SOURCE STATE — a non-`rejected` occurrence refuses the
 *      retry (`reserved` / `publishing` / `published`).
 *  (g) NOT FOUND — no occurrence row → typed not-found.
 *  (h) DORMANCY — exported + tested but no production caller.
 *
 * Out of scope: T11 (the scheduler wiring + the operator UI), the route
 * layer (covered separately in `scheduledOccurrenceRepairRoute.test.ts`),
 * the legacy `executeScheduledTask` path (unchanged). The retry function
 * is DORMANT — no production origin routes through it yet. The PRESERVE
 * suites stay byte-unchanged.
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
import {
  reserveScheduledOccurrence,
  type ReserveScheduledOccurrenceInput,
} from "../repositories/scheduledOccurrenceReservation.js";
import {
  markOccurrenceRejectedWithClient,
  getOccurrenceWithClient,
} from "../repositories/scheduledOccurrences.js";
import {
  publishScheduledOccurrence,
  type PublishScheduledOccurrenceInput,
} from "../services/scheduledOccurrencePublication.js";
import {
  repairScheduledOccurrence,
  type RepairScheduledOccurrenceInput,
  type RepairScheduledOccurrenceOutcome,
} from "../services/scheduledOccurrenceRepair.js";
import { TASK_CREATION_INTEGRITY_VERSION } from "../db/schema/taskPublication.js";
import type { TaskPriority, TaskTemplateEntry } from "@orcy/shared";

// --- Mocks: the retry emits NO pre-commit effects (SSE/hooks). ---
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

  const habitat = habitatRepo.createHabitat({ name: "Repair Test Habitat" });
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
const NEXT_RUN_INTERVAL = "2026-07-19T13:00:00.000Z";
const LEASE_FUTURE = "2099-01-01T00:00:00.000Z";

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
    name: "Repair Test Template",
    titlePattern: overrides.titlePattern ?? "Scheduled Mission {{counter}}",
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
    missionTitle: "Scheduled Mission {{counter}}",
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
function publishInput(
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

/** Canonical retry input; callers override individual fields. */
function retryInput(
  occurrenceId: string,
  overrides: Partial<RepairScheduledOccurrenceInput> = {},
): RepairScheduledOccurrenceInput {
  return {
    occurrenceId,
    actorId: "admin-operator",
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

/**
 * Produces a REJECTED occurrence (the retry's input) by reserving +
 * rejecting directly. Faster than the full publish-then-veto path; used
 * by tests that don't need the original failure's `result` shape.
 */
function makeRejectedOccurrence(scheduleId: string): { id: string } {
  const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
  const db = getDb();
  const result = markOccurrenceRejectedWithClient(db, occurrenceId, {
    leaseOwner: null, // reserved → rejected (no lease to fence).
    result: { reason: "test_setup", message: "synthetic rejection for retry test" },
  });
  if (result.outcome !== "transitioned") {
    throw new Error(`makeRejectedOccurrence failed: ${result.outcome}`);
  }
  return { id: occurrenceId };
}

/**
 * Produces a REJECTED occurrence via the FULL publish-then-veto path —
 * the retry's realistic input. The occurrence carries the original
 * failure's `result.vetoes` shape (a realistic prior-failure audit
 * trail). Used by tests that exercise the retryHistory-stamp mechanism
 * on top of a realistic original failure.
 */
function makeVetoedOccurrence(scheduleId: string): { id: string } {
  const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
  const result = publishScheduledOccurrence(publishInput(occurrenceId));
  if (result.outcome !== "vetoed") {
    throw new Error(`makeVetoedOccurrence expected vetoed, got ${result.outcome}`);
  }
  return { id: occurrenceId };
}

/** Writes + loads a temp plugin; returns the tmp dir for cleanup. */
async function writePlugin(name: string, moduleBody: string): Promise<string> {
  const tmpDir = `/tmp/test-t9b3-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
// 1. HAPPY PATH — repaired (Mission created + retryHistory stamped).
// ===========================================================================

describe("repairScheduledOccurrence — happy path (repaired)", () => {
  it("a rejected occurrence → retry → repaired: new Mission committed + retryHistory stamped; occurrence STAYS rejected (option b — terminal one-way door holds)", () => {
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = makeRejectedOccurrence(scheduleId);
    const before = countRows();

    const result = repairScheduledOccurrence(retryInput(occurrenceId));

    // **Failure mode (option a — state-machine edge)**: if the retry
    // transitioned the occurrence `rejected → reserved` (or any state
    // change), the occurrence ROW would no longer be `rejected`. Option
    // (b) keeps the occurrence terminal; the retry's Mission is linked
    // via the retryHistory stamp + the attempts.
    expect(result.outcome).toBe("repaired");
    if (result.outcome !== "repaired") throw new Error("unreachable");

    // retryNumber is 1 (the first retry — prior retryHistory was empty).
    expect(result.retryNumber).toBe(1);

    // The occurrence STAYS `rejected` (the terminal one-way door holds).
    // The retryHistory stamp is ADDITIVE on the `result` JSON.
    const occurrence = readOccurrence(occurrenceId);
    expect(occurrence.state).toBe("rejected");
    expect(occurrence.createdMissionId).toBeNull(); // NOT linked on the ROW.
    // The original failure's `result.reason` is RETAINED.
    expect((occurrence.result as Record<string, unknown>).reason).toBe("test_setup");
    // The retryHistory array carries the new `repaired` entry.
    const retryHistory = (occurrence.result as { retryHistory?: Array<Record<string, unknown>> })
      .retryHistory;
    expect(retryHistory).toHaveLength(1);
    expect(retryHistory![0]).toMatchObject({
      retryNumber: 1,
      outcome: "repaired",
      actorId: "admin-operator",
      missionId: result.mission.id,
    });
    expect(typeof retryHistory![0].attemptedAt).toBe("string");

    // The retry's Mission is a REAL Mission — committed to the database.
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

    // Aggregate counts moved (the retry's Mission + Tasks + envelopes
    // committed alongside the retryHistory stamp in ONE tx).
    const after = countRows();
    expect(after.missions).toBe(before.missions + 1);
    expect(after.tasks).toBe(before.tasks + result.tasks.length);
    expect(after.events).toBe(before.events + result.tasks.length);
    expect(after.envelopes).toBe(before.envelopes + result.tasks.length);

    // The retry's per-Task attempts use retry-scoped keys (distinct from
    // any prior publication's attempts; the retryNumber discriminator
    // guarantees retry-to-retry uniqueness too).
    const retryAttempts = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.sourceScopeId, occurrenceId))
      .all()
      .filter((a) => a.attemptKey.startsWith("occurrence-retry-1-"));
    expect(retryAttempts).toHaveLength(result.tasks.length);
    for (const a of retryAttempts) {
      expect(a.state).toBe("published_pending_observation");
      expect(a.sourceScopeKind).toBe("scheduled_occurrence");
      expect(a.source).toBe("scheduler");
      expect(a.publicationKind).toBe("scheduled_occurrence");
    }
  });

  it("retryNumber increments across successive retries (prior retryHistory length + 1)", () => {
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = makeRejectedOccurrence(scheduleId);

    // First retry — repaired at retryNumber 1.
    const r1 = repairScheduledOccurrence(retryInput(occurrenceId));
    expect(r1.outcome).toBe("repaired");
    if (r1.outcome !== "repaired") throw new Error("unreachable");
    expect(r1.retryNumber).toBe(1);

    // Second retry — repaired at retryNumber 2 (prior retryHistory had 1 entry).
    const r2 = repairScheduledOccurrence(retryInput(occurrenceId));
    expect(r2.outcome).toBe("repaired");
    if (r2.outcome !== "repaired") throw new Error("unreachable");
    expect(r2.retryNumber).toBe(2);

    // The retryHistory carries BOTH entries.
    const occurrence = readOccurrence(occurrenceId);
    const retryHistory = (occurrence.result as { retryHistory?: Array<Record<string, unknown>> })
      .retryHistory;
    expect(retryHistory).toHaveLength(2);
    expect(retryHistory![0].retryNumber).toBe(1);
    expect(retryHistory![1].retryNumber).toBe(2);
    // Each entry links to its own Mission (the two retries produced two
    // distinct Missions — the operator retried after the first).
    expect(retryHistory![0].missionId).toBe(r1.mission.id);
    expect(retryHistory![1].missionId).toBe(r2.mission.id);
    expect(retryHistory![0].missionId).not.toBe(retryHistory![1].missionId);
  });
});

// ===========================================================================
// 2. RETRY FAILS AGAIN — retry_failed_vetoed (retryHistory stamped with
//    the failure; no Mission).
// ===========================================================================

describe("repairScheduledOccurrence — retry_failed_vetoed", () => {
  it("the retry's latest governance also vetoes → retry_failed_vetoed; retryHistory stamped; no Mission; operator can retry again", async () => {
    // Enroll a vetoing interceptor. The retry will govern under this
    // policy + surface the veto as a retry failure (no Mission).
    await writePlugin(
      "veto-retry",
      `{
        manifest: {
          id: 'veto-retry', version: '1.0.0', description: 'veto every retry',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'veto-all-retry', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: {
          'veto-all-retry': () => ({ allow: false, reason: 'vetoed by retry test interceptor' }),
        },
      }`,
    );
    enrollInterceptor(habitatId, "veto-retry", "veto-all-retry");

    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = makeRejectedOccurrence(scheduleId);
    const before = countRows();

    const result = repairScheduledOccurrence(retryInput(occurrenceId));

    // Typed retry_failed_vetoed — NOT a throw, NOT a swallowed null.
    expect(result.outcome).toBe("retry_failed_vetoed");
    if (result.outcome !== "retry_failed_vetoed") throw new Error("unreachable");
    expect(result.retryNumber).toBe(1);
    expect(result.vetoes.length).toBeGreaterThanOrEqual(1);
    for (const v of result.vetoes) {
      expect(v.veto.reason).toBe("vetoed by retry test interceptor");
    }

    // Occurrence STAYS `rejected`; the retryHistory carries the failure.
    const occurrence = readOccurrence(occurrenceId);
    expect(occurrence.state).toBe("rejected");
    const retryHistory = (occurrence.result as { retryHistory?: Array<Record<string, unknown>> })
      .retryHistory;
    expect(retryHistory).toHaveLength(1);
    expect(retryHistory![0]).toMatchObject({
      retryNumber: 1,
      outcome: "retry_failed_vetoed",
      actorId: "admin-operator",
    });
    expect(retryHistory![0].vetoes).toBeDefined();

    // ZERO partial aggregate: no Mission, no Tasks committed.
    const after = countRows();
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
  });

  it("after a failed retry, the operator can retry again (retryNumber increments on each call)", async () => {
    // First: a vetoed retry.
    await writePlugin(
      "veto-retry-2",
      `{
        manifest: {
          id: 'veto-retry-2', version: '1.0.0', description: 'veto every retry',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'veto-all-retry-2', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: {
          'veto-all-retry-2': () => ({ allow: false, reason: 'vetoed' }),
        },
      }`,
    );
    enrollInterceptor(habitatId, "veto-retry-2", "veto-all-retry-2");

    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = makeRejectedOccurrence(scheduleId);

    const r1 = repairScheduledOccurrence(retryInput(occurrenceId));
    expect(r1.outcome).toBe("retry_failed_vetoed");
    if (r1.outcome !== "retry_failed_vetoed") throw new Error("unreachable");
    expect(r1.retryNumber).toBe(1);

    // Disable the interceptor (the operator corrected the policy).
    pluginManager.resetPlugins();

    // Second retry — succeeds (the policy now allows it).
    const r2 = repairScheduledOccurrence(retryInput(occurrenceId));
    expect(r2.outcome).toBe("repaired");
    if (r2.outcome !== "repaired") throw new Error("unreachable");
    expect(r2.retryNumber).toBe(2);

    // The retryHistory carries BOTH entries (the prior failure + the new success).
    const occurrence = readOccurrence(occurrenceId);
    const retryHistory = (occurrence.result as { retryHistory?: Array<Record<string, unknown>> })
      .retryHistory;
    expect(retryHistory).toHaveLength(2);
    expect(retryHistory![0].outcome).toBe("retry_failed_vetoed");
    expect(retryHistory![1].outcome).toBe("repaired");
  });
});

// ===========================================================================
// 3. LATEST-SCHEDULE USAGE — the retry uses the CURRENT schedule, NOT the
//    reservation-time snapshot. A schedule EDIT between the original
//    failure + the retry is reflected in the retry's Mission.
// ===========================================================================

describe("repairScheduledOccurrence — latest-schedule usage", () => {
  it("a schedule EDIT between the original failure + the retry is reflected in the retry's Mission (the retry uses the CURRENT schedule)", () => {
    // Reserve + reject under the ORIGINAL title.
    const { id: scheduleId } = createSchedule({
      missionTitle: "ORIGINAL Title {{counter}}",
    });
    const { id: occurrenceId } = makeRejectedOccurrence(scheduleId);

    // The operator EDITED the schedule's missionTitle AFTER the original
    // failure (the corrected title is the whole point of repair).
    const EDITED_TITLE = "CORRECTED Title {{counter}}";
    scheduledTaskRepo.updateScheduledTask(scheduleId, {
      missionTitle: EDITED_TITLE,
    });

    const result = repairScheduledOccurrence(retryInput(occurrenceId));

    // **Failure mode**: if the retry used the reservation-time snapshot
    // (the original title), the Mission would carry "ORIGINAL Title 1".
    // The retry MUST use the LATEST schedule — the corrected title is
    // reflected in the committed Mission.
    expect(result.outcome).toBe("repaired");
    if (result.outcome !== "repaired") throw new Error("unreachable");
    expect(result.mission.title).toBe("CORRECTED Title 1"); // token-substituted.
  });

  it("a schedule EDIT switching the templateId is reflected (the retry uses the LATEST template)", () => {
    // Reserve + reject under TEMPLATE_A.
    const { id: templateA } = createMissionTemplate({
      tasksTemplate: [{ title: "Template A task", order: 0 }],
    });
    const { id: scheduleId } = createSchedule({ templateId: templateA });
    const { id: occurrenceId } = makeRejectedOccurrence(scheduleId);

    // The operator switched the schedule to TEMPLATE_B (with a different
    // task definition).
    const { id: templateB } = createMissionTemplate({
      tasksTemplate: [{ title: "Template B task", order: 0 }],
    });
    scheduledTaskRepo.updateScheduledTask(scheduleId, { templateId: templateB });

    const result = repairScheduledOccurrence(retryInput(occurrenceId));

    expect(result.outcome).toBe("repaired");
    if (result.outcome !== "repaired") throw new Error("unreachable");
    // The retry published TEMPLATE_B's task (NOT templateA's).
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].task.title).toBe("Template B task");
  });
});

// ===========================================================================
// 4. TOKEN CONSISTENCY — {{date}}/{{counter}} use the occurrence's preserved
//    scheduledFor/ordinal (NOT wall-clock). A retry days after the original
//    firing renders the SAME date/counter.
// ===========================================================================

describe("repairScheduledOccurrence — token consistency (T9A-06)", () => {
  it("{{counter}} = ordinal + 1 (the occurrence's preserved ordinal, NOT a fresh schedule.runCount)", () => {
    // The schedule's title carries the {{counter}} token. The occurrence
    // was reserved with ordinal 0 (the first firing); the retry MUST
    // resolve {{counter}} to 1 (ordinal + 1), NOT to the schedule's
    // current runCount (which may have advanced past 1 if a subsequent
    // firing occurred between the original failure + the retry).
    const { id: scheduleId } = createSchedule({
      missionTitle: "Counter is {{counter}}",
    });
    const { id: occurrenceId } = makeRejectedOccurrence(scheduleId);

    // Simulate the schedule's runCount advancing (a subsequent firing
    // of the same schedule — the recurring-independence guarantee).
    // `runCount` is advanced internally by the reservation tx; the test
    // reaches into the row directly via drizzle to simulate a subsequent
    // firing without driving a second reservation.
    getDb()
      .update(scheduledTasks)
      .set({ runCount: 5 })
      .where(eq(scheduledTasks.id, scheduleId))
      .run();

    const result = repairScheduledOccurrence(retryInput(occurrenceId));

    expect(result.outcome).toBe("repaired");
    if (result.outcome !== "repaired") throw new Error("unreachable");
    // {{counter}} resolves to 1 (ordinal 0 + 1) — the occurrence's
    // preserved ordinal, NOT the schedule's current runCount (5).
    expect(result.mission.title).toBe("Counter is 1");
  });

  it("{{date}} uses the occurrence's preserved scheduledFor (NOT wall-clock — a retry on a different day renders the SAME date)", () => {
    // The occurrence's `scheduledFor` is NOW_ISO (2026-07-19T12:00:00Z).
    // The retry runs at the test's wall-clock time (which may differ).
    // {{date}} MUST resolve to 2026-07-19 (the occurrence's preserved
    // scheduledFor in the schedule's timezone — UTC).
    const { id: scheduleId } = createSchedule({
      missionTitle: "Date is {{date}}",
      timezone: "UTC",
    });
    const { id: occurrenceId } = makeRejectedOccurrence(scheduleId);

    const result = repairScheduledOccurrence(retryInput(occurrenceId));

    expect(result.outcome).toBe("repaired");
    if (result.outcome !== "repaired") throw new Error("unreachable");
    // {{date}} resolves to 2026-07-19 (the occurrence's preserved
    // scheduledFor, NOT the wall-clock at retry time).
    expect(result.mission.title).toBe("Date is 2026-07-19");
  });
});

// ===========================================================================
// 5. SCHEDULE MISSING — the schedule was deleted → retry_failed_schedule_missing.
// ===========================================================================

describe("repairScheduledOccurrence — retry_failed_schedule_missing", () => {
  it("schedule deleted between the original failure + the retry → retry_failed_schedule_missing; retryHistory stamped", () => {
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = makeRejectedOccurrence(scheduleId);

    // Delete the schedule (the operator removed it after the original failure).
    scheduledTaskRepo.deleteScheduledTask(scheduleId);

    const before = countRows();
    const result = repairScheduledOccurrence(retryInput(occurrenceId));

    expect(result.outcome).toBe("retry_failed_schedule_missing");
    if (result.outcome !== "retry_failed_schedule_missing") throw new Error("unreachable");
    expect(result.retryNumber).toBe(1);

    // Occurrence STAYS `rejected`; the retryHistory carries the failure.
    const occurrence = readOccurrence(occurrenceId);
    expect(occurrence.state).toBe("rejected");
    const retryHistory = (occurrence.result as { retryHistory?: Array<Record<string, unknown>> })
      .retryHistory;
    expect(retryHistory).toHaveLength(1);
    expect(retryHistory![0]).toMatchObject({
      retryNumber: 1,
      outcome: "retry_failed_schedule_missing",
      actorId: "admin-operator",
    });

    // No Mission committed.
    const after = countRows();
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
  });
});

// ===========================================================================
// 6. ILLEGAL SOURCE STATE — a non-`rejected` occurrence refuses the retry.
// ===========================================================================

describe("repairScheduledOccurrence — illegal_source_state", () => {
  it("a `reserved` occurrence (not yet published) refuses the retry", () => {
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    const result = repairScheduledOccurrence(retryInput(occurrenceId));

    expect(result.outcome).toBe("illegal_source_state");
    if (result.outcome !== "illegal_source_state") throw new Error("unreachable");
    expect(result.fromState).toBe("reserved");
  });

  it("a `published` occurrence (already succeeded) refuses the retry", () => {
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);

    // Publish successfully (occurrence → `published`).
    const pub = publishScheduledOccurrence(publishInput(occurrenceId));
    expect(pub.outcome).toBe("published");

    const result = repairScheduledOccurrence(retryInput(occurrenceId));

    expect(result.outcome).toBe("illegal_source_state");
    if (result.outcome !== "illegal_source_state") throw new Error("unreachable");
    expect(result.fromState).toBe("published");
  });

  it("NO retryHistory entry is stamped on illegal_source_state (the retry did not attempt publication)", () => {
    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = reserveOccurrenceForSchedule(scheduleId);
    const beforeResult = readOccurrence(occurrenceId).result;

    repairScheduledOccurrence(retryInput(occurrenceId));

    // The occurrence's `result` is UNCHANGED (no retryHistory entry).
    expect(readOccurrence(occurrenceId).result).toEqual(beforeResult);
  });
});

// ===========================================================================
// 7. NOT FOUND — no occurrence row.
// ===========================================================================

describe("repairScheduledOccurrence — not_found", () => {
  it("no occurrence row for the id → typed not-found", () => {
    const result = repairScheduledOccurrence(retryInput("nonexistent-occurrence-id"));
    expect(result.outcome).toBe("not_found");
  });
});

// ===========================================================================
// 8. DORMANCY — exported + tested but no production caller.
// ===========================================================================

describe("repairScheduledOccurrence — dormancy", () => {
  it("the function is exported + named", () => {
    expect(repairScheduledOccurrence).toBeInstanceOf(Function);
    expect(repairScheduledOccurrence.name).toBe("repairScheduledOccurrence");
  });

  it("the outcome type is a closed discriminated union (every branch typed)", () => {
    // A compile-time guarantee: the outcome's `outcome` field narrows
    // each branch. The runtime assertion is a smoke test that the
    // union's discriminant is one of the documented values.
    const sample: RepairScheduledOccurrenceOutcome = { outcome: "not_found" };
    const validOutcomes = new Set<RepairScheduledOccurrenceOutcome["outcome"]>([
      "repaired",
      "retry_failed_vetoed",
      "retry_failed_validation",
      "retry_failed_schedule_missing",
      "retry_guard_mismatch",
      "retry_governance_denied",
      "illegal_source_state",
      "not_found",
    ]);
    expect(validOutcomes.has(sample.outcome)).toBe(true);
  });
});

// ===========================================================================
// 9. PRIOR FAILURE HISTORY RETAINED — the retryHistory stamp is APPEND-ONLY.
// ===========================================================================

describe("repairScheduledOccurrence — prior failure history retained", () => {
  it("a realistic vetoed occurrence's `result.vetoes` is RETAINED alongside the new retryHistory entry", async () => {
    // First: veto the original publication (sets up a realistic prior
    // failure with `result.reason === "vetoed"` + `result.vetoes`).
    await writePlugin(
      "veto-original",
      `{
        manifest: {
          id: 'veto-original', version: '1.0.0', description: 'veto original',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'veto-orig', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: {
          'veto-orig': () => ({ allow: false, reason: 'original veto' }),
        },
      }`,
    );
    enrollInterceptor(habitatId, "veto-original", "veto-orig");

    const { id: scheduleId } = createSchedule();
    const { id: occurrenceId } = makeVetoedOccurrence(scheduleId);

    // The occurrence's `result` carries the ORIGINAL veto (prior history).
    const beforeOccurrence = readOccurrence(occurrenceId);
    expect(beforeOccurrence.state).toBe("rejected");
    expect((beforeOccurrence.result as Record<string, unknown>).reason).toBe("vetoed");
    expect((beforeOccurrence.result as Record<string, unknown>).vetoes).toBeDefined();

    // Disable the interceptor (the operator corrected the policy) + retry.
    pluginManager.resetPlugins();
    const result = repairScheduledOccurrence(retryInput(occurrenceId));

    expect(result.outcome).toBe("repaired");
    if (result.outcome !== "repaired") throw new Error("unreachable");

    // The occurrence's `result` RETAINS the original veto AND carries the
    // new retryHistory entry (append-only).
    const afterOccurrence = readOccurrence(occurrenceId);
    expect(afterOccurrence.state).toBe("rejected"); // one-way door holds.
    const resultJson = afterOccurrence.result as Record<string, unknown>;
    expect(resultJson.reason).toBe("vetoed"); // RETAINED.
    expect(resultJson.vetoes).toBeDefined(); // RETAINED.
    const retryHistory = resultJson.retryHistory as Array<Record<string, unknown>>;
    expect(retryHistory).toHaveLength(1);
    expect(retryHistory[0].outcome).toBe("repaired");
    expect(retryHistory[0].missionId).toBe(result.mission.id);
  });
});
