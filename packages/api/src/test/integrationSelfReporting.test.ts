import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskCrudRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as pulseService from "../services/pulseService.js";
import * as failureContextService from "../services/failureContextService.js";
import { initSkillHooks } from "../services/habitatSkillService.js";
import { attachWorkflow, initWorkflowService } from "../services/workflowService.js";
import { emitTransition, type TaskAction } from "../services/tasks/transition-emitter.js";
import {
  habitatSkillSignals,
  pulses,
  taskWorkflowGates,
  workflows,
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

function setupAgent(name: string) {
  return agentRepo.createAgent({ name, type: "claude-code", domain: "general" }).agent;
}

beforeEach(async () => {
  await initTestDb();
  initWorkflowService();
  initSkillHooks();
  const db = getDb();
  db.delete(habitatSkillSignals).run();
  db.delete(notificationEvents).run();
  db.delete(failureContexts).run();
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

describe("I1 Scenario 5 — Self-reporting cross-feature bridge", () => {
  it("flows experience signal → skill ingestion → failure context → recovery notification", () => {
    const { habitat, col } = setupHabitat();
    const mission = setupMission(habitat.id, col.id);
    const agent = setupAgent("agent-1");
    const task = taskCrudRepo.createTask({
      missionId: mission.id,
      title: "Complex task",
      createdBy: "test",
    });
    // Assign the agent so experience signals are attributed correctly.
    taskCrudRepo.updateTask(task.id, { assignedAgentId: agent.id });

    const definition: WorkflowTemplateDefinition = {
      gates: [{ upstreamTaskKey: task.id, downstreamTaskKey: task.id, gateType: "on_fail" }],
      failureHandler: {
        recoveryTaskTemplate: {
          title: "Investigate {{failedTaskTitle}}",
          description: "Root cause the stuck experience",
        },
      },
    };
    attachWorkflow(mission.id, habitat.id, definition, {}, "test");

    // Step 1: Agent posts a mid-task experience signal ("stuck").
    const pulse = pulseService.createPulseAndNotify({
      missionId: mission.id,
      habitatId: habitat.id,
      fromType: "agent",
      fromId: agent.id,
      signalType: "experience",
      subject: "Hit a wall with the auth module",
      taskId: task.id,
      body: "The JWT refresh flow is more complex than expected",
      metadata: { experience: "stuck", implicit: true, timing: "mid_task" },
    });

    // Step 2: Verify pulse stored with correct metadata.
    expect(pulse.signalType).toBe("experience");
    expect(pulse.metadata?.experience).toBe("stuck");
    expect(pulse.metadata?.implicit).toBe(true);
    expect(pulse.metadata?.timing).toBe("mid_task");

    // Step 3: Verify habitatSkillService.ingestFromPulse created a pitfall skill signal (S4 mapping).
    const skillSignals = getDb()
      .select()
      .from(habitatSkillSignals)
      .where(eq(habitatSkillSignals.habitatId, habitat.id))
      .all();

    const pitfallSignals = skillSignals.filter((s) => s.skillCategory === "pitfall");
    expect(pitfallSignals.length).toBeGreaterThanOrEqual(1);
    const stuckSignal = pitfallSignals.find((s) => s.sourceSignalType === "experience");
    expect(stuckSignal).toBeTruthy();

    // Step 4: Fail the task → verify FailureContext includes the experience signal.
    emitTransition(task.id, "failed" as TaskAction, habitat.id, {
      actorType: "agent",
      actorId: agent.id,
      reason: "Could not resolve auth issue",
      metadata: { reason: "Could not resolve auth issue" },
    });

    const ctx = failureContextService.getFailureContext(task.id);
    expect(ctx).not.toBeNull();
    const bundle = ctx!.bundle as Record<string, unknown>;
    const experienceSignals = bundle.experienceSignals as Array<Record<string, unknown>>;
    expect(Array.isArray(experienceSignals)).toBe(true);
    expect(experienceSignals.length).toBeGreaterThanOrEqual(1);
    const stuckSnapshot = experienceSignals.find((s) => s.experience === "stuck");
    expect(stuckSnapshot).toBeTruthy();
    expect(stuckSnapshot!.subject).toBe("Hit a wall with the auth module");

    // Step 5: Verify recovery notification fired.
    const startedNotifs = getDb()
      .select()
      .from(notificationEvents)
      .where(eq(notificationEvents.habitatId, habitat.id))
      .all()
      .filter((e) => e.eventType === "workflow.recovery_started");
    expect(startedNotifs).toHaveLength(1);

    // Step 6: Verify the recovery task was spawned with variable substitution.
    const failGates = getDb()
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.recoveryTaskId, ctx!.recoveryTaskId ?? ""))
      .all();
    // The original gate's recoveryTaskId should be set.
    const originalGate = getDb()
      .select()
      .from(taskWorkflowGates)
      .all()
      .find((g) => g.recoveryTaskId !== null);
    expect(originalGate).toBeTruthy();

    const recoveryTask = taskCrudRepo.getTaskById(originalGate!.recoveryTaskId!);
    expect(recoveryTask).not.toBeNull();
    expect(recoveryTask!.title).toContain("Investigate");
    expect(recoveryTask!.title).toContain("Complex task");
  });
});
