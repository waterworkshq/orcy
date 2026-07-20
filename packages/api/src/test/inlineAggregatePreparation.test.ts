/**
 * T9A-10 M1 Phase 1 — `prepareInlineAggregate` focused tests.
 *
 * Proves the four preparation guarantees (mirrors the template path's
 * `templateAggregatePreparation.test.ts`):
 *  (a) SHAPE — produces the complete prepared-aggregate shape (prospective
 *      Mission data + N canonical Task proposals in the kernel's
 *      CanonicalTaskPublicationProposal shape + per-Task guards + aggregate
 *      guard). NO Workflow (always null). NO usage descriptor.
 *  (b) PURITY — performs no writes (asserts no Mission/Task rows created).
 *  (c) REJECTION — the validation-rejection path returns
 *      `{ outcome: "rejected_validation" }` without throwing. The
 *      `empty_tasks_template` gate surfaces the degenerate zero-task case
 *      as a config error rather than producing a zero-task Mission.
 *  (d) CHARACTERIZATION — the proposals this PURE function produces match
 *      what the legacy `createMissionFromSchedule:103-133` would have
 *      inserted (modulo the kernel's per-Task additions: `created` event,
 *      `creationIntegrity: POST_CUTOVER`, governance history). The
 *      PRESERVE guarantee the inline publisher builds on.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import { missions, tasks, columns as columnsTable, habitats } from "../db/schema/index.js";
import { sql } from "drizzle-orm";
import type { AuditActorRef, AuditSource, TaskPriority, TaskTemplateEntry } from "@orcy/shared";
import {
  prepareInlineAggregate,
  INLINE_AGGREGATE_CAUSAL_ROOT_TYPE,
  type PrepareInlineAggregateContext,
} from "../services/inlineAggregatePreparation.js";

let habitatId: string;
let columnId: string;

const SYSTEM_ACTOR: AuditActorRef = { type: "system", id: "scheduler" };
const SYSTEM_SOURCE = "scheduler" as AuditSource;

function makeCtx(actor: AuditActorRef = SYSTEM_ACTOR): PrepareInlineAggregateContext {
  return { actor, auditSource: SYSTEM_SOURCE };
}

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();

  const habitat = habitatRepo.createHabitat({ name: "Inline Aggregate Test Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Backlog",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
});

afterEach(() => {
  closeDb();
});

/** Representative tasksTemplate (3 tasks, mixed optionality). */
function typicalTasksTemplate(): TaskTemplateEntry[] {
  return [
    {
      title: "Setup",
      description: "Initialize the work",
      priority: "high" as TaskPriority,
      order: 0,
      estimatedMinutes: 30,
    },
    {
      title: "Implementation",
      priority: "medium" as TaskPriority,
      order: 1,
      estimatedMinutes: 120,
    },
    {
      title: "Testing",
      description: "Write tests",
      priority: "medium" as TaskPriority,
      order: 2,
      requiredDomain: "qa",
    },
  ];
}

// ---------------------------------------------------------------------------
// (a) SHAPE — the prepared aggregate carries every component the publisher needs
// ---------------------------------------------------------------------------

