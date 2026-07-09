import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskCrudRepo from "../repositories/taskCrud.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as pulseService from "../services/pulseService.js";
import {
  attachWorkflow,
  detachWorkflow,
  manualUnblockGate,
  initWorkflowService,
} from "../services/workflowService.js";
import { emitTransition, type TaskAction } from "../services/tasks/transition-emitter.js";
import {
  workflows,
  taskWorkflowGates,
  taskEvents,
  missionEvents,
  tasks,
  missions,
  columns,
  habitats,
  pulses,
} from "../db/schema/index.js";
import type { WorkflowTemplateDefinition } from "../models/index.js";

vi.mock("../services/automationEvaluator.js", () => ({
  evaluateCondition: vi.fn(() => ({ matched: true })),
}));

import { evaluateCondition } from "../services/automationEvaluator.js";

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

function attachSequentialWorkflow(
  missionId: string,
  habitatId: string,
  upstreamTaskId: string,
  downstreamTaskId: string,
  gateType: "on_complete" | "on_approve" = "on_complete",
): string {
  const definition: WorkflowTemplateDefinition = {
    gates: [{ upstreamTaskKey: upstreamTaskId, downstreamTaskKey: downstreamTaskId, gateType }],
  };
  return attachWorkflow(missionId, habitatId, definition, {}, "test-author");
}

function emitTransitionForTask(taskId: string, action: TaskAction, habitatId: string) {
  emitTransition(taskId, action, habitatId, {
    actorType: "system",
    actorId: "test-harness",
  });
}

function readWorkflowMissionEvents(missionId: string, action: string) {
  return getDb()
    .select()
    .from(missionEvents)
    .where(eq(missionEvents.missionId, missionId))
    .all()
    .filter((e) => e.action === action);
}

function readWorkflowTaskEvents(taskId: string, action: string) {
  return getDb()
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .all()
    .filter((e) => e.action === action);
}

