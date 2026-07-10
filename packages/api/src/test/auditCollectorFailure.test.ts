/**
 * v0.29 Phase 5 — Collector failure-policy matrix.
 *
 * The catalog dispatches collectors via {@link dispatchCollector}, which calls
 * fatal-policy collectors directly (errors propagate) and wraps warning-policy
 * collectors (errors become `collector_unavailable` warnings + caveats).
 *
 * - T5.4.a — Fatal collector throws → `queryAuditEvents` propagates the error.
 * - T5.4.b — Warning collector throws → partial results + collector warning.
 * - T5.4.c — Empty source table → no events, no warning, no caveat.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import { queryAuditEvents } from "../services/auditQueryService.js";
import { columns, habitats, missions, tasks } from "../db/schema/index.js";

beforeEach(async () => {
  await initTestDb();
  const db = (await import("../db/index.js")).getDb();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columns).run();
  db.delete(habitats).run();
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
});

function setupHabitat() {
  const habitat = habitatRepo.createHabitat({ name: "Failure Habitat" });
  const column = columnRepo.createColumn({
    habitatId: habitat.id,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: column.id,
    title: "Failure Mission",
    createdBy: "user-1",
  });
  const task = taskRepo.createTask({ missionId: mission.id, title: "Failure Task", createdBy: "user-1" });
  return { habitat, mission, task };
}

describe("collector failure policy", () => {
  it("propagates errors from a fatal collector (lifecycle)", async () => {
    const { habitat } = setupHabitat();
    const lifecycleCollector = await import("../services/auditProjection/lifecycleCollector.js");
    const collectSpy = vi
      .spyOn(lifecycleCollector.lifecycleCollector, "collect")
      .mockImplementation(() => {
        throw new Error("lifecycle repository unavailable");
      });

    expect(() =>
      queryAuditEvents({ habitatId: habitat.id, order: "asc" }),
    ).toThrow(/lifecycle repository unavailable/);
    expect(collectSpy).toHaveBeenCalled();
  });

  it("returns partial results when a warning collector (automation) throws", async () => {
    const { habitat } = setupHabitat();

    const rule = ruleRepo.createAutomationRule({
      habitatId: habitat.id,
      name: "Failure Rule",
      trigger: { type: "event", eventType: "task.rejected" } as any,
      actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "X" }],
      createdBy: "user-1",
    });
    runRepo.startRuleRun({
      ruleId: rule.id,
      habitatId: habitat.id,
      triggerType: "task.rejected",
    });

    const automationRunCollector = await import(
      "../services/auditProjection/automationRunCollector.js"
    );
    const collectSpy = vi
      .spyOn(automationRunCollector.automationRunCollector, "collect")
      .mockImplementation(() => {
        throw new Error("automation projection repository failure");
      });

    const result = queryAuditEvents({ habitatId: habitat.id, order: "asc" });

    const collectorWarning = result.warnings.find((w) => w.code === "collector_unavailable");
    expect(collectorWarning).toBeDefined();
    expect(collectorWarning?.source).toBe("automation");
    expect(result.events).toEqual([]);
    expect(
      result.completenessSummary.caveats.some((c) => c.includes("automation_run")),
    ).toBe(true);
    expect(collectSpy).toHaveBeenCalled();
  });

  it("does not emit warnings when a collector returns empty (no rows)", async () => {
    const { habitat } = setupHabitat();
    const result = queryAuditEvents({ habitatId: habitat.id, order: "asc" });

    expect(result.events).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.completenessSummary.caveats).toEqual([]);
    expect(result.completenessSummary.totalEvents).toBe(0);
  });
});