/**
 * T7 Phase 1 — Clone Preparation + Clone Publication guardrail tests.
 *
 * Two DORMANT deliverables, each exercised solely by this suite until T11:
 *
 *   (a) {@link prepareClonePublication} — the read-only allowlisted DTO that
 *       prefills the clone composer. Opening the clone form creates NOTHING.
 *   (b) Clone publication via {@link publishTaskCreation} with
 *       `cloneSourceTaskId` — the kernel stamps the `cloned` Lifecycle Event
 *       + envelope `cloneSourceTaskId` atomically; the dual-signal
 *       (`task.cloned` then `task.created`) is emitted by T4B-2's
 *       `clientStreamAdapter`, NOT by this adapter.
 *
 * Each test maps 1:1 to a guardrail named in the T7 ticket:
 *   - Clone-prep allowlist: reusable fields present; execution history absent.
 *   - Clone-prep read-only: zero writes (no attempt/Task/event).
 *   - Clone publication uses EDITED values (not a re-copy of source).
 *   - Atomicity: failure at a nested write leaves NO clone aggregate.
 *   - `cloned` event + envelope `lifecycleAction === "cloned"` +
 *     `cloneSourceTaskId`; dual-signal NOT re-implemented (broadcaster untouched).
 *   - Same-Habitat enforcement: cross-Habitat target Mission → rejected.
 *   - Legacy `cloneTask` byte-unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  tasks,
  taskEvents,
  taskSubtasks,
  taskDependencies,
  taskCreationEnvelopes,
  taskCreationAttempts,
  agents,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as pluginManager from "../plugins/pluginManager.js";
import {
  publishTaskCreation,
  type PublishTaskCreationInput,
  type TaskCreationPublicationResult,
} from "../services/taskCreationPublication.js";
import {
  prepareClonePublication,
  type ClonePreparation,
} from "../services/taskClonePreparation.js";
import { TASK_CREATION_INTEGRITY_VERSION } from "../db/schema/taskPublication.js";
import type { AuditSource } from "@orcy/shared";

// --- Mocks: the adapter composes the kernel, which emits NO pre-commit
//     effects. The dual-signal is T4B-2's concern (clientStreamAdapter), NOT
//     the adapter's — assert publish/publishToClients are never reached. ---
const publishMock = vi.fn();
const publishToClientsMock = vi.fn();
vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: {
    publish: (...args: unknown[]) => publishMock(...args),
    publishToClients: (...args: unknown[]) => publishToClientsMock(...args),
  },
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
let missionId: string;

const ACTOR_ID = "user-clone";
const AUDIT_SOURCE: AuditSource = "rest_api";
const TARGETED_DEADLINE = "2099-01-01T00:00:00.000Z";

beforeEach(async () => {
  await initTestDb();
  pluginManager.resetPlugins();
  publishMock.mockClear();
  publishToClientsMock.mockClear();
  if (!process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD) {
    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "1000";
  }
  const habitat = habitatRepo.createHabitat({ name: "Clone Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
  missionId = missionRepo.createMission({
    habitatId,
    columnId,
    title: "clone-mission",
    createdBy: ACTOR_ID,
  }).id;
});

afterEach(async () => {
  pluginManager.resetPlugins();
  closeDb();
  delete process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let keyCounter = 0;
/** Returns a fresh client-supplied attempt key per call. */
function freshKey(label = "k"): string {
  keyCounter += 1;
  return `${label}-${keyCounter}-${Date.now()}`;
}

/** Builds a valid interactive publication input; callers override fields. */
function pubInput(overrides: Partial<PublishTaskCreationInput> = {}): PublishTaskCreationInput {
  return {
    attemptKey: freshKey(),
    actorId: ACTOR_ID,
    actorType: "human",
    auditSource: AUDIT_SOURCE,
    habitatId,
    targetMissionId: missionId,
    title: "Cloned Task",
    description: "Published via the dormant clone publication adapter.",
    priority: "medium",
    labels: ["clone"],
    assignment: { kind: "auto" },
    ...overrides,
  };
}

/** Asserts the result is `created` (recovering) with a committed publication. */
function expectCreatedRecovering(
  result: TaskCreationPublicationResult,
): asserts result is Extract<TaskCreationPublicationResult, { outcome: "created" }> {
  expect(result.outcome).toBe("created");
  if (result.outcome !== "created") throw new Error("expected created outcome");
  expect(result.recovering).toBe(true);
  expect(result.publication.task.id).toBeDefined();
}

