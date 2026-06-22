import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import { eq, and } from "drizzle-orm";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskCrudRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as failureContextService from "../services/failureContextService.js";
import {
  attachWorkflow,
  detachWorkflow,
  initWorkflowService,
} from "../services/workflowService.js";
import { claimTask } from "../repositories/taskStateMachine.js";
import { emitTransition, type TaskAction } from "../services/tasks/transition-emitter.js";
import { areAllWorkflowGatesSatisfied } from "../repositories/workflow.js";
import {
  workflows,
  taskWorkflowGates,
  taskEvents,
  missionEvents,
  failureContexts,
  tasks,
  missions,
  columns,
  habitats,
  notificationEvents,
} from "../db/schema/index.js";
import type { WorkflowTemplateDefinition } from "../models/index.js";

function setupHabitat() {
  const habitat = habitatRepo.createHabitat({ name: "Test Habitat" });
  const col = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0 });
  return { habitat, col };
}

function setupMission(habitatId: string, colId: string) {
  return missionRepo.createMission({
    habitatId,
    columnId: colId,
    title: "Test Mission",
    createdBy: "human-1",
  });
}

function setupTask(missionId: string, title: string) {
  return taskCrudRepo.createTask({ missionId, title, createdBy: "test" });
}

function setupAgent(name: string) {
  return agentRepo.createAgent({ name, type: "claude-code", domain: "general" }).agent;
}

function emit(taskId: string, action: TaskAction, habitatId: string) {
  emitTransition(taskId, action, habitatId, {
    actorType: "system",
    actorId: "test-harness",
  });
}

function gatesForDownstream(taskId: string) {
  return getDb()
    .select()
    .from(taskWorkflowGates)
    .where(eq(taskWorkflowGates.downstreamTaskId, taskId))
    .all();
}

function unsatisfiedGatesForDownstream(taskId: string) {
  return gatesForDownstream(taskId).filter((g) => !g.satisfied);
}

function readTaskEvents(taskId: string, action: string) {
  return getDb()
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .all()
    .filter((e) => e.action === action);
}

function readMissionEvents(missionId: string, action: string) {
  return getDb()
    .select()
    .from(missionEvents)
    .where(eq(missionEvents.missionId, missionId))
    .all()
    .filter((e) => e.action === action);
}

function readNotifications(habitatId: string, eventType: string) {
  return getDb()
    .select()
    .from(notificationEvents)
    .where(eq(notificationEvents.habitatId, habitatId))
    .all()
    .filter((e) => e.eventType === eventType);
}

beforeEach(async () => {
  await initTestDb();
  initWorkflowService();
  const db = getDb();
  db.delete(taskEvents).run();
  db.delete(missionEvents).run();
  db.delete(notificationEvents).run();
  db.delete(failureContexts).run();
  db.delete(taskWorkflowGates).run();
  db.delete(workflows).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columns).run();
  db.delete(habitats).run();
});

afterEach(() => {
  closeDb();
});

describe("I1 Scenario 1 — Full workflow lifecycle (sequential on_approve chain)", () => {
  it("progressively unlocks tasks as each upstream is approved", () => {
    const { habitat, col } = setupHabitat();
    const mission = setupMission(habitat.id, col.id);
    const build = setupTask(mission.id, "Build");
    const testTask = setupTask(mission.id, "Test");
    const review = setupTask(mission.id, "Review");
    const deploy = setupTask(mission.id, "Deploy");
    const agent = setupAgent("agent-1");

    const definition: WorkflowTemplateDefinition = {
      gates: [
        { upstreamTaskKey: build.id, downstreamTaskKey: testTask.id, gateType: "on_approve" },
        { upstreamTaskKey: testTask.id, downstreamTaskKey: review.id, gateType: "on_approve" },
        { upstreamTaskKey: review.id, downstreamTaskKey: deploy.id, gateType: "on_approve" },
      ],
    };
    attachWorkflow(mission.id, habitat.id, definition, {}, "test");

    // Initially, only "build" is claimable — the rest are gated.
    expect(areAllWorkflowGatesSatisfied(testTask.id)).toBe(false);
    expect(areAllWorkflowGatesSatisfied(review.id)).toBe(false);
    expect(areAllWorkflowGatesSatisfied(deploy.id)).toBe(false);
    expect(areAllWorkflowGatesSatisfied(build.id)).toBe(true);

    const claimBuild = claimTask(build.id, agent.id);
    expect(claimBuild.success).toBe(true);

    const claimTest = claimTask(testTask.id, agent.id);
    expect(claimTest.success).toBe(false);
    if (!claimTest.success) {
      expect(claimTest.reason).toBe("workflow_gates_unmet");
    }

    // Approve "build" → "test" becomes claimable.
    emit(build.id, "approved", habitat.id);
    expect(areAllWorkflowGatesSatisfied(testTask.id)).toBe(true);

    // Approve "test" → "review" becomes claimable.
    emit(testTask.id, "approved", habitat.id);
    expect(areAllWorkflowGatesSatisfied(review.id)).toBe(true);

    // Approve "review" → "deploy" becomes claimable.
    emit(review.id, "approved", habitat.id);
    expect(areAllWorkflowGatesSatisfied(deploy.id)).toBe(true);

    // Verify audit events: workflow_attached + 3x workflow_gate_satisfied.
    const attachedEvents = readMissionEvents(mission.id, "workflow_attached");
    expect(attachedEvents).toHaveLength(1);

    const satisfiedEvents = getDb()
      .select()
      .from(taskEvents)
      .all()
      .filter((e) => e.action === "workflow_gate_satisfied");
    expect(satisfiedEvents.length).toBeGreaterThanOrEqual(3);
  });
});