describe("prepareInlineAggregate — (a) aggregate shape", () => {
  it("produces a prepared aggregate with mission + N tasks + null workflow + guard (NO usageMutation)", () => {
    const entries = typicalTasksTemplate();

    const result = prepareInlineAggregate(
      habitatId,
      entries,
      {
        title: "Inline Mission",
        description: "## Goal",
        priority: "high" as TaskPriority,
        labels: ["scheduled", "inline"],
      },
      makeCtx(),
    );

    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;

    const { aggregate } = result;
    // Mission data
    expect(aggregate.mission).toBeDefined();
    expect(aggregate.mission.missionId).toEqual(expect.any(String));
    expect(aggregate.mission.habitatId).toBe(habitatId);
    expect(aggregate.mission.columnId).toBe(columnId);
    expect(aggregate.mission.title).toBe("Inline Mission");
    expect(aggregate.mission.description).toBe("## Goal");
    expect(aggregate.mission.priority).toBe("high");
    expect(aggregate.mission.labels).toEqual(["scheduled", "inline"]);
    expect(aggregate.mission.createdBy).toBe("scheduler");

    // Tasks: one per template entry, each carrying the kernel proposal shape
    expect(aggregate.tasks).toHaveLength(3);
    for (const pt of aggregate.tasks) {
      expect(pt.proposal.prospectiveTaskId).toEqual(expect.any(String));
      expect(pt.proposal.targetMissionId).toBe(aggregate.mission.missionId);
      expect(pt.proposal.habitatId).toBe(habitatId);
      // Inline path hardcodes labels: [] (no labels on TaskTemplateEntry).
      expect(pt.proposal.labels).toEqual([]);
      // Inline path always uses the `created` initialEventAction (matches
      // the template path + the kernel's contract for a fresh publication).
      expect(pt.proposal.initialEventAction).toBe("created");
      // Inline templates do not author subtasks, dependencies, or assignments.
      expect(pt.proposal.subtasks).toEqual([]);
      expect(pt.proposal.selectedDependencies).toEqual([]);
      expect(pt.proposal.requestedAssigneeId).toBeNull();
      expect(pt.proposal.cloneSourceTaskId).toBeNull();
      // Per-Task guard snapshots the prospective mission
      expect(pt.guard.missionId).toBe(aggregate.mission.missionId);
      expect(pt.guard.missionVersion).toBe(1);
      expect(pt.guard.missionStatus).toBe("not_started");
      expect(pt.guard.habitatId).toBe(habitatId);
      expect(pt.guard.dependencies).toEqual([]);
      // Per-Task inlineEntryMetadata carries the entry's initialStatus + order
      expect(pt.inlineEntryMetadata).toBeDefined();
    }

    // Explicit entry → metadata mapping
    expect(aggregate.tasks[0].inlineEntryMetadata.initialStatus).toBe("pending");
    expect(aggregate.tasks[0].inlineEntryMetadata.order).toBe(0);
    expect(aggregate.tasks[2].inlineEntryMetadata.order).toBe(2);

    // The kernel proposal carries the entry's requiredDomain + capabilities
    expect(aggregate.tasks[2].proposal.requiredDomain).toBe("qa");
    expect(aggregate.tasks[0].proposal.estimatedMinutes).toBe(30);

    // Workflow: always null for the inline path
    expect(aggregate.workflow).toBeNull();

    // Guard: the aggregate-level guard (habitat + column + displayOrder)
    expect(aggregate.guard.habitatId).toBe(habitatId);
    expect(aggregate.guard.columnId).toBe(columnId);
    expect(aggregate.guard.computedDisplayOrder).toEqual(expect.any(Number));

    // NO usageMutation field on the inline aggregate (distinct from the
    // template path's `usageMutation: { templateId }`).
    expect((aggregate as { usageMutation?: unknown }).usageMutation).toBeUndefined();
  });

  it("each prospective task ID is unique and distinct from the mission ID", () => {
    const result = prepareInlineAggregate(
      habitatId,
      typicalTasksTemplate(),
      {
        title: "T",
        description: "D",
        priority: "medium",
        labels: [],
      },
      makeCtx(),
    );
    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;

    const ids = result.aggregate.tasks.map((t) => t.proposal.prospectiveTaskId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).not.toBe(result.aggregate.mission.missionId);
    }
  });

  it("stamps the inline causal root type when no ctx.causalContext supplied", () => {
    const result = prepareInlineAggregate(
      habitatId,
      typicalTasksTemplate(),
      { title: "T", description: "D", priority: "medium", labels: [] },
      makeCtx(),
    );
    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;
    expect(result.aggregate.tasks[0].proposal.causalContext).toEqual({
      root: {
        type: INLINE_AGGREGATE_CAUSAL_ROOT_TYPE,
        id: result.aggregate.mission.missionId,
      },
    });
  });

  it("respects a caller-supplied causalContext (the occurrence publisher's per-occurrence root)", () => {
    const occurrenceId = "occ-123";
    const result = prepareInlineAggregate(
      habitatId,
      typicalTasksTemplate(),
      { title: "T", description: "D", priority: "medium", labels: [] },
      {
        actor: SYSTEM_ACTOR,
        auditSource: SYSTEM_SOURCE,
        causalContext: { root: { type: "scheduled_occurrence", id: occurrenceId } },
      },
    );
    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;
    expect(result.aggregate.tasks[0].proposal.causalContext).toEqual({
      root: { type: "scheduled_occurrence", id: occurrenceId },
    });
  });
});

// ---------------------------------------------------------------------------
// (b) PURITY (no writes/effects)
// ---------------------------------------------------------------------------

