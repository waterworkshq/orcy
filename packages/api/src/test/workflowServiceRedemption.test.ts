import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import { eq, and } from "drizzle-orm";

const audit = vi.hoisted(() => ({ shouldThrow: false }));

vi.mock("../repositories/events/event-crud.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/events/event-crud.js")>();
  return {
    ...actual,
    createEventWithClient: (
      ...args: Parameters<typeof actual.createEventWithClient>
    ): ReturnType<typeof actual.createEventWithClient> => {
      if (audit.shouldThrow) throw new Error("injected redemption audit write failure");
      return actual.createEventWithClient(...args);
    },
  };
});

import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskCrudRepo from "../repositories/taskCrud.js";
import * as failureContextRepo from "../repositories/failureContext.js";
import * as failureContextService from "../services/failureContextService.js";
import { attachWorkflow, initWorkflowService } from "../services/workflowService.js";
import { emitTransition, type TaskAction } from "../services/tasks/transition-emitter.js";
import {
  workflows,
  taskWorkflowGates,
  taskEvents,
  notificationEvents,
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

function attachRecoveryChain(
  missionId: string,
  habitatId: string,
  failedTaskId: string,
  downstreamTaskId: string,
  failureHandler: WorkflowFailureHandlerConfig,
): string {
  const definition: WorkflowTemplateDefinition = {
    gates: [
      // Original gate: when failedTask fails, downstream is reachable from recovery.
      {
        upstreamTaskKey: failedTaskId,
        downstreamTaskKey: downstreamTaskId,
        gateType: "on_fail",
      },
      // Gate that should fire on redemption: when failedTask "succeeds" (via redemption),
      // also unblock the downstream via on_complete.
      {
        upstreamTaskKey: failedTaskId,
        downstreamTaskKey: downstreamTaskId,
        gateType: "on_complete",
      },
    ],
    failureHandler,
  };
  return attachWorkflow(missionId, habitatId, definition, {}, "test-author");
}

function emitTransitionFor(taskId: string, action: TaskAction, habitatId: string) {
  emitTransition(taskId, action, habitatId, {
    actorType: "system",
    actorId: "test-harness",
  });
}

function readGatesForUpstreamTask(taskId: string) {
  return getDb()
    .select()
    .from(taskWorkflowGates)
    .where(eq(taskWorkflowGates.upstreamTaskId, taskId))
    .all();
}

function readRedemptionAudits() {
  return getDb()
    .select()
    .from(taskEvents)
    .all()
    .filter((event) => {
      const metadata = event.metadata as Record<string, unknown> | null;
      return event.action === "workflow_gate_satisfied" && metadata?.triggeredBy === "recovery_redemption";
    });
}

function readRecoverySucceededNotifications(habitatId: string) {
  return getDb()
    .select()
    .from(notificationEvents)
    .all()
    .filter(
      (event) =>
        event.habitatId === habitatId && event.eventType === "workflow.recovery_succeeded",
    );
}

const sampleHandler: WorkflowFailureHandlerConfig = {
  recoveryTaskTemplate: { title: "Recovery" },
};

describe("workflowService — recovery redemption (F4)", () => {
  beforeEach(async () => {
    audit.shouldThrow = false;
    await initTestDb();
    initWorkflowService();
    const db = getDb();
    db.delete(taskEvents).run();
    db.delete(notificationEvents).run();
    db.delete(tasks).run();
    db.delete(missions).run();
    db.delete(columns).run();
    db.delete(habitats).run();
    db.delete(taskWorkflowGates).run();
    db.delete(workflows).run();
    db.delete(tasks).run();
  });

  afterEach(() => {
    audit.shouldThrow = false;
    closeDb();
  });

  describe("redemption on recovery task success", () => {
    it("satisfies the original failed task's downstream on_complete gate when recovery is approved", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Original",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      attachRecoveryChain(mission.id, habitat.id, failedTask.id, downstream.id, sampleHandler);

      // Step 1: original task fails -> spawns recovery
      emitTransitionFor(failedTask.id, "failed", habitat.id);

      const recoveryTasks = getDb()
        .select()
        .from(tasks)
        .where(eq(tasks.createdBy, "workflow-recovery"))
        .all();
      expect(recoveryTasks).toHaveLength(1);
      const recoveryTask = recoveryTasks[0];

      // Step 2: recovery is approved -> redemption fires
      emitTransitionFor(recoveryTask.id, "approved", habitat.id);

      // The failed task's downstream on_complete gate should now be satisfied.
      const onCompleteGates = readGatesForUpstreamTask(failedTask.id).filter(
        (g) => g.gateType === "on_complete",
      );
      expect(onCompleteGates).toHaveLength(1);
      expect(onCompleteGates[0].satisfied).toBe(true);

      const context = failureContextService.getFailureContextsForTask(failedTask.id)[0];
      expect(context).toBeDefined();
      expect(onCompleteGates[0].satisfiedByEventId).toBe(context.id);

      const redemptionAudits = readRedemptionAudits();
      expect(redemptionAudits).toHaveLength(1);
      const auditMetadata = redemptionAudits[0].metadata as Record<string, unknown>;
      expect(auditMetadata.gateId).toBe(onCompleteGates[0].id);
      expect(auditMetadata.contextId).toBe(context.id);

      const succeededNotifications = readRecoverySucceededNotifications(habitat.id);
      expect(succeededNotifications).toHaveLength(1);
    });

    it("satisfies the original failed task's downstream on_approve gate when recovery is approved", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Original",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      const definition: WorkflowTemplateDefinition = {
        gates: [
          {
            upstreamTaskKey: failedTask.id,
            downstreamTaskKey: downstream.id,
            gateType: "on_fail",
          },
          {
            upstreamTaskKey: failedTask.id,
            downstreamTaskKey: downstream.id,
            gateType: "on_approve",
          },
        ],
        failureHandler: sampleHandler,
      };
      attachWorkflow(mission.id, habitat.id, definition, {}, "test-author");

      emitTransitionFor(failedTask.id, "failed", habitat.id);
      const recoveryTask = getDb()
        .select()
        .from(tasks)
        .where(eq(tasks.createdBy, "workflow-recovery"))
        .get()!;
      emitTransitionFor(recoveryTask.id, "approved", habitat.id);

      const onApproveGates = readGatesForUpstreamTask(failedTask.id).filter(
        (g) => g.gateType === "on_approve",
      );
      expect(onApproveGates[0].satisfied).toBe(true);
    });

    it("redemption fires on 'completed' as well as 'approved'", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Original",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      attachRecoveryChain(mission.id, habitat.id, failedTask.id, downstream.id, sampleHandler);

      emitTransitionFor(failedTask.id, "failed", habitat.id);
      const recoveryTask = getDb()
        .select()
        .from(tasks)
        .where(eq(tasks.createdBy, "workflow-recovery"))
        .get()!;
      emitTransitionFor(recoveryTask.id, "completed", habitat.id);

      const onCompleteGates = readGatesForUpstreamTask(failedTask.id).filter(
        (g) => g.gateType === "on_complete",
      );
      expect(onCompleteGates[0].satisfied).toBe(true);
    });

    it("resolves the failure context with 'redeemed' kind on redemption", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Original",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      attachRecoveryChain(mission.id, habitat.id, failedTask.id, downstream.id, sampleHandler);

      emitTransitionFor(failedTask.id, "failed", habitat.id);
      const recoveryTask = getDb()
        .select()
        .from(tasks)
        .where(eq(tasks.createdBy, "workflow-recovery"))
        .get()!;
      emitTransitionFor(recoveryTask.id, "approved", habitat.id);

      const ctx = failureContextRepo.getUnresolvedFailureContextByTaskId(failedTask.id);
      expect(ctx).toBeNull(); // resolved

      const allContexts = failureContextService.getFailureContextsForTask(failedTask.id);
      expect(allContexts).toHaveLength(1);
      expect(allContexts[0].resolutionKind).toBe("redeemed");
      expect(allContexts[0].resolvedAt).not.toBeNull();
    });

    it("satisfies MULTIPLE downstream gates on a single redemption", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Original",
        createdBy: "test",
      });
      const downstreamA = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream A",
        createdBy: "test",
      });
      const downstreamB = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream B",
        createdBy: "test",
      });
      const definition: WorkflowTemplateDefinition = {
        gates: [
          {
            upstreamTaskKey: failedTask.id,
            downstreamTaskKey: downstreamA.id,
            gateType: "on_fail",
          },
          {
            upstreamTaskKey: failedTask.id,
            downstreamTaskKey: downstreamA.id,
            gateType: "on_complete",
          },
          {
            upstreamTaskKey: failedTask.id,
            downstreamTaskKey: downstreamB.id,
            gateType: "on_complete",
          },
        ],
        failureHandler: sampleHandler,
      };
      attachWorkflow(mission.id, habitat.id, definition, {}, "test-author");

      emitTransitionFor(failedTask.id, "failed", habitat.id);
      const recoveryTask = getDb()
        .select()
        .from(tasks)
        .where(eq(tasks.createdBy, "workflow-recovery"))
        .get()!;
      emitTransitionFor(recoveryTask.id, "approved", habitat.id);

      const onCompleteGates = readGatesForUpstreamTask(failedTask.id).filter(
        (g) => g.gateType === "on_complete",
      );
      expect(onCompleteGates).toHaveLength(2);
      expect(onCompleteGates.every((g) => g.satisfied)).toBe(true);

      const context = failureContextService.getFailureContextsForTask(failedTask.id)[0];
      expect(onCompleteGates.every((g) => g.satisfiedByEventId === context.id)).toBe(true);

      const redemptionAudits = readRedemptionAudits();
      expect(redemptionAudits).toHaveLength(onCompleteGates.length);
      expect(new Set(redemptionAudits.map((event) => (event.metadata as Record<string, unknown>).gateId))).toEqual(
        new Set(onCompleteGates.map((gate) => gate.id)),
      );
    });

    it("keeps the failure context unresolved when redemption advancement writes fail", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Original",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      attachRecoveryChain(mission.id, habitat.id, failedTask.id, downstream.id, sampleHandler);

      emitTransitionFor(failedTask.id, "failed", habitat.id);
      const recoveryTask = getDb()
        .select()
        .from(tasks)
        .where(eq(tasks.createdBy, "workflow-recovery"))
        .get()!;

      audit.shouldThrow = true;
      emitTransitionFor(recoveryTask.id, "approved", habitat.id);
      audit.shouldThrow = false;

      const onCompleteGates = readGatesForUpstreamTask(failedTask.id).filter(
        (g) => g.gateType === "on_complete",
      );
      expect(onCompleteGates[0].satisfied).toBe(false);
      expect(failureContextRepo.getUnresolvedFailureContextByTaskId(failedTask.id)).not.toBeNull();
      expect(readRedemptionAudits()).toHaveLength(0);
      expect(readRecoverySucceededNotifications(habitat.id)).toHaveLength(0);
    });
  });

  describe("no redemption when recovery itself fails", () => {
    it("does NOT redeem when recovery transitions to 'rejected'", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Original",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      attachRecoveryChain(mission.id, habitat.id, failedTask.id, downstream.id, sampleHandler);

      emitTransitionFor(failedTask.id, "failed", habitat.id);
      const recoveryTask = getDb()
        .select()
        .from(tasks)
        .where(eq(tasks.createdBy, "workflow-recovery"))
        .get()!;
      // Recovery rejected — should NOT trigger redemption. Instead, F2+F3's
      // on_fail gate (upstream=recoveryTask) fires, possibly spawning deeper recovery.
      emitTransitionFor(recoveryTask.id, "rejected", habitat.id);

      const onCompleteGates = readGatesForUpstreamTask(failedTask.id).filter(
        (g) => g.gateType === "on_complete",
      );
      expect(onCompleteGates[0].satisfied).toBe(false);

      // Failure context still unresolved — no redemption.
      const ctx = failureContextRepo.getUnresolvedFailureContextByTaskId(failedTask.id);
      expect(ctx).not.toBeNull();
      expect(ctx!.resolutionKind).toBeNull();
    });

    it("does NOT redeem when recovery transitions to 'failed'", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Original",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      attachRecoveryChain(mission.id, habitat.id, failedTask.id, downstream.id, sampleHandler);

      emitTransitionFor(failedTask.id, "failed", habitat.id);
      const recoveryTask = getDb()
        .select()
        .from(tasks)
        .where(eq(tasks.createdBy, "workflow-recovery"))
        .get()!;
      emitTransitionFor(recoveryTask.id, "failed", habitat.id);

      const onCompleteGates = readGatesForUpstreamTask(failedTask.id).filter(
        (g) => g.gateType === "on_complete",
      );
      expect(onCompleteGates[0].satisfied).toBe(false);
    });
  });

  describe("idempotency", () => {
    it("does not double-satisfy gates or double-resolve when 'approved' fires twice", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Original",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      attachRecoveryChain(mission.id, habitat.id, failedTask.id, downstream.id, sampleHandler);

      emitTransitionFor(failedTask.id, "failed", habitat.id);
      const recoveryTask = getDb()
        .select()
        .from(tasks)
        .where(eq(tasks.createdBy, "workflow-recovery"))
        .get()!;
      emitTransitionFor(recoveryTask.id, "approved", habitat.id);
      // Re-fire approved — the failure context is already resolved,
      // so the WHERE resolvedAt IS NULL guard makes this a no-op.
      emitTransitionFor(recoveryTask.id, "approved", habitat.id);

      const onCompleteGates = readGatesForUpstreamTask(failedTask.id).filter(
        (g) => g.gateType === "on_complete",
      );
      // Still exactly one gate, satisfied once.
      expect(onCompleteGates).toHaveLength(1);
      expect(onCompleteGates[0].satisfied).toBe(true);
    });
  });

  describe("non-recovery tasks", () => {
    it("does not run redemption logic for an approved task that is NOT a recovery task", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Original",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      attachRecoveryChain(mission.id, habitat.id, failedTask.id, downstream.id, sampleHandler);

      emitTransitionFor(failedTask.id, "failed", habitat.id);
      const recoveryTask = getDb()
        .select()
        .from(tasks)
        .where(eq(tasks.createdBy, "workflow-recovery"))
        .get()!;

      // Now create a SEPARATE unrelated task and approve it — should not affect redemption state.
      const unrelated = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Unrelated",
        createdBy: "test",
      });
      emitTransitionFor(unrelated.id, "approved", habitat.id);

      // The failed task's on_complete gate is still unsatisfied (the unrelated task
      // is not the recovery task, so no redemption fired).
      const onCompleteGates = readGatesForUpstreamTask(failedTask.id).filter(
        (g) => g.gateType === "on_complete",
      );
      expect(onCompleteGates[0].satisfied).toBe(false);

      // Recovery task was never approved — context still unresolved.
      const ctx = failureContextRepo.getUnresolvedFailureContextByTaskId(failedTask.id);
      expect(ctx).not.toBeNull();
      // sanity: recoveryTask exists
      expect(recoveryTask).toBeDefined();
    });
  });

  describe("already-satisfied gates", () => {
    it("skips gates that are already satisfied without error", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Original",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      attachRecoveryChain(mission.id, habitat.id, failedTask.id, downstream.id, sampleHandler);

      // Pre-satisfy ONLY the on_complete gate manually (leave on_fail unsatisfied
      // so recovery still spawns).
      getDb()
        .update(taskWorkflowGates)
        .set({ satisfied: true, satisfiedAt: new Date().toISOString() })
        .where(
          and(
            eq(taskWorkflowGates.upstreamTaskId, failedTask.id),
            eq(taskWorkflowGates.gateType, "on_complete"),
          ),
        )
        .run();

      emitTransitionFor(failedTask.id, "failed", habitat.id);
      const recoveryTask = getDb()
        .select()
        .from(tasks)
        .where(eq(tasks.createdBy, "workflow-recovery"))
        .get()!;

      // Redemption should still run (resolve context) but the already-satisfied
      // gate should not be re-touched.
      emitTransitionFor(recoveryTask.id, "approved", habitat.id);

      const onCompleteGates = readGatesForUpstreamTask(failedTask.id).filter(
        (g) => g.gateType === "on_complete",
      );
      expect(onCompleteGates[0].satisfied).toBe(true);
      // Context resolved regardless.
      const ctx = failureContextRepo.getUnresolvedFailureContextByTaskId(failedTask.id);
      expect(ctx).toBeNull();
    });
  });
});
