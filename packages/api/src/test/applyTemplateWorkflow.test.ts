import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as templateRepo from "../repositories/template.js";
import {
  missionTemplates,
  tasks,
  missions,
  columns as columnsTable,
  habitats,
  workflows,
  taskWorkflowGates,
} from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import type {
  TaskTemplateEntry,
  WorkflowTemplateDefinition,
  WorkflowFailureHandlerConfig,
} from "../models/index.js";

let habitatId: string;

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

  columnRepo.createColumn({ habitatId, name: "Backlog", order: 0, requiresClaim: false });
});

afterEach(() => {
  closeDb();
});

function makeWorkflowTemplate(
  overrides: Partial<WorkflowTemplateDefinition> = {},
): WorkflowTemplateDefinition {
  return {
    gates: [],
    ...overrides,
  };
}

describe("applyTemplate — workflow instantiation", () => {
  it("returns null workflow when template has no workflowTemplate", () => {
    const template = templateRepo.createTemplate({
      habitatId,
      name: "Plain Template",
      titlePattern: "Plain",
      tasksTemplate: [{ title: "Task A", order: 0 }],
      createdBy: "human",
    });

    const result = templateRepo.applyTemplate(template.id, habitatId);

    expect(result).not.toBeNull();
    expect(result!.workflow).toBeNull();
  });

  it("creates a workflow row and gate rows from a simple 2-task template", () => {
    const wfTemplate = makeWorkflowTemplate({
      gates: [{ upstreamTaskKey: "build", downstreamTaskKey: "deploy", gateType: "on_approve" }],
    });

    const template = templateRepo.createTemplate({
      habitatId,
      name: "Build-Deploy",
      titlePattern: "Build and Deploy",
      tasksTemplate: [
        { key: "build", title: "Build", order: 0 },
        { key: "deploy", title: "Deploy", order: 1 },
      ],
      workflowTemplate: wfTemplate,
      createdBy: "human",
    });

    const result = templateRepo.applyTemplate(template.id, habitatId);

    expect(result).not.toBeNull();
    expect(result!.workflow).not.toBeNull();
    expect(result!.workflow!.status).toBe("active");
    expect(result!.workflow!.missionId).toBe(result!.mission.id);
    expect(result!.workflow!.habitatId).toBe(habitatId);

    const db = getDb();
    const gates = db
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.workflowId, result!.workflow!.id))
      .all();
    expect(gates).toHaveLength(1);
    expect(gates[0].gateType).toBe("on_approve");
    expect(gates[0].upstreamTaskId).toBe(result!.tasks[0].id);
    expect(gates[0].downstreamTaskId).toBe(result!.tasks[1].id);
    expect(gates[0].satisfied).toBe(false);
    expect(gates[0].recoveryDepth).toBe(0);
  });

  it("auto-generates task keys when not explicitly set", () => {
    const wfTemplate = makeWorkflowTemplate({
      gates: [{ upstreamTaskKey: "task_1", downstreamTaskKey: "task_2", gateType: "on_complete" }],
    });

    const template = templateRepo.createTemplate({
      habitatId,
      name: "Auto Keys",
      titlePattern: "Auto",
      tasksTemplate: [
        { title: "First", order: 0 },
        { title: "Second", order: 1 },
      ],
      workflowTemplate: wfTemplate,
      createdBy: "human",
    });

    const result = templateRepo.applyTemplate(template.id, habitatId);

    expect(result).not.toBeNull();
    const db = getDb();
    const gates = db
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.workflowId, result!.workflow!.id))
      .all();
    expect(gates).toHaveLength(1);
    expect(gates[0].upstreamTaskId).toBe(result!.tasks[0].id);
    expect(gates[0].downstreamTaskId).toBe(result!.tasks[1].id);
  });

  it("throws on duplicate task keys", () => {
    const wfTemplate = makeWorkflowTemplate({
      gates: [],
    });

    const template = templateRepo.createTemplate({
      habitatId,
      name: "Dup Keys",
      titlePattern: "Dup",
      tasksTemplate: [
        { key: "dup", title: "A", order: 0 },
        { key: "dup", title: "B", order: 1 },
      ],
      workflowTemplate: wfTemplate,
      createdBy: "human",
    });

    expect(() => templateRepo.applyTemplate(template.id, habitatId)).toThrow(
      /Duplicate task key "dup"/,
    );

    const db = getDb();
    const missionCount = db.select().from(missions).all().length;
    expect(missionCount).toBe(0);
  });

  it("throws on missing required variable", () => {
    const wfTemplate = makeWorkflowTemplate({
      gates: [{ upstreamTaskKey: "a", downstreamTaskKey: "b", gateType: "on_complete" }],
      variables: [{ key: "mission_name", description: "Mission name", required: true }],
    });

    const template = templateRepo.createTemplate({
      habitatId,
      name: "Required Var",
      titlePattern: "{{mission_name}}",
      tasksTemplate: [
        { key: "a", title: "A", order: 0 },
        { key: "b", title: "B", order: 1 },
      ],
      workflowTemplate: wfTemplate,
      createdBy: "human",
    });

    expect(() => templateRepo.applyTemplate(template.id, habitatId)).toThrow(
      /Required template variable "mission_name" was not provided/,
    );
  });

  it("resolves variables from caller overrides", () => {
    const wfTemplate = makeWorkflowTemplate({
      gates: [{ upstreamTaskKey: "a", downstreamTaskKey: "b", gateType: "on_complete" }],
      variables: [{ key: "mission_name", description: "Mission name", required: true }],
    });

    const template = templateRepo.createTemplate({
      habitatId,
      name: "Caller Var",
      titlePattern: "Test",
      tasksTemplate: [
        { key: "a", title: "Build: {{mission_name}}", order: 0 },
        { key: "b", title: "Deploy: {{mission_name}}", order: 1 },
      ],
      workflowTemplate: wfTemplate,
      createdBy: "human",
    });

    const result = templateRepo.applyTemplate(template.id, habitatId, {
      variables: { mission_name: "Auth" },
    });

    expect(result).not.toBeNull();
    expect(result!.tasks[0].title).toBe("Build: Auth");
    expect(result!.tasks[1].title).toBe("Deploy: Auth");
    expect(result!.workflow!.resolvedVariables).toEqual({ mission_name: "Auth" });
  });

  it("resolves variables from defaults when caller does not provide", () => {
    const wfTemplate = makeWorkflowTemplate({
      gates: [],
      variables: [{ key: "env", description: "Environment", default: "staging" }],
    });

    const template = templateRepo.createTemplate({
      habitatId,
      name: "Default Var",
      titlePattern: "Test",
      tasksTemplate: [{ key: "a", title: "Deploy to {{env}}", order: 0 }],
      workflowTemplate: wfTemplate,
      createdBy: "human",
    });

    const result = templateRepo.applyTemplate(template.id, habitatId);

    expect(result).not.toBeNull();
    expect(result!.tasks[0].title).toBe("Deploy to staging");
  });

  it("substitutes variables in gate matchConfig.subjectContains", () => {
    const wfTemplate = makeWorkflowTemplate({
      gates: [
        {
          upstreamTaskKey: "a",
          downstreamTaskKey: "b",
          gateType: "on_signal",
          matchConfig: { signalType: "finding", subjectContains: "{{feature}} complete" },
        },
      ],
      variables: [{ key: "feature", description: "Feature", required: true }],
    });

    const template = templateRepo.createTemplate({
      habitatId,
      name: "Match Config Var",
      titlePattern: "Test",
      tasksTemplate: [
        { key: "a", title: "A", order: 0 },
        { key: "b", title: "B", order: 1 },
      ],
      workflowTemplate: wfTemplate,
      createdBy: "human",
    });

    const result = templateRepo.applyTemplate(template.id, habitatId, {
      variables: { feature: "Payments" },
    });

    expect(result).not.toBeNull();
    const db = getDb();
    const gates = db
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.workflowId, result!.workflow!.id))
      .all();
    expect(gates[0].matchConfig).toEqual({
      signalType: "finding",
      subjectContains: "Payments complete",
    });
  });

  it("substitutes variables in workflow-level failure handler recovery template", () => {
    const failureHandler: WorkflowFailureHandlerConfig = {
      recoveryTaskTemplate: {
        title: "Investigate {{feature}} failure",
        description: "Debug {{feature}}",
      },
    };
    const wfTemplate = makeWorkflowTemplate({
      gates: [{ upstreamTaskKey: "a", downstreamTaskKey: "b", gateType: "on_fail" }],
      failureHandler,
      variables: [{ key: "feature", description: "Feature", required: true }],
    });

    const template = templateRepo.createTemplate({
      habitatId,
      name: "FH Var",
      titlePattern: "Test",
      tasksTemplate: [
        { key: "a", title: "A", order: 0 },
        { key: "b", title: "B", order: 1 },
      ],
      workflowTemplate: wfTemplate,
      createdBy: "human",
    });

    const result = templateRepo.applyTemplate(template.id, habitatId, {
      variables: { feature: "API Gateway" },
    });

    expect(result).not.toBeNull();
    const storedHandler = result!.workflow!.failureHandler as WorkflowFailureHandlerConfig | null;
    expect(storedHandler).not.toBeNull();
    expect(storedHandler!.recoveryTaskTemplate.title).toBe("Investigate API Gateway failure");
    expect(storedHandler!.recoveryTaskTemplate.description).toBe("Debug API Gateway");
  });

  it("leaves runtime tokens like {{failedTaskTitle}} unsubstituted", () => {
    const failureHandler: WorkflowFailureHandlerConfig = {
      recoveryTaskTemplate: { title: "Investigate {{failedTaskTitle}} failure" },
    };
    const wfTemplate = makeWorkflowTemplate({
      gates: [{ upstreamTaskKey: "a", downstreamTaskKey: "b", gateType: "on_fail" }],
      failureHandler,
      variables: [{ key: "feature", description: "Feature", required: true }],
    });

    const template = templateRepo.createTemplate({
      habitatId,
      name: "Runtime Token",
      titlePattern: "Test",
      tasksTemplate: [
        { key: "a", title: "{{feature}}", order: 0 },
        { key: "b", title: "B", order: 1 },
      ],
      workflowTemplate: wfTemplate,
      createdBy: "human",
    });

    const result = templateRepo.applyTemplate(template.id, habitatId, {
      variables: { feature: "Auth" },
    });

    expect(result).not.toBeNull();
    expect(result!.tasks[0].title).toBe("Auth");
    const storedHandler = result!.workflow!.failureHandler as WorkflowFailureHandlerConfig | null;
    expect(storedHandler!.recoveryTaskTemplate.title).toBe(
      "Investigate {{failedTaskTitle}} failure",
    );
  });

  it("stores per-task failureHandlerOverride in gate matchConfig", () => {
    const taskOverride: WorkflowFailureHandlerConfig = {
      recoveryTaskTemplate: { title: "Custom recovery for {{feature}}" },
    };
    const wfTemplate = makeWorkflowTemplate({
      gates: [{ upstreamTaskKey: "a", downstreamTaskKey: "b", gateType: "on_fail" }],
      variables: [{ key: "feature", description: "Feature", required: true }],
    });

    const template = templateRepo.createTemplate({
      habitatId,
      name: "Override",
      titlePattern: "Test",
      tasksTemplate: [
        { key: "a", title: "A", order: 0, failureHandlerOverride: taskOverride },
        { key: "b", title: "B", order: 1 },
      ],
      workflowTemplate: wfTemplate,
      createdBy: "human",
    });

    const result = templateRepo.applyTemplate(template.id, habitatId, {
      variables: { feature: "Search" },
    });

    expect(result).not.toBeNull();
    const db = getDb();
    const gates = db
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.workflowId, result!.workflow!.id))
      .all();
    expect(gates[0].matchConfig).toHaveProperty("failureHandlerOverride");
    const mc = gates[0].matchConfig as Record<string, unknown>;
    const override = mc.failureHandlerOverride as WorkflowFailureHandlerConfig;
    expect(override.recoveryTaskTemplate.title).toBe("Custom recovery for Search");
  });

  it("stores per-task failureHandlerOverride null as explicit disable", () => {
    const wfTemplate = makeWorkflowTemplate({
      gates: [{ upstreamTaskKey: "a", downstreamTaskKey: "b", gateType: "on_fail" }],
      failureHandler: { recoveryTaskTemplate: { title: "Default recovery" } },
    });

    const template = templateRepo.createTemplate({
      habitatId,
      name: "Null Override",
      titlePattern: "Test",
      tasksTemplate: [
        { key: "a", title: "A", order: 0, failureHandlerOverride: null },
        { key: "b", title: "B", order: 1 },
      ],
      workflowTemplate: wfTemplate,
      createdBy: "human",
    });

    const result = templateRepo.applyTemplate(template.id, habitatId);

    expect(result).not.toBeNull();
    const db = getDb();
    const gates = db
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.workflowId, result!.workflow!.id))
      .all();
    expect(gates[0].matchConfig).toHaveProperty("failureHandlerOverride", null);
  });

  it("resolves joinSpecs keys from task keys to task IDs", () => {
    const wfTemplate = makeWorkflowTemplate({
      gates: [
        { upstreamTaskKey: "inv1", downstreamTaskKey: "report", gateType: "on_complete" },
        { upstreamTaskKey: "inv2", downstreamTaskKey: "report", gateType: "on_complete" },
      ],
      joinSpecs: { report: { mode: "any_of" } },
    });

    const template = templateRepo.createTemplate({
      habitatId,
      name: "Join",
      titlePattern: "Test",
      tasksTemplate: [
        { key: "inv1", title: "Inv1", order: 0 },
        { key: "inv2", title: "Inv2", order: 1 },
        { key: "report", title: "Report", order: 2 },
      ],
      workflowTemplate: wfTemplate,
      createdBy: "human",
    });

    const result = templateRepo.applyTemplate(template.id, habitatId);

    expect(result).not.toBeNull();
    const reportTaskId = result!.tasks[2].id;
    expect(result!.workflow!.joinSpecs).toHaveProperty(reportTaskId);
    expect((result!.workflow!.joinSpecs as Record<string, unknown>)[reportTaskId]).toEqual({
      mode: "any_of",
    });
  });

  it("throws on join spec referencing unknown task key", () => {
    const wfTemplate = makeWorkflowTemplate({
      gates: [],
      joinSpecs: { nonexistent: { mode: "all_of" } },
    });

    const template = templateRepo.createTemplate({
      habitatId,
      name: "Bad Join",
      titlePattern: "Test",
      tasksTemplate: [{ key: "a", title: "A", order: 0 }],
      workflowTemplate: wfTemplate,
      createdBy: "human",
    });

    expect(() => templateRepo.applyTemplate(template.id, habitatId)).toThrow(
      /Join spec references unknown task key "nonexistent"/,
    );
  });

  it("throws on gate referencing unknown task key", () => {
    const wfTemplate = makeWorkflowTemplate({
      gates: [{ upstreamTaskKey: "ghost", downstreamTaskKey: "b", gateType: "on_complete" }],
    });

    const template = templateRepo.createTemplate({
      habitatId,
      name: "Bad Gate",
      titlePattern: "Test",
      tasksTemplate: [
        { key: "a", title: "A", order: 0 },
        { key: "b", title: "B", order: 1 },
      ],
      workflowTemplate: wfTemplate,
      createdBy: "human",
    });

    expect(() => templateRepo.applyTemplate(template.id, habitatId)).toThrow(
      /Gate references unknown upstream task key "ghost"/,
    );
  });

  it("pre-satisfies gates whose upstream task is created with terminal status", () => {
    const wfTemplate = makeWorkflowTemplate({
      gates: [
        { upstreamTaskKey: "done_task", downstreamTaskKey: "next_task", gateType: "on_approve" },
      ],
    });

    const template = templateRepo.createTemplate({
      habitatId,
      name: "Pre-satisfy",
      titlePattern: "Test",
      tasksTemplate: [
        {
          key: "done_task",
          title: "Already Done",
          order: 0,
          initialStatus: "done",
        },
        { key: "next_task", title: "Next", order: 1 },
      ],
      workflowTemplate: wfTemplate,
      createdBy: "human",
    });

    const result = templateRepo.applyTemplate(template.id, habitatId);

    expect(result).not.toBeNull();
    const db = getDb();
    const gates = db
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.workflowId, result!.workflow!.id))
      .all();
    expect(gates[0].satisfied).toBe(true);
    expect(gates[0].satisfiedAt).not.toBeNull();
    expect(gates[0].satisfiedByEventId).toMatch(/^pre_satisfied_at_attach:/);
  });

  it("does not pre-satisfy gates when upstream task is pending", () => {
    const wfTemplate = makeWorkflowTemplate({
      gates: [{ upstreamTaskKey: "a", downstreamTaskKey: "b", gateType: "on_complete" }],
    });

    const template = templateRepo.createTemplate({
      habitatId,
      name: "No Pre-satisfy",
      titlePattern: "Test",
      tasksTemplate: [
        { key: "a", title: "A", order: 0 },
        { key: "b", title: "B", order: 1 },
      ],
      workflowTemplate: wfTemplate,
      createdBy: "human",
    });

    const result = templateRepo.applyTemplate(template.id, habitatId);

    expect(result).not.toBeNull();
    const db = getDb();
    const gates = db
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.workflowId, result!.workflow!.id))
      .all();
    expect(gates[0].satisfied).toBe(false);
    expect(gates[0].satisfiedAt).toBeNull();
  });

  it("rolls back everything on validation failure inside the transaction", () => {
    const wfTemplate = makeWorkflowTemplate({
      gates: [],
      variables: [{ key: "missing", description: "Missing", required: true }],
    });

    const template = templateRepo.createTemplate({
      habitatId,
      name: "Rollback",
      titlePattern: "Test",
      tasksTemplate: [{ key: "a", title: "A", order: 0 }],
      workflowTemplate: wfTemplate,
      createdBy: "human",
    });

    const db = getDb();
    const missionCountBefore = db.select().from(missions).all().length;
    const workflowCountBefore = db.select().from(workflows).all().length;

    expect(() => templateRepo.applyTemplate(template.id, habitatId)).toThrow();

    const missionCountAfter = db.select().from(missions).all().length;
    const workflowCountAfter = db.select().from(workflows).all().length;
    expect(missionCountAfter).toBe(missionCountBefore);
    expect(workflowCountAfter).toBe(workflowCountBefore);
  });

  it("templates without workflowTemplate behave identically to pre-v0.20 (regression)", () => {
    const template = templateRepo.createTemplate({
      habitatId,
      name: "Legacy",
      titlePattern: "Legacy Task",
      tasksTemplate: [
        { title: "Setup", order: 0 },
        { title: "Build", order: 1 },
      ],
      createdBy: "human",
    });

    const result = templateRepo.applyTemplate(template.id, habitatId);

    expect(result).not.toBeNull();
    expect(result!.tasks).toHaveLength(2);
    expect(result!.tasks[0].title).toBe("Setup");
    expect(result!.tasks[1].title).toBe("Build");
    expect(result!.workflow).toBeNull();
    const db = getDb();
    expect(db.select().from(workflows).all()).toHaveLength(0);
  });
});