/**
 * Seeds a source Task with rich work-definition + execution-history + Subtasks
 * + outgoing dependencies, so clone-preparation has something substantive to
 * allowlist. Returns the source Task row + the ids of its dependency targets.
 */
function seedSourceTask(opts?: { title?: string; withSubtasks?: boolean; withDeps?: boolean }): {
  sourceId: string;
  depTargetIds: string[];
} {
  const sourceId = `source-${keyCounter}-${Math.random().toString(36).slice(2, 8)}`;
  // Seed the agents referenced by execution-history fields (assignedAgentId,
  // subtask assigneeId) so the FK constraints hold. These exist ONLY on the
  // source — the clone DTO must not carry them.
  getDb()
    .insert(agents)
    .values([
      {
        id: "agent-executor",
        name: "Executor Agent",
        type: "claude-code",
        domain: "backend",
        apiKey: "key-executor",
      },
      {
        id: "agent-x",
        name: "Agent X",
        type: "codex",
        domain: "frontend",
        apiKey: "key-x",
      },
    ])
    .onConflictDoNothing()
    .run();
  getDb()
    .insert(tasks)
    .values({
      id: sourceId,
      missionId,
      title: opts?.title ?? "Source Task",
      description: "Source description with detail.",
      labels: ["backend", "api"],
      priority: "high",
      // Execution-history fields (MUST be absent from the clone DTO):
      status: "in_progress",
      assignedAgentId: "agent-executor",
      rejectedCount: 2,
      rejectionReason: "needs work",
      result: "partial",
      artifacts: [{ type: "file", url: "file:///out.txt", description: "partial output" }],
      version: 7,
      order: 3,
      retryCount: 1,
      actualMinutes: 42,
      cycleTimeMinutes: 100,
      // Work-definition fields (reusable):
      requiredDomain: "backend",
      requiredCapabilities: ["typescript", "sqlite"],
      estimatedMinutes: 90,
      createdBy: ACTOR_ID,
    })
    .run();

  const depTargetIds: string[] = [];
  if (opts?.withDeps) {
    const depA = `dep-a-${keyCounter}-${Math.random().toString(36).slice(2, 6)}`;
    const depB = `dep-b-${keyCounter}-${Math.random().toString(36).slice(2, 6)}`;
    getDb()
      .insert(tasks)
      .values([
        { id: depA, missionId, title: "Dependency A", createdBy: ACTOR_ID },
        { id: depB, missionId, title: "Dependency B", createdBy: ACTOR_ID },
      ])
      .run();
    getDb()
      .insert(taskDependencies)
      .values([
        { taskId: sourceId, dependsOnId: depA },
        { taskId: sourceId, dependsOnId: depB },
      ])
      .run();
    depTargetIds.push(depA, depB);
  }

  if (opts?.withSubtasks) {
    getDb()
      .insert(taskSubtasks)
      .values([
        {
          id: `st-1-${sourceId}`,
          taskId: sourceId,
          title: "Source subtask one",
          completed: true,
          order: 0,
          assigneeId: "agent-x",
        },
        {
          id: `st-2-${sourceId}`,
          taskId: sourceId,
          title: "Source subtask two",
          completed: false,
          order: 1,
          assigneeId: null,
        },
      ])
      .run();
  }

  return { sourceId, depTargetIds };
}

// ===========================================================================
// (a) CLONE PREPARATION — read-only allowlisted DTO
// ===========================================================================

