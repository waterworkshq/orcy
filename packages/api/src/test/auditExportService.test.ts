import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as ruleRunRepo from "../repositories/automationRuleRun.js";
import * as eventRepo from "../repositories/events/index.js";
import * as notificationEventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as pluginRunRepo from "../repositories/pluginRun.js";
import {
  createSchedule,
  deleteSchedule,
  generateAuditExportContent,
  getAuditSummary,
  getScheduleById,
  listSchedules,
} from "../services/auditExportService.js";
import {
  auditExportSchedules,
  automationRuleRuns,
  automationRules,
  columns,
  habitatCodeRepositories,
  habitats,
  missions,
  notificationDeliveries,
  notificationEvents,
  pipelineEvents,
  pluginRuns,
  taskEvents,
  tasks,
} from "../db/schema/index.js";

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(auditExportSchedules).run();
  db.delete(pluginRuns).run();
  db.delete(notificationDeliveries).run();
  db.delete(notificationEvents).run();
  db.delete(automationRuleRuns).run();
  db.delete(automationRules).run();
  db.delete(pipelineEvents).run();
  db.delete(habitatCodeRepositories).run();
  db.delete(taskEvents).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columns).run();
  db.delete(habitats).run();
});

afterEach(() => {
  closeDb();
});

function createFixture() {
  const habitat = habitatRepo.createHabitat({ name: "Habitat" });
  const column = columnRepo.createColumn({
    habitatId: habitat.id,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: column.id,
    title: "Mission",
    createdBy: "user-1",
  });
  const task = taskRepo.createTask({ missionId: mission.id, title: "Task", createdBy: "user-1" });
  return { habitat, mission, task };
}

