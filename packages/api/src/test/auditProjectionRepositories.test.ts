/**
 * v0.29 Phase 2 — Uncapped audit projection repository tests.
 *
 * Each new `repositories/auditProjection/*` function must NOT inherit the
 * 50-row default limit used by the operational list methods. The Ac-FAILURE
 * invariant is that habitat-level projections can carry many rows of the same
 * operational source (automation rules, plugin runs, time records), so silently
 * capping at 50 would corrupt the canonical audit projection.
 *
 * Each describe seeds >50 rows and asserts all are returned.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as pluginRunRepo from "../repositories/pluginRun.js";
import * as timeRepo from "../repositories/timeTracking.js";
import * as healthRepo from "../repositories/habitatHealth.js";
import {
  automationRuleRuns,
  notificationDeliveries,
  notificationEvents,
  pluginRuns,
  habitatHealthSnapshots,
} from "../db/schema/index.js";
import { v4 as uuid } from "uuid";
import { listForAudit as listAutomationRunsForAudit } from "../repositories/auditProjection/automationRuns.js";
import { listEventsForAudit } from "../repositories/auditProjection/notificationEvents.js";
import { listDeliveriesForAudit } from "../repositories/auditProjection/notificationDeliveries.js";
import { listForAudit as listPluginRunsForAudit } from "../repositories/auditProjection/pluginRuns.js";
import { listForAudit as listTimeRecordsForAudit } from "../repositories/auditProjection/timeRecords.js";
import { listForAudit as listHealthSnapshotsForAudit } from "../repositories/auditProjection/healthSnapshots.js";

const SEED_ROWS = 60;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(automationRuleRuns).run();
  db.delete(notificationDeliveries).run();
  db.delete(notificationEvents).run();
  db.delete(pluginRuns).run();
  db.delete(habitatHealthSnapshots).run();
});

afterEach(() => {
  closeDb();
});

function setupHabitat() {
  const habitat = habitatRepo.createHabitat({ name: "Audit Uncapped" });
  const column = columnRepo.createColumn({
    habitatId: habitat.id,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: column.id,
    title: "Audit Mission",
    createdBy: "user-1",
  });
  const task = taskRepo.createTask({ missionId: mission.id, title: "Audit Task", createdBy: "user-1" });
  return { habitat, column, mission, task };
}

describe("auditProjection/automationRuns.listForAudit", () => {
  it("returns every automation rule run in the habitat uncapped (>50 rows)", () => {
    const { habitat } = setupHabitat();
    const rule = ruleRepo.createAutomationRule({
      habitatId: habitat.id,
      name: "Looper",
      trigger: { type: "event", eventType: "task.rejected" },
      actions: [],
      createdBy: "system:test",
    });

    for (let i = 0; i < SEED_ROWS; i++) {
      runRepo.startRuleRun({
        habitatId: habitat.id,
        ruleId: rule.id,
        triggerType: "task.rejected",
        triggerEventId: `evt-${i}`,
      });
    }

    const rows = listAutomationRunsForAudit(habitat.id);
    expect(rows).toHaveLength(SEED_ROWS);
    expect(rows.every((r) => r.run.habitatId === habitat.id)).toBe(true);
    expect(rows.every((r) => r.rule?.id === rule.id)).toBe(true);
  });
});

describe("auditProjection/notificationEvents.listEventsForAudit", () => {
  it("returns every notification event in the habitat uncapped (>50 rows)", () => {
    const { habitat } = setupHabitat();

    for (let i = 0; i < SEED_ROWS; i++) {
      eventRepo.createNotificationEvent({
        habitatId: habitat.id,
        eventType: "task.assigned",
        sourceType: "task",
        severity: "info",
        title: `Notification ${i}`,
        body: `Body ${i}`,
        createdByType: "system",
        createdById: `system:notification-${i}`,
      });
    }

    const rows = listEventsForAudit(habitat.id);
    expect(rows).toHaveLength(SEED_ROWS);
    expect(rows.every((r) => r.habitatId === habitat.id)).toBe(true);
  });
});

describe("auditProjection/notificationDeliveries.listDeliveriesForAudit", () => {
  it("returns every notification delivery in the habitat uncapped (>50 rows)", () => {
    const { habitat } = setupHabitat();
    const event = eventRepo.createNotificationEvent({
      habitatId: habitat.id,
      eventType: "task.assigned",
      sourceType: "task",
      severity: "info",
      title: "Bulk Event",
      body: "Body",
      createdByType: "system",
    });

    for (let i = 0; i < SEED_ROWS; i++) {
      deliveryRepo.createNotificationDelivery({
        habitatId: habitat.id,
        eventId: event.id,
        recipientType: "agent",
        recipientId: `agent-${i}`,
      });
    }

    const rows = listDeliveriesForAudit(habitat.id);
    expect(rows).toHaveLength(SEED_ROWS);
    expect(rows.every((r) => r.delivery.habitatId === habitat.id)).toBe(true);
    expect(rows.every((r) => r.event?.id === event.id)).toBe(true);
  });
});

describe("auditProjection/pluginRuns.listForAudit", () => {
  it("returns every plugin run in the habitat uncapped (>50 rows)", () => {
    const { habitat } = setupHabitat();

    for (let i = 0; i < SEED_ROWS; i++) {
      pluginRunRepo.startRun({
        habitatId: habitat.id,
        pluginId: "audit-test-plugin",
        contributionId: `contrib-${i}`,
        contributionKind: "signalDetector",
        triggerEventId: `evt-${i}`,
        triggerType: "habitat_health",
        signalsEmitted: 0,
        error: null,
      });
    }

    const rows = listPluginRunsForAudit(habitat.id);
    expect(rows).toHaveLength(SEED_ROWS);
    expect(rows.every((r) => r.habitatId === habitat.id)).toBe(true);
  });
});

describe("auditProjection/timeRecords.listForAudit", () => {
  it("returns every time record in the habitat uncapped (>50 rows) and resolves task/mission/agent context", () => {
    const { habitat, task } = setupHabitat();

    for (let i = 0; i < SEED_ROWS; i++) {
      timeRepo.createTimeRecord({
        taskId: task.id,
        minutesSpent: 5 + (i % 10),
        statusDuringWork: "in_progress",
      });
    }

    const rows = listTimeRecordsForAudit(habitat.id);
    expect(rows).toHaveLength(SEED_ROWS);
    expect(rows.every((r) => r.taskTitle === "Audit Task")).toBe(true);
    expect(rows.every((r) => r.missionTitle === "Audit Mission")).toBe(true);
    expect(rows.every((r) => r.missionHabitatId === habitat.id)).toBe(true);
    expect(rows.every((r) => r.record.taskId === task.id)).toBe(true);
  });

  it("habitat isolation: returns 0 rows for a different habitat", () => {
    const { task } = setupHabitat();
    for (let i = 0; i < 5; i++) {
      timeRepo.createTimeRecord({
        taskId: task.id,
        minutesSpent: 5,
        statusDuringWork: "in_progress",
      });
    }
    const rows = listTimeRecordsForAudit(uuid());
    expect(rows).toHaveLength(0);
  });
});

describe("auditProjection/healthSnapshots.listForAudit", () => {
  it("returns every health snapshot in the habitat uncapped (>50 rows)", () => {
    const { habitat } = setupHabitat();

    for (let i = 0; i < SEED_ROWS; i++) {
      healthRepo.createHealthSnapshot({
        id: uuid(),
        habitatId: habitat.id,
        score: 50 + (i % 50),
        grade: ["A", "B", "C", "D", "F"][i % 5] as "A" | "B" | "C" | "D" | "F",
        dimensions: "{}",
        metrics: "{}",
        recommendations: "[]",
        snapshotAt: new Date(2026, 0, 1, 0, i).toISOString(),
      });
    }

    const rows = listHealthSnapshotsForAudit(habitat.id);
    expect(rows).toHaveLength(SEED_ROWS);
    expect(rows.every((r) => r.habitatId === habitat.id)).toBe(true);
  });
});