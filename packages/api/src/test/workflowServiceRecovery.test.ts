import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import { eq, and } from "drizzle-orm";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskCrudRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as failureContextRepo from "../repositories/failureContext.js";
import {
  attachWorkflow,
  MAX_RECOVERY_DEPTH,
  substituteTemplate,
  initWorkflowService,
} from "../services/workflowService.js";
import { emitTransition, type TaskAction } from "../services/tasks/transition-emitter.js";
import {
  workflows,
  taskWorkflowGates,
  tasks,
  missions,
  columns,
  habitats,
} from "../db/schema/index.js";
import type { WorkflowTemplateDefinition, WorkflowFailureHandlerConfig } from "../models/index.js";

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

function setupAgent(name: string) {
  return agentRepo.createAgent({ name, type: "claude-code", domain: "general" }).agent;
}

function attachSimpleWorkflowWithFailure(
  missionId: string,
  habitatId: string,
  failedTaskId: string,
  downstreamTaskId: string,
  failureHandler?: WorkflowFailureHandlerConfig,
): string {
  const definition: WorkflowTemplateDefinition = {
    gates: [
      {
        upstreamTaskKey: failedTaskId,
        downstreamTaskKey: downstreamTaskId,
        gateType: "on_fail",
      },
    ],
    failureHandler,
  };
  return attachWorkflow(missionId, habitatId, definition, {}, "test-author");
}

function emitFailure(
  taskId: string,
  action: "failed" | "rejected" | "released",
  habitatId: string,
  reason?: string,
) {
  emitTransition(taskId, action as TaskAction, habitatId, {
    actorType: "system",
    actorId: "test-harness",
    reason,
    metadata: reason ? { reason } : undefined,
  });
}

function readGate(gateId: string) {
  return getDb().select().from(taskWorkflowGates).where(eq(taskWorkflowGates.id, gateId)).get();
}

function readGatesForUpstreamTask(taskId: string) {
  return getDb()
    .select()
    .from(taskWorkflowGates)
    .where(eq(taskWorkflowGates.upstreamTaskId, taskId))
    .all();
}

function readGatesForDownstreamTask(taskId: string) {
  return getDb()
    .select()
    .from(taskWorkflowGates)
    .where(eq(taskWorkflowGates.downstreamTaskId, taskId))
    .all();
}