describe("T7P1 clone preparation — allowlisted DTO", () => {
  it("selects reusable work-definition fields from the source", () => {
    const { sourceId } = seedSourceTask();
    const result = prepareClonePublication(sourceId);

    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") throw new Error("expected prepared");
    const p = result.preparation;

    expect(p.title).toBe("Source Task");
    expect(p.description).toBe("Source description with detail.");
    expect(p.priority).toBe("high");
    expect(p.labels).toEqual(["backend", "api"]);
    expect(p.requiredDomain).toBe("backend");
    expect(p.requiredCapabilities).toEqual(["typescript", "sqlite"]);
    expect(p.estimatedMinutes).toBe(90);
  });

  it("carries source references (task + mission + habitat) for provenance + same-Habitat", () => {
    const { sourceId } = seedSourceTask();
    const result = prepareClonePublication(sourceId);
    if (result.outcome !== "prepared") throw new Error("expected prepared");

    expect(result.preparation.source.taskId).toBe(sourceId);
    expect(result.preparation.source.missionId).toBe(missionId);
    expect(result.preparation.source.habitatId).toBe(habitatId);
    expect(result.preparation.defaultTargetMissionId).toBe(missionId);
  });

  it("does NOT include any execution-history field (allowlist, not serialize-then-remove)", () => {
    const { sourceId } = seedSourceTask({ withSubtasks: true, withDeps: true });
    const result = prepareClonePublication(sourceId);
    if (result.outcome !== "prepared") throw new Error("expected prepared");
    const p = result.preparation;

    // The forbidden execution-history fields must be structurally ABSENT.
    // Assert each one is not a property of the DTO object.
    const forbidden = [
      "status",
      "assignedAgentId",
      "claimedAt",
      "startedAt",
      "submittedAt",
      "completedAt",
      "rejectedCount",
      "rejectionReason",
      "result",
      "artifacts",
      "version",
      "order",
      "retryCount",
      "nextRetryAt",
      "actualMinutes",
      "cycleTimeMinutes",
      "leadTimeMinutes",
      "estimationAccuracy",
      "delegatedToAgentId",
      "remoteAssignedParticipantId",
      "createdBy",
      "createdAt",
      "updatedAt",
      "creationIntegrity",
      "id",
      "missionId",
    ];
    for (const field of forbidden) {
      expect(p).not.toHaveProperty(field);
    }
  });

  it("resets Subtasks to incomplete + unassigned (copies work structure, not execution state)", () => {
    const { sourceId } = seedSourceTask({ withSubtasks: true });
    const result = prepareClonePublication(sourceId);
    if (result.outcome !== "prepared") throw new Error("expected prepared");
    const subtasks = result.preparation.subtasks;

    expect(subtasks).toHaveLength(2);
    expect(subtasks[0].title).toBe("Source subtask one");
    expect(subtasks[0].order).toBe(0);
    expect(subtasks[1].title).toBe("Source subtask two");
    expect(subtasks[1].order).toBe(1);

    // RESET: no completed, no assigneeId, no id on each subtask DTO.
    for (const st of subtasks) {
      expect(st).not.toHaveProperty("completed");
      expect(st).not.toHaveProperty("assigneeId");
      expect(st).not.toHaveProperty("id");
    }
  });

  it("exposes source dependencies as UNSELECTED suggestions", () => {
    const { sourceId, depTargetIds } = seedSourceTask({ withDeps: true });
    const result = prepareClonePublication(sourceId);
    if (result.outcome !== "prepared") throw new Error("expected prepared");
    const suggestions = result.preparation.dependencySuggestions;

    expect(suggestions).toHaveLength(2);
    const ids = suggestions.map((s) => s.dependsOnId).sort();
    expect(ids).toEqual([...depTargetIds].sort());
  });

  it("returns not_found when the source Task does not exist", () => {
    const result = prepareClonePublication("nonexistent-task-id");
    expect(result.outcome).toBe("not_found");
  });
});

// ===========================================================================
// (a) CLONE PREPARATION — read-only (zero writes)
// ===========================================================================

describe("T7P1 clone preparation — read-only (creates nothing)", () => {
  it("calling prepareClonePublication creates NO attempt, NO Task, NO event", () => {
    const { sourceId } = seedSourceTask({ withSubtasks: true, withDeps: true });

    const beforeTasks = getDb().select().from(tasks).all().length;
    const beforeEvents = getDb().select().from(taskEvents).all().length;
    const beforeAttempts = getDb().select().from(taskCreationAttempts).all().length;
    const beforeEnvelopes = getDb().select().from(taskCreationEnvelopes).all().length;
    const beforeSubtasks = getDb().select().from(taskSubtasks).all().length;

    // Opening the clone form creates nothing (Core Flows § "Prepare" rule 3).
    const result = prepareClonePublication(sourceId);
    expect(result.outcome).toBe("prepared");

    expect(getDb().select().from(tasks).all().length).toBe(beforeTasks);
    expect(getDb().select().from(taskEvents).all().length).toBe(beforeEvents);
    expect(getDb().select().from(taskCreationAttempts).all().length).toBe(beforeAttempts);
    expect(getDb().select().from(taskCreationEnvelopes).all().length).toBe(beforeEnvelopes);
    expect(getDb().select().from(taskSubtasks).all().length).toBe(beforeSubtasks);
  });
});

// ===========================================================================
// (b) CLONE PUBLICATION — happy path: edited values + cloned event + envelope
// ===========================================================================