describe("prepareInlineAggregate — (b) purity (no writes)", () => {
  it("creates zero Mission/Task rows", () => {
    const db = getDb();
    const before = {
      missions: db
        .select({ count: sql<number>`COUNT(*)` })
        .from(missions)
        .get()!.count,
      tasks: db
        .select({ count: sql<number>`COUNT(*)` })
        .from(tasks)
        .get()!.count,
    };

    prepareInlineAggregate(
      habitatId,
      typicalTasksTemplate(),
      { title: "T", description: "D", priority: "medium", labels: [] },
      makeCtx(),
    );

    const after = {
      missions: db
        .select({ count: sql<number>`COUNT(*)` })
        .from(missions)
        .get()!.count,
      tasks: db
        .select({ count: sql<number>`COUNT(*)` })
        .from(tasks)
        .get()!.count,
    };
    expect(after.missions).toBe(before.missions);
    expect(after.tasks).toBe(before.tasks);
  });

  it("detaches the labels array from the caller's mutable input", () => {
    const labels = ["a", "b"];
    const result = prepareInlineAggregate(
      habitatId,
      typicalTasksTemplate(),
      { title: "T", description: "D", priority: "medium", labels },
      makeCtx(),
    );
    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;

    // Mutate the caller's array AFTER prep; the prepared aggregate's copy
    // must NOT observe the mutation.
    labels.push("c");
    expect(result.aggregate.mission.labels).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// (c) REJECTION — validate-then-return (never throws)
// ---------------------------------------------------------------------------

describe("prepareInlineAggregate — (c) rejection path", () => {
  it("returns rejected_validation for an EMPTY tasksTemplate (the config-error gate)", () => {
    const result = prepareInlineAggregate(
      habitatId,
      [],
      { title: "T", description: "D", priority: "medium", labels: [] },
      makeCtx(),
    );
    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        field: "tasksTemplate",
        code: "empty_tasks_template",
      }),
    );
  });

  it("returns rejected_validation when the habitat has no columns", () => {
    const db = getDb();
    db.delete(columnsTable).run();

    const result = prepareInlineAggregate(
      habitatId,
      typicalTasksTemplate(),
      { title: "T", description: "D", priority: "medium", labels: [] },
      makeCtx(),
    );
    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        field: "habitatId",
        code: "habitat_has_no_columns",
      }),
    );
  });

  it("returns rejected_validation for an invalid actor (does not throw)", () => {
    const result = prepareInlineAggregate(
      habitatId,
      typicalTasksTemplate(),
      { title: "T", description: "D", priority: "medium", labels: [] },
      { actor: {} as AuditActorRef, auditSource: SYSTEM_SOURCE },
    );
    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "actor", code: "invalid_actor" }),
    );
  });

  it("returns rejected_validation for an empty auditSource (does not throw)", () => {
    const result = prepareInlineAggregate(
      habitatId,
      typicalTasksTemplate(),
      { title: "T", description: "D", priority: "medium", labels: [] },
      { actor: SYSTEM_ACTOR, auditSource: "" as AuditSource },
    );
    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "auditSource", code: "invalid_audit_source" }),
    );
  });

  it("collects MULTIPLE errors in one round-trip (empty tasksTemplate + invalid actor)", () => {
    const result = prepareInlineAggregate(
      habitatId,
      [],
      { title: "T", description: "D", priority: "medium", labels: [] },
      { actor: {} as AuditActorRef, auditSource: SYSTEM_SOURCE },
    );
    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain("empty_tasks_template");
    expect(codes).toContain("invalid_actor");
  });
});

// ---------------------------------------------------------------------------
// (d) CHARACTERIZATION vs legacy createMissionFromSchedule:103-133
//     The proposals this PURE function produces match what the legacy
//     non-atomic loop would have written (modulo the kernel's per-Task
//     additions). The inline publisher builds on this guarantee.
// ---------------------------------------------------------------------------

