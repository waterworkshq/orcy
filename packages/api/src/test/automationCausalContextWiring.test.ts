/**
 * Fix-P3 / M2 — inherited causalContext reaches action execution.
 *
 * Proves the wiring introduced in Fix-P3: the trusted-envelope `causalContext`
 * extracted by `ingestEvent` is carried through `executeAndRecordRuleRun` →
 * `buildTriggerContext` → `buildEvaluationContext` onto the
 * `AutomationEvaluationContext` that actions receive. T8B (the producer) reads
 * this seam to append its own hop before republishing, so the context MUST land
 * here verbatim.
 *
 * Capture strategy: wrap `buildEvaluationContext` (imported by the executor
 * from a separate module, so the mock IS hit by the internal call — unlike a
 * same-module `executeActions` spy). The wrapper delegates to the real
 * implementation and records the returned ctx, which is exactly the value
 * passed onward to `executeActions`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AutomationEvaluationContext } from "../services/automationContextBuilder.js";
import type { AutomationTriggerContext, CausalContext } from "@orcy/shared";
import { closeDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as ruleRepo from "../repositories/automationRule.js";
import { ingestEvent } from "../services/automationEventService.js";

// `vi.hoisted` runs before the hoisted `vi.mock` factory so the capture holder
// is initialized when the factory's wrapper closes over it.
const capture = vi.hoisted(() => ({ ctx: null as AutomationEvaluationContext | null }));

vi.mock("../services/automationContextBuilder.js", async (importActual) => {
  const actual = (await importActual()) as typeof import("../services/automationContextBuilder.js");
  return {
    ...actual,
    buildEvaluationContext: (trigger: AutomationTriggerContext) => {
      const ctx = actual.buildEvaluationContext(trigger);
      capture.ctx = ctx;
      return ctx;
    },
  };
});

// ---------------------------------------------------------------------------
// Fixtures (mirror the T4C ingestion proofs)
// ---------------------------------------------------------------------------

function setupHabitat() {
  const h = boardRepo.createHabitat({ name: "M2 Wiring Habitat" });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  return h;
}

function setupMission(habitatId: string) {
  return missionRepo.createMission({ habitatId, title: "M2 Mission", createdBy: "user-1" });
}

function setupTask(missionId: string) {
  return taskRepo.createTask({ missionId, title: "M2 Task", createdBy: "user-1" });
}

function createTaskCreatedRule(habitatId: string) {
  ruleRepo.createAutomationRule({
    habitatId,
    name: "M2 task.created rule",
    trigger: { type: "event", eventType: "task.created" },
    condition: { type: "always" },
    actions: [{ type: "create_signal", content: "M2 triggered" }],
    cooldownSeconds: 300,
    maxRunsPerHour: 100,
    priority: 0,
    enabled: true,
    createdBy: "test",
  });
  return ruleRepo.getEnabledRulesByHabitatAndTrigger(habitatId, "task.created")[0];
}

function createTaskRejectedRule(habitatId: string) {
  ruleRepo.createAutomationRule({
    habitatId,
    name: "M2 task.rejected rule",
    trigger: { type: "event", eventType: "task.rejected" },
    condition: { type: "always" },
    actions: [{ type: "create_signal", content: "M2 rejected triggered" }],
    cooldownSeconds: 300,
    maxRunsPerHour: 100,
    priority: 0,
    enabled: true,
    createdBy: "test",
  });
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Fix-P3 / M2 — inherited causalContext wiring to action execution", () => {
  beforeEach(async () => {
    capture.ctx = null;
    await initTestDb();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeDb();
  });

  it("task.created trusted envelope: the action-execution ctx carries the EXACT inherited causalContext (root + parent + hops verbatim)", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    createTaskCreatedRule(h.id);

    const inherited: CausalContext = {
      root: { type: "human", id: "user-origin" },
      parent: { type: "automation_rule_run", id: "run-ancestor-42" },
      hops: [
        { type: "automation", id: "rule-alpha" },
        { type: "automation", id: "rule-beta" },
      ],
    };

    const result = await ingestEvent(h.id, {
      type: "task.created",
      data: {
        taskId: task.id,
        eventId: "evt-m2-inherited",
        habitatId: "",
        lifecycleAction: "created",
        causalContext: inherited,
      },
    });

    expect(result.matched).toBe(1);
    expect(result.skipped).toBe(0);

    // The ctx built inside executeAndRecordRuleRun — the very value handed to
    // executeActions — carries the inherited causalContext byte-for-byte.
    expect(capture.ctx).not.toBeNull();
    const ctxCausal = capture.ctx!.causalContext as CausalContext | undefined;
    expect(ctxCausal).toBeDefined();
    expect(ctxCausal).toEqual(inherited);
    // Field-level verbatim (defensive — guards against shallow-clone drift).
    expect(ctxCausal!.root).toEqual({ type: "human", id: "user-origin" });
    expect(ctxCausal!.parent).toEqual({ type: "automation_rule_run", id: "run-ancestor-42" });
    expect(ctxCausal!.hops).toEqual(inherited.hops);
    // No hop appended here — M2 is carry-only; T8B appends.
    expect(ctxCausal!.hops).toHaveLength(2);
  });

  it("non-task.created event (task.rejected): the action-execution ctx's causalContext is undefined (no inherited chain)", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    createTaskRejectedRule(h.id);

    const result = await ingestEvent(h.id, {
      type: "task.rejected",
      data: { taskId: task.id, eventId: "evt-m2-rejected" },
    });

    expect(result.matched).toBe(1);

    expect(capture.ctx).not.toBeNull();
    expect(capture.ctx!.causalContext).toBeUndefined();
  });
});
