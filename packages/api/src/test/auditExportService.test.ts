import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import * as eventRepo from "../repositories/events/index.js";
import { generateAuditExportContent } from "../services/auditExportService.js";
import {
  columns,
  habitatCodeRepositories,
  habitats,
  missions,
  pipelineEvents,
  taskEvents,
  tasks,
} from "../db/schema/index.js";

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
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
});
