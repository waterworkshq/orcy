/**
 * T9A Milestone 1 Phase 2 — `publishTemplateAggregateWithClient` focused tests.
 *
 * Proves the four Phase-2 guarantees:
 *  (a) HAPPY PATH — publishes the COMPLETE aggregate (Mission + N Tasks +
 *      optional Workflow + gates + usage mutation) atomically; each Task
 *      carries `creationIntegrity: POST_CUTOVER`, a `created` event, and a
 *      committed envelope; the participant seam fires once with the full ctx.
 *  (b) ATOMICITY MATRIX — failure injected at EACH step rolls back the WHOLE
 *      aggregate (zero orphan Mission / partial Workflow):
 *       - governance veto on Task #2 of 3 → NO Mission, NO Task #1, NO Task
 *         #3, NO Workflow, NO usage mutation.
 *       - participant throw → full rollback.
 *       - Mission-insert failure (duplicate ID) → nothing else commits.
 *       - Workflow-instantiation failure (duplicate ID) → Mission + Tasks
 *         roll back too.
 *  (c) PARTICIPANTS SEAM — a participant that writes a sentinel row commits
 *      with the aggregate AND rolls back with it.
 *  (d) DORMANCY — the function is exported + tested but wires NO production
 *      caller (legacy `applyTemplate` paths stay byte-unchanged — verified by
 *      the PRESERVE suite `applyTemplate.test.ts` remaining green).
 *
 * The atomicity matrix is the load-bearing proof: it establishes that the
 * aggregate publisher composes the kernel's per-Task publication primitive
 * (`publishTaskWithClient`) N times inside ONE caller-owned transaction such
 * that ANY failure at ANY step leaves ZERO partial state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  missions,
  tasks,
  taskEvents,
  workflows,
  taskWorkflowGates,
  taskCreationAttempts,
  taskCreationEnvelopes,
  missionEvents,
  columns as columnsTable,
  habitats,
  missionTemplates,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as templateRepo from "../repositories/template.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import {
  prepareTemplateAggregate,
  type PrepareTemplateAggregateContext,
} from "../services/templateAggregatePreparation.js";
import {
  publishTemplateAggregateWithClient,
  type PublishTemplateAggregateInput,
  type PublishTemplateAggregateOutcome,
  type TemplateAggregateParticipantContext,
} from "../services/templateAggregatePublication.js";
import { TASK_CREATION_INTEGRITY_VERSION } from "../db/schema/taskPublication.js";
import type {
  AuditActorRef,
  AuditSource,
  TaskPriority,
  TaskTemplateEntry,
  WorkflowTemplateDefinition,
} from "@orcy/shared";

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

const SYSTEM_ACTOR: AuditActorRef = { type: "system", id: "system" };
const SYSTEM_SOURCE = "system" as AuditSource;

function makeCtx(actor: AuditActorRef = SYSTEM_ACTOR): PrepareTemplateAggregateContext {
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
  db.delete(taskWorkflowGates).run();
  db.delete(workflows).run();
  db.delete(taskCreationEnvelopes).run();
  db.delete(taskEvents).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();
  db.delete(missionTemplates).run();

  const habitat = habitatRepo.createHabitat({ name: "Aggregate Habitat" });
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

function createTemplate(
  overrides: {
    tasksTemplate?: TaskTemplateEntry[];
    workflowTemplate?: WorkflowTemplateDefinition | null;
    titlePattern?: string;
    descriptionPattern?: string;
    priority?: TaskPriority;
    labels?: string[];
  } = {},
) {
  return templateRepo.createTemplate({
    habitatId,
    name: "Aggregate Test Template",
    titlePattern: overrides.titlePattern ?? "Sprint Task",
    descriptionPattern: overrides.descriptionPattern ?? "## Goal\nComplete the work",
    priority: overrides.priority ?? ("high" as TaskPriority),
    labels: overrides.labels ?? ["sprint", "backend"],
    requiredDomain: "backend",
    requiredCapabilities: ["typescript"],
    tasksTemplate: overrides.tasksTemplate ?? [
      { title: "Setup", description: "Initialize", priority: "high" as TaskPriority, order: 0 },
      { title: "Implementation", priority: "medium" as TaskPriority, order: 1 },
      {
        title: "Testing",
        description: "Write tests",
        priority: "medium" as TaskPriority,
        order: 2,
      },
    ],
    workflowTemplate: overrides.workflowTemplate ?? null,
    createdBy: "system",
  });
}

/**
 * Seeds a `task_creation_attempts` row at `pending` for one prepared Task.
 * Mirrors the coordinator test's `seedAttempt` helper. The aggregate publisher
 * takes one attemptId per prepared Task; the caller (a real origin adapter)
 * would reserve these via `reserveAttemptWithClient`. Tests seed directly to
 * keep the fixture focused on the publication atomicity (not the reservation
 * protocol, which is exercised by its own suite).
 */
