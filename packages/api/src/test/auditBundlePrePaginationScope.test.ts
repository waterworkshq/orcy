/**
 * v0.29 Phase 5 — Bundle pre-pagination scope test.
 *
 * Verifies that bundle queries pre-filter by `referencedEntities` BEFORE
 * pagination, so an operational event linked to a task survives even when
 * the habitat contains far more lifecycle events than the default audit
 * page size.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import { getTaskAuditBundle } from "../services/auditBundleService.js";
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
  closeDb();
});

describe("auditBundle pre-pagination scope", () => {
  it("includes a linked operational event in a task bundle despite >1000 other events", async () => {
    const db = (await import("../db/index.js")).getDb();
    const habitat = habitatRepo.createHabitat({ name: "Scope Habitat" });
    const column = columnRepo.createColumn({
      habitatId: habitat.id,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: column.id,
      title: "Scope Mission",
      createdBy: "user-1",
    });
    const targetTask = taskRepo.createTask({
      missionId: mission.id,
      title: "Target Task",
      createdBy: "user-1",
    });

    const eventRepo = await import("../repositories/events/index.js");
    const bigTask = taskRepo.createTask({
      missionId: mission.id,
      title: "Noisy Task",
      createdBy: "user-1",
    });
    for (let i = 0; i < 1005; i++) {
      eventRepo.createEvent({
        taskId: bigTask.id,
        actorType: "system",
        actorId: `system-${i}`,
        action: "updated",
      });
    }

    const rule = ruleRepo.createAutomationRule({
      habitatId: habitat.id,
      name: "Scope Rule",
      trigger: { type: "event", eventType: "task.rejected" } as any,
      actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "X" }],
      createdBy: "user-1",
    });
    const linkedRun = runRepo.startRuleRun({
      ruleId: rule.id,
      habitatId: habitat.id,
      triggerType: "task.rejected",
      targetType: "task",
      targetId: targetTask.id,
    });
    runRepo.finishRuleRun(linkedRun.id, { status: "succeeded" });

    const bundle = getTaskAuditBundle(targetTask.id);

    expect(
      bundle.events.find((event) => event.id === `automation_run:${linkedRun.id}`),
    ).toBeDefined();
    expect(
      bundle.events.find(
        (event) => event.id === `automation_run:${linkedRun.id}`)?.linkedEntities,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "task", id: targetTask.id }),
      ]),
    );
    expect(bundle.warnings.map((w) => w.code)).not.toContain("result_truncated");
  });
});