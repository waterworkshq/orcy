import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as eventRepo from "../repositories/events/index.js";
import * as codeEvidenceLinkRepo from "../repositories/codeEvidenceLinkRepository.js";
import { logEffort } from "../services/effortService.js";
import { getMissionAuditBundle, getTaskAuditBundle } from "../services/auditBundleService.js";
import {
  codeEvidenceLinks,
  columns,
  habitatCodeRepositories,
  habitats,
  missionEvents,
  missions,
  pipelineEvents,
  taskEvents,
  tasks,
  effortEntries,
} from "../db/schema/index.js";

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(pipelineEvents).run();
  db.delete(codeEvidenceLinks).run();
  db.delete(effortEntries).run();
  db.delete(taskEvents).run();
  db.delete(missionEvents).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columns).run();
  db.delete(habitatCodeRepositories).run();
  db.delete(habitats).run();
});

afterEach(() => closeDb());

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

describe("auditBundleService", () => {
  it("builds a task bundle with lifecycle, effort, code evidence, and pipeline metadata", () => {
    const fixture = createFixture();
    const db = getDb();
    eventRepo.createEvent({
      taskId: fixture.task.id,
      actorType: "agent",
      actorId: "agent-1",
      action: "claimed",
    });
    logEffort(fixture.task.id, "human", "user-1", { minutes: 15, source: "human_manual" });
    const link = codeEvidenceLinkRepo.create({
      targetType: "task",
      targetId: fixture.task.id,
      evidenceType: "external_url",
      externalUrl: "https://example.com/evidence",
      title: "Evidence URL",
      linkSource: "api",
      linkedByType: "human",
      linkedById: "user-1",
      metadata: { payload: { unsafe: true } },
    });
    db.insert(pipelineEvents)
      .values({
        id: "pipeline-1",
        taskId: fixture.task.id,
        provider: "github",
        repo: "orcy/app",
        runId: "run-1",
        status: "success",
        branch: "main",
        metadata: { payload: { unsafe: true } },
      })
      .run();

    const bundle = getTaskAuditBundle(fixture.task.id);

    expect(bundle.target).toMatchObject({
      type: "task",
      id: fixture.task.id,
      missionId: fixture.mission.id,
      habitatId: fixture.habitat.id,
    });
    expect(bundle.events.map((event) => event.id)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^task_event:/),
        expect.stringMatching(/^effort_entry:/),
        `code_evidence_link:${link!.id}`,
        "pipeline_event:pipeline-1",
      ]),
    );
    expect(
      bundle.events.find((event) => event.id === `code_evidence_link:${link!.id}`),
    ).toMatchObject({
      metadata: expect.not.objectContaining({ payload: expect.anything() }),
    });
    expect(bundle.events.find((event) => event.id === "pipeline_event:pipeline-1")).toMatchObject({
      metadata: expect.not.objectContaining({ payload: expect.anything() }),
    });
    expect(bundle.completenessSummary.totalEvents).toBe(bundle.events.length);
    expect(bundle.completenessSummary.byStatus.legacy_partial).toBeGreaterThan(0);
  });

  it("separates direct mission evidence from rolled-up task evidence", () => {
    const fixture = createFixture();
    eventRepo.createMissionEvent({
      missionId: fixture.mission.id,
      actorType: "human",
      actorId: "user-1",
      action: "updated",
    });
    eventRepo.createEvent({
      taskId: fixture.task.id,
      actorType: "agent",
      actorId: "agent-1",
      action: "claimed",
    });
    const directLink = codeEvidenceLinkRepo.create({
      targetType: "mission",
      targetId: fixture.mission.id,
      evidenceType: "external_url",
      externalUrl: "https://example.com/mission",
      title: "Mission evidence",
      linkSource: "api",
      linkedByType: "human",
      linkedById: "user-1",
    });
    const taskLink = codeEvidenceLinkRepo.create({
      targetType: "task",
      targetId: fixture.task.id,
      evidenceType: "external_url",
      externalUrl: "https://example.com/task",
      title: "Task evidence",
      linkSource: "api",
      linkedByType: "agent",
      linkedById: "agent-1",
    });

    const bundle = getMissionAuditBundle(fixture.mission.id);

    expect(bundle.directMissionEvidence.map((event) => event.id)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^mission_event:/),
        `code_evidence_link:${directLink!.id}`,
      ]),
    );
    expect(bundle.rolledUpTaskEvidence.map((event) => event.id)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^task_event:/),
        `code_evidence_link:${taskLink!.id}`,
      ]),
    );
    expect(bundle.rolledUpTaskEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          linkedEntities: expect.arrayContaining([
            { type: "task", id: fixture.task.id, title: "Task" },
          ]),
        }),
      ]),
    );
    expect(bundle.completenessSummary.totalEvents).toBe(
      bundle.directMissionEvidence.length + bundle.rolledUpTaskEvidence.length,
    );
  });
});