describe("I1 Scenario 2 — Fan-out / fan-in with any_of join", () => {
  it("unlocks all investigations after scout completes; report unlocks via any_of after one inv", () => {
    const { habitat, col } = setupHabitat();
    const mission = setupMission(habitat.id, col.id);
    const scout = setupTask(mission.id, "Scout");
    const inv1 = setupTask(mission.id, "Investigation 1");
    const inv2 = setupTask(mission.id, "Investigation 2");
    const inv3 = setupTask(mission.id, "Investigation 3");
    const report = setupTask(mission.id, "Report");

    const definition: WorkflowTemplateDefinition = {
      gates: [
        { upstreamTaskKey: scout.id, downstreamTaskKey: inv1.id, gateType: "on_complete" },
        { upstreamTaskKey: scout.id, downstreamTaskKey: inv2.id, gateType: "on_complete" },
        { upstreamTaskKey: scout.id, downstreamTaskKey: inv3.id, gateType: "on_complete" },
        { upstreamTaskKey: inv1.id, downstreamTaskKey: report.id, gateType: "on_complete" },
        { upstreamTaskKey: inv2.id, downstreamTaskKey: report.id, gateType: "on_complete" },
        { upstreamTaskKey: inv3.id, downstreamTaskKey: report.id, gateType: "on_complete" },
      ],
      joinSpecs: {
        [report.id]: { mode: "any_of" },
      },
    };
    attachWorkflow(mission.id, habitat.id, definition, {}, "test");

    // Initially, all investigations and report are gated.
    expect(areAllWorkflowGatesSatisfied(inv1.id)).toBe(false);
    expect(areAllWorkflowGatesSatisfied(inv2.id)).toBe(false);
    expect(areAllWorkflowGatesSatisfied(inv3.id)).toBe(false);
    expect(areAllWorkflowGatesSatisfied(report.id)).toBe(false);

    // Complete scout → all 3 investigations become claimable.
    emit(scout.id, "completed", habitat.id);
    expect(areAllWorkflowGatesSatisfied(inv1.id)).toBe(true);
    expect(areAllWorkflowGatesSatisfied(inv2.id)).toBe(true);
    expect(areAllWorkflowGatesSatisfied(inv3.id)).toBe(true);

    // Report still gated (3 upstream gates, any_of not yet satisfied by completing scout alone).
    // Actually, scout→report gates don't exist. The report gates are inv1→report, inv2→report, inv3→report.
    // Completing scout doesn't satisfy any report gate. Report is still gated.
    expect(areAllWorkflowGatesSatisfied(report.id)).toBe(false);

    // Complete only inv1 → report becomes claimable (any_of satisfied).
    emit(inv1.id, "completed", habitat.id);
    expect(areAllWorkflowGatesSatisfied(report.id)).toBe(true);

    // Verify gate states in the DB.
    const reportGates = gatesForDownstream(report.id);
    expect(reportGates).toHaveLength(3);
    const satisfiedReportGates = reportGates.filter((g) => g.satisfied);
    expect(satisfiedReportGates).toHaveLength(1);
    expect(satisfiedReportGates[0].upstreamTaskId).toBe(inv1.id);
  });
});