describe("workflowService — on_fail gates + recovery spawning", () => {
  beforeEach(async () => {
    await initTestDb();
    initWorkflowService();
    const db = getDb();
    db.delete(tasks).run();
    db.delete(missions).run();
    db.delete(columns).run();
    db.delete(habitats).run();
    // Note: workflow tables + failure_contexts cascade on task deletion above,
    // but we wipe workflows explicitly to clear detached rows from prior tests.
    db.delete(taskWorkflowGates).run();
    db.delete(workflows).run();
    db.delete(tasks).run();
  });

  afterEach(() => {
    closeDb();
  });

  describe("actionToGateType (via end-to-end transition handling)", () => {
    it("fires on_fail gate on 'failed' action", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Will fail",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      attachSimpleWorkflowWithFailure(mission.id, habitat.id, failedTask.id, downstream.id);

      emitFailure(failedTask.id, "failed", habitat.id);

      const gates = readGatesForUpstreamTask(failedTask.id);
      expect(gates).toHaveLength(1);
      expect(gates[0].satisfied).toBe(true);
    });

    it("fires on_fail gate on 'rejected' action", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Will reject",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      attachSimpleWorkflowWithFailure(mission.id, habitat.id, failedTask.id, downstream.id);

      emitFailure(failedTask.id, "rejected", habitat.id);

      expect(readGatesForUpstreamTask(failedTask.id)[0].satisfied).toBe(true);
    });

    it("fires on_fail gate on 'released' action (heartbeat-lost)", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Will lose heartbeat",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      attachSimpleWorkflowWithFailure(mission.id, habitat.id, failedTask.id, downstream.id);

      emitFailure(failedTask.id, "released", habitat.id);

      expect(readGatesForUpstreamTask(failedTask.id)[0].satisfied).toBe(true);
    });

    it("does NOT fire on_fail gate for non-failure actions", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Will complete",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      attachSimpleWorkflowWithFailure(mission.id, habitat.id, failedTask.id, downstream.id);

      // Emit a 'completed' action — should NOT trigger the on_fail gate.
      emitTransition(failedTask.id, "completed", habitat.id, {
        actorType: "system",
        actorId: "test",
      });

      expect(readGatesForUpstreamTask(failedTask.id)[0].satisfied).toBe(false);
    });
  });

  describe("failure context capture alongside gate firing", () => {
    it("builds a failure context row when an on_fail gate fires", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Will fail",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      attachSimpleWorkflowWithFailure(mission.id, habitat.id, failedTask.id, downstream.id);

      emitFailure(failedTask.id, "failed", habitat.id, "exhausted retries");

      const ctx = failureContextRepo.getUnresolvedFailureContextByTaskId(failedTask.id);
      expect(ctx).not.toBeNull();
      expect(ctx!.failureKind).toBe("lifecycle_failed");
      expect(ctx!.failureReason).toBe("exhausted retries");
    });

    it("records lifecycle_rejected kind on 'rejected' action", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Will reject",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      attachSimpleWorkflowWithFailure(mission.id, habitat.id, failedTask.id, downstream.id);

      emitFailure(failedTask.id, "rejected", habitat.id);

      const ctx = failureContextRepo.getUnresolvedFailureContextByTaskId(failedTask.id);
      expect(ctx!.failureKind).toBe("lifecycle_rejected");
    });

    it("records heartbeat_lost kind on 'released' action", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Will release",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      attachSimpleWorkflowWithFailure(mission.id, habitat.id, failedTask.id, downstream.id);

      emitFailure(failedTask.id, "released", habitat.id);

      const ctx = failureContextRepo.getUnresolvedFailureContextByTaskId(failedTask.id);
      expect(ctx!.failureKind).toBe("heartbeat_lost");
    });
  });

  describe("recovery task spawning (F3)", () => {
    const sampleHandler: WorkflowFailureHandlerConfig = {
      recoveryTaskTemplate: {
        title: "Recover: {{failedTaskTitle}}",
        description:
          "Investigate failure of {{failedTaskId}} by {{failedAgentName}}. Reason: {{failureReason}}",
      },
      agentSelector: {
        requiredCapabilities: ["debugging"],
        requiredDomain: "backend",
      },
    };

    it("spawns a recovery task with variables substituted and agentSelector applied", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failingAgent = setupAgent("alice-bot");
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Original Task",
        createdBy: "test",
      });
      getDb()
        .update(tasks)
        .set({ assignedAgentId: failingAgent.id })
        .where(eq(tasks.id, failedTask.id))
        .run();
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      attachSimpleWorkflowWithFailure(
        mission.id,
        habitat.id,
        failedTask.id,
        downstream.id,
        sampleHandler,
      );

      emitFailure(failedTask.id, "failed", habitat.id, "tests exploded");

      // Recovery task created with substituted title
      const recoveryTasks = getDb()
        .select()
        .from(tasks)
        .where(eq(tasks.title, "Recover: Original Task"))
        .all();
      expect(recoveryTasks).toHaveLength(1);
      const recovery = recoveryTasks[0];
      expect(recovery.description).toContain(failedTask.id);
      expect(recovery.description).toContain("alice-bot");
      expect(recovery.description).toContain("tests exploded");
      expect(recovery.requiredCapabilities).toEqual(["debugging"]);
      expect(recovery.requiredDomain).toBe("backend");
      expect(recovery.createdBy).toBe("workflow-recovery");

      // Original gate linked to recovery task
      const originalGate = readGatesForUpstreamTask(failedTask.id)[0];
      expect(originalGate.recoveryTaskId).toBe(recovery.id);

      // New on_fail gate created at depth + 1, upstream of the recovery task
      // (so it fires only when the recovery itself fails, enabling recovery-of-recovery).
      const deeperGates = getDb()
        .select()
        .from(taskWorkflowGates)
        .where(eq(taskWorkflowGates.upstreamTaskId, recovery.id))
        .all();
      expect(deeperGates).toHaveLength(1);
      const newGate = deeperGates[0];
      expect(newGate.gateType).toBe("on_fail");
      expect(newGate.recoveryDepth).toBe(originalGate.recoveryDepth + 1);
      expect(newGate.downstreamTaskId).toBe(originalGate.downstreamTaskId);

      // Failure context linked
      const ctx = failureContextRepo.getUnresolvedFailureContextByTaskId(failedTask.id);
      expect(ctx!.recoveryTaskId).toBe(recovery.id);
    });

    it("applies assignedAgentId when the handler's agentSelector specifies one", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const recoveryAgent = setupAgent("recovery-specialist");
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Failed",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      const handler: WorkflowFailureHandlerConfig = {
        recoveryTaskTemplate: { title: "Recover" },
        agentSelector: { assignedAgentId: recoveryAgent.id },
      };
      attachSimpleWorkflowWithFailure(
        mission.id,
        habitat.id,
        failedTask.id,
        downstream.id,
        handler,
      );

      emitFailure(failedTask.id, "failed", habitat.id);

      const recovery = getDb().select().from(tasks).where(eq(tasks.title, "Recover")).get();
      expect(recovery).toBeDefined();
      expect(recovery!.assignedAgentId).toBe(recoveryAgent.id);
    });

    it("respects depth cap: depth-N gate where N >= MAX_RECOVERY_DEPTH does not spawn", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Failed",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      attachSimpleWorkflowWithFailure(
        mission.id,
        habitat.id,
        failedTask.id,
        downstream.id,
        sampleHandler,
      );

      // Manually bump the gate to the cap so we can verify the suppress branch.
      getDb()
        .update(taskWorkflowGates)
        .set({ recoveryDepth: MAX_RECOVERY_DEPTH })
        .where(eq(taskWorkflowGates.upstreamTaskId, failedTask.id))
        .run();

      emitFailure(failedTask.id, "failed", habitat.id);

      // Gate satisfied, but no recovery task spawned.
      expect(readGatesForUpstreamTask(failedTask.id)[0].satisfied).toBe(true);
      expect(readGatesForUpstreamTask(failedTask.id)[0].recoveryTaskId).toBeNull();
      const recoveryTasks = getDb()
        .select()
        .from(tasks)
        .where(eq(tasks.createdBy, "workflow-recovery"))
        .all();
      expect(recoveryTasks).toHaveLength(0);
    });

    it("does not spawn when failureHandler is not configured on the workflow", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Failed",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      // No failureHandler passed
      attachSimpleWorkflowWithFailure(mission.id, habitat.id, failedTask.id, downstream.id);

      emitFailure(failedTask.id, "failed", habitat.id);

      expect(readGatesForUpstreamTask(failedTask.id)[0].satisfied).toBe(true);
      expect(readGatesForUpstreamTask(failedTask.id)[0].recoveryTaskId).toBeNull();
    });

    it("does not spawn when per-gate failureHandlerOverride is explicitly null (per-task disable)", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Failed",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      attachSimpleWorkflowWithFailure(
        mission.id,
        habitat.id,
        failedTask.id,
        downstream.id,
        sampleHandler,
      );

      // Override the gate's matchConfig to explicitly disable handler for this task.
      getDb()
        .update(taskWorkflowGates)
        .set({ matchConfig: { failureHandlerOverride: null } })
        .where(eq(taskWorkflowGates.upstreamTaskId, failedTask.id))
        .run();

      emitFailure(failedTask.id, "failed", habitat.id);

      expect(readGatesForUpstreamTask(failedTask.id)[0].satisfied).toBe(true);
      expect(readGatesForUpstreamTask(failedTask.id)[0].recoveryTaskId).toBeNull();
    });

    it("uses per-gate failureHandlerOverride object when present, ignoring workflow-level handler", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Failed",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      // Workflow-level handler produces "Workflow Recovery"
      attachSimpleWorkflowWithFailure(mission.id, habitat.id, failedTask.id, downstream.id, {
        recoveryTaskTemplate: { title: "Workflow Recovery" },
      });
      // Per-gate override produces "Override Recovery"
      getDb()
        .update(taskWorkflowGates)
        .set({
          matchConfig: {
            failureHandlerOverride: { recoveryTaskTemplate: { title: "Override Recovery" } },
          },
        })
        .where(eq(taskWorkflowGates.upstreamTaskId, failedTask.id))
        .run();

      emitFailure(failedTask.id, "failed", habitat.id);

      const overrideTask = getDb()
        .select()
        .from(tasks)
        .where(eq(tasks.title, "Override Recovery"))
        .get();
      const workflowTask = getDb()
        .select()
        .from(tasks)
        .where(eq(tasks.title, "Workflow Recovery"))
        .get();
      expect(overrideTask).toBeDefined();
      expect(workflowTask).toBeUndefined();
    });

    it("does not double-spawn when the same failure event fires twice (idempotency via satisfied flag)", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Failed",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      attachSimpleWorkflowWithFailure(
        mission.id,
        habitat.id,
        failedTask.id,
        downstream.id,
        sampleHandler,
      );

      emitFailure(failedTask.id, "failed", habitat.id);
      emitFailure(failedTask.id, "failed", habitat.id);

      const recoveryTasks = getDb()
        .select()
        .from(tasks)
        .where(eq(tasks.createdBy, "workflow-recovery"))
        .all();
      expect(recoveryTasks).toHaveLength(1);
    });

    it("substitutes unknown {{key}} placeholders as empty strings (graceful)", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Failed",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      attachSimpleWorkflowWithFailure(mission.id, habitat.id, failedTask.id, downstream.id, {
        recoveryTaskTemplate: { title: "Recover [{{unknownKey}}]" },
      });

      emitFailure(failedTask.id, "failed", habitat.id);

      const recovery = getDb().select().from(tasks).where(eq(tasks.title, "Recover []")).get();
      expect(recovery).toBeDefined();
    });
  });

  describe("substituteTemplate (pure helper)", () => {
    it("replaces known keys", () => {
      expect(substituteTemplate("{{a}}-{{b}}", { a: "x", b: "y" })).toBe("x-y");
    });
    it("leaves text without placeholders unchanged", () => {
      expect(substituteTemplate("no placeholders", {})).toBe("no placeholders");
    });
    it("treats unknown keys as empty strings", () => {
      expect(substituteTemplate("[{{missing}}]", {})).toBe("[]");
    });
  });
});
