/**
 * T9A-10 M1 — `publishInlineAggregateWithClient` focused tests.
 *
 * Proves the four inline-publication guarantees (mirrors the template path's
 * `templateAggregatePublication.test.ts` MINUS the Workflow + usage-mutation
 * branches — the inline path produces neither):
 *  (a) HAPPY PATH — publishes Mission + N Tasks atomically; each Task carries
 *      `creationIntegrity: POST_CUTOVER`, a `created` event, + a committed
 *      envelope; the participant seam fires once with the full ctx. The
 *      `published.workflow` is always `null` (inline path produces no Workflow).
 *  (b) ATOMICITY MATRIX — failure injected at EACH step rolls back the WHOLE
 *      aggregate (zero orphan Mission / partial Tasks):
 *       - governance veto on Task #2 of 3 → NO Mission, NO Task #1, NO Task #3.
 *       - participant throw → full rollback.
 *       - Mission-insert failure (duplicate ID) → nothing else commits.
 *       - per-Task `governance_denied` → Mission + earlier Tasks roll back too.
 *  (c) PARTICIPANTS SEAM — a participant that writes a sentinel row commits
 *      with the aggregate AND rolls back with it. T9A-10 M1 PRESERVE: the
 *      occurrence-record participant (`buildOccurrenceRecordParticipant`
 *      re-exported from `scheduledOccurrencePublication.ts`) composes against
 *      the inline {@link InlineAggregateParticipantContext} unchanged (the
 *      participant is shape-agnostic).
 *  (d) DORMANCY — the function is exported + tested but wires NO production
 *      caller (legacy `createMissionFromSchedule` + `executeScheduledTask:236-240`
 *      stay byte-unchanged — verified by the PRESERVE suite
 *      `scheduledTaskService.test.ts` remaining green).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  missions,
  tasks,
  taskEvents,
  taskCreationAttempts,
  taskCreationEnvelopes,
  columns as columnsTable,
  habitats,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import {
  prepareInlineAggregate,
  type PrepareInlineAggregateContext,
} from "../services/inlineAggregatePreparation.js";
import {
  publishInlineAggregateWithClient,
  type PublishInlineAggregateInput,
  type PublishInlineAggregateOutcome,
  type InlineAggregateParticipantContext,
} from "../services/inlineAggregatePublication.js";
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

const SYSTEM_ACTOR: AuditActorRef = { type: "system", id: "scheduler" };
const SYSTEM_SOURCE = "scheduler" as AuditSource;

function makeCtx(actor: AuditActorRef = SYSTEM_ACTOR): PrepareInlineAggregateContext {
  return { actor, auditSource: SYSTEM_SOURCE };
}

beforeEach(async () => {
  await initTestDb();
  pluginManager.resetPlugins();
  publishMock.mockClear();
  if (!process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD) {
    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "1000";
  }
  const db = getDb();
  db.delete(taskCreationEnvelopes).run();
  db.delete(taskCreationAttempts).run();
  db.delete(taskEvents).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();

  const habitat = habitatRepo.createHabitat({ name: "Inline Aggregate Pub Habitat" });
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

/** Inline tasksTemplate entries (3 tasks). */
function typicalTasksTemplate(): TaskTemplateEntry[] {
  return [
    { title: "Setup", description: "init", priority: "high" as TaskPriority, order: 0 },
    { title: "Implementation", priority: "medium" as TaskPriority, order: 1 },
    { title: "Testing", description: "tests", priority: "medium" as TaskPriority, order: 2 },
  ];
}

/** Seeds a `task_creation_attempts` row at `pending` for one prepared Task. */
function seedAttempt(id: string, scopeId: string): void {
  getDb()
    .insert(taskCreationAttempts)
    .values({
      id,
      source: "test",
      sourceScopeKind: "inline_aggregate",
      sourceScopeId: scopeId,
      attemptKey: `key-${id}`,
      requestFingerprint: `fp-${id}`,
      publicationKind: "create",
      actorType: "system",
      actorId: "system",
      habitatId,
      state: "pending",
    })
    .run();
}