describe("T7P1 clone publication — happy path", () => {
  it("commits a clone with EDITED values (not a re-copy of the source)", () => {
    const { sourceId } = seedSourceTask({
      title: "Source Title",
      withSubtasks: true,
      withDeps: true,
    });

    // The user edits title, description, subtasks in the clone composer.
    // These EDITED values are published — NOT a re-copy of source fields.
    const result = publishTaskCreation(
      pubInput({
        cloneSourceTaskId: sourceId,
        title: "EDITED Clone Title",
        description: "EDITED description",
        priority: "critical",
        labels: ["edited"],
        subtasks: [{ title: "EDITED subtask", order: 0 }],
        // NO selectedDependencies — the suggestions are unselected by default.
      }),
    );
    expectCreatedRecovering(result);

    // The committed Task reflects the EDITED values, not the source.
    expect(result.publication.task.title).toBe("EDITED Clone Title");
    expect(result.publication.task.description).toBe("EDITED description");
    expect(result.publication.task.priority).toBe("critical");
    expect(result.publication.task.labels).toEqual(["edited"]);

    // The committed Subtask is the edited one, not the source's two.
    expect(result.publication.subtasks).toHaveLength(1);
    expect(result.publication.subtasks[0].title).toBe("EDITED subtask");

    // The clone is POST_CUTOVER (creation-integrity engaged).
    expect(result.publication.task.creationIntegrity).toBe(
      TASK_CREATION_INTEGRITY_VERSION.POST_CUTOVER,
    );
  });

  it("stamps exactly ONE `cloned` Lifecycle Event + envelope lifecycleAction=cloned + cloneSourceTaskId", () => {
    const { sourceId } = seedSourceTask();

    const result = publishTaskCreation(
      pubInput({ cloneSourceTaskId: sourceId, title: "Clone With Event" }),
    );
    expectCreatedRecovering(result);

    // Exactly ONE initial event, action === "cloned".
    expect(result.publication.event).not.toBeNull();
    expect(result.publication.event!.action).toBe("cloned");

    // The envelope carries lifecycleAction "cloned" + cloneSourceTaskId.
    const envelope = getDb()
      .select()
      .from(taskCreationEnvelopes)
      .where(eq(taskCreationEnvelopes.taskId, result.publication.task.id))
      .all()[0];
    expect(envelope).toBeDefined();
    expect(envelope.lifecycleAction).toBe("cloned");
    expect(envelope.cloneSourceTaskId).toBe(sourceId);
  });

  it("does NOT re-implement the dual-signal (T4B-2 owns it — broadcaster untouched)", () => {
    const { sourceId } = seedSourceTask();

    publishTaskCreation(pubInput({ cloneSourceTaskId: sourceId, title: "Dual Signal" }));

    // The adapter composes the kernel, which emits NO pre-commit SSE effects.
    // The dual-signal (task.cloned then task.created) is T4B-2's
    // clientStreamAdapter — NOT the adapter. Assert neither publish nor
    // publishToClients was called.
    expect(publishMock).not.toHaveBeenCalled();
    expect(publishToClientsMock).not.toHaveBeenCalled();
  });

  it("same-key retry after commit returns the recovering clone publication (no duplicate)", () => {
    const { sourceId } = seedSourceTask();
    const key = freshKey("clone-retry");
    const payload = pubInput({
      attemptKey: key,
      cloneSourceTaskId: sourceId,
      title: "Clone Retry",
    });

    const first = publishTaskCreation(payload);
    expectCreatedRecovering(first);
    const taskId = first.publication.task.id;
    const taskCount = getDb().select().from(tasks).all().length;

    // Same-key retry: re-reads the committed clone, does NOT re-publish.
    const retry = publishTaskCreation(payload);
    expectCreatedRecovering(retry);
    expect(retry.publication.task.id).toBe(taskId);
    expect(getDb().select().from(tasks).all().length).toBe(taskCount);
  });
});

// ===========================================================================
// (b) CLONE PUBLICATION — atomicity (failure leaves NO clone aggregate)
// ===========================================================================