describe("prepareInlineAggregate — (d) characterization vs legacy createMissionFromSchedule", () => {
  /**
   * Re-implementation of the legacy `createMissionFromSchedule:103-133`
   * write path (the non-atomic loop the inline publisher replaces behind
   * the flag). Used to characterizeize the PURE preparation's output
   * against the legacy write semantics.
   */
  function legacyCreateMissionFromSchedule(
    scheduleOverrides: {
      missionTitle?: string;
      missionDescription?: string;
      missionPriority?: TaskPriority;
      missionLabels?: string[];
      tasksTemplate?: TaskTemplateEntry[];
    } = {},
  ) {
    const missionTitle = scheduleOverrides.missionTitle ?? "Mission";
    const missionDescription = scheduleOverrides.missionDescription ?? "Desc";
    const missionPriority = scheduleOverrides.missionPriority ?? "medium";
    const missionLabels = scheduleOverrides.missionLabels ?? [];
    const tasksTemplate = scheduleOverrides.tasksTemplate ?? typicalTasksTemplate();

    const mission = missionRepo.createMission({
      habitatId,
      columnId,
      title: missionTitle,
      description: missionDescription,
      acceptanceCriteria: "",
      priority: missionPriority,
      labels: missionLabels,
      displayOrder: 0,
      createdBy: "system",
    });

    const createdTasks: {
      title: string;
      description: string;
      priority: TaskPriority;
      requiredDomain: string | null;
      requiredCapabilities: string[];
      estimatedMinutes: number | null;
      order: number | null;
    }[] = [];
    for (const entry of tasksTemplate) {
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: entry.title,
        description: entry.description ?? "",
        priority: entry.priority ?? "medium",
        requiredDomain: entry.requiredDomain ?? null,
        requiredCapabilities: entry.requiredCapabilities ?? [],
        estimatedMinutes: entry.estimatedMinutes ?? null,
        ...(entry.order !== undefined ? { order: entry.order } : {}),
        createdBy: "system",
      });
      createdTasks.push({
        title: task.title,
        description: task.description,
        priority: task.priority,
        requiredDomain: task.requiredDomain,
        requiredCapabilities: task.requiredCapabilities,
        estimatedMinutes: task.estimatedMinutes,
        order: (task as { order: number | null }).order,
      });
    }
    return { mission, tasks: createdTasks };
  }

  it("matches legacy for a plain inline task list", () => {
    const entries = typicalTasksTemplate();
    const title = "Scheduled Mission";
    const description = "Auto-generated";
    const priority = "medium" as TaskPriority;
    const labels = ["scheduled"];

    const legacy = legacyCreateMissionFromSchedule({
      missionTitle: title,
      missionDescription: description,
      missionPriority: priority,
      missionLabels: labels,
      tasksTemplate: entries,
    });

    const result = prepareInlineAggregate(
      habitatId,
      entries,
      { title, description, priority, labels },
      makeCtx(),
    );
    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;

    // Mission shape matches
    expect(result.aggregate.mission.title).toBe(legacy.mission.title);
    expect(result.aggregate.mission.description).toBe(legacy.mission.description);
    expect(result.aggregate.mission.priority).toBe(legacy.mission.priority);
    expect(result.aggregate.mission.labels).toEqual(legacy.mission.labels);
    expect(result.aggregate.mission.habitatId).toBe(legacy.mission.habitatId);
    expect(result.aggregate.mission.columnId).toBe(legacy.mission.columnId);

    // Tasks: one per entry, titles/priorities/domain match the legacy writes
    expect(result.aggregate.tasks).toHaveLength(legacy.tasks.length);
    for (let i = 0; i < legacy.tasks.length; i++) {
      const prepTask = result.aggregate.tasks[i].proposal;
      const legacyTask = legacy.tasks[i];
      expect(prepTask.title).toBe(legacyTask.title);
      expect(prepTask.description).toBe(legacyTask.description);
      expect(prepTask.priority).toBe(legacyTask.priority);
      expect(prepTask.requiredDomain).toBe(legacyTask.requiredDomain);
      expect(prepTask.requiredCapabilities).toEqual(legacyTask.requiredCapabilities);
      expect(prepTask.estimatedMinutes).toBe(legacyTask.estimatedMinutes);
    }
  });

  it("matches legacy for a single-task inline list", () => {
    const entries: TaskTemplateEntry[] = [{ title: "Only Task", description: "single", order: 0 }];
    const legacy = legacyCreateMissionFromSchedule({
      missionTitle: "M",
      missionDescription: "D",
      tasksTemplate: entries,
    });
    const result = prepareInlineAggregate(
      habitatId,
      entries,
      { title: "M", description: "D", priority: "medium", labels: [] },
      makeCtx(),
    );
    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;
    expect(result.aggregate.tasks).toHaveLength(1);
    expect(result.aggregate.tasks[0].proposal.title).toBe(legacy.tasks[0].title);
  });

  it("matches legacy defaults (priority medium, empty description, no domain)", () => {
    // Entry with only `title` — verify defaults match the legacy path.
    const entries: TaskTemplateEntry[] = [{ title: "Bare Task", order: 0 }];
    const legacy = legacyCreateMissionFromSchedule({
      missionTitle: "M",
      missionDescription: "D",
      tasksTemplate: entries,
    });
    const result = prepareInlineAggregate(
      habitatId,
      entries,
      { title: "M", description: "D", priority: "medium", labels: [] },
      makeCtx(),
    );
    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;
    expect(result.aggregate.tasks[0].proposal.priority).toBe("medium");
    expect(result.aggregate.tasks[0].proposal.description).toBe("");
    expect(result.aggregate.tasks[0].proposal.requiredDomain).toBeNull();
    expect(result.aggregate.tasks[0].proposal.requiredCapabilities).toEqual([]);
    expect(result.aggregate.tasks[0].proposal.estimatedMinutes).toBeNull();
    // Legacy defaults match
    expect(legacy.tasks[0].priority).toBe("medium");
    expect(legacy.tasks[0].description).toBe("");
    expect(legacy.tasks[0].requiredDomain).toBeNull();
  });
});