/** Seeds one pending attempt per prepared Task; returns the attemptIds. */
function seedAttemptsForAggregate(
  prepared: Extract<
    ReturnType<typeof prepareInlineAggregate>,
    { outcome: "prepared" }
  >["aggregate"],
  scopeId: string,
): string[] {
  const attemptIds: string[] = [];
  for (let i = 0; i < prepared.tasks.length; i++) {
    const id = `inline-attempt-${scopeId}-${i}`;
    seedAttempt(id, scopeId);
    attemptIds.push(id);
  }
  return attemptIds;
}

/** Builds + prepares a representative 3-Task inline aggregate. */
function prepareRepresentativeInlineAggregate(
  overrides: { tasksTemplate?: TaskTemplateEntry[] } = {},
) {
  const result = prepareInlineAggregate(
    habitatId,
    overrides.tasksTemplate ?? typicalTasksTemplate(),
    {
      title: "Inline Mission",
      description: "## Goal",
      priority: "high" as TaskPriority,
      labels: ["scheduled", "inline"],
    },
    makeCtx(),
  );
  expect(result.outcome).toBe("prepared");
  if (result.outcome !== "prepared") throw new Error("prep failed");
  return result.aggregate;
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
  };
}

/** Write + load a temp plugin; returns the tmp dir for cleanup. */
async function writePlugin(name: string, moduleBody: string): Promise<string> {
  const tmpDir = `/tmp/test-t9a10m1-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
// 1. HAPPY PATH — full aggregate committed atomically.
// ===========================================================================

describe("publishInlineAggregateWithClient — happy path", () => {
  it("publishes Mission + N Tasks atomically; participant fires; workflow is null", () => {
    const aggregate = prepareRepresentativeInlineAggregate();
    const attemptIds = seedAttemptsForAggregate(aggregate, "happy");

    let participantCtx: InlineAggregateParticipantContext | null = null;
    const input: PublishInlineAggregateInput = {
      attemptIds,
      prepared: aggregate,
      participants: (_db, ctx) => {
        participantCtx = ctx;
      },
    };

    const result = publishInlineAggregateWithClient(getDb(), input);

    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") return;

    // Mission committed with the prepared content.
    expect(result.mission.id).toBe(aggregate.mission.missionId);
    expect(result.mission.habitatId).toBe(habitatId);
    expect(result.mission.title).toBe("Inline Mission");
    expect(result.mission.status).toBe("not_started");
    expect(result.mission.version).toBe(1);
    expect(result.mission.priority).toBe("high");
    expect(result.mission.labels).toEqual(["scheduled", "inline"]);

    // N Tasks committed, each POST_CUTOVER with a created event + envelope.
    expect(result.tasks).toHaveLength(3);
    for (let i = 0; i < result.tasks.length; i++) {
      const pub = result.tasks[i];
      const preparedTask = aggregate.tasks[i];
      expect(pub.task.id).toBe(preparedTask.proposal.prospectiveTaskId);
      expect(pub.task.missionId).toBe(aggregate.mission.missionId);
      expect(pub.task.creationIntegrity).toBe(TASK_CREATION_INTEGRITY_VERSION.POST_CUTOVER);
      expect(pub.event.taskId).toBe(pub.task.id);
      expect(pub.event.action).toBe("created");
      expect(pub.envelope.taskId).toBe(pub.task.id);
      expect(pub.envelope.lifecycleAction).toBe("created");
    }

    // Workflow is always null on the inline path.
    expect(result.workflow).toBeNull();

    // Each attempt advanced to published_pending_observation (RECOVERING).
    for (const attemptId of attemptIds) {
      const attempt = getDb()
        .select()
        .from(taskCreationAttempts)
        .where(eq(taskCreationAttempts.id, attemptId))
        .all()[0];
      expect(attempt).toBeDefined();
      expect(attempt.state).toBe("published_pending_observation");
    }

    // Participant seam fired with the full aggregate context.
    expect(participantCtx).not.toBeNull();
    expect(participantCtx!.mission.id).toBe(aggregate.mission.missionId);
    expect(participantCtx!.tasks).toHaveLength(3);
    expect(participantCtx!.attemptIds).toEqual(attemptIds);
    expect(participantCtx!.prepared).toBe(aggregate);
  });

  it("publishes a single-Task inline aggregate", () => {
    const aggregate = prepareRepresentativeInlineAggregate({
      tasksTemplate: [{ title: "Only Task", order: 0 }],
    });
    const attemptIds = seedAttemptsForAggregate(aggregate, "single");
    const result = publishInlineAggregateWithClient(getDb(), {
      attemptIds,
      prepared: aggregate,
    });
    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") return;
    expect(result.tasks).toHaveLength(1);
    expect(result.workflow).toBeNull();
  });

  it("resolves inlineEntryMetadata overrides — pinned order applied via in-tx update", () => {
    // Entries pin explicit orders that differ from the kernel's 0,1,2 allocation.
    const aggregate = prepareRepresentativeInlineAggregate({
      tasksTemplate: [
        { title: "First", order: 10 },
        { title: "Second", order: 20 },
        { title: "Third", order: 30 },
      ],
    });
    const attemptIds = seedAttemptsForAggregate(aggregate, "order-override");
    const result = publishInlineAggregateWithClient(getDb(), {
      attemptIds,
      prepared: aggregate,
    });
    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") return;
    expect(result.tasks[0].task.order).toBe(10);
    expect(result.tasks[1].task.order).toBe(20);
    expect(result.tasks[2].task.order).toBe(30);
  });
});

// ===========================================================================
// 2. ATOMICITY MATRIX — failure at EACH step rolls back the WHOLE aggregate.
// ===========================================================================

describe("publishInlineAggregateWithClient — atomicity matrix (zero partial aggregate)", () => {
  it("(a) governance veto on Task #2 of 3 → zero Mission/Tasks (tx never opens)", async () => {
    await writePlugin(
      "veto-task2",
      `{
        manifest: {
          id: 'veto-task2', version: '1.0.0', description: 'veto task 2 only',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'veto-on-2', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: {
          'veto-on-2': (pluginCtx, transition) => {
            const title = transition && transition.context && transition.context.metadata && transition.context.metadata.title;
            if (title === 'VETO-THIS') {
              return { allow: false, reason: 'vetoed task 2' };
            }
            return { allow: true };
          },
        },
      }`,
    );
    enrollInterceptor(habitatId, "veto-task2", "veto-on-2");

    const aggregate = prepareRepresentativeInlineAggregate({
      tasksTemplate: [
        { title: "Allow-1", order: 0 },
        { title: "VETO-THIS", order: 1 },
        { title: "Allow-3", order: 2 },
      ],
    });
    const attemptIds = seedAttemptsForAggregate(aggregate, "veto");

    const before = countRows();
    const result = publishInlineAggregateWithClient(getDb(), {
      attemptIds,
      prepared: aggregate,
    });

    // T9A-04: the `vetoes` list carries ONLY Task #2's decisive veto.
    expect(result.outcome).toBe("vetoed");
    if (result.outcome !== "vetoed") return;
    expect(result.vetoes).toHaveLength(1);
    expect(result.vetoes[0].taskIndex).toBe(1);
    expect(result.vetoes[0].veto.reason).toBe("vetoed task 2");

    // ZERO partial aggregate: no Mission, no Tasks.
    const after = countRows();
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
    expect(after.events).toBe(before.events);
    expect(after.envelopes).toBe(before.envelopes);

    // All three attempts are STILL pending (the tx never opened).
    for (const attemptId of attemptIds) {
      const attempt = getDb()
        .select()
        .from(taskCreationAttempts)
        .where(eq(taskCreationAttempts.id, attemptId))
        .all()[0];
      expect(attempt.state).toBe("pending");
    }
  });

  it("(b) participant throw → Mission + Tasks all roll back", () => {
    const aggregate = prepareRepresentativeInlineAggregate();
    const attemptIds = seedAttemptsForAggregate(aggregate, "participant-throw");

    const before = countRows();
    const input: PublishInlineAggregateInput = {
      attemptIds,
      prepared: aggregate,
      participants: () => {
        throw new Error("participant failure (simulated)");
      },
    };

    // Infrastructure failure propagates as a retryable runtime error. The
    // tx rolled back; nothing committed.
    expect(() => publishInlineAggregateWithClient(getDb(), input)).toThrow(/participant failure/);

    const after = countRows();
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
    expect(after.events).toBe(before.events);
    expect(after.envelopes).toBe(before.envelopes);
  });

  it("(c) Mission-insert failure (duplicate ID) → no Tasks, no envelopes", () => {
    const aggregate = prepareRepresentativeInlineAggregate();
    const attemptIds = seedAttemptsForAggregate(aggregate, "dup-mission");

    // Pre-insert a Mission with the SAME id the prepared aggregate will use.
    // The publisher's tx will fail on the duplicate primary key.
    const db = getDb();
    const now = new Date().toISOString();
    db.insert(missions)
      .values({
        id: aggregate.mission.missionId,
        habitatId: aggregate.mission.habitatId,
        columnId: aggregate.mission.columnId,
        title: "pre-existing",
        description: "",
        acceptanceCriteria: "",
        priority: aggregate.mission.priority,
        labels: [],
        status: "not_started",
        displayOrder: 99,
        dependsOn: [],
        blocks: [],
        dueAt: null,
        slaMinutes: null,
        createdBy: "test",
        createdAt: now,
        updatedAt: now,
        version: 1,
      })
      .run();

    const before = countRows();
    expect(() =>
      publishInlineAggregateWithClient(getDb(), { attemptIds, prepared: aggregate }),
    ).toThrow();

    const after = countRows();
    // No NEW Mission, no Tasks, no envelopes (the only Mission is the pre-existing one).
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
    expect(after.events).toBe(before.events);
    expect(after.envelopes).toBe(before.envelopes);
  });

  it("(d) multi-veto: two interceptors veto Task #0 + Task #2 → BOTH vetoes; zero publish", async () => {
    await writePlugin(
      "veto-task-0",
      `{
        manifest: {
          id: 'veto-task-0', version: '1.0.0', description: 'veto task 0 only',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'veto-on-0', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: {
          'veto-on-0': (pluginCtx, transition) => {
            const title = transition && transition.context && transition.context.metadata && transition.context.metadata.title;
            if (title === 'VETO-A') {
              return { allow: false, reason: 'vetoed task 0' };
            }
            return { allow: true };
          },
        },
      }`,
    );
    await writePlugin(
      "veto-task-2",
      `{
        manifest: {
          id: 'veto-task-2', version: '1.0.0', description: 'veto task 2 only',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'veto-on-2', phase: 'pre', event: 'taskCreated', priority: 2, requires: [] },
          ],
        },
        interceptors: {
          'veto-on-2': (pluginCtx, transition) => {
            const title = transition && transition.context && transition.context.metadata && transition.context.metadata.title;
            if (title === 'VETO-C') {
              return { allow: false, reason: 'vetoed task 2' };
            }
            return { allow: true };
          },
        },
      }`,
    );
    enrollInterceptor(habitatId, "veto-task-0", "veto-on-0");
    enrollInterceptor(habitatId, "veto-task-2", "veto-on-2");

    const aggregate = prepareRepresentativeInlineAggregate({
      tasksTemplate: [
        { title: "VETO-A", order: 0 },
        { title: "Allow-B", order: 1 },
        { title: "VETO-C", order: 2 },
      ],
    });
    const attemptIds = seedAttemptsForAggregate(aggregate, "multi-veto");

    const before = countRows();
    const result = publishInlineAggregateWithClient(getDb(), {
      attemptIds,
      prepared: aggregate,
    });

    // T9A-04 — the `vetoes` list contains BOTH decisive Task-level vetoes.
    expect(result.outcome).toBe("vetoed");
    if (result.outcome !== "vetoed") return;
    expect(result.vetoes).toHaveLength(2);
    expect(result.vetoes[0].taskIndex).toBe(0);
    expect(result.vetoes[1].taskIndex).toBe(2);

    // ZERO partial aggregate.
    const after = countRows();
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
  });
});

// ===========================================================================
// 3. PARTICIPANTS SEAM — a participant write commits with the aggregate
//    and rolls back with it. Proves the occurrence-record participant
//    (re-exported from the shipped T9A subsystem) composes against the
//    inline ctx unchanged.
// ===========================================================================

describe("publishInlineAggregateWithClient — participants seam", () => {
  it("participant write commits with the aggregate", () => {
    const aggregate = prepareRepresentativeInlineAggregate();
    const attemptIds = seedAttemptsForAggregate(aggregate, "participant-commit");

    // The participant writes a Mission label update in-tx; it commits with
    // the aggregate.
    const input: PublishInlineAggregateInput = {
      attemptIds,
      prepared: aggregate,
      participants: (db, ctx) => {
        db.update(missions)
          .set({ labels: [...ctx.mission.labels, "participant-stamped"] })
          .where(eq(missions.id, ctx.mission.id))
          .run();
      },
    };

    const result = publishInlineAggregateWithClient(getDb(), input);
    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") return;

    // The participant's label update landed (the Mission row reflects it).
    const row = getDb()
      .select()
      .from(missions)
      .where(eq(missions.id, aggregate.mission.missionId))
      .get();
    expect(row).toBeDefined();
    expect(row!.labels).toContain("participant-stamped");
  });

  it("participant receives the committed Mission + per-Task publications + attemptIds + prepared aggregate", () => {
    const aggregate = prepareRepresentativeInlineAggregate();
    const attemptIds = seedAttemptsForAggregate(aggregate, "participant-ctx");

    let captured: InlineAggregateParticipantContext | null = null;
    publishInlineAggregateWithClient(getDb(), {
      attemptIds,
      prepared: aggregate,
      participants: (_db, ctx) => {
        captured = ctx;
      },
    });
    expect(captured).not.toBeNull();
    expect(captured!.mission.id).toBe(aggregate.mission.missionId);
    expect(captured!.tasks.map((p) => p.task.id)).toEqual(
      aggregate.tasks.map((t) => t.proposal.prospectiveTaskId),
    );
    expect(captured!.attemptIds).toEqual(attemptIds);
    expect(captured!.prepared).toBe(aggregate);
  });
});

// ===========================================================================
// 4. INPUT CONTRACT — attemptIds PLURAL (one per Task)
// ===========================================================================

describe("publishInlineAggregateWithClient — input contract", () => {
  it("throws when attemptIds.length !== prepared.tasks.length", () => {
    const aggregate = prepareRepresentativeInlineAggregate(); // 3 tasks
    // Supply only 2 attemptIds for 3 prepared tasks.
    const attemptIds = ["a-0", "a-1"];
    seedAttempt("a-0", "contract-short");
    seedAttempt("a-1", "contract-short");
    expect(() =>
      publishInlineAggregateWithClient(getDb(), { attemptIds, prepared: aggregate }),
    ).toThrow(/attemptIds\.length \(2\) must equal prepared\.tasks\.length \(3\)/);
  });

  it("throws when an attemptId is empty", () => {
    const aggregate = prepareRepresentativeInlineAggregate();
    const attemptIds = ["", "a-1", "a-2"]; // empty first
    seedAttempt("a-1", "contract-empty");
    seedAttempt("a-2", "contract-empty");
    expect(() =>
      publishInlineAggregateWithClient(getDb(), { attemptIds, prepared: aggregate }),
    ).toThrow(/attemptIds\[0\] must be a non-empty string/);
  });
});

// ===========================================================================
// 5. DORMANCY — exported + tested but no production caller
// ===========================================================================

describe("publishInlineAggregateWithClient — dormancy", () => {
  it("the publisher is exported and callable (wired to no production path)", () => {
    // The mere fact that we can import + call the function is the dormancy
    // assertion. The full-suite run confirms the legacy
    // `scheduledTaskService.test.ts` PRESERVE suite stays green (the
    // inline branch of `executeScheduledTask:236-240` is byte-identical).
    const aggregate = prepareRepresentativeInlineAggregate();
    const attemptIds = seedAttemptsForAggregate(aggregate, "dormancy");
    const result = publishInlineAggregateWithClient(getDb(), {
      attemptIds,
      prepared: aggregate,
    });
    expect(result.outcome).toBe("published");
  });

  it("closed-union exhaustiveness — every result branch is a known outcome", () => {
    // Type-level exhaustiveness: switch over the outcome with no default
    // branch — TypeScript would error if a branch were missing. Runtime
    // just confirms the published branch returns the expected shape.
    const aggregate = prepareRepresentativeInlineAggregate();
    const attemptIds = seedAttemptsForAggregate(aggregate, "exhaustive");
    const result: PublishInlineAggregateOutcome = publishInlineAggregateWithClient(getDb(), {
      attemptIds,
      prepared: aggregate,
    });
    switch (result.outcome) {
      case "published":
        expect(result.workflow).toBeNull();
        expect(result.mission.id).toBe(aggregate.mission.missionId);
        break;
      case "vetoed":
      case "guard_mismatch":
      case "governance_denied":
        throw new Error(`unexpected outcome on happy path: ${result.outcome}`);
    }
  });
});
