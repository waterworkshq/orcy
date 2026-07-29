/**
 * CS-56 T3 — Direct unit tests for the canonical rule-attempt lifecycle.
 *
 * Exercises the 10-step ordering in `automationAttemptLifecycle.attemptRuleRun`:
 *   1. normalize + validate target
 *   2. cooldown
 *   3. admitted-attempt hourly cap
 *   4. reserve/start or return `deduplicated`
 *   5. runtime-validate condition
 *   6. evaluate condition
 *   7. causal cycle/depth
 *   8. kill switch
 *   9. ordered actions
 *  10. owned terminalization + completion
 *
 * The acceptance checklist (and these tests) prove:
 *   - No false condition reaches `executeActions`.
 *   - Condition evaluation precedes causal classification.
 *   - Every branch persists the correct condition tree.
 *   - Kill switch is `skipped/disabled`, never success.
 *   - Double finalization and duplicate reservation emit no second completion.
 *   - One throwing completion subscriber does not block the others.
 *   - The returned disposition contains the refreshed terminal row.
 *
 * These tests call the new seam directly. They do NOT exercise
 * `executeAndRecordRuleRun` (compat path) — that is the
 * automationCS56Characterization + automationExecutor suite's job.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as pulseRepo from "../repositories/pulse.js";
import { attemptRuleRun, CAUSAL_DEPTH_LIMIT } from "../services/automationAttemptLifecycle.js";
import type { AutomationAttemptInput } from "../services/automationAttemptLifecycle.js";
import { onAutomationRunCompleted } from "../services/automationExecutor.js";
import type { AutomationCondition, AutomationRule } from "@orcy/shared";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function setupHabitat() {
  const h = boardRepo.createHabitat({ name: "Lifecycle Habitat" });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  return h;
}

function setupMission(habitatId: string) {
  return missionRepo.createMission({ habitatId, title: "Lifecycle Mission", createdBy: "user-1" });
}

function setupTask(missionId: string, priority: "low" | "medium" | "high" | "critical" = "high") {
  return taskRepo.createTask({
    missionId,
    title: "Lifecycle Task",
    priority,
    createdBy: "user-1",
  });
}

function createEnabledRule(
  habitatId: string,
  overrides?: Partial<{
    name: string;
    condition: AutomationCondition;
    cooldownSeconds: number;
    maxRunsPerHour: number;
    triggerType: string;
    actions: Array<{ type: string; [k: string]: unknown }>;
  }>,
): AutomationRule {
  const triggerType = overrides?.triggerType ?? "task.rejected";
  const isEvent =
    triggerType.startsWith("task.") ||
    triggerType.startsWith("mission.") ||
    triggerType.startsWith("pulse.") ||
    triggerType.startsWith("sprint.");
  const trigger = isEvent
    ? { type: "event", eventType: triggerType }
    : { type: "scan", scanType: triggerType };
  return ruleRepo.createAutomationRule({
    habitatId,
    name: overrides?.name ?? "Lifecycle Rule",
    priority: 0,
    trigger: trigger as unknown as Parameters<typeof ruleRepo.createAutomationRule>[0]["trigger"],
    condition: overrides?.condition ?? ({ type: "always" } as AutomationCondition),
    actions: (overrides?.actions ?? [
      { type: "create_signal", content: "Lifecycle fired" },
    ]) as unknown as Parameters<typeof ruleRepo.createAutomationRule>[0]["actions"],
    cooldownSeconds: overrides?.cooldownSeconds ?? 0,
    maxRunsPerHour: overrides?.maxRunsPerHour ?? 100,
    enabled: true,
    createdBy: "test",
  });
}

function makeInput(
  rule: AutomationRule,
  habitatId: string,
  taskId: string,
  overrides?: Partial<AutomationAttemptInput>,
): AutomationAttemptInput {
  return {
    rule,
    source: "event",
    trigger: {
      triggerType: "task.rejected",
      triggerEventId: `evt-${Math.random().toString(36).slice(2, 8)}`,
      habitatId,
      targetType: "task",
      targetId: taskId,
      payload: { taskId, eventId: "evt-test" },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. True condition → executed
// ---------------------------------------------------------------------------

describe("CS-56 T3 — true condition branch", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("returns executed with refreshed terminal row and emits one completion", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, {
      condition: { type: "priority_above", threshold: "medium" },
      cooldownSeconds: 0,
    });

    let hookCalls = 0;
    let hookOutcome: string | null = null;
    const unsub = onAutomationRunCompleted((opts) => {
      hookCalls++;
      hookOutcome = opts.outcome;
    });

    const result = await attemptRuleRun(makeInput(rule, h.id, task.id));

    expect(result.kind).toBe("executed");
    if (result.kind !== "executed") throw new Error("expected executed");
    expect(result.run.status).toBe("succeeded");
    expect(result.run.finishedAt).not.toBeNull();
    expect(result.run.conditionResult).not.toBeNull();
    expect(result.run.conditionResult?.matched).toBe(true);
    expect(result.run.actionResults).toHaveLength(1);
    expect(result.run.actionResults?.[0]?.status).toBe("succeeded");
    expect(hookCalls).toBe(1);
    expect(hookOutcome).toBe("succeeded");
    unsub();
  });

  it("an {type:'always'} rule short-circuits to true and runs actions", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    const rule = createEnabledRule(h.id, { condition: { type: "always" }, cooldownSeconds: 0 });

    const result = await attemptRuleRun(makeInput(rule, h.id, task.id));

    expect(result.kind).toBe("executed");
    if (result.kind !== "executed") throw new Error("expected executed");
    expect(result.run.conditionResult?.matched).toBe(true);
    expect(result.run.conditionResult?.conditionType).toBe("always");
  });
});

// ---------------------------------------------------------------------------
// 2. False condition → skipped/condition_false with the false result
// ---------------------------------------------------------------------------

describe("CS-56 T3 — false condition branch", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("returns skipped/condition_false, never executes actions, persists the false tree", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "low");
    const rule = createEnabledRule(h.id, {
      condition: { type: "priority_above", threshold: "high" },
      cooldownSeconds: 0,
    });

    const baseline = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;

    let hookCalls = 0;
    const unsub = onAutomationRunCompleted(() => {
      hookCalls++;
    });

    const result = await attemptRuleRun(makeInput(rule, h.id, task.id));

    expect(result.kind).toBe("skipped");
    if (result.kind !== "skipped") throw new Error("expected skipped");
    expect(result.reason).toBe("condition_false");
    expect(result.run.status).toBe("skipped");
    expect(result.run.skipReason).toBe("condition_false");
    expect(result.run.conditionResult).not.toBeNull();
    expect(result.run.conditionResult?.matched).toBe(false);
    expect(result.run.actionResults).toBeNull();

    // No actions ran — no pulse was created.
    const after = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;
    expect(after).toBe(baseline);

    // Completion emitted once for the skip.
    expect(hookCalls).toBe(1);
    unsub();
  });
});

// ---------------------------------------------------------------------------
// 3. Malformed / depth-exceeded condition → failed
// ---------------------------------------------------------------------------

describe("CS-56 T3 — failed condition branch", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("returns failed/stage:condition with synthetic unmatched `invalid` result + bounded diagnostic", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    const rule = createEnabledRule(h.id, { cooldownSeconds: 0 });

    // Persist a known-invalid tree directly via the DB (bypasses the
    // route schema — the runtime validator is what we test).
    const ruleId = rule.id;
    const invalid = { type: "field" } as unknown as AutomationCondition;
    const db = (await import("../db/index.js")).getDb();
    const { automationRules } = await import("../db/schema/index.js");
    const { eq } = await import("drizzle-orm");
    db.update(automationRules).set({ condition: invalid }).where(eq(automationRules.id, ruleId)).run();

    // Re-fetch so the rule object carries the persisted invalid condition.
    const persistedRule = ruleRepo.getAutomationRuleById(ruleId)!;

    const result = await attemptRuleRun(makeInput(persistedRule, h.id, task.id));

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("expected failed");
    expect(result.stage).toBe("condition");
    expect(result.run.status).toBe("failed");
    expect(result.run.conditionResult).not.toBeNull();
    expect(result.run.conditionResult?.matched).toBe(false);
    expect(result.run.conditionResult?.conditionType).toBe("invalid");
    expect(result.run.conditionResult?.reason).toBeTruthy();
    // Bounded diagnostic as metadata.
    const metadata = result.run.metadata as Record<string, unknown> | null;
    expect(metadata?.stage).toBe("condition");
    expect(typeof metadata?.diagnostic).toBe("string");
  });

  it("depth-exceeded tree fails closed with the same synthetic invalid result", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    const rule = createEnabledRule(h.id, { cooldownSeconds: 0 });

    // Build a 6-level nested and/or tree (exceeds MAX_CONDITION_DEPTH=5).
    const deep: AutomationCondition = {
      type: "and",
      children: [
        {
          type: "and",
          children: [
            {
              type: "and",
              children: [
                {
                  type: "and",
                  children: [
                    {
                      type: "and",
                      children: [{ type: "and", children: [{ type: "always" }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const db = (await import("../db/index.js")).getDb();
    const { automationRules } = await import("../db/schema/index.js");
    const { eq } = await import("drizzle-orm");
    db.update(automationRules).set({ condition: deep }).where(eq(automationRules.id, rule.id)).run();

    const persistedRule = ruleRepo.getAutomationRuleById(rule.id)!;

    const result = await attemptRuleRun(makeInput(persistedRule, h.id, task.id));

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("expected failed");
    expect(result.run.conditionResult?.conditionType).toBe("invalid");
    const metadata = result.run.metadata as Record<string, unknown>;
    expect(metadata.stage).toBe("condition");
    expect(String(metadata.diagnostic)).toMatch(/depth|MAX_CONDITION_DEPTH/);
  });
});

// ---------------------------------------------------------------------------
// 4. Plugin conditions: missing handler / throwing handler
// ---------------------------------------------------------------------------

describe("CS-56 T3 — plugin condition branches", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("missing plugin handler evaluates to false and skips with condition_false", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    const rule = createEnabledRule(h.id, {
      condition: { type: "plugin", conditionId: "nonexistent-plugin-x" },
      cooldownSeconds: 0,
    });

    const result = await attemptRuleRun(makeInput(rule, h.id, task.id));

    expect(result.kind).toBe("skipped");
    if (result.kind !== "skipped") throw new Error("expected skipped");
    expect(result.reason).toBe("condition_false");
    expect(result.run.conditionResult?.matched).toBe(false);
    expect(result.run.conditionResult?.conditionType).toBe("plugin");
  });
});

// ---------------------------------------------------------------------------
// 5. Causal cycle / depth — only after a TRUE condition
// ---------------------------------------------------------------------------

describe("CS-56 T3 — causal branch", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("causal_cycle is labeled only after a TRUE condition, with the true result persisted", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, {
      condition: { type: "priority_above", threshold: "medium" },
      cooldownSeconds: 0,
    });

    const data = {
      triggerType: "task.rejected",
      triggerEventId: "evt-cs56-causal",
      habitatId: h.id,
      targetType: "task" as const,
      targetId: task.id,
      causalContext: {
        root: { type: "human" as const, id: "user-1" },
        hops: [{ type: "automation" as const, id: rule.id }],
      },
    };

    const result = await attemptRuleRun(makeInput(rule, h.id, task.id, { trigger: data }));

    expect(result.kind).toBe("skipped");
    if (result.kind !== "skipped") throw new Error("expected skipped");
    expect(result.reason).toBe("causal_cycle");
    // The TRUE conditionResult is persisted — this is the load-bearing
    // property that T6's audit projection relies on.
    expect(result.run.conditionResult?.matched).toBe(true);
  });

  it("causal_depth_limit is labeled after CAUSAL_DEPTH_LIMIT hops, with the true result", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, {
      condition: { type: "priority_above", threshold: "medium" },
      cooldownSeconds: 0,
    });

    // Build a hop list of length CAUSAL_DEPTH_LIMIT, none of which are the
    // current rule (so no cycle, but depth exceeded).
    const hops = Array.from({ length: CAUSAL_DEPTH_LIMIT }, (_, i) => ({
      type: "automation" as const,
      id: `other-rule-${i}`,
    }));

    const result = await attemptRuleRun(
      makeInput(rule, h.id, task.id, {
        trigger: {
          triggerType: "task.rejected",
          triggerEventId: "evt-cs56-depth",
          habitatId: h.id,
          targetType: "task",
          targetId: task.id,
          causalContext: {
            root: { type: "human", id: "user-1" },
            hops,
          },
        },
      }),
    );

    expect(result.kind).toBe("skipped");
    if (result.kind !== "skipped") throw new Error("expected skipped");
    expect(result.reason).toBe("causal_depth_limit");
    expect(result.run.conditionResult?.matched).toBe(true);
  });

  it("condition evaluation precedes causal classification — a false condition is never labeled cycle", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "low");
    const rule = createEnabledRule(h.id, {
      condition: { type: "priority_above", threshold: "high" }, // FALSE on low
      cooldownSeconds: 0,
    });

    const result = await attemptRuleRun(
      makeInput(rule, h.id, task.id, {
        trigger: {
          triggerType: "task.rejected",
          triggerEventId: "evt-cs56-false+cyclic",
          habitatId: h.id,
          targetType: "task",
          targetId: task.id,
          causalContext: {
            root: { type: "human", id: "user-1" },
            hops: [{ type: "automation", id: rule.id }],
          },
        },
      }),
    );

    expect(result.kind).toBe("skipped");
    if (result.kind !== "skipped") throw new Error("expected skipped");
    // The phantom-cycle defect is gone: causal guard runs AFTER condition.
    expect(result.reason).toBe("condition_false");
    expect(result.run.conditionResult?.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Kill switch — skipped/disabled, never success
// ---------------------------------------------------------------------------

describe("CS-56 T3 — kill switch branch", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => {
    closeDb();
    delete process.env.ORCY_AUTOMATION_EXECUTE_ACTIONS;
  });

  it("global env kill switch persists skipped/disabled with the TRUE condition result and no actions", async () => {
    process.env.ORCY_AUTOMATION_EXECUTE_ACTIONS = "false";
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, {
      condition: { type: "priority_above", threshold: "medium" },
      cooldownSeconds: 0,
    });

    const baseline = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;

    const result = await attemptRuleRun(makeInput(rule, h.id, task.id));

    expect(result.kind).toBe("skipped");
    if (result.kind !== "skipped") throw new Error("expected skipped");
    expect(result.reason).toBe("disabled");
    expect(result.run.status).toBe("skipped");
    expect(result.run.skipReason).toBe("disabled");
    expect(result.run.conditionResult?.matched).toBe(true);
    expect(result.run.actionResults).toBeNull();

    const after = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;
    expect(after).toBe(baseline);
  });

  it("habitat setting kill switch produces the same skipped/disabled branch", async () => {
    const h = setupHabitat();
    boardRepo.updateHabitat(h.id, { automationSettings: { executeActions: false } });
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, {
      condition: { type: "priority_above", threshold: "medium" },
      cooldownSeconds: 0,
    });

    const result = await attemptRuleRun(makeInput(rule, h.id, task.id));

    expect(result.kind).toBe("skipped");
    if (result.kind !== "skipped") throw new Error("expected skipped");
    expect(result.reason).toBe("disabled");
    expect(result.run.conditionResult?.matched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Action failure → executed with composite action status
// ---------------------------------------------------------------------------

describe("CS-56 T3 — action failure branch", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("action failure returns executed with composite status and persisted actionResults", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, {
      condition: { type: "priority_above", threshold: "medium" },
      cooldownSeconds: 0,
      // 2 actions: one succeeds, one fails (webhook rejected).
      actions: [
        { type: "create_signal", content: "first" },
        { type: "call_webhook", url: "http://localhost:3000/hook" },
      ],
    });

    const result = await attemptRuleRun(makeInput(rule, h.id, task.id));

    expect(result.kind).toBe("executed");
    if (result.kind !== "executed") throw new Error("expected executed");
    expect(result.outcome).toBe("partial_failed");
    expect(result.run.status).toBe("partial_failed");
    expect(result.run.actionResults).toHaveLength(2);
    expect(result.run.actionResults?.[0]?.status).toBe("succeeded");
    expect(result.run.actionResults?.[1]?.status).toBe("failed");
    expect(result.run.conditionResult?.matched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Dedupe loser — never mutates, never emits completion
// ---------------------------------------------------------------------------

describe("CS-56 T3 — dedupe loser branch", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("duplicate trusted delivery returns deduplicated and emits NO completion", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    const rule = createEnabledRule(h.id, {
      triggerType: "task.created",
      condition: { type: "always" },
      cooldownSeconds: 0,
    });

    const eventId = "evt-cs56-dedupe-direct";

    // First delivery owns the run.
    const r1 = await attemptRuleRun(
      makeInput(rule, h.id, task.id, {
        source: "event",
        eventDedupeKey: eventId,
        trigger: {
          triggerType: "task.created",
          triggerEventId: eventId,
          habitatId: h.id,
          targetType: "task",
          targetId: task.id,
          payload: { taskId: task.id, eventId, causalContext: { root: { type: "human", id: "user-1" } } },
        },
      }),
    );

    expect(r1.kind).toBe("executed");

    // Register hook AFTER the success to isolate the dedupe-loser call.
    let hookCalls = 0;
    const unsub = onAutomationRunCompleted(() => {
      hookCalls++;
    });

    // Second delivery: same eventId → dedupe.
    const r2 = await attemptRuleRun(
      makeInput(rule, h.id, task.id, {
        source: "event",
        eventDedupeKey: eventId,
        trigger: {
          triggerType: "task.created",
          triggerEventId: eventId,
          habitatId: h.id,
          targetType: "task",
          targetId: task.id,
          payload: { taskId: task.id, eventId, causalContext: { root: { type: "human", id: "user-1" } } },
        },
      }),
    );

    expect(r2.kind).toBe("deduplicated");
    if (r2.kind !== "deduplicated") throw new Error("expected deduplicated");
    // Returns the EXISTING owned row, not a new one.
    expect(r2.run.id).toBe(r1.kind === "executed" ? r1.run.id : "");
    expect(r2.run.status).toBe("succeeded");
    // No completion emitted for the loser.
    expect(hookCalls).toBe(0);

    // Only one row in the DB.
    const { runs } = runRepo.listRunsByRule(rule.id);
    expect(runs).toHaveLength(1);

    unsub();
  });

  it("a pre-admission rejection still reserves, so a duplicate trusted delivery resolves as deduplicated", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    const rule = createEnabledRule(h.id, {
      triggerType: "task.created",
      condition: { type: "always" },
      cooldownSeconds: 0,
    });

    const eventId = "evt-cs56-missing-target-dedupe";

    // First delivery: missing target → dedupe-loser never reaches executeActions.
    const r1 = await attemptRuleRun(
      makeInput(rule, h.id, task.id, {
        source: "event",
        eventDedupeKey: eventId,
        trigger: {
          triggerType: "task.created",
          triggerEventId: eventId,
          habitatId: h.id,
          targetType: "task",
          targetId: null, // missing target
        },
      }),
    );

    expect(r1.kind).toBe("skipped");
    expect(r1.run.skipReason).toBe("missing_target");

    // Second delivery: same eventId → dedupe.
    const r2 = await attemptRuleRun(
      makeInput(rule, h.id, task.id, {
        source: "event",
        eventDedupeKey: eventId,
        trigger: {
          triggerType: "task.created",
          triggerEventId: eventId,
          habitatId: h.id,
          targetType: "task",
          targetId: null,
        },
      }),
    );

    expect(r2.kind).toBe("deduplicated");
    // Only one row in the DB.
    const { runs } = runRepo.listRunsByRule(rule.id);
    expect(runs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 9. Cooldown / rate-limited pre-admission rejection
// ---------------------------------------------------------------------------

describe("CS-56 T3 — pre-admission guards", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("cooldown produces skipped/cooldown with no condition evaluation", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, {
      condition: { type: "priority_above", threshold: "medium" },
      cooldownSeconds: 3600,
      maxRunsPerHour: 100,
    });

    const first = await attemptRuleRun(
      makeInput(rule, h.id, task.id, {
        trigger: {
          triggerType: "task.rejected",
          triggerEventId: "evt-cd-1",
          habitatId: h.id,
          targetType: "task",
          targetId: task.id,
        },
      }),
    );
    expect(first.kind).toBe("executed");

    const second = await attemptRuleRun(
      makeInput(rule, h.id, task.id, {
        trigger: {
          triggerType: "task.rejected",
          triggerEventId: "evt-cd-1", // same fingerprint
          habitatId: h.id,
          targetType: "task",
          targetId: task.id,
        },
      }),
    );

    expect(second.kind).toBe("skipped");
    if (second.kind !== "skipped") throw new Error("expected skipped");
    expect(second.reason).toBe("cooldown");
    expect(second.run.conditionResult).toBeNull();
  });

  it("rate_limited produces skipped/rate_limited when admitted attempts saturate the hourly cap", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, {
      condition: { type: "priority_above", threshold: "medium" },
      cooldownSeconds: 0,
      maxRunsPerHour: 1,
    });

    const first = await attemptRuleRun(
      makeInput(rule, h.id, task.id, {
        trigger: {
          triggerType: "task.rejected",
          triggerEventId: "evt-rl-1",
          habitatId: h.id,
          targetType: "task",
          targetId: task.id,
        },
      }),
    );
    expect(first.kind).toBe("executed");

    const second = await attemptRuleRun(
      makeInput(rule, h.id, task.id, {
        trigger: {
          triggerType: "task.rejected",
          triggerEventId: "evt-rl-2",
          habitatId: h.id,
          targetType: "task",
          targetId: task.id,
        },
      }),
    );

    expect(second.kind).toBe("skipped");
    if (second.kind !== "skipped") throw new Error("expected skipped");
    expect(second.reason).toBe("rate_limited");
  });

  it("missing_target produces skipped/missing_target without context construction", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    const rule = createEnabledRule(h.id, { condition: { type: "always" }, cooldownSeconds: 0 });

    const result = await attemptRuleRun(
      makeInput(rule, h.id, task.id, {
        trigger: {
          triggerType: "task.rejected",
          triggerEventId: "evt-mt-1",
          habitatId: h.id,
          targetType: "task",
          targetId: null,
        },
      }),
    );

    expect(result.kind).toBe("skipped");
    if (result.kind !== "skipped") throw new Error("expected skipped");
    expect(result.reason).toBe("missing_target");
    expect(result.run.conditionResult).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 10. Completion safety: refresh, double-finalization, throwing subscribers
// ---------------------------------------------------------------------------

describe("CS-56 T3 — completion safety", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("the returned run is the refreshed terminal row (not the stale running object)", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, {
      condition: { type: "priority_above", threshold: "medium" },
      cooldownSeconds: 0,
    });

    const result = await attemptRuleRun(makeInput(rule, h.id, task.id));

    expect(result.kind).toBe("executed");
    if (result.kind !== "executed") throw new Error("expected executed");
    // Re-fetch from the DB and compare.
    const refreshed = runRepo.getRuleRunById(result.run.id);
    expect(refreshed).not.toBeNull();
    expect(refreshed?.status).toBe(result.run.status);
    expect(refreshed?.finishedAt).toBe(result.run.finishedAt);
    expect(refreshed?.conditionResult).toEqual(result.run.conditionResult);
  });

  it("double finalization of the same row reports transitioned:false on the second call (terminalize seam)", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, { condition: { type: "always" }, cooldownSeconds: 0 });

    // First call owns the transition.
    const r1 = await attemptRuleRun(makeInput(rule, h.id, task.id));
    expect(r1.kind).toBe("executed");
    if (r1.kind !== "executed") throw new Error("expected executed");

    // Second terminalize call with the same final-state arguments must
    // report transitioned:false so the lifecycle never emits a second
    // completion when this happens by accident.
    const probe = runRepo.terminalizeRuleRun({
      runId: r1.run.id,
      status: "skipped",
      skipReason: "cooldown",
      finishedAt: new Date().toISOString(),
    });
    expect(probe.transitioned).toBe(false);
  });

  it("throws in one completion subscriber do not block the others", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, {
      condition: { type: "priority_above", threshold: "medium" },
      cooldownSeconds: 0,
    });

    const order: string[] = [];
    const unsub1 = onAutomationRunCompleted(() => {
      order.push("first");
      throw new Error("subscriber 1 exploded");
    });
    const unsub2 = onAutomationRunCompleted(() => {
      order.push("second");
    });
    const unsub3 = onAutomationRunCompleted(() => {
      order.push("third");
    });

    // Use vi.spyOn to silence the expected logger.warn output.
    const loggerSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The logger used by the executor is from pino — it has its own
    // format. We just want to keep test output clean.
    void loggerSpy;

    const result = await attemptRuleRun(makeInput(rule, h.id, task.id));

    expect(result.kind).toBe("executed");
    // All three subscribers must run despite the first throwing.
    expect(order).toEqual(["first", "second", "third"]);

    unsub1();
    unsub2();
    unsub3();
  });
});

// ---------------------------------------------------------------------------
// 11. Order proof — condition is evaluated before causal guards
// ---------------------------------------------------------------------------

describe("CS-56 T3 — ordering proof (condition before causal)", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("false condition + self-cycle is condition_false, not causal_cycle (phantom-cycle inversion)", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "low");
    const rule = createEnabledRule(h.id, {
      condition: { type: "priority_above", threshold: "high" }, // FALSE on low
      cooldownSeconds: 0,
    });

    const result = await attemptRuleRun(
      makeInput(rule, h.id, task.id, {
        trigger: {
          triggerType: "task.rejected",
          triggerEventId: "evt-cs56-phantom-direct",
          habitatId: h.id,
          targetType: "task",
          targetId: task.id,
          causalContext: {
            root: { type: "human", id: "user-1" },
            hops: [{ type: "automation", id: rule.id }],
          },
        },
      }),
    );

    expect(result.kind).toBe("skipped");
    if (result.kind !== "skipped") throw new Error("expected skipped");
    expect(result.reason).toBe("condition_false");
    expect(result.run.conditionResult?.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 12. Failed actions surface via the shared disposition→counter helper
//    (CS-56 cold-review M2).
//
// When an attempt executes actions and any of them fail, the disposition
// is `{ kind: "executed", outcome: "failed" | "partial_failed", ... }`.
// The shared `tallyDisposition` helper (used by every caller — event + 7
// scans) surfaces this as a bounded error appended to the report's
// `errors` array, WITHOUT decrementing `matched` (the attempt did
// execute). The same helper is the only path callers go through, so this
// pinning covers all 8 callers uniformly.
// ---------------------------------------------------------------------------

import { tallyDisposition } from "../services/automationScanService.js";

describe("CS-56 cold-review M2 — failed actions surface to report.errors via tallyDisposition", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("an executed disposition whose outcome is partial_failed appends a bounded error and still increments matched", () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, {
      condition: { type: "priority_above", threshold: "medium" },
      cooldownSeconds: 0,
    });

    const acc = { matched: 0, skipped: 0, deduplicated: 0, errors: [] as string[] };
    // Synthesize the disposition the lifecycle returns for an attempt
    // whose first action succeeded and whose second action (webhook to
    // localhost) failed. Mirrors `CS-56 T3 — action failure branch` which
    // observes outcome="partial_failed" end-to-end.
    const failedDisposition = {
      kind: "executed" as const,
      run: {} as never,
      outcome: "partial_failed" as const,
      actionResults: [
        { actionType: "create_signal" as const, actionIndex: 0, status: "succeeded" as const },
        {
          actionType: "call_webhook" as const,
          actionIndex: 1,
          status: "failed" as const,
          error: "ECONNREFUSED",
        },
      ],
    };
    tallyDisposition(rule, failedDisposition, acc);

    // matched is incremented for the executed attempt; an additional
    // bounded error pins the failing action indices/types.
    expect(acc.matched).toBe(1);
    expect(acc.errors).toHaveLength(1);
    expect(acc.errors[0]).toContain(rule.id);
    expect(acc.errors[0]).toContain("partial_failed");
    // Pin both the failing action and the non-empty error detail so the
    // operator can see WHICH action failed without re-running the run.
    expect(acc.errors[0]).toContain("1:call_webhook");
    expect(acc.errors[0]).toContain("ECONNREFUSED");

    // Sanity: the helper accepted the `run: {} as never` shape — the
    // function does not introspect the run; it only inspects `kind`,
    // `outcome`, and `actionResults`.
    void task;
  });

  it("an executed disposition whose outcome is failed (no action succeeded) still surfaces to errors and keeps matched=1", () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, { condition: { type: "always" }, cooldownSeconds: 0 });

    const acc = { matched: 0, skipped: 0, deduplicated: 0, errors: [] as string[] };
    tallyDisposition(rule, {
      kind: "executed",
      run: {} as never,
      outcome: "failed",
      actionResults: [
        { actionType: "call_webhook", actionIndex: 0, status: "failed", error: "HTTP 500" },
      ],
    }, acc);

    expect(acc.matched).toBe(1);
    expect(acc.errors).toHaveLength(1);
    expect(acc.errors[0]).toContain("failed");
    expect(acc.errors[0]).toContain("0:call_webhook:HTTP 500");
  });

  it("a fully-succeeded executed disposition does NOT append to errors", () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, { condition: { type: "always" }, cooldownSeconds: 0 });

    const acc = { matched: 0, skipped: 0, deduplicated: 0, errors: [] as string[] };
    tallyDisposition(rule, {
      kind: "executed",
      run: {} as never,
      outcome: "succeeded",
      actionResults: [
        { actionType: "create_signal", actionIndex: 0, status: "succeeded" },
      ],
    }, acc);

    expect(acc.matched).toBe(1);
    expect(acc.errors).toHaveLength(0);
  });
});
