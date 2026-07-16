/**
 * v0.29 Phase 4 — Operational coverage integration test.
 *
 * Seeds a habitat with operational source rows (automation rule runs,
 * notification events, notification deliveries, plugin runs) and asserts that
 * all four kinds appear in the default canonical audit query, that entity/source
 * filters scope correctly, and that the canonical metadata allowlist excludes
 * raw payload / error text / fingerprint.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as pluginRunRepo from "../repositories/pluginRun.js";
import * as agentRepo from "../repositories/agent.js";
import * as timeRepo from "../repositories/timeTracking.js";
import { queryAuditEvents } from "../services/auditQueryService.js";
import {
  automationRuleRuns,
  notificationDeliveries,
  notificationEvents,
  pluginRuns,
} from "../db/schema/index.js";

beforeEach(async () => {
  await initTestDb();
  const db = (await import("../db/index.js")).getDb();
  db.delete(pluginRuns).run();
  db.delete(notificationDeliveries).run();
  db.delete(notificationEvents).run();
  db.delete(automationRuleRuns).run();
});

afterEach(() => {
  closeDb();
});

function setupHabitat() {
  const habitat = boardRepo.createHabitat({ name: "Operational Habitat" });
  const column = columnRepo.createColumn({
    habitatId: habitat.id,
    name: "Backlog",
    order: 0,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: column.id,
    title: "Op Mission",
    createdBy: "user-1",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: "Op Task",
    createdBy: "user-1",
  });
  return { habitat, mission, task };
}

describe("audit operational coverage", () => {
  it("all 4 operational event kinds appear in default queryAuditEvents output", () => {
    const { habitat, task } = setupHabitat();

    const rule = ruleRepo.createAutomationRule({
      habitatId: habitat.id,
      name: "Op Rule",
      trigger: { type: "event", eventType: "task.rejected" } as any,
      actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "T" }],
      createdBy: "user-1",
    });

    const run1 = runRepo.startRuleRun({
      ruleId: rule.id,
      habitatId: habitat.id,
      triggerType: "task.rejected",
      triggerEventId: "evt-1",
      targetType: "task",
      targetId: task.id,
    });
    runRepo.finishRuleRun(run1.id, { status: "succeeded" });

    const run2 = runRepo.startRuleRun({
      ruleId: rule.id,
      habitatId: habitat.id,
      triggerType: "task.rejected",
      triggerEventId: "evt-2",
    });
    runRepo.skipRuleRun(run2.id, "cooldown");

    const event = eventRepo.createNotificationEvent({
      habitatId: habitat.id,
      eventType: "task.assigned",
      sourceType: "task",
      sourceId: task.id,
      targetType: "task",
      targetId: task.id,
      severity: "info",
      title: "Assigned",
      body: "B",
      payload: { secret: true } as any,
      createdByType: "system",
    });

    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
      channels: ["in_app"],
    });
    deliveryRepo.acknowledgeDelivery(delivery.id);

    const pluginRun = pluginRunRepo.startRun({
      habitatId: habitat.id,
      pluginId: "plugin-a",
      contributionId: "detector-1",
      contributionKind: "signalDetector",
      triggerType: "task.created",
      triggerEventId: "evt-plug-1",
    });
    pluginRunRepo.finishRun(pluginRun.id, "succeeded", 1);

    const result = queryAuditEvents({ habitatId: habitat.id, order: "asc" });

    const ids = result.events.map((e) => e.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        `automation_run:${run1.id}`,
        `automation_run:${run2.id}`,
        `notification_event:${event.id}`,
        `notification_delivery:${delivery.id}`,
        `plugin_run:${pluginRun.id}`,
      ]),
    );
  });

  it("entityType filter 'automation_run' returns only automation events", () => {
    const { habitat, task } = setupHabitat();
    const rule = ruleRepo.createAutomationRule({
      habitatId: habitat.id,
      name: "Only rule",
      trigger: { type: "event", eventType: "task.rejected" } as any,
      actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "T" }],
      createdBy: "user-1",
    });
    const run = runRepo.startRuleRun({
      ruleId: rule.id,
      habitatId: habitat.id,
      triggerType: "task.rejected",
      targetType: "task",
      targetId: task.id,
    });
    runRepo.finishRuleRun(run.id, { status: "succeeded" });

    eventRepo.createNotificationEvent({
      habitatId: habitat.id,
      eventType: "task.assigned",
      sourceType: "task",
      severity: "info",
      title: "E",
      body: "B",
      createdByType: "system",
    });

    const result = queryAuditEvents({
      habitatId: habitat.id,
      entityType: "automation_run",
      order: "asc",
    });

    expect(result.events.every((e) => e.entity.type === "automation_run")).toBe(true);
    expect(result.events.length).toBe(1);
  });

  it("source filter 'plugin' returns only plugin events", () => {
    const { habitat } = setupHabitat();
    pluginRunRepo.startRun({
      habitatId: habitat.id,
      pluginId: "plugin-x",
      contributionId: "detector-x",
      contributionKind: "signalDetector",
      triggerType: "task.created",
    });

    const event = eventRepo.createNotificationEvent({
      habitatId: habitat.id,
      eventType: "task.assigned",
      sourceType: "task",
      severity: "info",
      title: "E",
      body: "B",
      createdByType: "system",
    });

    const result = queryAuditEvents({
      habitatId: habitat.id,
      source: "plugin",
      order: "asc",
    });

    expect(result.events.every((e) => e.source === "plugin")).toBe(true);
    expect(result.events.some((e) => e.id === `notification_event:${event.id}`)).toBe(false);
  });

  it("raw notification payload is NOT in any event metadata", () => {
    const { habitat } = setupHabitat();
    const event = eventRepo.createNotificationEvent({
      habitatId: habitat.id,
      eventType: "task.assigned",
      sourceType: "task",
      severity: "info",
      title: "Secret",
      body: "B",
      payload: { api_key: "leak-me", nested: { password: "x" } } as any,
      createdByType: "system",
    });

    const result = queryAuditEvents({ habitatId: habitat.id, order: "asc" });

    for (const e of result.events) {
      const metadataStr = JSON.stringify(e.metadata);
      expect(metadataStr).not.toContain("api_key");
      expect(metadataStr).not.toContain("leak-me");
      expect(metadataStr).not.toContain("password");
      expect(metadataStr).not.toContain("payload");
    }
    expect(result.events.some((e) => e.id === `notification_event:${event.id}`)).toBe(true);
  });

  it("plugin error text is NOT in any event metadata (only hasError boolean)", () => {
    const { habitat } = setupHabitat();
    const run = pluginRunRepo.startRun({
      habitatId: habitat.id,
      pluginId: "plugin-b",
      contributionId: "detector-b",
      contributionKind: "signalDetector",
      triggerType: "task.created",
    });
    pluginRunRepo.finishRun(run.id, "failed", undefined, "STACKTRACE-SECRET-LEAK");

    const result = queryAuditEvents({ habitatId: habitat.id, order: "asc" });
    const pluginEvent = result.events.find((e) => e.id === `plugin_run:${run.id}`);
    expect(pluginEvent).toBeDefined();
    expect(pluginEvent!.metadata.hasError).toBe(true);
    expect(pluginEvent!.metadata.error).toBeUndefined();
    expect(JSON.stringify(pluginEvent!.metadata)).not.toContain("STACKTRACE-SECRET-LEAK");
    expect(pluginEvent!.summary).not.toContain("STACKTRACE-SECRET-LEAK");
  });

  it("every operational event has completeness { status: 'complete' }", () => {
    const { habitat, task } = setupHabitat();

    const rule = ruleRepo.createAutomationRule({
      habitatId: habitat.id,
      name: "R",
      trigger: { type: "event", eventType: "task.rejected" } as any,
      actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "T" }],
      createdBy: "user-1",
    });
    const run = runRepo.startRuleRun({
      ruleId: rule.id,
      habitatId: habitat.id,
      triggerType: "task.rejected",
    });
    runRepo.finishRuleRun(run.id, { status: "failed" });

    const event = eventRepo.createNotificationEvent({
      habitatId: habitat.id,
      eventType: "task.assigned",
      sourceType: "task",
      severity: "info",
      title: "E",
      body: "B",
      createdByType: "system",
    });
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
      channels: ["in_app"],
    });

    const pluginRun = pluginRunRepo.startRun({
      habitatId: habitat.id,
      pluginId: "plugin-r",
      contributionId: "detector-r",
      contributionKind: "signalDetector",
      triggerType: "task.created",
    });
    pluginRunRepo.finishRun(pluginRun.id, "rate_limited");

    const result = queryAuditEvents({ habitatId: habitat.id, order: "asc" });
    const operational = result.events.filter(
      (e) =>
        e.entity.type === "automation_run" ||
        e.entity.type === "notification_event" ||
        e.entity.type === "notification_delivery" ||
        e.entity.type === "plugin_run",
    );
    for (const e of operational) {
      expect(e.completeness.status).toBe("complete");
      expect(e.completeness.caveats).toEqual([]);
    }

    void task;
    void delivery;
  });

  it("explicit entityType 'time_record' returns time_record events", () => {
    const { habitat, task } = setupHabitat();
    const { agent } = agentRepo.createAgent({
      name: "Op Agent",
      type: "claude-code",
      domain: "ops",
    });
    timeRepo.createTimeRecord({
      taskId: task.id,
      agentId: agent.id,
      minutesSpent: 12,
      statusDuringWork: "in_progress",
    });

    const result = queryAuditEvents({
      habitatId: habitat.id,
      entityType: "time_record",
      order: "asc",
    });

    expect(result.events.some((e) => e.entity.type === "time_record")).toBe(true);
    for (const e of result.events) {
      expect(e.entity.type).toBe("time_record");
      expect(e.completeness.status).toBe("source_unavailable");
    }
    expect(result.warnings.map((w) => w.code)).not.toContain("source_unavailable");
  });

  it("emits inferred_presence_source_unavailable when time_record events survive filtering", () => {
    const { habitat, task } = setupHabitat();
    const { agent } = agentRepo.createAgent({
      name: "Presence Agent",
      type: "claude-code",
      domain: "ops",
    });
    timeRepo.createTimeRecord({
      taskId: task.id,
      agentId: agent.id,
      minutesSpent: 15,
      statusDuringWork: "in_progress",
    });

    const result = queryAuditEvents({
      habitatId: habitat.id,
      entityType: "time_record",
      order: "asc",
    });

    expect(result.warnings.map((w) => w.code)).toContain("inferred_presence_source_unavailable");
  });

  it("does NOT emit inferred_presence_source_unavailable when time_record events are filtered out", () => {
    const { habitat, task } = setupHabitat();
    const { agent } = agentRepo.createAgent({
      name: "Presence Agent",
      type: "claude-code",
      domain: "ops",
    });
    timeRepo.createTimeRecord({
      taskId: task.id,
      agentId: agent.id,
      minutesSpent: 15,
      statusDuringWork: "in_progress",
    });

    const result = queryAuditEvents({
      habitatId: habitat.id,
      entityType: "effort_entry",
      order: "asc",
    });

    expect(result.events.some((e) => e.entity.type === "time_record")).toBe(false);
    expect(result.warnings.map((w) => w.code)).not.toContain("inferred_presence_source_unavailable");
  });

  it("default query does NOT include time_record events", () => {
    const { habitat, task } = setupHabitat();
    timeRepo.createTimeRecord({
      taskId: task.id,
      agentId: undefined,
      minutesSpent: 7,
      statusDuringWork: "in_progress",
    });

    const result = queryAuditEvents({ habitatId: habitat.id, order: "asc" });

    expect(result.events.some((e) => e.entity.type === "time_record")).toBe(false);
  });

  it("notification deliveries do NOT appear in task bundle via referencedEntities", () => {
    const { habitat, task } = setupHabitat();
    const event = eventRepo.createNotificationEvent({
      habitatId: habitat.id,
      eventType: "task.assigned",
      sourceType: "task",
      sourceId: task.id,
      targetType: "task",
      targetId: task.id,
      severity: "info",
      title: "Task assigned",
      body: "Test",
      createdByType: "system",
    });
    deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
      channels: ["in_app"],
    });

    const result = queryAuditEvents({
      habitatId: habitat.id,
      referencedEntities: [{ type: "task", id: task.id }],
      order: "asc",
    });

    expect(result.events.some((e) => e.entity.type === "notification_event")).toBe(true);
    expect(result.events.some((e) => e.entity.type === "notification_delivery")).toBe(false);
  });
});
