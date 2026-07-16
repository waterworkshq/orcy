import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import { eq, and } from "drizzle-orm";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskCrudRepo from "../repositories/taskCrud.js";
import * as notificationEventRepo from "../repositories/notificationEvent.js";
import {
  attachWorkflow,
  initWorkflowService,
  MAX_RECOVERY_DEPTH,
} from "../services/workflowService.js";
import { emitTransition, type TaskAction } from "../services/tasks/transition-emitter.js";
import {
  notificationEvents,
  taskWorkflowGates,
  workflows,
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

function emit(taskId: string, action: TaskAction, habitatId: string) {
  emitTransition(taskId, action, habitatId, {
    actorType: "system",
    actorId: "test-harness",
  });
}

function readWorkflowNotifications(habitatId: string) {
  return getDb()
    .select()
    .from(notificationEvents)
    .where(eq(notificationEvents.habitatId, habitatId))
    .all()
    .filter((e) => (e.eventType as string).startsWith("workflow."));
}

const sampleHandler: WorkflowFailureHandlerConfig = {
  recoveryTaskTemplate: { title: "Recovery" },
};

describe("workflowService — audit + notification integration (F5)", () => {
  beforeEach(async () => {
    await initTestDb();
    initWorkflowService();
    const db = getDb();
    db.delete(tasks).run();
    db.delete(missions).run();
    db.delete(columns).run();
    db.delete(habitats).run();
    db.delete(taskWorkflowGates).run();
    db.delete(workflows).run();
    db.delete(tasks).run();
    db.delete(notificationEvents).run();
  });

  afterEach(() => {
    closeDb();
  });

  describe("workflow.recovery_started notification", () => {
    it("emits when F3 spawns a recovery task", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Will Fail",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      const def: WorkflowTemplateDefinition = {
        gates: [
          { upstreamTaskKey: failedTask.id, downstreamTaskKey: downstream.id, gateType: "on_fail" },
        ],
        failureHandler: sampleHandler,
      };
      attachWorkflow(mission.id, habitat.id, def, {}, "test");

      emit(failedTask.id, "failed", habitat.id);

      const wfNotes = readWorkflowNotifications(habitat.id);
      expect(wfNotes.length).toBeGreaterThanOrEqual(1);
      const started = wfNotes.find((e) => e.eventType === "workflow.recovery_started");
      expect(started).toBeDefined();
      expect(started!.sourceType).toBe("workflow");
      const payload = started!.payload as Record<string, unknown>;
      expect(payload.failedTaskId).toBe(failedTask.id);
      expect(payload.recoveryTaskId).toBeDefined();
      expect(payload.recoveryDepth).toBe(1);
    });
  });

  describe("workflow.recovery_unrecoverable notification", () => {
    it("emits when depth cap is reached instead of spawning", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Will Fail",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      const def: WorkflowTemplateDefinition = {
        gates: [
          { upstreamTaskKey: failedTask.id, downstreamTaskKey: downstream.id, gateType: "on_fail" },
        ],
        failureHandler: sampleHandler,
      };
      attachWorkflow(mission.id, habitat.id, def, {}, "test");

      // Bump gate to the cap so spawning is suppressed.
      getDb()
        .update(taskWorkflowGates)
        .set({ recoveryDepth: MAX_RECOVERY_DEPTH })
        .where(eq(taskWorkflowGates.upstreamTaskId, failedTask.id))
        .run();

      emit(failedTask.id, "failed", habitat.id);

      const wfNotes = readWorkflowNotifications(habitat.id);
      const unrecoverable = wfNotes.find((e) => e.eventType === "workflow.recovery_unrecoverable");
      expect(unrecoverable).toBeDefined();
      expect(unrecoverable!.sourceType).toBe("workflow");
      const payload = unrecoverable!.payload as Record<string, unknown>;
      expect(payload.failedTaskId).toBe(failedTask.id);
      expect(payload.recoveryDepth).toBe(MAX_RECOVERY_DEPTH);
    });
  });

  describe("workflow.recovery_succeeded notification", () => {
    it("emits when F4 redemption fires", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Will Fail",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      const def: WorkflowTemplateDefinition = {
        gates: [
          { upstreamTaskKey: failedTask.id, downstreamTaskKey: downstream.id, gateType: "on_fail" },
          {
            upstreamTaskKey: failedTask.id,
            downstreamTaskKey: downstream.id,
            gateType: "on_complete",
          },
        ],
        failureHandler: sampleHandler,
      };
      attachWorkflow(mission.id, habitat.id, def, {}, "test");

      // Trigger failure → spawn recovery
      emit(failedTask.id, "failed", habitat.id);
      const recoveryTask = getDb()
        .select()
        .from(tasks)
        .where(eq(tasks.createdBy, "workflow-recovery"))
        .get()!;

      // Clear notifications so we only see the redemption emission
      getDb().delete(notificationEvents).run();

      // Approve recovery → redemption
      emit(recoveryTask.id, "approved", habitat.id);

      const wfNotes = readWorkflowNotifications(habitat.id);
      const succeeded = wfNotes.find((e) => e.eventType === "workflow.recovery_succeeded");
      expect(succeeded).toBeDefined();
      expect(succeeded!.sourceType).toBe("workflow");
      const payload = succeeded!.payload as Record<string, unknown>;
      expect(payload.failedTaskId).toBe(failedTask.id);
      expect(payload.gatesSatisfied).toBeDefined();
    });
  });

  describe("no spurious notifications", () => {
    it("does not emit workflow notifications when no failureHandler is configured", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Will Fail",
        createdBy: "test",
      });
      const downstream = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Downstream",
        createdBy: "test",
      });
      const def: WorkflowTemplateDefinition = {
        gates: [
          { upstreamTaskKey: failedTask.id, downstreamTaskKey: downstream.id, gateType: "on_fail" },
        ],
        // no failureHandler
      };
      attachWorkflow(mission.id, habitat.id, def, {}, "test");

      emit(failedTask.id, "failed", habitat.id);

      const wfNotes = readWorkflowNotifications(habitat.id);
      expect(wfNotes).toHaveLength(0);
    });
  });
});
