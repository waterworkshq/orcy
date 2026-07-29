/**
 * CS-56 cold-review m3.4 — `on_automation outcome=skipped` integration test.
 *
 * Pre-fix characterization proved that the lifecycle emits a completion
 * callback for every terminal branch (CS-56 §3 / gate #12). But there was
 * NO load-bearing test that proves a Workflow Gate configured for
 * `outcome=skipped` actually observes the completion. This file closes
 * that gap: a single end-to-end test that builds:
 *   1. an enabled rule whose condition is FALSE on the trigger payload
 *      (`{ type: "priority_above", threshold: "high" }` evaluated against a
 *      low-priority Task → finalizes `skipped/condition_false` with the
 *      lifecycle's `outcome="skipped"`),
 *   2. an attached Workflow whose single gate is `on_automation` with
 *      `matchConfig: { ruleId, outcome: "skipped" }`, and
 *   3. an assertion that the gate is satisfied (one
 *      `workflow_gate_satisfied` audit on the downstream TaskId) by the
 *      in-process Workflow Service listener registered at boot.
 *
 * This pins gate #12 of the acceptance matrix on the runtime path that
 * actually delivers the event to a Workflow Gate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as ruleRepo from "../repositories/automationRule.js";
import { missionEvents, taskEvents, tasks } from "../db/schema/index.js";
import { attemptRuleRun } from "../services/automationAttemptLifecycle.js";
import { attachWorkflow, initWorkflowService } from "../services/workflowService.js";
import type { WorkflowTemplateDefinition } from "../models/index.js";

function setupHabitat(name = "Gate Habitat") {
  const h = boardRepo.createHabitat({ name });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  return h;
}

function setupMission(habitatId: string) {
  return missionRepo.createMission({
    habitatId,
    title: "Gate Mission",
    createdBy: "user-1",
  });
}

function setupTask(missionId: string, title: string, priority: "low" | "medium" | "high" | "critical" = "low") {
  return taskRepo.createTask({ missionId, title, priority, createdBy: "user-1" });
}

function readTaskEvents(taskId: string, action: string) {
  return getDb()
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .all()
    .filter((e) => e.action === action);
}

describe("CS-56 cold-review m3.4 — on_automation outcome=skipped integration", () => {
  beforeEach(async () => {
    await initTestDb();
    // Initialize the workflow service so the onAutomationRunCompleted
    // listener (registered at boot) is active for the test.
    initWorkflowService();
    // Clear any pre-existing automation-related task events.
    const db = getDb();
    db.delete(taskEvents).run();
    db.delete(missionEvents).run();
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
  });

  it("a condition_false terminal skip satisfies an on_automation outcome=skipped gate on the downstream task", async () => {
    const habitat = setupHabitat();
    const mission = setupMission(habitat.id);
    // upstream Task is the rule's trigger target; downstream Task is what
    // the on_automation gate unblocks.
    const upstreamTask = setupTask(mission.id, "Upstream", "low");
    const downstreamTask = setupTask(mission.id, "Downstream", "low");

    // Rule has a FALSE condition (priority_above:high) — when evaluated
    // against a low-priority upstream, the lifecycle finalizes
    // `skipped/condition_false` with `outcome="skipped"`.
    const rule = ruleRepo.createAutomationRule({
      habitatId: habitat.id,
      name: "Skipped outcome rule",
      priority: 0,
      trigger: { type: "event", eventType: "task.rejected" },
      condition: { type: "priority_above", threshold: "high" },
      actions: [{ type: "create_signal", content: "Should NOT fire" }] as unknown as Parameters<
        typeof ruleRepo.createAutomationRule
      >[0]["actions"],
      cooldownSeconds: 0,
      maxRunsPerHour: 100,
      enabled: true,
      createdBy: "test",
    });

    // Attach a workflow with a single on_automation gate that watches
    // the upstream Task for `outcome=skipped`. Per the gate evaluator
    // (workflowGateEvaluator.automationMatchEqualsRun), the gate matches
    // when `opts.outcome === "skipped"` and the run's ruleId matches.
    const definition: WorkflowTemplateDefinition = {
      gates: [
        {
          upstreamTaskKey: upstreamTask.id,
          downstreamTaskKey: downstreamTask.id,
          gateType: "on_automation",
          matchConfig: { ruleId: rule.id, outcome: "skipped" },
        },
      ],
    };
    attachWorkflow(mission.id, habitat.id, definition, {}, "test-author");

    // Drive the lifecycle directly with a condition that finalizes
    // `skipped/condition_false` (low-priority task against a
    // priority_above:high threshold).
    const disposition = await attemptRuleRun({
      rule,
      source: "event",
      trigger: {
        triggerType: "task.rejected",
        triggerEventId: "evt-on-auto-skipped-1",
        habitatId: habitat.id,
        targetType: "task",
        targetId: upstreamTask.id,
      },
    });

    // Sanity: this attempt must be a terminal skipped run, with
    // `outcome="skipped"` (the gate filter key).
    expect(disposition.kind).toBe("skipped");
    if (disposition.kind !== "skipped") throw new Error("expected skipped");
    expect(disposition.reason).toBe("condition_false");

    // The Workflow Service listener should have observed the completion
    // and satisfied the on_automation gate on the downstream Task. The
    // audit event for the downstream Task id is the load-bearing
    // observable for gate #12 of the acceptance matrix.
    const satisfied = readTaskEvents(downstreamTask.id, "workflow_gate_satisfied");
    expect(satisfied).toHaveLength(1);
    const meta = satisfied[0].metadata as Record<string, unknown>;
    expect(meta.gateType).toBe("on_automation");
    expect(meta.runId).toBe(disposition.run.id);
    expect(meta.ruleId).toBe(rule.id);
    expect(meta.upstreamTaskId).toBe(upstreamTask.id);
    expect(meta.downstreamTaskId).toBe(downstreamTask.id);

    // Sanity: the upstream Task itself got NO `workflow_gate_satisfied`
    // event — the gate watches the upstream Task's automation run, but
    // it fires the audit on the DOWNSTREAM Task.
    const upstreamEvents = readTaskEvents(upstreamTask.id, "workflow_gate_satisfied");
    expect(upstreamEvents).toHaveLength(0);
  });
});
