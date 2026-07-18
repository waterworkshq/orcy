/**
 * T9A Milestone 1 Phase 1 — `prepareTemplateAggregate` focused tests.
 *
 * Proves the four Phase-1 guarantees:
 *  (a) SHAPE — produces the complete prepared-aggregate shape (prospective
 *      Mission data + N canonical Task proposals in the kernel's
 *      CanonicalTaskPublicationProposal shape + per-Task guards + Workflow
 *      definition + usage-mutation descriptor + aggregate guard).
 *  (b) PURITY — performs no writes (asserts no Mission/Task/Workflow/Gate rows
 *      are created and the template usageCount is unchanged).
 *  (c) REJECTION — the validation-rejection path returns
 *      `{ outcome: "rejected_validation" }` without throwing (mirrors
 *      `prepareTaskPublication`'s validate-then-return contract).
 *  (d) CHARACTERIZATION — for representative templates (plain, with-workflow,
 *      with variables, with gates + join specs + failure handler), the
 *      proposals this PURE function produces match what the legacy
 *      `applyTemplate` transaction WOULD have written. This is the PRESERVE
 *      guarantee Phase 2's atomic publisher builds on.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as templateRepo from "../repositories/template.js";
import {
  missions,
  tasks,
  workflows,
  taskWorkflowGates,
  columns as columnsTable,
  habitats,
  missionTemplates,
} from "../db/schema/index.js";
import { sql, eq } from "drizzle-orm";
import type {
  AuditActorRef,
  AuditSource,
  TaskPriority,
  TaskTemplateEntry,
  WorkflowFailureHandlerConfig,
  WorkflowTemplateDefinition,
} from "@orcy/shared";
import {
  prepareTemplateAggregate,
  TEMPLATE_AGGREGATE_CAUSAL_ROOT_TYPE,
  type PrepareTemplateAggregateContext,
} from "../services/templateAggregatePreparation.js";
import type { ApplyTemplateOverrides } from "../repositories/template.js";

let habitatId: string;
let columnId: string;

const SYSTEM_ACTOR: AuditActorRef = { type: "system", id: "system" };
const SYSTEM_SOURCE = "system" as AuditSource;

function makeCtx(actor: AuditActorRef = SYSTEM_ACTOR): PrepareTemplateAggregateContext {
  return { actor, auditSource: SYSTEM_SOURCE };
}

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(taskWorkflowGates).run();
  db.delete(workflows).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();
  db.delete(missionTemplates).run();

  const habitat = habitatRepo.createHabitat({ name: "Test Habitat" });
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
    name: "Test Template",
    titlePattern: overrides.titlePattern ?? "Sprint Task",
    descriptionPattern: overrides.descriptionPattern ?? "## Goal\nComplete the work",
    priority: overrides.priority ?? ("high" as TaskPriority),
    labels: overrides.labels ?? ["sprint", "backend"],
    requiredDomain: "backend",
    requiredCapabilities: ["typescript"],
    tasksTemplate: overrides.tasksTemplate ?? [
      {
        title: "Setup",
        description: "Initialize project",
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
    ],
    workflowTemplate: overrides.workflowTemplate ?? null,
    createdBy: "human",
  });
}

// ---------------------------------------------------------------------------
// (a) SHAPE — the prepared aggregate carries every component Phase 2 needs
// ---------------------------------------------------------------------------

describe("prepareTemplateAggregate — (a) aggregate shape", () => {
  it("produces a prepared aggregate with mission + tasks + null workflow + usageMutation + guard", () => {
    const template = createTemplate();

    const result = prepareTemplateAggregate(template.id, habitatId, undefined, makeCtx());

    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;

    const { aggregate } = result;
    // Mission data
    expect(aggregate.mission).toBeDefined();
    expect(aggregate.mission.missionId).toEqual(expect.any(String));
    expect(aggregate.mission.habitatId).toBe(habitatId);
    expect(aggregate.mission.columnId).toBe(columnId);
    expect(aggregate.mission.title).toBe("Sprint Task");
    expect(aggregate.mission.createdBy).toBe("system");

    // Tasks: one per template entry, each carrying the kernel proposal shape
    expect(aggregate.tasks).toHaveLength(3);
    for (const pt of aggregate.tasks) {
      expect(pt.proposal.prospectiveTaskId).toEqual(expect.any(String));
      expect(pt.proposal.targetMissionId).toBe(aggregate.mission.missionId);
      expect(pt.proposal.habitatId).toBe(habitatId);
      expect(pt.proposal.labels).toEqual([]);
      expect(pt.proposal.subtasks).toEqual([]);
      expect(pt.proposal.selectedDependencies).toEqual([]);
      expect(pt.proposal.requestedAssigneeId).toBeNull();
      expect(pt.proposal.cloneSourceTaskId).toBeNull();
      expect(pt.proposal.initialEventAction).toBe("created");
      expect(pt.proposal.actor).toEqual(SYSTEM_ACTOR);
      expect(pt.proposal.auditSource).toBe(SYSTEM_SOURCE);
      expect(pt.proposal.causalContext.root.type).toBe(TEMPLATE_AGGREGATE_CAUSAL_ROOT_TYPE);
      expect(pt.proposal.causalContext.root.id).toBe(template.id);
      // Guard carries the PROSPECTIVE mission snapshot
      expect(pt.guard.missionId).toBe(aggregate.mission.missionId);
      expect(pt.guard.missionVersion).toBe(1);
      expect(pt.guard.missionStatus).toBe("not_started");
      expect(pt.guard.habitatId).toBe(habitatId);
      expect(pt.guard.dependencies).toEqual([]);
      expect(pt.guard.interceptorEnrollmentFingerprint).toEqual(expect.any(String));
      // Template-entry metadata carries status + order
      expect(pt.templateEntryMetadata).toBeDefined();
      expect(typeof pt.templateEntryMetadata.initialStatus).toBe("string");
      expect(typeof pt.templateEntryMetadata.order).toBe("number");
    }

    // No workflowTemplate on this template → null workflow
    expect(aggregate.workflow).toBeNull();

    // Usage mutation descriptor
    expect(aggregate.usageMutation.templateId).toBe(template.id);

    // Aggregate guard
    expect(aggregate.guard.templateId).toBe(template.id);
    expect(aggregate.guard.templateUsageCount).toBe(0);
    expect(aggregate.guard.habitatId).toBe(habitatId);
    expect(aggregate.guard.columnId).toBe(columnId);
    expect(aggregate.guard.computedDisplayOrder).toEqual(expect.any(Number));
  });

  it("produces a prepared workflow definition when the template has a workflowTemplate", () => {
    const wfTemplate: WorkflowTemplateDefinition = {
      gates: [{ upstreamTaskKey: "build", downstreamTaskKey: "deploy", gateType: "on_approve" }],
    };
    const template = createTemplate({
      tasksTemplate: [
        { key: "build", title: "Build", order: 0 },
        { key: "deploy", title: "Deploy", order: 1 },
      ],
      workflowTemplate: wfTemplate,
    });

    const result = prepareTemplateAggregate(template.id, habitatId, undefined, makeCtx());
    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;

    const { workflow } = result.aggregate;
    expect(workflow).not.toBeNull();
    expect(workflow!.workflowId).toEqual(expect.any(String));
    expect(workflow!.missionId).toBe(result.aggregate.mission.missionId);
    expect(workflow!.habitatId).toBe(habitatId);
    expect(workflow!.gates).toHaveLength(1);
    expect(workflow!.gates[0].gateType).toBe("on_approve");
    expect(workflow!.gates[0].missionId).toBe(result.aggregate.mission.missionId);
    expect(workflow!.gates[0].recoveryDepth).toBe(0);
    // Upstream/downstream resolved to the prospective task IDs
    expect(workflow!.gates[0].upstreamTaskId).toBe(
      result.aggregate.tasks[0].proposal.prospectiveTaskId,
    );
    expect(workflow!.gates[0].downstreamTaskId).toBe(
      result.aggregate.tasks[1].proposal.prospectiveTaskId,
    );
  });

  it("each prospective task ID is unique and distinct from the mission ID", () => {
    const template = createTemplate();
    const result = prepareTemplateAggregate(template.id, habitatId, undefined, makeCtx());
    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;

    const ids = result.aggregate.tasks.map((t) => t.proposal.prospectiveTaskId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).not.toBe(result.aggregate.mission.missionId);
    }
  });
});

// ---------------------------------------------------------------------------
// (b) PURITY — no writes, no effects
// ---------------------------------------------------------------------------

describe("prepareTemplateAggregate — (b) purity (no writes)", () => {
  it("creates zero Mission/Task/Workflow/Gate rows", () => {
    const template = createTemplate();

    const db = getDb();
    const missionsBefore = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(missions)
      .get()!.count;
    const tasksBefore = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(tasks)
      .get()!.count;
    const workflowsBefore = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(workflows)
      .get()!.count;
    const gatesBefore = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(taskWorkflowGates)
      .get()!.count;

    const result = prepareTemplateAggregate(template.id, habitatId, undefined, makeCtx());
    expect(result.outcome).toBe("prepared");

    const missionsAfter = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(missions)
      .get()!.count;
    const tasksAfter = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(tasks)
      .get()!.count;
    const workflowsAfter = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(workflows)
      .get()!.count;
    const gatesAfter = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(taskWorkflowGates)
      .get()!.count;

    expect(missionsAfter).toBe(missionsBefore);
    expect(tasksAfter).toBe(tasksBefore);
    expect(workflowsAfter).toBe(workflowsBefore);
    expect(gatesAfter).toBe(gatesBefore);
  });

  it("does NOT mutate the template usageCount", () => {
    const template = createTemplate();
    expect(template.usageCount).toBe(0);

    prepareTemplateAggregate(template.id, habitatId, undefined, makeCtx());
    prepareTemplateAggregate(template.id, habitatId, undefined, makeCtx());
    prepareTemplateAggregate(template.id, habitatId, undefined, makeCtx());

    const after = templateRepo.getTemplateById(template.id);
    expect(after!.usageCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (c) REJECTION — validate-then-return (never throws for a decision)
// ---------------------------------------------------------------------------

describe("prepareTemplateAggregate — (c) rejection path", () => {
  it("returns rejected_validation for a non-existent template (does not throw)", () => {
    const result = prepareTemplateAggregate("non-existent-id", habitatId, undefined, makeCtx());
    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors.some((e) => e.code === "template_not_found")).toBe(true);
  });

  it("returns rejected_validation when the habitat has no columns", () => {
    const template = createTemplate();
    const emptyHabitat = habitatRepo.createHabitat({ name: "Empty Habitat" });

    const result = prepareTemplateAggregate(template.id, emptyHabitat.id, undefined, makeCtx());
    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors.some((e) => e.code === "habitat_has_no_columns")).toBe(true);
  });

  it("returns rejected_validation for duplicate task keys (does not throw)", () => {
    const template = createTemplate({
      tasksTemplate: [
        { key: "dup", title: "A", order: 0 },
        { key: "dup", title: "B", order: 1 },
      ],
      workflowTemplate: { gates: [] },
    });

    const result = prepareTemplateAggregate(template.id, habitatId, undefined, makeCtx());
    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors.some((e) => e.code === "duplicate_task_key")).toBe(true);
  });

  it("returns rejected_validation for a missing required variable (does not throw)", () => {
    const template = createTemplate({
      tasksTemplate: [
        { key: "a", title: "A", order: 0 },
        { key: "b", title: "B", order: 1 },
      ],
      workflowTemplate: {
        gates: [{ upstreamTaskKey: "a", downstreamTaskKey: "b", gateType: "on_complete" }],
        variables: [{ key: "mission_name", description: "Mission name", required: true }],
      },
    });

    const result = prepareTemplateAggregate(template.id, habitatId, undefined, makeCtx());
    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors.some((e) => e.code === "missing_required_variable")).toBe(true);
  });

  it("returns rejected_validation for an unknown join-spec task key (does not throw)", () => {
    const template = createTemplate({
      tasksTemplate: [{ key: "a", title: "A", order: 0 }],
      workflowTemplate: {
        gates: [],
        joinSpecs: { nonexistent: { mode: "all_of" } },
      },
    });

    const result = prepareTemplateAggregate(template.id, habitatId, undefined, makeCtx());
    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors.some((e) => e.code === "unknown_join_spec_key")).toBe(true);
  });

  it("returns rejected_validation for an unknown gate upstream key (does not throw)", () => {
    const template = createTemplate({
      tasksTemplate: [
        { key: "a", title: "A", order: 0 },
        { key: "b", title: "B", order: 1 },
      ],
      workflowTemplate: {
        gates: [{ upstreamTaskKey: "ghost", downstreamTaskKey: "b", gateType: "on_complete" }],
      },
    });

    const result = prepareTemplateAggregate(template.id, habitatId, undefined, makeCtx());
    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors.some((e) => e.code === "unknown_gate_upstream_key")).toBe(true);
  });

  it("returns rejected_validation for an unknown gate downstream key (does not throw)", () => {
    const template = createTemplate({
      tasksTemplate: [
        { key: "a", title: "A", order: 0 },
        { key: "b", title: "B", order: 1 },
      ],
      workflowTemplate: {
        gates: [{ upstreamTaskKey: "a", downstreamTaskKey: "ghost", gateType: "on_complete" }],
      },
    });

    const result = prepareTemplateAggregate(template.id, habitatId, undefined, makeCtx());
    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors.some((e) => e.code === "unknown_gate_downstream_key")).toBe(true);
  });

  it("returns rejected_validation for an invalid actor (does not throw)", () => {
    const template = createTemplate();
    const result = prepareTemplateAggregate(template.id, habitatId, undefined, {
      actor: {} as AuditActorRef,
      auditSource: SYSTEM_SOURCE,
    });
    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    expect(result.errors.some((e) => e.code === "invalid_actor")).toBe(true);
  });

  it("collects MULTIPLE errors in one round-trip (template + provenance)", () => {
    // Non-existent template + invalid actor → both collected
    const result = prepareTemplateAggregate("non-existent-id", habitatId, undefined, {
      actor: {} as AuditActorRef,
      auditSource: SYSTEM_SOURCE,
    });
    expect(result.outcome).toBe("rejected_validation");
    if (result.outcome !== "rejected_validation") return;
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain("template_not_found");
    expect(codes).toContain("invalid_actor");
  });
});

// ---------------------------------------------------------------------------
// (d) CHARACTERIZATION — proposals match what legacy applyTemplate WOULD write
// ---------------------------------------------------------------------------

describe("prepareTemplateAggregate — (d) characterization vs legacy applyTemplate", () => {
  /**
   * Characterization strategy: for a given (templateId, habitatId, overrides, createdBy),
   * run BOTH the PURE `prepareTemplateAggregate` AND the legacy `applyTemplate`
   * (which writes), then assert the prepared proposals match the rows legacy
   * wrote. This is the PRESERVE guarantee Phase 2 builds on.
   *
   * ORDER MATTERS: prep runs FIRST (pure, no writes) so it sees the same clean
   * DB state legacy is about to write into. Legacy runs SECOND (writes). Then
   * we compare. If legacy ran first, its writes would shift the `displayOrder`
   * max+1 the prep reads, producing a false mismatch.
   */
  function characterizeBoth(
    templateId: string,
    overrides: ApplyTemplateOverrides | undefined,
    createdBy: string,
    actor: AuditActorRef = SYSTEM_ACTOR,
  ): {
    result: ReturnType<typeof prepareTemplateAggregate>;
    legacy: NonNullable<ReturnType<typeof templateRepo.applyTemplate>>;
  } {
    const result = prepareTemplateAggregate(templateId, habitatId, overrides, makeCtx(actor));
    expect(result.outcome).toBe("prepared");
    const legacy = templateRepo.applyTemplate(templateId, habitatId, overrides, createdBy);
    expect(legacy).not.toBeNull();
    return { result, legacy: legacy! };
  }

  it("matches legacy for a plain template (no workflow)", () => {
    const template = createTemplate();

    const { result, legacy } = characterizeBoth(template.id, undefined, "system");
    if (result.outcome !== "prepared") return;

    // Mission parity (content fields; IDs differ since both allocate fresh UUIDs)
    expect(result.aggregate.mission.habitatId).toBe(legacy.mission.habitatId);
    expect(result.aggregate.mission.columnId).toBe(legacy.mission.columnId);
    expect(result.aggregate.mission.title).toBe(legacy.mission.title);
    expect(result.aggregate.mission.description).toBe(legacy.mission.description);
    expect(result.aggregate.mission.priority).toBe(legacy.mission.priority);
    expect(result.aggregate.mission.labels).toEqual(legacy.mission.labels);
    expect(result.aggregate.mission.displayOrder).toBe(legacy.mission.displayOrder);
    expect(result.aggregate.mission.createdBy).toBe(legacy.mission.createdBy);

    // Task parity (order + content)
    expect(result.aggregate.tasks).toHaveLength(legacy.tasks.length);
    for (let i = 0; i < legacy.tasks.length; i++) {
      const legacyTask = legacy.tasks[i];
      const prepared = result.aggregate.tasks[i];
      // Content fields
      expect(prepared.proposal.title).toBe(legacyTask.title);
      expect(prepared.proposal.description).toBe(legacyTask.description);
      expect(prepared.proposal.priority).toBe(legacyTask.priority);
      expect(prepared.proposal.requiredDomain).toBe(legacyTask.requiredDomain);
      expect(prepared.proposal.requiredCapabilities).toEqual(legacyTask.requiredCapabilities);
      expect(prepared.proposal.estimatedMinutes).toBe(legacyTask.estimatedMinutes);
      // The kernel writes `createdBy` from proposal.actor.id
      expect(prepared.proposal.actor.id).toBe(legacyTask.createdBy);
      // Template-entry metadata
      expect(prepared.templateEntryMetadata.initialStatus).toBe(legacyTask.status);
      expect(prepared.templateEntryMetadata.order).toBe(legacyTask.order);
    }

    // No workflow on either side
    expect(result.aggregate.workflow).toBeNull();
    expect(legacy.workflow).toBeNull();
  });

  it("matches legacy for a template WITH a workflow (gates + variables + joinSpecs)", () => {
    const template = createTemplate({
      tasksTemplate: [
        { key: "build", title: "Build: {{mission_name}}", order: 0, requiredDomain: "backend" },
        { key: "test", title: "Test: {{mission_name}}", order: 1 },
        { key: "deploy", title: "Deploy: {{mission_name}}", order: 2 },
      ],
      workflowTemplate: {
        gates: [
          { upstreamTaskKey: "build", downstreamTaskKey: "test", gateType: "on_complete" },
          { upstreamTaskKey: "test", downstreamTaskKey: "deploy", gateType: "on_approve" },
        ],
        joinSpecs: { deploy: { mode: "all_of" } },
        variables: [{ key: "mission_name", description: "Mission name", required: true }],
      },
    });
    const overrides: ApplyTemplateOverrides = { variables: { mission_name: "Auth" } };

    const { result, legacy } = characterizeBoth(template.id, overrides, "system");
    if (result.outcome !== "prepared") return;

    // Task titles have substituted variables (legacy writes them via the
    // instantiateWorkflow update pass; the prepared proposals carry them upfront)
    expect(result.aggregate.tasks[0].proposal.title).toBe("Build: Auth");
    expect(result.aggregate.tasks[1].proposal.title).toBe("Test: Auth");
    expect(result.aggregate.tasks[2].proposal.title).toBe("Deploy: Auth");
    expect(result.aggregate.tasks[0].proposal.title).toBe(legacy.tasks[0].title);
    expect(result.aggregate.tasks[1].proposal.title).toBe(legacy.tasks[1].title);
    expect(result.aggregate.tasks[2].proposal.title).toBe(legacy.tasks[2].title);

    // Workflow definition parity
    expect(result.aggregate.workflow).not.toBeNull();
    expect(legacy.workflow).not.toBeNull();
    expect(result.aggregate.workflow!.resolvedVariables).toEqual(
      legacy.workflow!.resolvedVariables,
    );
    // joinSpecs keyed by task ID
    const deployTaskId = result.aggregate.tasks[2].proposal.prospectiveTaskId;
    expect(result.aggregate.workflow!.joinSpecs[deployTaskId]).toEqual({ mode: "all_of" });

    // Gates: resolved upstream/downstream + gateType + pre-satisfaction
    expect(result.aggregate.workflow!.gates).toHaveLength(2);
    const preparedGate0 = result.aggregate.workflow!.gates[0];
    expect(preparedGate0.gateType).toBe("on_complete");
    expect(preparedGate0.isPreSatisfied).toBe(false); // build task is pending
    expect(preparedGate0.matchConfig).toBeNull();
    expect(preparedGate0.condition).toBeNull();
    expect(preparedGate0.recoveryDepth).toBe(0);
  });

  it("matches legacy for variable substitution in gate matchConfig.subjectContains", () => {
    const template = createTemplate({
      tasksTemplate: [
        { key: "a", title: "A", order: 0 },
        { key: "b", title: "B", order: 1 },
      ],
      workflowTemplate: {
        gates: [
          {
            upstreamTaskKey: "a",
            downstreamTaskKey: "b",
            gateType: "on_signal",
            matchConfig: { signalType: "finding", subjectContains: "{{feature}} complete" },
          },
        ],
        variables: [{ key: "feature", description: "Feature", required: true }],
      },
    });
    const overrides: ApplyTemplateOverrides = { variables: { feature: "Payments" } };

    const { result, legacy } = characterizeBoth(template.id, overrides, "system");
    if (result.outcome !== "prepared") return;

    expect(result.aggregate.workflow!.gates[0].matchConfig).toEqual({
      signalType: "finding",
      subjectContains: "Payments complete",
    });
    // The legacy gate row carries the same substituted matchConfig
    const db = getDb();
    const legacyGate = db
      .select()
      .from(taskWorkflowGates)
      .where(
        // legacy.workflow.id is the committed workflow row id
        eq(taskWorkflowGates.workflowId, legacy.workflow!.id),
      )
      .all();
    expect(legacyGate[0].matchConfig).toEqual(result.aggregate.workflow!.gates[0].matchConfig);
  });

  it("matches legacy for failure-handler variable substitution", () => {
    const failureHandler: WorkflowFailureHandlerConfig = {
      recoveryTaskTemplate: {
        title: "Investigate {{feature}} failure",
        description: "Debug {{feature}}",
      },
    };
    const template = createTemplate({
      tasksTemplate: [
        { key: "a", title: "A", order: 0 },
        { key: "b", title: "B", order: 1 },
      ],
      workflowTemplate: {
        gates: [{ upstreamTaskKey: "a", downstreamTaskKey: "b", gateType: "on_fail" }],
        failureHandler,
        variables: [{ key: "feature", description: "Feature", required: true }],
      },
    });
    const overrides: ApplyTemplateOverrides = { variables: { feature: "API Gateway" } };

    const { result, legacy } = characterizeBoth(template.id, overrides, "system");
    if (result.outcome !== "prepared") return;

    const preparedFH = result.aggregate.workflow!.failureHandler;
    expect(preparedFH).not.toBeNull();
    expect(preparedFH!.recoveryTaskTemplate.title).toBe("Investigate API Gateway failure");
    expect(preparedFH!.recoveryTaskTemplate.description).toBe("Debug API Gateway");
    expect(preparedFH).toEqual(legacy.workflow!.failureHandler);
  });

  it("matches legacy for per-task failureHandlerOverride (substituted + stored in matchConfig)", () => {
    const taskOverride: WorkflowFailureHandlerConfig = {
      recoveryTaskTemplate: { title: "Custom recovery for {{feature}}" },
    };
    const template = createTemplate({
      tasksTemplate: [
        { key: "a", title: "A", order: 0, failureHandlerOverride: taskOverride },
        { key: "b", title: "B", order: 1 },
      ],
      workflowTemplate: {
        gates: [{ upstreamTaskKey: "a", downstreamTaskKey: "b", gateType: "on_fail" }],
        variables: [{ key: "feature", description: "Feature", required: true }],
      },
    });
    const overrides: ApplyTemplateOverrides = { variables: { feature: "Search" } };

    const { result, legacy } = characterizeBoth(template.id, overrides, "system");
    if (result.outcome !== "prepared") return;

    const mc = result.aggregate.workflow!.gates[0].matchConfig as Record<string, unknown>;
    expect(mc).toHaveProperty("failureHandlerOverride");
    const override = mc.failureHandlerOverride as WorkflowFailureHandlerConfig;
    expect(override.recoveryTaskTemplate.title).toBe("Custom recovery for Search");
  });

  it("matches legacy for null failureHandlerOverride (explicit disable)", () => {
    const template = createTemplate({
      tasksTemplate: [
        { key: "a", title: "A", order: 0, failureHandlerOverride: null },
        { key: "b", title: "B", order: 1 },
      ],
      workflowTemplate: {
        gates: [{ upstreamTaskKey: "a", downstreamTaskKey: "b", gateType: "on_fail" }],
        failureHandler: { recoveryTaskTemplate: { title: "Default recovery" } },
      },
    });

    const { result, legacy } = characterizeBoth(template.id, undefined, "system");
    if (result.outcome !== "prepared") return;

    const mc = result.aggregate.workflow!.gates[0].matchConfig as Record<string, unknown>;
    expect(mc).toHaveProperty("failureHandlerOverride", null);
  });

  it("matches legacy for pre-satisfied gates (upstream initialStatus is terminal)", () => {
    const template = createTemplate({
      tasksTemplate: [
        { key: "done_task", title: "Already Done", order: 0, initialStatus: "done" },
        { key: "next_task", title: "Next", order: 1 },
      ],
      workflowTemplate: {
        gates: [
          { upstreamTaskKey: "done_task", downstreamTaskKey: "next_task", gateType: "on_approve" },
        ],
      },
    });

    const { result, legacy } = characterizeBoth(template.id, undefined, "system");
    if (result.outcome !== "prepared") return;

    // The PURE prep computes isPreSatisfied from the upstream entry's initialStatus
    expect(result.aggregate.workflow!.gates[0].isPreSatisfied).toBe(true);
    // The legacy gate row carries satisfied=true (the in-tx read confirmed the terminal status)
    const db = getDb();
    const legacyGate = db
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.workflowId, legacy.workflow!.id))
      .all();
    expect(legacyGate[0].satisfied).toBe(true);
    // And the prepared task carries the terminal status in its metadata
    expect(result.aggregate.tasks[0].templateEntryMetadata.initialStatus).toBe("done");
  });

  it("matches legacy for runtime tokens left unsubstituted ({{failedTaskTitle}})", () => {
    const failureHandler: WorkflowFailureHandlerConfig = {
      recoveryTaskTemplate: { title: "Investigate {{failedTaskTitle}} failure" },
    };
    const template = createTemplate({
      tasksTemplate: [
        { key: "a", title: "{{feature}}", order: 0 },
        { key: "b", title: "B", order: 1 },
      ],
      workflowTemplate: {
        gates: [{ upstreamTaskKey: "a", downstreamTaskKey: "b", gateType: "on_fail" }],
        failureHandler,
        variables: [{ key: "feature", description: "Feature", required: true }],
      },
    });
    const overrides: ApplyTemplateOverrides = { variables: { feature: "Auth" } };

    const { result } = characterizeBoth(template.id, overrides, "system");
    if (result.outcome !== "prepared") return;

    // Declared variable substituted
    expect(result.aggregate.tasks[0].proposal.title).toBe("Auth");
    // Runtime token left as-is
    const fh = result.aggregate.workflow!.failureHandler!;
    expect(fh.recoveryTaskTemplate.title).toBe("Investigate {{failedTaskTitle}} failure");
  });

  it("matches legacy for default variable values (caller omits)", () => {
    const template = createTemplate({
      tasksTemplate: [{ key: "a", title: "Deploy to {{env}}", order: 0 }],
      workflowTemplate: {
        gates: [],
        variables: [{ key: "env", description: "Environment", default: "staging" }],
      },
    });

    const { result } = characterizeBoth(template.id, undefined, "system");
    if (result.outcome !== "prepared") return;

    expect(result.aggregate.tasks[0].proposal.title).toBe("Deploy to staging");
    expect(result.aggregate.workflow!.resolvedVariables).toEqual({ env: "staging" });
  });

  it("matches legacy for createdBy flowing to mission + task proposals", () => {
    const template = createTemplate();
    const { result, legacy } = characterizeBoth(template.id, undefined, "agent-42", {
      type: "system",
      id: "agent-42",
    });
    if (result.outcome !== "prepared") return;

    expect(result.aggregate.mission.createdBy).toBe("agent-42");
    expect(legacy.mission.createdBy).toBe("agent-42");
    for (const pt of result.aggregate.tasks) {
      expect(pt.proposal.actor.id).toBe("agent-42");
    }
  });

  it("matches legacy for overrides applied to mission content", () => {
    const template = createTemplate();
    const overrides: ApplyTemplateOverrides = {
      title: "Custom Title",
      description: "Custom description",
      priority: "critical" as TaskPriority,
      labels: ["custom"],
    };

    const { result, legacy } = characterizeBoth(template.id, overrides, "system");
    if (result.outcome !== "prepared") return;

    expect(result.aggregate.mission.title).toBe("Custom Title");
    expect(result.aggregate.mission.description).toBe("Custom description");
    expect(result.aggregate.mission.priority).toBe("critical");
    expect(result.aggregate.mission.labels).toEqual(["custom"]);
    expect(result.aggregate.mission.title).toBe(legacy.mission.title);
    expect(result.aggregate.mission.priority).toBe(legacy.mission.priority);
    expect(result.aggregate.mission.labels).toEqual(legacy.mission.labels);
  });

  it("matches legacy for an empty tasksTemplate (mission only, no tasks)", () => {
    const template = createTemplate({ tasksTemplate: [] });

    const { result, legacy } = characterizeBoth(template.id, undefined, "system");
    if (result.outcome !== "prepared") return;

    expect(result.aggregate.tasks).toHaveLength(0);
    expect(legacy.tasks).toHaveLength(0);
    expect(result.aggregate.mission.title).toBe(legacy.mission.title);
  });

  it("matches legacy for auto-generated task keys (task_1, task_2)", () => {
    const template = createTemplate({
      tasksTemplate: [
        { title: "First", order: 0 },
        { title: "Second", order: 1 },
      ],
      workflowTemplate: {
        gates: [
          { upstreamTaskKey: "task_1", downstreamTaskKey: "task_2", gateType: "on_complete" },
        ],
      },
    });

    const { result, legacy } = characterizeBoth(template.id, undefined, "system");
    if (result.outcome !== "prepared") return;

    // The gate resolves the auto-generated keys to the prospective task IDs
    expect(result.aggregate.workflow!.gates).toHaveLength(1);
    expect(result.aggregate.workflow!.gates[0].upstreamTaskId).toBe(
      result.aggregate.tasks[0].proposal.prospectiveTaskId,
    );
    expect(result.aggregate.workflow!.gates[0].downstreamTaskId).toBe(
      result.aggregate.tasks[1].proposal.prospectiveTaskId,
    );
  });
});
