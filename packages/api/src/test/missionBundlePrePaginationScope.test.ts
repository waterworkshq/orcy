/**
 * v0.29 Phase 5 — Mission bundle pre-pagination scope test.
 *
 * Mirrors `auditBundlePrePaginationScope.test.ts` for the mission bundle:
 * verifies that `getMissionAuditBundle` pre-filters by `referencedEntities`
 * BEFORE pagination, so a notification event linked to the target mission
 * is surfaced in the bundle regardless of how many unrelated notification
 * events the habitat contains. Also asserts that events linked to a
 * different mission in the same habitat do NOT leak into the bundle.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as notificationEventRepo from "../repositories/notificationEvent.js";
import { getMissionAuditBundle } from "../services/auditBundleService.js";
import {
  columns,
  habitats,
  missions,
  notificationDeliveries,
  notificationEvents,
  tasks,
} from "../db/schema/index.js";

beforeEach(async () => {
  await initTestDb();
  const db = (await import("../db/index.js")).getDb();
  db.delete(notificationDeliveries).run();
  db.delete(notificationEvents).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columns).run();
  db.delete(habitats).run();
});

afterEach(() => {
  closeDb();
});

describe("missionBundle pre-pagination scope", () => {
  it("isolates notification events by mission scope", () => {
    const habitat = habitatRepo.createHabitat({ name: "Scope Habitat" });
    const column = columnRepo.createColumn({
      habitatId: habitat.id,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    });
    const targetMission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: column.id,
      title: "Target Mission",
      createdBy: "user-1",
    });
    const targetTask = taskRepo.createTask({
      missionId: targetMission.id,
      title: "Target Task",
      createdBy: "user-1",
    });
    const otherMission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: column.id,
      title: "Other Mission",
      createdBy: "user-1",
    });
    taskRepo.createTask({
      missionId: otherMission.id,
      title: "Other Task",
      createdBy: "user-1",
    });

    const targetMissionNotification = notificationEventRepo.createNotificationEvent({
      habitatId: habitat.id,
      eventType: "mission.risk_marked",
      sourceType: "mission",
      sourceId: targetMission.id,
      severity: "critical",
      title: "Target mission at risk",
      body: "Target mission body",
      createdByType: "system",
    });

    const targetTaskNotification = notificationEventRepo.createNotificationEvent({
      habitatId: habitat.id,
      eventType: "task.assigned",
      sourceType: "task",
      sourceId: targetTask.id,
      severity: "info",
      title: "Target task assigned",
      body: "Target task body",
      createdByType: "system",
    });

    const otherMissionNotification = notificationEventRepo.createNotificationEvent({
      habitatId: habitat.id,
      eventType: "mission.risk_marked",
      sourceType: "mission",
      sourceId: otherMission.id,
      severity: "critical",
      title: "Other mission at risk",
      body: "Other mission body",
      createdByType: "system",
    });

    const bundle = getMissionAuditBundle(targetMission.id);

    const allIncluded = [
      ...bundle.directMissionEvidence,
      ...bundle.rolledUpTaskEvidence,
    ];

    const targetMissionEvent = allIncluded.find(
      (event) => event.id === `notification_event:${targetMissionNotification.id}`,
    );
    expect(targetMissionEvent).toBeDefined();
    expect(targetMissionEvent?.linkedEntities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "mission", id: targetMission.id }),
      ]),
    );
    expect(bundle.directMissionEvidence.map((event) => event.id)).toContain(
      `notification_event:${targetMissionNotification.id}`,
    );

    const targetTaskEvent = allIncluded.find(
      (event) => event.id === `notification_event:${targetTaskNotification.id}`,
    );
    expect(targetTaskEvent).toBeDefined();
    expect(targetTaskEvent?.linkedEntities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "task", id: targetTask.id }),
      ]),
    );
    expect(bundle.rolledUpTaskEvidence.map((event) => event.id)).toContain(
      `notification_event:${targetTaskNotification.id}`,
    );

    expect(
      allIncluded.find(
        (event) => event.id === `notification_event:${otherMissionNotification.id}`,
      ),
    ).toBeUndefined();

    expect(bundle.completenessSummary.totalEvents).toBe(allIncluded.length);
    expect(bundle.warnings.map((w) => w.code)).not.toContain("result_truncated");
  });

  it("surfaces a target-mission notification despite >1000 unrelated notifications in the habitat", () => {
    const habitat = habitatRepo.createHabitat({ name: "Noisy Habitat" });
    const column = columnRepo.createColumn({
      habitatId: habitat.id,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    });
    const targetMission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: column.id,
      title: "Target Mission",
      createdBy: "user-1",
    });
    const noisyMission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: column.id,
      title: "Noisy Mission",
      createdBy: "user-1",
    });

    for (let i = 0; i < 1005; i++) {
      notificationEventRepo.createNotificationEvent({
        habitatId: habitat.id,
        eventType: "mission.risk_marked",
        sourceType: "mission",
        sourceId: noisyMission.id,
        severity: "info",
        title: `Noise ${i}`,
        body: "noise",
        createdByType: "system",
      });
    }

    const targetNotification = notificationEventRepo.createNotificationEvent({
      habitatId: habitat.id,
      eventType: "mission.risk_marked",
      sourceType: "mission",
      sourceId: targetMission.id,
      severity: "critical",
      title: "Target",
      body: "target",
      createdByType: "system",
    });

    const bundle = getMissionAuditBundle(targetMission.id);

    const targetEvent = bundle.directMissionEvidence.find(
      (event) => event.id === `notification_event:${targetNotification.id}`,
    );
    expect(targetEvent).toBeDefined();
    expect(targetEvent?.linkedEntities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "mission", id: targetMission.id }),
      ]),
    );

    expect(bundle.warnings.map((w) => w.code)).not.toContain("result_truncated");
    expect(bundle.completenessSummary.totalEvents).toBe(
      bundle.directMissionEvidence.length + bundle.rolledUpTaskEvidence.length,
    );
  });
});