describe("auditExportService", () => {
  it("exports canonical CSV columns", () => {
    const fixture = createFixture();
    eventRepo.createEvent({
      taskId: fixture.task.id,
      actorType: "human",
      actorId: "user-1",
      action: "created",
    });

    const csv = generateAuditExportContent(fixture.habitat.id, { format: "csv" });

    expect(csv).toContain(
      "id,occurredAt,habitatId,entityType,entityId,action,actorType,actorId,source,summary,completenessStatus",
    );
    expect(csv).toContain("task_event:");
    expect(csv).toContain(",task,");
    expect(csv).toContain(",created,");
  });

  it("can include optional integrity metadata in CSV exports", () => {
    const fixture = createFixture();
    eventRepo.createEvent({
      taskId: fixture.task.id,
      actorType: "human",
      actorId: "user-1",
      action: "created",
    });

    const csv = generateAuditExportContent(fixture.habitat.id, {
      format: "csv",
      includeIntegrity: "true",
    });

    expect(csv.split("\n")[0]).toContain("completenessStatus,integrityJson");
    expect(csv).toContain(",legacy_partial,null");
  });

  it("exports canonical JSON and JSONL AuditEvent shapes", () => {
    const fixture = createFixture();
    eventRepo.createEvent({
      taskId: fixture.task.id,
      actorType: "agent",
      actorId: "agent-1",
      action: "claimed",
    });

    const json = JSON.parse(generateAuditExportContent(fixture.habitat.id, { format: "json" }));
    const jsonl = generateAuditExportContent(fixture.habitat.id, { format: "jsonl" })
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(json[0]).toMatchObject({
      id: expect.stringMatching(/^task_event:/),
      entity: { type: "task", id: fixture.task.id, title: "Task" },
      action: "claimed",
      completeness: { status: "legacy_partial" },
    });
    expect(jsonl[0]).toMatchObject({ entity: { type: "task" }, action: "claimed" });
  });

  it("filters by provider/source and failed pipeline preset", () => {
    const fixture = createFixture();
    const db = getDb();
    db.insert(habitatCodeRepositories)
      .values({ id: "repo-1", habitatId: fixture.habitat.id, provider: "github" })
      .run();
    db.insert(pipelineEvents)
      .values({
        id: "pipeline-1",
        taskId: fixture.task.id,
        provider: "github",
        repo: "orcy/app",
        runId: "run-1",
        status: "failure",
        branch: "main",
        repositoryId: "repo-1",
        metadata: { audit: { source: "webhook", provider: "github" } },
      })
      .run();
    db.insert(pipelineEvents)
      .values({
        id: "pipeline-2",
        taskId: fixture.task.id,
        provider: "gitlab",
        repo: "orcy/app",
        runId: "run-2",
        status: "success",
        branch: "main",
        metadata: { audit: { source: "webhook", provider: "gitlab" } },
      })
      .run();

    const rows = JSON.parse(
      generateAuditExportContent(fixture.habitat.id, {
        format: "json",
        provider: "github",
        source: "webhook",
        preset: "failed_pipelines",
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "pipeline_event:pipeline-1",
      entity: { type: "pipeline_event" },
      action: "failure",
      source: "webhook",
      provenance: { provider: "github" },
    });
  });

  it("creates, lists, reads, and deletes export schedules", () => {
    const fixture = createFixture();

    const schedule = createSchedule(fixture.habitat.id, {
      name: "Daily JSONL",
      format: "jsonl",
      filters: { source: "scheduler" },
      schedule: "0 8 * * *",
    });

    expect(schedule).toMatchObject({
      habitatId: fixture.habitat.id,
      name: "Daily JSONL",
      format: "jsonl",
      filters: { source: "scheduler" },
      destination: "local",
      destinationConfig: {},
      enabled: true,
      createdBy: "system",
    });

    expect(getScheduleById(schedule.id)?.id).toBe(schedule.id);
    expect(listSchedules(fixture.habitat.id).map((item) => item.id)).toEqual([schedule.id]);

    expect(deleteSchedule(schedule.id)).toBe(true);
    expect(getScheduleById(schedule.id)).toBeNull();
  });

  it("getAuditSummary aggregates through canonical projection with warnings and completeness", () => {
    const fixture = createFixture();
    eventRepo.createEvent({
      taskId: fixture.task.id,
      actorType: "human",
      actorId: "user-1",
      action: "created",
    });
    eventRepo.createMissionEvent({
      missionId: fixture.mission.id,
      actorType: "system",
      actorId: "status-engine",
      action: "status_changed",
    });

    const summary = getAuditSummary(fixture.habitat.id);

    expect(summary.totalEvents).toBe(2);
    expect(summary.byAction.created).toBe(1);
    expect(summary.byAction.status_changed).toBe(1);
    expect(summary.byActorType.human).toBe(1);
    expect(summary.byActorType.system).toBe(1);
    expect(summary.byDay).toHaveLength(1);
    expect(summary.topMissions).toEqual([
      expect.objectContaining({
        missionId: fixture.mission.id,
        missionTitle: "Mission",
        count: 2,
      }),
    ]);
    expect(summary.warnings).toEqual([
      expect.objectContaining({ code: "legacy_partial_history" }),
    ]);
    expect(summary.completenessSummary.totalEvents).toBe(2);
    expect(summary.completenessSummary.byStatus.legacy_partial).toBe(2);
  });

  it("getAuditSummary topMissions counts missions targeted by automation runs", () => {
    const habitat = habitatRepo.createHabitat({ name: "Top Missions Habitat" });
    const targetedColumn = columnRepo.createColumn({
      habitatId: habitat.id,
      name: "Targeted",
      order: 0,
      requiresClaim: false,
    });
    const untargetedColumn = columnRepo.createColumn({
      habitatId: habitat.id,
      name: "Untargeted",
      order: 1,
      requiresClaim: false,
    });
    const targetedMission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: targetedColumn.id,
      title: "Targeted Mission",
      createdBy: "user-1",
    });
    const untargetedMission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: untargetedColumn.id,
      title: "Untargeted Mission",
      createdBy: "user-1",
    });

    const rule = ruleRepo.createAutomationRule({
      habitatId: habitat.id,
      name: "Mission Nudge",
      trigger: { type: "event", eventType: "mission.stale" } as any,
      actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "T" }],
      createdBy: "user-1",
    });

    const { run: run1 } = ruleRunRepo.startRuleRun({
      ruleId: rule.id,
      habitatId: habitat.id,
      triggerType: "mission.stale",
      triggerEventId: "evt-m-1",
      targetType: "mission",
      targetId: targetedMission.id,
    });
    ruleRunRepo.finishRuleRun(run1.id, { status: "succeeded" });

    const { run: run2 } = ruleRunRepo.startRuleRun({
      ruleId: rule.id,
      habitatId: habitat.id,
      triggerType: "mission.stale",
      triggerEventId: "evt-m-2",
      targetType: "mission",
      targetId: targetedMission.id,
    });
    ruleRunRepo.finishRuleRun(run2.id, { status: "failed" });

    const summary = getAuditSummary(habitat.id);

    const targetedEntry = summary.topMissions.find((m) => m.missionId === targetedMission.id);
    expect(targetedEntry).toEqual({
      missionId: targetedMission.id,
      missionTitle: "Targeted Mission",
      count: 2,
    });
    expect(summary.topMissions.some((m) => m.missionId === untargetedMission.id)).toBe(false);
  });

  it("getAuditSummary aggregates operational events into totalEvents, byAction, byActorType, and byDay", () => {
    const fixture = createFixture();

    const rule = ruleRepo.createAutomationRule({
      habitatId: fixture.habitat.id,
      name: "Op Summary Rule",
      trigger: { type: "event", eventType: "task.rejected" } as any,
      actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "T" }],
      createdBy: "user-1",
    });
    const { run: automationRun } = ruleRunRepo.startRuleRun({
      ruleId: rule.id,
      habitatId: fixture.habitat.id,
      triggerType: "task.rejected",
      targetType: "task",
      targetId: fixture.task.id,
    });
    ruleRunRepo.finishRuleRun(automationRun.id, { status: "succeeded" });

    const notification = notificationEventRepo.createNotificationEvent({
      habitatId: fixture.habitat.id,
      eventType: "task.assigned",
      sourceType: "task",
      sourceId: fixture.task.id,
      targetType: "task",
      targetId: fixture.task.id,
      severity: "info",
      title: "Assigned",
      body: "B",
      createdByType: "system",
    });
    deliveryRepo.createNotificationDelivery({
      eventId: notification.id,
      habitatId: fixture.habitat.id,
      recipientType: "human",
      recipientId: "user-1",
      channels: ["in_app"],
    });

    const pluginRun = pluginRunRepo.startRun({
      habitatId: fixture.habitat.id,
      pluginId: "plugin-summary",
      contributionId: "detector-summary",
      contributionKind: "signalDetector",
      triggerType: "task.created",
    });
    pluginRunRepo.finishRun(pluginRun.id, "succeeded", 1);

    const summary = getAuditSummary(fixture.habitat.id);

    expect(summary.totalEvents).toBe(4);
    expect(summary.byAction).toEqual(
      expect.objectContaining({
        "automation.rule_run.succeeded": 1,
        "notification.task.assigned": 1,
        "notification.delivery.pending": 1,
        "plugin.succeeded": 1,
      }),
    );
    expect(summary.byActorType).toEqual(
      expect.objectContaining({ system: 3, human: 1 }),
    );
    expect(summary.byDay).toEqual([
      { date: new Date().toISOString().slice(0, 10), count: 4 },
    ]);
  });
});