describe("workflowService — deferred audit events", () => {
  beforeEach(async () => {
    vi.mocked(evaluateCondition).mockReturnValue({ matched: true } as never);
    await initTestDb();
    initWorkflowService();
    const db = getDb();
    db.delete(taskEvents).run();
    db.delete(missionEvents).run();
    db.delete(taskWorkflowGates).run();
    db.delete(workflows).run();
    db.delete(pulses).run();
    db.delete(tasks).run();
    db.delete(missions).run();
    db.delete(columns).run();
    db.delete(habitats).run();
  });

  afterEach(() => {
    closeDb();
  });

  describe("workflow_attached", () => {
    it("emits a mission event when attachWorkflow creates a workflow", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const upstream = setupTask(mission.id, "Upstream");
      const downstream = setupTask(mission.id, "Downstream");

      attachSequentialWorkflow(mission.id, habitat.id, upstream.id, downstream.id);

      const events = readWorkflowMissionEvents(mission.id, "workflow_attached");
      expect(events).toHaveLength(1);
      expect(events[0].actorType).toBe("system");
      expect(events[0].actorId).toBe("workflow-service");
    });

    it("includes workflowId, habitatId, and gateCount in the payload", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const t1 = setupTask(mission.id, "T1");
      const t2 = setupTask(mission.id, "T2");

      const wfId = attachSequentialWorkflow(mission.id, habitat.id, t1.id, t2.id);

      const events = readWorkflowMissionEvents(mission.id, "workflow_attached");
      const meta = events[0].metadata as Record<string, unknown>;
      expect(meta.workflowId).toBe(wfId);
      expect(meta.habitatId).toBe(habitat.id);
      expect(meta.gateCount).toBe(1);
      expect(meta.audit).toEqual({ source: "workflow" });
    });
  });

  describe("workflow_detached", () => {
    it("emits a mission event when detachWorkflow sets status to detached", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const t1 = setupTask(mission.id, "T1");
      const t2 = setupTask(mission.id, "T2");
      const wfId = attachSequentialWorkflow(mission.id, habitat.id, t1.id, t2.id);

      detachWorkflow(wfId, "admin-1");

      const events = readWorkflowMissionEvents(mission.id, "workflow_detached");
      expect(events).toHaveLength(1);
      expect(events[0].actorType).toBe("system");
      const meta = events[0].metadata as Record<string, unknown>;
      expect(meta.workflowId).toBe(wfId);
      expect(meta.detachedBy).toBe("admin-1");
      expect(meta.audit).toEqual({ source: "workflow" });
    });
  });

  describe("workflow_gate_satisfied", () => {
    it("emits a task event when on_complete gate is satisfied via transition", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const upstream = setupTask(mission.id, "Upstream");
      const downstream = setupTask(mission.id, "Downstream");
      attachSequentialWorkflow(mission.id, habitat.id, upstream.id, downstream.id, "on_complete");

      emitTransitionForTask(upstream.id, "completed", habitat.id);

      const events = readWorkflowTaskEvents(downstream.id, "workflow_gate_satisfied");
      expect(events).toHaveLength(1);
      expect(events[0].actorType).toBe("system");
      const meta = events[0].metadata as Record<string, unknown>;
      expect(meta.gateType).toBe("on_complete");
      expect(meta.triggeredBy).toBe("completed");
      expect(meta.upstreamTaskId).toBe(upstream.id);
      expect(meta.downstreamTaskId).toBe(downstream.id);
      expect(meta.audit).toEqual({ source: "workflow" });
    });

    it("emits a task event when on_approve gate is satisfied via transition", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const upstream = setupTask(mission.id, "Upstream");
      const downstream = setupTask(mission.id, "Downstream");
      attachSequentialWorkflow(mission.id, habitat.id, upstream.id, downstream.id, "on_approve");

      emitTransitionForTask(upstream.id, "approved", habitat.id);

      const events = readWorkflowTaskEvents(downstream.id, "workflow_gate_satisfied");
      expect(events).toHaveLength(1);
      const meta = events[0].metadata as Record<string, unknown>;
      expect(meta.gateType).toBe("on_approve");
    });

    it("emits a task event when on_signal gate is satisfied via pulse", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const upstream = setupTask(mission.id, "Upstream");
      const downstream = setupTask(mission.id, "Downstream");

      const definition: WorkflowTemplateDefinition = {
        gates: [
          {
            upstreamTaskKey: upstream.id,
            downstreamTaskKey: downstream.id,
            gateType: "on_signal",
            matchConfig: { signalType: "blocker", matchScope: "task" },
          },
        ],
      };
      attachWorkflow(mission.id, habitat.id, definition, {}, "test");

      pulseService.createPulseAndNotify({
        missionId: mission.id,
        habitatId: habitat.id,
        fromType: "agent",
        fromId: "agent-1",
        signalType: "blocker",
        subject: "Something blocked",
        taskId: upstream.id,
      });

      const events = readWorkflowTaskEvents(downstream.id, "workflow_gate_satisfied");
      expect(events).toHaveLength(1);
      const meta = events[0].metadata as Record<string, unknown>;
      expect(meta.gateType).toBe("on_signal");
      expect(meta.triggeredBy).toBe("pulse");
    });

    it("does not emit when gate is already satisfied (idempotency)", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const upstream = setupTask(mission.id, "Upstream");
      const downstream = setupTask(mission.id, "Downstream");
      attachSequentialWorkflow(mission.id, habitat.id, upstream.id, downstream.id, "on_complete");

      emitTransitionForTask(upstream.id, "completed", habitat.id);
      emitTransitionForTask(upstream.id, "completed", habitat.id);

      const events = readWorkflowTaskEvents(downstream.id, "workflow_gate_satisfied");
      expect(events).toHaveLength(1);
    });
  });

  describe("workflow_gate_unblocked", () => {
    it("emits a task event when manualUnblockGate fires an on_manual gate", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const upstream = setupTask(mission.id, "Upstream");
      const downstream = setupTask(mission.id, "Downstream");

      const definition: WorkflowTemplateDefinition = {
        gates: [
          {
            upstreamTaskKey: upstream.id,
            downstreamTaskKey: downstream.id,
            gateType: "on_manual",
          },
        ],
      };
      const wfId = attachWorkflow(mission.id, habitat.id, definition, {}, "test");

      const gates = getDb()
        .select()
        .from(taskWorkflowGates)
        .where(eq(taskWorkflowGates.workflowId, wfId))
        .all();
      const gateId = gates[0].id;

      manualUnblockGate(gateId, "admin-1");

      const events = readWorkflowTaskEvents(downstream.id, "workflow_gate_unblocked");
      expect(events).toHaveLength(1);
      expect(events[0].actorType).toBe("system");
      const meta = events[0].metadata as Record<string, unknown>;
      expect(meta.gateId).toBe(gateId);
      expect(meta.unblockedBy).toBe("admin-1");
      expect(meta.audit).toEqual({ source: "workflow" });
    });

    // CR-13 / TG-1: manualUnblockGate emits a workflow_gate_unblocked audit
    // event on BOTH the first unblock (unsatisfied → satisfied) and a repeat
    // unblock (already_satisfied). satisfyManualGateIfEligible returns
    // "already_satisfied" on the second call, but manualUnblockGate only
    // short-circuits on not_found/wrong_gate_type — so the audit fires again.
    it("emits an audit event on a repeat unblock of an already-satisfied gate", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const upstream = setupTask(mission.id, "Upstream");
      const downstream = setupTask(mission.id, "Downstream");

      const definition: WorkflowTemplateDefinition = {
        gates: [
          {
            upstreamTaskKey: upstream.id,
            downstreamTaskKey: downstream.id,
            gateType: "on_manual",
          },
        ],
      };
      const wfId = attachWorkflow(mission.id, habitat.id, definition, {}, "test");

      const gates = getDb()
        .select()
        .from(taskWorkflowGates)
        .where(eq(taskWorkflowGates.workflowId, wfId))
        .all();
      const gateId = gates[0].id;

      const first = manualUnblockGate(gateId, "admin-1");
      const second = manualUnblockGate(gateId, "admin-1");

      expect(first).toBe(true);
      expect(second).toBe(true);

      const events = readWorkflowTaskEvents(downstream.id, "workflow_gate_unblocked");
      expect(events).toHaveLength(2);
      for (const e of events) {
        const m = e.metadata as Record<string, unknown>;
        expect(m.gateId).toBe(gateId);
        expect(m.unblockedBy).toBe("admin-1");
        expect(m.audit).toEqual({ source: "workflow" });
      }
    });
  });

  describe("workflow_evaluation_error", () => {
    it("emits a task event when gate condition evaluation throws", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const upstream = setupTask(mission.id, "Upstream");
      const downstream = setupTask(mission.id, "Downstream");

      const definition: WorkflowTemplateDefinition = {
        gates: [
          {
            upstreamTaskKey: upstream.id,
            downstreamTaskKey: downstream.id,
            gateType: "on_complete",
            condition: { type: "and", children: [] },
          },
        ],
      };
      attachWorkflow(mission.id, habitat.id, definition, {}, "test");

      vi.mocked(evaluateCondition).mockImplementationOnce(() => {
        throw new Error("malformed predicate");
      });

      emitTransitionForTask(upstream.id, "completed", habitat.id);

      const events = readWorkflowTaskEvents(downstream.id, "workflow_evaluation_error");
      expect(events).toHaveLength(1);
      expect(events[0].actorType).toBe("system");
      const meta = events[0].metadata as Record<string, unknown>;
      expect(meta.error).toBe("malformed predicate");
      expect(meta.phase).toBe("gate_satisfaction");
      expect(meta.audit).toEqual({ source: "workflow" });
    });

    it("does not crash the subscriber — other gates still process", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const upstream = setupTask(mission.id, "Upstream");
      const downstreamOk = setupTask(mission.id, "Downstream-OK");
      const downstreamErr = setupTask(mission.id, "Downstream-Err");

      const definition: WorkflowTemplateDefinition = {
        gates: [
          {
            upstreamTaskKey: upstream.id,
            downstreamTaskKey: downstreamOk.id,
            gateType: "on_complete",
          },
          {
            upstreamTaskKey: upstream.id,
            downstreamTaskKey: downstreamErr.id,
            gateType: "on_complete",
            condition: { type: "and", children: [] },
          },
        ],
      };
      attachWorkflow(mission.id, habitat.id, definition, {}, "test");

      let callCount = 0;
      vi.mocked(evaluateCondition).mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error("eval error on first condition");
        return { matched: true } as never;
      });

      emitTransitionForTask(upstream.id, "completed", habitat.id);

      const errEvents = readWorkflowTaskEvents(downstreamErr.id, "workflow_evaluation_error");
      expect(errEvents).toHaveLength(1);

      const okEvents = readWorkflowTaskEvents(downstreamOk.id, "workflow_gate_satisfied");
      expect(okEvents).toHaveLength(1);
    });
  });

  describe("F5 recovery events regression", () => {
    it("workflow_gate_satisfied still fires for on_fail gates alongside recovery_started", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = setupTask(mission.id, "Will fail");
      const downstream = setupTask(mission.id, "Downstream");

      const definition: WorkflowTemplateDefinition = {
        gates: [
          {
            upstreamTaskKey: failedTask.id,
            downstreamTaskKey: downstream.id,
            gateType: "on_fail",
          },
        ],
        failureHandler: {
          recoveryTaskTemplate: {
            title: "Recovery task",
            description: "Fix it",
          },
        },
      };
      attachWorkflow(mission.id, habitat.id, definition, {}, "test");

      emitTransitionForTask(failedTask.id, "failed", habitat.id);

      const events = readWorkflowTaskEvents(downstream.id, "workflow_gate_satisfied");
      expect(events).toHaveLength(1);
      const meta = events[0].metadata as Record<string, unknown>;
      expect(meta.gateType).toBe("on_fail");
      expect(meta.triggeredBy).toBe("failed");
    });
  });

  describe("detached workflow gate suppression (AC-CHAR-5)", () => {
    it("does not satisfy on_complete gate via transition when workflow is detached", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const upstream = setupTask(mission.id, "Upstream");
      const downstream = setupTask(mission.id, "Downstream");
      const wfId = attachSequentialWorkflow(
        mission.id,
        habitat.id,
        upstream.id,
        downstream.id,
        "on_complete",
      );

      // Detach the workflow directly, bypassing the detachWorkflow audit-emission path.
      getDb().update(workflows).set({ status: "detached" }).where(eq(workflows.id, wfId)).run();

      emitTransitionForTask(upstream.id, "completed", habitat.id);

      const events = readWorkflowTaskEvents(downstream.id, "workflow_gate_satisfied");
      expect(events).toHaveLength(0);
    });

    it("does not satisfy on_signal gate via pulse when workflow is detached", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const upstream = setupTask(mission.id, "Upstream");
      const downstream = setupTask(mission.id, "Downstream");

      const definition: WorkflowTemplateDefinition = {
        gates: [
          {
            upstreamTaskKey: upstream.id,
            downstreamTaskKey: downstream.id,
            gateType: "on_signal",
            matchConfig: { signalType: "blocker", matchScope: "task" },
          },
        ],
      };
      const wfId = attachWorkflow(mission.id, habitat.id, definition, {}, "test");

      getDb().update(workflows).set({ status: "detached" }).where(eq(workflows.id, wfId)).run();

      pulseService.createPulseAndNotify({
        missionId: mission.id,
        habitatId: habitat.id,
        fromType: "agent",
        fromId: "agent-1",
        signalType: "blocker",
        subject: "Something blocked",
        taskId: upstream.id,
      });

      const events = readWorkflowTaskEvents(downstream.id, "workflow_gate_satisfied");
      expect(events).toHaveLength(0);
    });
  });
});
