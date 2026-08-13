/**
 * CS-56 T6 — Audit + history condition-result exposure.
 *
 * The canonical lifecycle persists `conditionResult` on every evaluated
 * terminal run (false / true / causal-skip / kill-switch / synthetic
 * `invalid`). The audit projection surfaces this in
 * `metadata.condition = { matched, conditionType, reason }`, and the run
 * history (`/automation-rules/:ruleId/runs`) returns the full row including
 * the raw `conditionResult`. Both surfaces must agree, and both must
 * include the result for EVERY evaluated branch — not just executed /
 * succeeded.
 *
 * No schema migration is required: the existing `condition_result` column
 * carries the per-branch JSON.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import { attemptRuleRun } from "../services/automationAttemptLifecycle.js";
import { projectAutomationRunToAudit } from "../services/automationAuditProjection.js";
import type { AutomationCondition, AutomationRule } from "@orcy/shared";

function setupHabitat() {
  const h = boardRepo.createHabitat({ name: "T6 Audit Habitat" });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  return h;
}

function setupMission(habitatId: string) {
  return missionRepo.createMission({ habitatId, title: "T6 Mission", createdBy: "user-1" });
}

function setupTask(missionId: string, priority: "low" | "medium" | "high" | "critical" = "high") {
  return taskRepo.createTask({
    missionId,
    title: "T6 Task",
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
    name: overrides?.name ?? "T6 Rule",
    priority: 0,
    trigger: trigger as unknown as Parameters<typeof ruleRepo.createAutomationRule>[0]["trigger"],
    condition: overrides?.condition ?? ({ type: "always" } as AutomationCondition),
    actions: (overrides?.actions ?? [
      { type: "create_signal", content: "T6 fired" },
    ]) as unknown as Parameters<typeof ruleRepo.createAutomationRule>[0]["actions"],
    cooldownSeconds: overrides?.cooldownSeconds ?? 0,
    maxRunsPerHour: overrides?.maxRunsPerHour ?? 100,
    enabled: true,
    createdBy: "test",
  });
}

async function runManual(
  rule: AutomationRule,
  habitatId: string,
  taskId: string,
  triggerEventId = "manual",
) {
  return attemptRuleRun({
    rule,
    source: "manual",
    trigger: {
      triggerType: rule.trigger.type === "scan"
        ? (rule.trigger as { scanType?: string }).scanType ?? "manual"
        : (rule.trigger as { eventType?: string }).eventType ?? "manual",
      triggerEventId,
      habitatId,
      targetType: "task",
      targetId: taskId,
    },
    eventDedupeKey: null,
  });
}

describe("CS-56 T6 — audit + history conditionResult exposure across all branches", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => {
    closeDb();
    delete process.env.ORCY_AUTOMATION_EXECUTE_ACTIONS;
  });

  it("true condition: run row + audit metadata both carry matched=true", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, {
      condition: { type: "priority_above", threshold: "medium" },
      cooldownSeconds: 0,
    });

    const disposition = await runManual(rule, h.id, task.id);
    expect(disposition.kind).toBe("executed");

    const refreshed = runRepo.getRuleRunById(disposition.run.id)!;
    expect(refreshed.conditionResult?.matched).toBe(true);

    const audit = projectAutomationRunToAudit(refreshed, rule);
    expect((audit.metadata.condition as Record<string, unknown>).matched).toBe(true);
    expect(audit.metadata.status).toBe("succeeded");
  });

  it("false condition: run row + audit metadata both carry matched=false", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "low");
    const rule = createEnabledRule(h.id, {
      condition: { type: "priority_above", threshold: "high" },
      cooldownSeconds: 0,
    });

    const disposition = await runManual(rule, h.id, task.id);
    expect(disposition.kind).toBe("skipped");
    if (disposition.kind !== "skipped") throw new Error("expected skipped");
    expect(disposition.reason).toBe("condition_false");

    const refreshed = runRepo.getRuleRunById(disposition.run.id)!;
    expect(refreshed.status).toBe("skipped");
    expect(refreshed.skipReason).toBe("condition_false");
    expect(refreshed.conditionResult?.matched).toBe(false);
    expect(refreshed.conditionResult?.conditionType).toBe("priority_above");

    const audit = projectAutomationRunToAudit(refreshed, rule);
    expect((audit.metadata.condition as Record<string, unknown>).matched).toBe(false);
    expect((audit.metadata.condition as Record<string, unknown>).conditionType).toBe(
      "priority_above",
    );
    expect(audit.metadata.skipReason).toBe("condition_false");
  });

  it("causal-cycle skip: run row + audit metadata carry the TRUE conditionResult (post-condition)", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, {
      condition: { type: "priority_above", threshold: "medium" },
      cooldownSeconds: 0,
    });

    const disposition = await attemptRuleRun({
      rule,
      source: "manual",
      trigger: {
        triggerType: rule.trigger.type === "scan"
          ? (rule.trigger as { scanType?: string }).scanType ?? "manual"
          : (rule.trigger as { eventType?: string }).eventType ?? "manual",
        triggerEventId: "manual",
        habitatId: h.id,
        targetType: "task",
        targetId: task.id,
        causalContext: {
          root: { type: "human", id: "user-1" },
          hops: [{ type: "automation", id: rule.id }],
        },
      },
      eventDedupeKey: null,
    });
    expect(disposition.kind).toBe("skipped");
    if (disposition.kind !== "skipped") throw new Error("expected skipped");
    expect(disposition.reason).toBe("causal_cycle");

    const refreshed = runRepo.getRuleRunById(disposition.run.id)!;
    expect(refreshed.conditionResult?.matched).toBe(true);
    expect(refreshed.skipReason).toBe("causal_cycle");

    const audit = projectAutomationRunToAudit(refreshed, rule);
    expect((audit.metadata.condition as Record<string, unknown>).matched).toBe(true);
    expect(audit.metadata.skipReason).toBe("causal_cycle");
  });

  it("kill switch: run row + audit metadata carry skipped/disabled + TRUE conditionResult", async () => {
    void boardRepo.updateHabitat; // satisfy the import-side reference
    const h = setupHabitat();
    boardRepo.updateHabitat(h.id, { automationSettings: { executeActions: false } });
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, {
      condition: { type: "priority_above", threshold: "medium" },
      cooldownSeconds: 0,
    });

    const disposition = await runManual(rule, h.id, task.id);
    expect(disposition.kind).toBe("skipped");
    if (disposition.kind !== "skipped") throw new Error("expected skipped");
    expect(disposition.reason).toBe("disabled");

    const refreshed = runRepo.getRuleRunById(disposition.run.id)!;
    expect(refreshed.status).toBe("skipped");
    expect(refreshed.skipReason).toBe("disabled");
    expect(refreshed.conditionResult?.matched).toBe(true);
    expect(refreshed.actionResults).toBeNull();

    const audit = projectAutomationRunToAudit(refreshed, rule);
    expect((audit.metadata.condition as Record<string, unknown>).matched).toBe(true);
    expect(audit.metadata.skipReason).toBe("disabled");
    expect(audit.metadata.status).toBe("skipped");
  });

  it("synthetic invalid condition: run row + audit metadata carry conditionType='invalid' with the diagnostic", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, { cooldownSeconds: 0 });

    // Persist a known-invalid tree directly (bypasses route schema; the
    // runtime validator is what we test here).
    const invalid = { type: "field" } as unknown as AutomationCondition;
    const db = (await import("../db/index.js")).getDb();
    const { automationRules } = await import("../db/schema/index.js");
    const { eq } = await import("drizzle-orm");
    db.update(automationRules).set({ condition: invalid }).where(eq(automationRules.id, rule.id)).run();
    const persistedRule = ruleRepo.getAutomationRuleById(rule.id)!;

    const disposition = await runManual(persistedRule, h.id, task.id);
    expect(disposition.kind).toBe("failed");
    if (disposition.kind !== "failed") throw new Error("expected failed");
    expect(disposition.stage).toBe("condition");

    const refreshed = runRepo.getRuleRunById(disposition.run.id)!;
    expect(refreshed.status).toBe("failed");
    expect(refreshed.conditionResult?.matched).toBe(false);
    expect(refreshed.conditionResult?.conditionType).toBe("invalid");
    expect(refreshed.conditionResult?.reason).toBeTruthy();

    const audit = projectAutomationRunToAudit(refreshed, rule);
    expect((audit.metadata.condition as Record<string, unknown>).matched).toBe(false);
    expect((audit.metadata.condition as Record<string, unknown>).conditionType).toBe("invalid");
    expect(audit.metadata.status).toBe("failed");
  });

  it("listRunsByRule returns terminal rows with the refreshed conditionResult for every branch", async () => {
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id, "high");
    const rule = createEnabledRule(h.id, {
      condition: { type: "priority_above", threshold: "medium" },
      cooldownSeconds: 3600,
    });

    // Run 1: succeeds (the one allowed attempt).
    const d1 = await runManual(rule, h.id, task.id, "manual-history-1");
    expect(d1.kind).toBe("executed");

    // Run 2: same fingerprint → cooldown skip. conditionResult stays null
    // (cooldown is pre-admission rejection).
    const d2 = await runManual(rule, h.id, task.id, "manual-history-1");
    expect(d2.kind).toBe("skipped");
    if (d2.kind !== "skipped") throw new Error("expected skipped");
    expect(d2.reason).toBe("cooldown");

    const { runs } = runRepo.listRunsByRule(rule.id);
    expect(runs.length).toBe(2);
    const succeeded = runs.find((r) => r.status === "succeeded")!;
    const cooldown = runs.find((r) => r.skipReason === "cooldown")!;
    expect(succeeded.conditionResult?.matched).toBe(true);
    expect(cooldown.conditionResult).toBeNull();
    // Both rows are terminal — the cooldown skip persisted `finishedAt`.
    expect(succeeded.finishedAt).not.toBeNull();
    expect(cooldown.finishedAt).not.toBeNull();
  });
});