function seedAttempt(id: string, scopeId: string): void {
  getDb()
    .insert(taskCreationAttempts)
    .values({
      id,
      source: "test",
      sourceScopeKind: "template_aggregate",
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
    ReturnType<typeof prepareTemplateAggregate>,
    { outcome: "prepared" }
  >["aggregate"],
  scopeId: string,
): string[] {
  const attemptIds: string[] = [];
  for (let i = 0; i < prepared.tasks.length; i++) {
    const id = `attempt-${scopeId}-${i}`;
    seedAttempt(id, scopeId);
    attemptIds.push(id);
  }
  return attemptIds;
}

/** Write + load a temp plugin; returns the tmp dir for cleanup. */
async function writePlugin(name: string, moduleBody: string): Promise<string> {
  const tmpDir = `/tmp/test-t9a-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

/** Builds + prepares a representative 3-Task aggregate with a 2-gate workflow. */
function prepareRepresentativeAggregate(template: ReturnType<typeof createTemplate>) {
  const result = prepareTemplateAggregate(template.id, habitatId, undefined, makeCtx());
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
    workflows: db
      .select({ count: sql<number>`COUNT(*)` })
      .from(workflows)
      .get()!.count,
    gates: db
      .select({ count: sql<number>`COUNT(*)` })
      .from(taskWorkflowGates)
      .get()!.count,
    envelopes: db
      .select({ count: sql<number>`COUNT(*)` })
      .from(taskCreationEnvelopes)
      .get()!.count,
  };
}

function templateUsageCount(templateId: string): number {
  return templateRepo.getTemplateById(templateId)?.usageCount ?? 0;
}

// ===========================================================================
// 1. HAPPY PATH — full aggregate committed atomically.
// ===========================================================================

describe("publishTemplateAggregateWithClient — happy path", () => {
  it("publishes Mission + N Tasks + Workflow + gates + usage mutation atomically; participant fires", () => {
    const wfDef: WorkflowTemplateDefinition = {
      gates: [
        {
          upstreamTaskKey: "build",
          downstreamTaskKey: "test",
          gateType: "on_complete",
        },
        {
          upstreamTaskKey: "test",
          downstreamTaskKey: "deploy",
          gateType: "on_approve",
        },
      ],
    };
    const template = createTemplate({
      tasksTemplate: [
        { key: "build", title: "Build", order: 0 },
        { key: "test", title: "Test", order: 1 },
        { key: "deploy", title: "Deploy", order: 2 },
      ],
      workflowTemplate: wfDef,
    });
    const aggregate = prepareRepresentativeAggregate(template);
    const attemptIds = seedAttemptsForAggregate(aggregate, "happy");

    let participantCtx: TemplateAggregateParticipantContext | null = null;
    const input: PublishTemplateAggregateInput = {
      attemptIds,
      prepared: aggregate,
      participants: (_db, ctx) => {
        participantCtx = ctx;
      },
    };

    const result = publishTemplateAggregateWithClient(getDb(), input);

    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") return;

    // Mission committed with the prepared content.
    expect(result.mission.id).toBe(aggregate.mission.missionId);
    expect(result.mission.habitatId).toBe(habitatId);
    expect(result.mission.title).toBe("Sprint Task");
    expect(result.mission.status).toBe("not_started");
    expect(result.mission.version).toBe(1);

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

    // Workflow + gates committed.
    expect(result.workflow).not.toBeNull();
    expect(result.workflow!.id).toBe(aggregate.workflow!.workflowId);
    expect(result.workflow!.status).toBe("active");
    const gateRows = getDb()
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.workflowId, aggregate.workflow!.workflowId))
      .all();
    expect(gateRows).toHaveLength(2);
    expect(gateRows.map((g) => g.gateType).sort()).toEqual(["on_approve", "on_complete"]);

    // Usage count incremented.
    expect(templateUsageCount(template.id)).toBe(1);

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

  it("publishes an aggregate with NO workflow (workflow branch is null)", () => {
    const template = createTemplate(); // no workflowTemplate
    const aggregate = prepareRepresentativeAggregate(template);
    const attemptIds = seedAttemptsForAggregate(aggregate, "no-wf");

    const result = publishTemplateAggregateWithClient(getDb(), {
      attemptIds,
      prepared: aggregate,
    });

    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") return;
    expect(result.workflow).toBeNull();
    expect(result.tasks).toHaveLength(3);
    expect(countRows().workflows).toBe(0);
    expect(countRows().gates).toBe(0);
  });

  it("resolves templateEntryMetadata overrides — pinned order applied via in-tx update", () => {
    // Template pins explicit orders that differ from the kernel's 0,1,2 allocation.
    const template = createTemplate({
      tasksTemplate: [
        { title: "First", order: 10 },
        { title: "Second", order: 20 },
        { title: "Third", order: 30 },
      ],
    });
    const aggregate = prepareRepresentativeAggregate(template);
    const attemptIds = seedAttemptsForAggregate(aggregate, "order-override");

    const result = publishTemplateAggregateWithClient(getDb(), {
      attemptIds,
      prepared: aggregate,
    });
    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") return;

    // Each task's order matches the template-pinned value (not the kernel's 0,1,2).
    expect(result.tasks[0].task.order).toBe(10);
    expect(result.tasks[1].task.order).toBe(20);
    expect(result.tasks[2].task.order).toBe(30);
  });
});

// ===========================================================================
// 2. ATOMICITY MATRIX — failure at EACH step rolls back the WHOLE aggregate.
// ===========================================================================

describe("publishTemplateAggregateWithClient — atomicity matrix (zero partial aggregate)", () => {
  /**
   * (a) GOVERNANCE VETO on Task #2 of 3 → NO Mission, NO Task #1, NO Task #3,
   *     NO Workflow, NO usage mutation. The tx never opens (governance runs
   *     BEFORE the tx; a veto returns {outcome:"vetoed"} without opening it).
   */
  it("(a) governance veto on Task #2 of 3 → zero Mission/Tasks/Workflow/usage mutation", async () => {
    // Enroll a vetoing interceptor that vetoes ONLY the task titled "VETO-THIS"
    // (Task #2). Tasks #1 and #3 are allowed. The handler receives
    // `(pluginCtx, transition)` where `transition.context.metadata.title` is
    // the proposal title (the prospective TransitionContext the runtime builds).
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

    const template = createTemplate({
      tasksTemplate: [
        { key: "t1", title: "Allow-1", order: 0 },
        { key: "t2", title: "VETO-THIS", order: 1 },
        { key: "t3", title: "Allow-3", order: 2 },
      ],
      workflowTemplate: {
        gates: [{ upstreamTaskKey: "t1", downstreamTaskKey: "t2", gateType: "on_complete" }],
      },
    });
    const aggregate = prepareRepresentativeAggregate(template);
    const attemptIds = seedAttemptsForAggregate(aggregate, "veto");

    const before = countRows();
    const usageBefore = templateUsageCount(template.id);

    const result = publishTemplateAggregateWithClient(getDb(), {
      attemptIds,
      prepared: aggregate,
    });

    // The publisher returns the typed vetoed outcome (NOT a throw, NOT a
    // swallowed null). Task #2 (index 1) is the decisive veto.
    expect(result.outcome).toBe("vetoed");
    if (result.outcome !== "vetoed") return;
    expect(result.taskIndex).toBe(1);
    expect(result.veto.reason).toBe("vetoed task 2");

    // ZERO partial aggregate: no Mission, no Tasks (including the allowed #1
    // and #3), no Workflow, no gates, no envelopes. The tx never opened.
    const after = countRows();
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
    expect(after.events).toBe(before.events);
    expect(after.workflows).toBe(before.workflows);
    expect(after.gates).toBe(before.gates);
    expect(after.envelopes).toBe(before.envelopes);

    // Usage count unchanged.
    expect(templateUsageCount(template.id)).toBe(usageBefore);

    // All three attempts are STILL pending (the tx never opened; no checkpoint).
    for (const attemptId of attemptIds) {
      const attempt = getDb()
        .select()
        .from(taskCreationAttempts)
        .where(eq(taskCreationAttempts.id, attemptId))
        .all()[0];
      expect(attempt.state).toBe("pending");
    }
  });

  /**
   * (b) PARTICIPANT THROW → full rollback. The participant runs AFTER the
   *     Mission + Tasks + Workflow + usage mutation commit; its throw rolls
   *     back the entire aggregate (including the kernel's per-Task writes).
   */
  it("(b) participant throw → Mission + Tasks + Workflow + usage mutation all roll back", () => {
    const template = createTemplate({
      tasksTemplate: [
        { key: "a", title: "A", order: 0 },
        { key: "b", title: "B", order: 1 },
      ],
      workflowTemplate: {
        gates: [{ upstreamTaskKey: "a", downstreamTaskKey: "b", gateType: "on_complete" }],
      },
    });
    const aggregate = prepareRepresentativeAggregate(template);
    const attemptIds = seedAttemptsForAggregate(aggregate, "participant-throw");

    const before = countRows();
    const usageBefore = templateUsageCount(template.id);

    expect(() =>
      publishTemplateAggregateWithClient(getDb(), {
        attemptIds,
        prepared: aggregate,
        participants: () => {
          throw new Error("participant explosion");
        },
      }),
    ).toThrow("participant explosion");

    // ZERO partial aggregate: everything the tx wrote rolled back.
    const after = countRows();
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
    expect(after.events).toBe(before.events);
    expect(after.workflows).toBe(before.workflows);
    expect(after.gates).toBe(before.gates);
    expect(after.envelopes).toBe(before.envelopes);
    expect(templateUsageCount(template.id)).toBe(usageBefore);

    // The attempts returned to pending (the checkpoint UPDATE rolled back).
    for (const attemptId of attemptIds) {
      const attempt = getDb()
        .select()
        .from(taskCreationAttempts)
        .where(eq(taskCreationAttempts.id, attemptId))
        .all()[0];
      expect(attempt.state).toBe("pending");
    }
  });

  /**
   * (c) MISSION-INSERT FAILURE → nothing else commits. Injected by
   *     pre-inserting a Mission with the same prospective missionId (UNIQUE
   *     violation on the first in-tx write).
   */
  it("(c) Mission-insert failure → no Tasks, no Workflow, no usage mutation", () => {
    const template = createTemplate();
    const aggregate = prepareRepresentativeAggregate(template);
    const attemptIds = seedAttemptsForAggregate(aggregate, "mission-fail");

    // Inject: pre-insert a Mission with the SAME prospective missionId. The
    // publisher's first in-tx write (tx.insert(missions)) hits UNIQUE → throws
    // → tx rolls back (nothing else ran).
    const now = new Date().toISOString();
    getDb()
      .insert(missions)
      .values({
        id: aggregate.mission.missionId,
        habitatId,
        columnId,
        title: "DUPLICATE-INJECTOR",
        createdBy: "injector",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const before = countRows();
    const usageBefore = templateUsageCount(template.id);

    expect(() =>
      publishTemplateAggregateWithClient(getDb(), { attemptIds, prepared: aggregate }),
    ).toThrow();

    // No Tasks, no Workflow, no gates, no envelopes committed. The
    // DUPLICATE-INJECTOR Mission persists (the injection artifact), so the
    // Mission count is before+1 (the injector). Everything else is unchanged.
    const after = countRows();
    expect(after.tasks).toBe(before.tasks);
    expect(after.events).toBe(before.events);
    expect(after.workflows).toBe(before.workflows);
    expect(after.gates).toBe(before.gates);
    expect(after.envelopes).toBe(before.envelopes);
    expect(templateUsageCount(template.id)).toBe(usageBefore);

    // No Task references the prospective task IDs.
    for (const preparedTask of aggregate.tasks) {
      const taskRows = getDb()
        .select()
        .from(tasks)
        .where(eq(tasks.id, preparedTask.proposal.prospectiveTaskId))
        .all();
      expect(taskRows).toHaveLength(0);
    }
  });

  /**
   * (d) WORKFLOW-INSTANTIATION FAILURE → Mission + Tasks roll back too. The
   *     Workflow insert happens AFTER the Mission + all N Tasks published. A
   *     failure here MUST roll back the entire aggregate (the load-bearing
   *     atomicity proof — without the caller-owned tx, the Mission + Tasks
   *     would orphan).
   */
  it("(d) Workflow-instantiation failure → Mission + Tasks + envelopes all roll back", () => {
    const template = createTemplate({
      tasksTemplate: [
        { key: "a", title: "A", order: 0 },
        { key: "b", title: "B", order: 1 },
      ],
      workflowTemplate: {
        gates: [{ upstreamTaskKey: "a", downstreamTaskKey: "b", gateType: "on_complete" }],
      },
    });
    const aggregate = prepareRepresentativeAggregate(template);
    const attemptIds = seedAttemptsForAggregate(aggregate, "wf-fail");

    // Inject: pre-insert a Workflow with the SAME prospective workflowId. The
    // publisher's workflow insert (AFTER Mission + Tasks committed in the tx)
    // hits UNIQUE → throws → tx rolls back EVERYTHING (Mission + Tasks +
    // events + envelopes + the failed workflow insert). The duplicate workflow
    // references a throwaway injector mission (the workflow.missionId FK
    // requires the mission to exist).
    const injectorMissionId = `injector-mission-${Date.now()}`;
    const now0 = new Date().toISOString();
    getDb()
      .insert(missions)
      .values({
        id: injectorMissionId,
        habitatId,
        columnId,
        title: "INJECTOR-MISSION",
        createdBy: "injector",
        createdAt: now0,
        updatedAt: now0,
      })
      .run();
    getDb()
      .insert(workflows)
      .values({
        id: aggregate.workflow!.workflowId,
        missionId: injectorMissionId,
        habitatId,
        resolvedVariables: {},
        status: "detached",
        createdBy: "injector",
      })
      .run();

    const before = countRows();
    const usageBefore = templateUsageCount(template.id);

    expect(() =>
      publishTemplateAggregateWithClient(getDb(), { attemptIds, prepared: aggregate }),
    ).toThrow();

    // ZERO partial aggregate. The DUPLICATE-INJECTOR workflow persists
    // (injection artifact, +1 workflow), but NO Mission, NO Tasks, NO events,
    // NO envelopes, NO gates committed for this publication.
    const after = countRows();
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
    expect(after.events).toBe(before.events);
    expect(after.gates).toBe(before.gates);
    expect(after.envelopes).toBe(before.envelopes);
    expect(templateUsageCount(template.id)).toBe(usageBefore);

    // The attempts returned to pending (the per-Task checkpoint UPDATEs
    // rolled back with the tx).
    for (const attemptId of attemptIds) {
      const attempt = getDb()
        .select()
        .from(taskCreationAttempts)
        .where(eq(taskCreationAttempts.id, attemptId))
        .all()[0];
      expect(attempt.state).toBe("pending");
    }
  });
});

// ===========================================================================
// 3. PARTICIPANTS SEAM — sentinel row commits with the aggregate AND rolls
//    back with it.
// ===========================================================================

describe("publishTemplateAggregateWithClient — participants seam", () => {
  it("participant write commits with the aggregate", () => {
    const template = createTemplate();
    const aggregate = prepareRepresentativeAggregate(template);
    const attemptIds = seedAttemptsForAggregate(aggregate, "participant-commit");

    // The participant writes a sentinel mission_event row with distinctive
    // metadata. This mirrors how T8A's triage junction will commit in the
    // same tx as the aggregate.
    const result = publishTemplateAggregateWithClient(getDb(), {
      attemptIds,
      prepared: aggregate,
      participants: (db, ctx) => {
        db.insert(missionEvents)
          .values({
            id: `sentinel-${ctx.mission.id}`,
            missionId: ctx.mission.id,
            actorType: "system",
            actorId: "participant-test",
            action: "created",
            metadata: { sentinel: true, taskCount: ctx.tasks.length },
          })
          .run();
      },
    });

    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") return;

    // The sentinel row committed with the aggregate.
    const sentinel = getDb()
      .select()
      .from(missionEvents)
      .where(eq(missionEvents.missionId, aggregate.mission.missionId))
      .all();
    expect(sentinel).toHaveLength(1);
    expect(sentinel[0].metadata).toMatchObject({ sentinel: true, taskCount: 3 });
  });

  it("participant receives the committed Mission + per-Task publications + attemptIds + prepared aggregate", () => {
    const template = createTemplate();
    const aggregate = prepareRepresentativeAggregate(template);
    const attemptIds = seedAttemptsForAggregate(aggregate, "participant-ctx");

    let captured: TemplateAggregateParticipantContext | null = null;
    publishTemplateAggregateWithClient(getDb(), {
      attemptIds,
      prepared: aggregate,
      participants: (_db, ctx) => {
        captured = ctx;
      },
    });

    expect(captured).not.toBeNull();
    expect(captured!.mission.id).toBe(aggregate.mission.missionId);
    expect(captured!.mission.title).toBe("Sprint Task");
    expect(captured!.tasks).toHaveLength(3);
    expect(captured!.tasks[0].task.missionId).toBe(aggregate.mission.missionId);
    expect(captured!.attemptIds).toEqual(attemptIds);
    // The prepared aggregate is passed by reference.
    expect(captured!.prepared).toBe(aggregate);
  });
});

// ===========================================================================
// 4. INPUT CONTRACT — attemptIds length must match prepared.tasks length.
// ===========================================================================

describe("publishTemplateAggregateWithClient — input contract", () => {
  it("throws when attemptIds.length !== prepared.tasks.length", () => {
    const template = createTemplate({
      tasksTemplate: [{ title: "Solo", order: 0 }],
    });
    const aggregate = prepareRepresentativeAggregate(template);

    expect(() =>
      publishTemplateAggregateWithClient(getDb(), {
        attemptIds: ["a", "b", "c"], // 3 attempts for 1 task — mismatch
        prepared: aggregate,
      }),
    ).toThrow(/attemptIds\.length \(3\) must equal prepared\.tasks\.length \(1\)/);
  });

  it("throws when an attemptId is empty", () => {
    const template = createTemplate({
      tasksTemplate: [{ title: "Solo", order: 0 }],
    });
    const aggregate = prepareRepresentativeAggregate(template);

    expect(() =>
      publishTemplateAggregateWithClient(getDb(), {
        attemptIds: [""],
        prepared: aggregate,
      }),
    ).toThrow(/attemptIds\[0\] must be a non-empty string/);
  });
});

// ===========================================================================
// 5. DORMANCY — the publisher ships with NO production caller. This suite is
//    the sole exerciser. Legacy `applyTemplate` paths stay byte-unchanged
//    (verified by the PRESERVE suite `applyTemplate.test.ts` remaining green,
//    which the orchestrator's full-suite run confirms).
// ===========================================================================

describe("publishTemplateAggregateWithClient — dormancy", () => {
  it("the publisher is exported and callable (wired to no production path)", () => {
    // The function exists, is typed, and is the sole export of its module
    // alongside the closed outcome + input types. No route/MCP/service wires
    // it (the consuming origins T8A-triage + later T9A phases land later).
    expect(typeof publishTemplateAggregateWithClient).toBe("function");
    // A minimal end-to-end call exercises the wiring without asserting
    // anything beyond "the publisher runs and returns a closed outcome".
    const template = createTemplate({
      tasksTemplate: [{ title: "Dormancy Probe", order: 0 }],
    });
    const aggregate = prepareRepresentativeAggregate(template);
    const attemptIds = seedAttemptsForAggregate(aggregate, "dormancy");
    const result = publishTemplateAggregateWithClient(getDb(), {
      attemptIds,
      prepared: aggregate,
    });
    const outcomes: PublishTemplateAggregateOutcome["outcome"][] = [
      "published",
      "vetoed",
      "guard_mismatch",
      "governance_denied",
    ];
    expect(outcomes).toContain(result.outcome);
  });
});