describe("I1 Scenario 3 — Recovery lifecycle (fail → spawn → redeem)", () => {
  it("spawns a recovery task on failure, then redemption satisfies downstream gates on recovery approval", () => {
    const { habitat, col } = setupHabitat();
    const mission = setupMission(habitat.id, col.id);
    const taskA = setupTask(mission.id, "Task A (will fail)");
    const taskB = setupTask(mission.id, "Task B (downstream)");
    const agent = setupAgent("recovery-claimer");

    const definition: WorkflowTemplateDefinition = {
      gates: [
        { upstreamTaskKey: taskA.id, downstreamTaskKey: taskB.id, gateType: "on_complete" },
        { upstreamTaskKey: taskA.id, downstreamTaskKey: taskB.id, gateType: "on_fail" },
      ],
      failureHandler: {
        recoveryTaskTemplate: {
          title: "Investigate {{failedTaskTitle}} failure",
          description: "Root-cause and fix",
        },
      },
    };
    attachWorkflow(mission.id, habitat.id, definition, {}, "test");

    // Task B is initially gated by on_complete from taskA.
    expect(areAllWorkflowGatesSatisfied(taskB.id)).toBe(false);

    // Fail taskA → on_fail gate fires, recovery task spawns.
    emitTransition(taskA.id, "failed" as TaskAction, habitat.id, {
      actorType: "agent",
      actorId: "agent-1",
      reason: "Build broke",
      metadata: { reason: "Build broke" },
    });

    // on_fail gate should be satisfied.
    const failGates = getDb()
      .select()
      .from(taskWorkflowGates)
      .where(
        and(
          eq(taskWorkflowGates.upstreamTaskId, taskA.id),
          eq(taskWorkflowGates.gateType, "on_fail"),
        ),
      )
      .all();
    expect(failGates).toHaveLength(1);
    expect(failGates[0].satisfied).toBe(true);
    expect(failGates[0].recoveryTaskId).not.toBeNull();

    // Recovery task was spawned.
    const recoveryTaskId = failGates[0].recoveryTaskId!;
    const recoveryTask = taskCrudRepo.getTaskById(recoveryTaskId);
    expect(recoveryTask).not.toBeNull();
    expect(recoveryTask!.title).toBe("Investigate Task A (will fail) failure");

    // Failure context was built.
    const ctx = failureContextService.getFailureContext(taskA.id);
    expect(ctx).not.toBeNull();
    expect(ctx!.resolvedAt).toBeNull();

    // Task B is still gated (on_complete not yet satisfied).
    expect(areAllWorkflowGatesSatisfied(taskB.id)).toBe(false);

    // Approve the recovery task → redemption fires.
    emit(recoveryTaskId, "approved", habitat.id);

    // on_complete gate upstream of taskA should now be satisfied (redemption).
    const completeGates = getDb()
      .select()
      .from(taskWorkflowGates)
      .where(
        and(
          eq(taskWorkflowGates.upstreamTaskId, taskA.id),
          eq(taskWorkflowGates.gateType, "on_complete"),
        ),
      )
      .all();
    expect(completeGates.length).toBeGreaterThanOrEqual(1);
    expect(completeGates.every((g) => g.satisfied)).toBe(true);

    // The recovery-spawned depth-1 on_fail gate (upstream=recoveryTask, downstream=taskB)
    // exists but is NOT satisfied — recovery succeeded, so it never fired. It is a spawn
    // trigger for recovery-of-recovery, not a claim constraint. See
    // "fix(workflow): exclude recovery-spawned gates from claim-blocking check".
    const recoverySpawnedGates = getDb()
      .select()
      .from(taskWorkflowGates)
      .where(
        and(
          eq(taskWorkflowGates.downstreamTaskId, taskB.id),
          eq(taskWorkflowGates.recoveryDepth, 1),
        ),
      )
      .all();
    expect(recoverySpawnedGates.length).toBeGreaterThanOrEqual(1);
    expect(recoverySpawnedGates.every((g) => !g.satisfied)).toBe(true);

    // CRITICAL: Despite the unsatisfied recovery-spawned gate, taskB IS claimable.
    // areAllWorkflowGatesSatisfied excludes recoveryDepth > 0 gates (spawn triggers),
    // counting only the original depth-0 on_complete gate — which redemption satisfied.
    expect(areAllWorkflowGatesSatisfied(taskB.id)).toBe(true);
    const claimB = claimTask(taskB.id, agent.id);
    expect(claimB.success).toBe(true);

    // Failure context resolved with "redeemed".
    const resolvedCtx = failureContextService.getFailureContextsForTask(taskA.id);
    const unresolved = resolvedCtx.filter((c) => c.resolvedAt === null);
    expect(unresolved).toHaveLength(0);
    const redeemed = resolvedCtx.filter((c) => c.resolutionKind === "redeemed");
    expect(redeemed.length).toBeGreaterThanOrEqual(1);

    // Verify recovery notification events.
    const startedNotifs = readNotifications(habitat.id, "workflow.recovery_started");
    expect(startedNotifs).toHaveLength(1);
    const succeededNotifs = readNotifications(habitat.id, "workflow.recovery_succeeded");
    expect(succeededNotifs).toHaveLength(1);
  });
});