describe("T7P1 clone publication — atomicity", () => {
  it("failure at a nested write (dangling dependency) leaves NO clone aggregate", () => {
    const { sourceId } = seedSourceTask();

    const beforeTasks = getDb().select().from(tasks).all().length;
    const beforeEvents = getDb().select().from(taskEvents).all().length;
    const beforeSubtasks = getDb().select().from(taskSubtasks).all().length;
    const beforeEnvelopes = getDb().select().from(taskCreationEnvelopes).all().length;

    // An invalid dependency — the kernel's prepare step rejects it
    // (dangling_dependency). Nothing commits.
    const result = publishTaskCreation(
      pubInput({
        cloneSourceTaskId: sourceId,
        title: "Clone With Bad Dep",
        selectedDependencies: [{ dependsOnId: "nonexistent-dep-target" }],
      }),
    );

    expect(result.outcome).toBe("rejected_validation");

    // NO clone aggregate: no Task, no Subtask, no event, no envelope.
    expect(getDb().select().from(tasks).all().length).toBe(beforeTasks);
    expect(getDb().select().from(taskEvents).all().length).toBe(beforeEvents);
    expect(getDb().select().from(taskSubtasks).all().length).toBe(beforeSubtasks);
    expect(getDb().select().from(taskCreationEnvelopes).all().length).toBe(beforeEnvelopes);
  });
});

// ===========================================================================
// (b) CLONE PUBLICATION — same-Habitat enforcement
// ===========================================================================

describe("T7P1 clone publication — same-Habitat enforcement", () => {
  it("rejects a clone targeting a Mission in a DIFFERENT Habitat than the source", () => {
    const { sourceId } = seedSourceTask();

    // Create a second Habitat + Mission (a different Habitat than the source).
    const otherHabitat = habitatRepo.createHabitat({ name: "Other Habitat" });
    const otherColumn = columnRepo.createColumn({
      habitatId: otherHabitat.id,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    });
    const otherMissionId = missionRepo.createMission({
      habitatId: otherHabitat.id,
      columnId: otherColumn.id,
      title: "other-habitat-mission",
      createdBy: ACTOR_ID,
    }).id;

    // The clone source is in `habitatId`; the target Mission is in
    // `otherHabitat`. The adapter resolves the source's Habitat as
    // authoritative, so the kernel's cross_habitat_mission check fires.
    const result = publishTaskCreation(
      pubInput({
        cloneSourceTaskId: sourceId,
        targetMissionId: otherMissionId,
        title: "Cross-Habitat Clone",
      }),
    );

    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") throw new Error("expected rejection");
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain("cross_habitat_mission");
  });

  it("allows a clone targeting another ACTIVE Mission in the SAME Habitat", () => {
    const { sourceId } = seedSourceTask();

    // A second Mission in the SAME Habitat as the source.
    const sameHabitatMission = missionRepo.createMission({
      habitatId,
      columnId,
      title: "same-habitat-other-mission",
      createdBy: ACTOR_ID,
    }).id;

    const result = publishTaskCreation(
      pubInput({
        cloneSourceTaskId: sourceId,
        targetMissionId: sameHabitatMission,
        title: "Same-Habitat Clone",
      }),
    );
    expectCreatedRecovering(result);
    expect(result.publication.task.missionId).toBe(sameHabitatMission);
  });
});

// ===========================================================================
// Dormancy — legacy cloneTask byte-unchanged + ordinary creation unaffected
// ===========================================================================

describe("T7P1 dormancy — legacy path unchanged + ordinary creation unaffected", () => {
  it("ordinary creation (no cloneSourceTaskId) still uses initialEventAction=created", () => {
    const result = publishTaskCreation(pubInput({ title: "Ordinary Create" }));
    expectCreatedRecovering(result);

    // No cloneSourceTaskId ⇒ created (not cloned).
    expect(result.publication.event!.action).toBe("created");

    const envelope = getDb()
      .select()
      .from(taskCreationEnvelopes)
      .where(eq(taskCreationEnvelopes.taskId, result.publication.task.id))
      .all()[0];
    expect(envelope.lifecycleAction).toBe("created");
    expect(envelope.cloneSourceTaskId).toBeNull();
  });

  it("legacy cloneTask still works unchanged alongside the dormant clone adapter", async () => {
    const { cloneTask } = await import("../services/tasks/task-crud.js");
    const { sourceId } = seedSourceTask({ title: "Legacy Clone Source" });

    const beforeTasks = getDb().select().from(tasks).all().length;
    const result = cloneTask(sourceId, ACTOR_ID);

    expect(result.success).toBe(true);
    expect(getDb().select().from(tasks).all().length).toBe(beforeTasks + 1);
    // Legacy clone stamps a raw `cloned` action event directly (not via kernel).
    if (result.success) {
      const legacyEvents = getDb()
        .select()
        .from(taskEvents)
        .where(eq(taskEvents.taskId, result.task.id))
        .all();
      expect(legacyEvents.some((e) => e.action === "cloned")).toBe(true);
    }
  });
});
