/**
 * v0.29 Phase 4 — Operational-event export serialization + filter pipeline coverage.
 *
 * The canonical query test (`auditOperationalCoverage.test.ts`) proves operational
 * events appear in `queryAuditEvents`. This suite proves the same four event kinds
 * survive the full export path used by `/api/audit/export`:
 *
 *   - `getCanonicalAuditEvents` (the projection + `eventMatchesExportFilters` pipeline)
 *   - `generateAuditExportContent` (JSON / CSV / JSONL serialization)
 *
 * Doubles as regression coverage for CS-25 (commit 1ccf5dd) — collector caveats must
 * surface in `completenessSummary.caveats` whenever an operational event carries
 * one (e.g. agent-attribution gaps on `time_record` events).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
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
import {
  generateAuditExportContent,
  getCanonicalAuditEvents,
} from "../services/auditExportService.js";
import {
  automationRuleRuns,
  notificationDeliveries,
  notificationEvents,
  pluginRuns,
  taskTimeRecords,
} from "../db/schema/index.js";

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(taskTimeRecords).run();
  db.delete(pluginRuns).run();
  db.delete(notificationDeliveries).run();
  db.delete(notificationEvents).run();
  db.delete(automationRuleRuns).run();
});

afterEach(() => {
  closeDb();
});

function setupHabitat() {
  const habitat = boardRepo.createHabitat({ name: "Export Op Habitat" });
  const column = columnRepo.createColumn({
    habitatId: habitat.id,
    name: "Backlog",
    order: 0,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: column.id,
    title: "Export Mission",
    createdBy: "user-1",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: "Export Task",
    createdBy: "user-1",
  });
  return { habitat, mission, task };
}

function seedOperationalRows(habitatId: string, taskId: string) {
  const rule = ruleRepo.createAutomationRule({
    habitatId,
    name: "Op Rule",
    trigger: { type: "event", eventType: "task.rejected" } as any,
    actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "T" }],
    createdBy: "user-1",
  });

  const automationRun = runRepo.startRuleRun({
    ruleId: rule.id,
    habitatId,
    triggerType: "task.rejected",
    triggerEventId: "evt-export-1",
    targetType: "task",
    targetId: taskId,
  });
  runRepo.finishRuleRun(automationRun.id, { status: "succeeded" });

  const notificationEvent = eventRepo.createNotificationEvent({
    habitatId,
    eventType: "task.assigned",
    sourceType: "task",
    sourceId: taskId,
    targetType: "task",
    targetId: taskId,
    severity: "info",
    title: "Task assigned",
    body: "Notification body",
    createdByType: "system",
  });

  const notificationDelivery = deliveryRepo.createNotificationDelivery({
    eventId: notificationEvent.id,
    habitatId,
    recipientType: "human",
    recipientId: "user-1",
    channels: ["in_app"],
  });
  deliveryRepo.acknowledgeDelivery(notificationDelivery.id);

  const pluginRun = pluginRunRepo.startRun({
    habitatId,
    pluginId: "plugin-export",
    contributionId: "detector-export",
    contributionKind: "signalDetector",
    triggerType: "task.created",
    triggerEventId: "evt-plug-export",
  });
  pluginRunRepo.finishRun(pluginRun.id, "succeeded", 3);

  return { automationRun, notificationEvent, notificationDelivery, pluginRun };
}

describe("audit export operational coverage", () => {
  it("getCanonicalAuditEvents returns all 4 operational event kinds", () => {
    const { habitat, task } = setupHabitat();
    const seeded = seedOperationalRows(habitat.id, task.id);

    const result = getCanonicalAuditEvents(habitat.id, {});

    const ids = result.events.map((e) => e.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        `automation_run:${seeded.automationRun.id}`,
        `notification_event:${seeded.notificationEvent.id}`,
        `notification_delivery:${seeded.notificationDelivery.id}`,
        `plugin_run:${seeded.pluginRun.id}`,
      ]),
    );
  });

  it("JSON export serializes all 4 operational event kinds end-to-end", () => {
    const { habitat, task } = setupHabitat();
    const seeded = seedOperationalRows(habitat.id, task.id);

    const json = generateAuditExportContent(habitat.id, { format: "json" });
    const parsed = JSON.parse(json) as Array<{ id: string; entity: { type: string } }>;

    const ids = parsed.map((e) => e.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        `automation_run:${seeded.automationRun.id}`,
        `notification_event:${seeded.notificationEvent.id}`,
        `notification_delivery:${seeded.notificationDelivery.id}`,
        `plugin_run:${seeded.pluginRun.id}`,
      ]),
    );

    const automation = parsed.find((e) => e.id === `automation_run:${seeded.automationRun.id}`);
    const notification = parsed.find(
      (e) => e.id === `notification_event:${seeded.notificationEvent.id}`,
    );
    const delivery = parsed.find(
      (e) => e.id === `notification_delivery:${seeded.notificationDelivery.id}`,
    );
    const plugin = parsed.find((e) => e.id === `plugin_run:${seeded.pluginRun.id}`);

    expect(automation?.entity.type).toBe("automation_run");
    expect(notification?.entity.type).toBe("notification_event");
    expect(delivery?.entity.type).toBe("notification_delivery");
    expect(plugin?.entity.type).toBe("plugin_run");
  });

  it("CSV export serializes all 4 operational event kinds as a row per event", () => {
    const { habitat, task } = setupHabitat();
    const seeded = seedOperationalRows(habitat.id, task.id);

    const csv = generateAuditExportContent(habitat.id, { format: "csv" });
    const lines = csv.split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(5); // header + 4 operational rows

    const header = lines[0];
    expect(header).toContain("entityType");
    expect(header).toContain("entityId");

    const entityTypes = lines.slice(1).map((line) => line.split(",")[3]);
    expect(entityTypes).toEqual(
      expect.arrayContaining([
        "automation_run",
        "notification_event",
        "notification_delivery",
        "plugin_run",
      ]),
    );

    const dataRows = lines.slice(1).join("\n");
    expect(dataRows).toContain(seeded.automationRun.id);
    expect(dataRows).toContain(seeded.notificationEvent.id);
    expect(dataRows).toContain(seeded.notificationDelivery.id);
    expect(dataRows).toContain(seeded.pluginRun.id);
  });

  it("JSONL export emits one valid JSON line per operational event", () => {
    const { habitat, task } = setupHabitat();
    const seeded = seedOperationalRows(habitat.id, task.id);

    const jsonl = generateAuditExportContent(habitat.id, { format: "jsonl" });
    const records = jsonl
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));

    const ids = records.map((r: { id: string }) => r.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        `automation_run:${seeded.automationRun.id}`,
        `notification_event:${seeded.notificationEvent.id}`,
        `notification_delivery:${seeded.notificationDelivery.id}`,
        `plugin_run:${seeded.pluginRun.id}`,
      ]),
    );
  });

  it("eventMatchesExportFilters forwards all 4 operational kinds under default preset", () => {
    const { habitat, task } = setupHabitat();
    const seeded = seedOperationalRows(habitat.id, task.id);

    const result = getCanonicalAuditEvents(habitat.id, {});

    const operationalTypes = new Set(
      result.events
        .map((e) => e.entity.type)
        .filter(
          (type) =>
            type === "automation_run" ||
            type === "notification_event" ||
            type === "notification_delivery" ||
            type === "plugin_run",
        ),
    );
    expect(operationalTypes.size).toBe(4);
    expect(operationalTypes.has("automation_run")).toBe(true);
    expect(operationalTypes.has("notification_event")).toBe(true);
    expect(operationalTypes.has("notification_delivery")).toBe(true);
    expect(operationalTypes.has("plugin_run")).toBe(true);
  });

  it("entityTypes CSV filter restricts export to the named operational kinds", () => {
    const { habitat, task } = setupHabitat();
    seedOperationalRows(habitat.id, task.id);

    const json = generateAuditExportContent(habitat.id, {
      format: "json",
      entityTypes: "automation_run,plugin_run",
    });
    const parsed = JSON.parse(json) as Array<{ entity: { type: string } }>;

    expect(parsed.length).toBe(2);
    const types = parsed.map((e) => e.entity.type).sort();
    expect(types).toEqual(["automation_run", "plugin_run"]);
  });

  it("operational events filtered into completenessSummary when time_records have caveats", () => {
    const { habitat, task } = setupHabitat();
    seedOperationalRows(habitat.id, task.id);

    // Seed a time record without agent attribution — produces caveats via the
    // effort collector and exercises the CS-25 regression path: caveats collected
    // from individual event completeness flow into completenessSummary.caveats.
    const { agent } = agentRepo.createAgent({
      name: "Caveat Agent",
      type: "claude-code",
      domain: "ops",
    });
    timeRepo.createTimeRecord({
      taskId: task.id,
      agentId: agent.id,
      minutesSpent: 9,
      statusDuringWork: "in_progress",
    });

    const result = getCanonicalAuditEvents(habitat.id, {
      entityType: "time_record",
    });

    expect(result.events.length).toBe(1);
    expect(result.events[0]?.entity.type).toBe("time_record");
    expect(result.completenessSummary.caveats).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Inferred presence record has no heartbeat session provenance."),
      ]),
    );
  });
});
