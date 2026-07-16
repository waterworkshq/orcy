import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync } from "fs";
import { join, resolve } from "path";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import * as eventRepo from "../repositories/events/index.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as pluginRunRepo from "../repositories/pluginRun.js";
import { archiveOldEvents } from "../services/auditArchivalService.js";
import {
  columns,
  habitats,
  missionEvents,
  missions,
  taskEvents,
  tasks,
  automationRuleRuns,
  pluginRuns,
} from "../db/schema/index.js";

const workspaceRoot = resolve(process.cwd(), "../..");

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(pluginRuns).run();
  db.delete(automationRuleRuns).run();
  db.delete(taskEvents).run();
  db.delete(missionEvents).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columns).run();
  db.delete(habitats).run();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
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

describe("auditArchivalService", () => {
  it("archives old task and mission lifecycle events as canonical audit events", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const fixture = createFixture();
    eventRepo.createEvent({
      taskId: fixture.task.id,
      actorType: "agent",
      actorId: "agent-1",
      action: "claimed",
    });
    eventRepo.createMissionEvent({
      missionId: fixture.mission.id,
      actorType: "system",
      actorId: "status-engine",
      action: "status_changed",
    });

    vi.setSystemTime(new Date("2026-06-04T00:00:00.000Z"));
    const result = archiveOldEvents(fixture.habitat.id);

    expect(result.archivedCount).toBe(2);
    expect(result.archivePath).toBeTruthy();
    expect(existsSync(result.archivePath)).toBe(true);

    const archive = JSON.parse(readFileSync(result.archivePath, "utf-8"));
    expect(archive).toMatchObject({
      schemaVersion: 2,
      metadata: {
        habitatId: fixture.habitat.id,
        eventCount: 2,
        completenessSummary: {
          totalEvents: 2,
          byStatus: { complete: 0, legacy_partial: 2, source_unavailable: 0 },
        },
      },
    });
    expect(archive.metadata.sourceRange.until).toContain("2026-03-06");
    expect(archive.events.map((event: any) => event.id)).toEqual([
      expect.stringMatching(/^mission_event:/),
      expect.stringMatching(/^task_event:/),
    ]);
    expect(archive.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: { type: "task", id: fixture.task.id, title: "Task" },
          linkedEntities: [{ type: "mission", id: fixture.mission.id, title: "Mission" }],
          completeness: { status: "legacy_partial", caveats: expect.any(Array) },
        }),
        expect.objectContaining({
          entity: { type: "mission", id: fixture.mission.id, title: "Mission" },
          actor: { type: "system", id: "system:status-engine" },
        }),
      ]),
    );

    expect(getDb().select().from(taskEvents).all()).toHaveLength(0);
    expect(getDb().select().from(missionEvents).all()).toHaveLength(0);

    const archiveDir = join(workspaceRoot, "archives", fixture.habitat.id);
    rmSync(archiveDir, { recursive: true, force: true });
  });

  it("does not archive or delete automation run or plugin run source rows", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const fixture = createFixture();
    eventRepo.createEvent({
      taskId: fixture.task.id,
      actorType: "agent",
      actorId: "agent-1",
      action: "claimed",
    });
    const rule = ruleRepo.createAutomationRule({
      habitatId: fixture.habitat.id,
      name: "Isolation Rule",
      trigger: { type: "event", eventType: "task.rejected" } as any,
      actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "X" }],
      createdBy: "user-1",
    });
    const run = runRepo.startRuleRun({
      ruleId: rule.id,
      habitatId: fixture.habitat.id,
      triggerType: "task.rejected",
      targetType: "task",
      targetId: fixture.task.id,
    });
    runRepo.finishRuleRun(run.id, { status: "succeeded" });

    const pluginRun = pluginRunRepo.startRun({
      habitatId: fixture.habitat.id,
      pluginId: "iso-plugin",
      contributionId: "iso-detector",
      contributionKind: "signalDetector",
      triggerType: "task.created",
    });
    pluginRunRepo.finishRun(pluginRun.id, "succeeded", 0);

    vi.setSystemTime(new Date("2026-06-04T00:00:00.000Z"));
    const result = archiveOldEvents(fixture.habitat.id);

    expect(result.archivedCount).toBe(1);
    expect(
      getDb().select().from(taskEvents).all(),
    ).toHaveLength(0);
    expect(
      getDb().select().from(automationRuleRuns).all(),
    ).toHaveLength(1);
    expect(
      getDb().select().from(pluginRuns).all(),
    ).toHaveLength(1);

    const archiveDir = join(workspaceRoot, "archives", fixture.habitat.id);
    rmSync(archiveDir, { recursive: true, force: true });
  });
});