describe("I1 Scenario 4 — Recovery depth cap (two attempts maximum)", () => {
  it("stops spawning recovery at depth 2 and fires unrecoverable notification", () => {
    const { habitat, col } = setupHabitat();
    const mission = setupMission(habitat.id, col.id);
    const originalTask = setupTask(mission.id, "Original (will fail chain)");

    const definition: WorkflowTemplateDefinition = {
      gates: [
        {
          upstreamTaskKey: originalTask.id,
          downstreamTaskKey: originalTask.id,
          gateType: "on_fail",
        },
      ],
      failureHandler: {
        recoveryTaskTemplate: {
          title: "Recovery attempt",
          description: "Fix",
        },
      },
    };
    attachWorkflow(mission.id, habitat.id, definition, {}, "test");

    // Fail original → recovery1 spawns (depth 1).
    emitTransition(originalTask.id, "failed" as TaskAction, habitat.id, {
      actorType: "agent",
      actorId: "agent-1",
      metadata: { reason: "fail 1" },
    });

    let allGates = getDb()
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.gateType, "on_fail"))
      .all();
    let recoveryGates = allGates.filter((g) => g.recoveryTaskId !== null);
    expect(recoveryGates).toHaveLength(1);

    const recovery1Id = recoveryGates[0].recoveryTaskId!;
    expect(recoveryGates[0].recoveryDepth).toBe(0);
    // The new depth-1 gate:
    const depth1Gates = allGates.filter((g) => g.recoveryDepth === 1);
    expect(depth1Gates).toHaveLength(1);
    expect(depth1Gates[0].upstreamTaskId).toBe(recovery1Id);

    // Fail recovery1 → recovery2 spawns (depth 2).
    emitTransition(recovery1Id, "failed" as TaskAction, habitat.id, {
      actorType: "agent",
      actorId: "agent-1",
      metadata: { reason: "fail 2" },
    });

    allGates = getDb()
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.gateType, "on_fail"))
      .all();
    const depth2Gates = allGates.filter((g) => g.recoveryDepth === 2);
    expect(depth2Gates).toHaveLength(1);

    // recovery2 task ID is linked to the depth-1 gate (the gate that spawned it).
    const depth1Gate = allGates.find((g) => g.recoveryDepth === 1);
    const recovery2TaskId = depth1Gate?.recoveryTaskId;
    expect(recovery2TaskId).toBeTruthy();

    // Fail recovery2 → NO recovery3 spawns, unrecoverable notification fires.
    if (recovery2TaskId) {
      emitTransition(recovery2TaskId, "failed" as TaskAction, habitat.id, {
        actorType: "agent",
        actorId: "agent-1",
        metadata: { reason: "fail 3" },
      });
    }

    // The depth-2 gate should now be satisfied (the fail event fired),
    // but no depth-3 gate should exist.
    allGates = getDb()
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.gateType, "on_fail"))
      .all();
    const depth3Gates = allGates.filter((g) => g.recoveryDepth === 3);
    expect(depth3Gates).toHaveLength(0);

    // Unrecoverable notification fired.
    const unrecoverableNotifs = readNotifications(habitat.id, "workflow.recovery_unrecoverable");
    expect(unrecoverableNotifs.length).toBeGreaterThanOrEqual(1);
  });
});
