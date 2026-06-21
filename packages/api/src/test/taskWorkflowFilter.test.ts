import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/board.js";
import * as taskRepo from "../repositories/task.js";
import * as missionRepo from "../repositories/feature.js";
import * as columnRepo from "../repositories/column.js";
import {
  tasks,
  habitats,
  columns as columnsTable,
  taskEvents,
  agents,
} from "../db/schema/index.js";
import { taskWorkflowGates, workflows } from "../db/schema/index.js";
import { getTasksByHabitatId } from "../repositories/task.js";

vi.mock("../services/chatService.js", () => ({
  sendAnomalyAlert: vi.fn().mockResolvedValue(undefined),
  processEvent: vi.fn().mockResolvedValue(undefined),
  executeCommand: vi.fn().mockResolvedValue({ response: {}, provider: "slack" as const }),
  sendTestMessage: vi.fn().mockResolvedValue({ success: true, statusCode: 200, latencyMs: 0 }),
}));

let habitatId: string;
let missionId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(taskEvents).run();
  db.delete(tasks).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();
  db.delete(agents).run();

  const habitat = habitatRepo.createHabitat({ name: "Test Habitat" });
  habitatId = habitat.id;

  const column = columnRepo.createColumn({
    habitatId,
    name: "Backlog",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;

  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: "Test Mission",
    createdBy: "test-user",
  });
  missionId = mission.id;
});

afterEach(() => {
  closeDb();
});

function createTask(title: string) {
  return taskRepo.createTask({
    missionId,
    title,
    priority: "medium",
    createdBy: "test-user",
  });
}

function createWorkflowGate(
  workflowId: string,
  upstreamTaskId: string,
  downstreamTaskId: string,
  satisfied: boolean,
) {
  const db = getDb();
  const id = `gate-${Math.random().toString(36).slice(2, 10)}`;
  db.insert(taskWorkflowGates)
    .values({
      id,
      workflowId,
      missionId,
      habitatId,
      upstreamTaskId,
      downstreamTaskId,
      gateType: "on_complete",
      satisfied,
    })
    .run();
  return id;
}

describe("getTasksByHabitatId — hasUnmetWorkflowGates filter", () => {
  it("returns tasks with unsatisfied workflow gates when filter is true", () => {
    const taskA = createTask("Task A");
    const taskB = createTask("Task B");
    const taskC = createTask("Task C — no gates");

    const db = getDb();
    const wfId = `wf-${Math.random().toString(36).slice(2, 10)}`;
    db.insert(workflows)
      .values({
        id: wfId,
        missionId,
        habitatId,
        status: "active",
        createdBy: "test-user",
      })
      .run();

    createWorkflowGate(wfId, taskA.id, taskB.id, false);

    const result = getTasksByHabitatId(habitatId, {
      hasUnmetWorkflowGates: true,
    });

    const taskIds = result.tasks.map((t) => t.id);
    expect(taskIds).toContain(taskB.id);
    expect(taskIds).not.toContain(taskA.id);
    expect(taskIds).not.toContain(taskC.id);
  });

  it("does not return tasks with satisfied workflow gates", () => {
    const taskA = createTask("Task A");
    const taskB = createTask("Task B");

    const db = getDb();
    const wfId = `wf-${Math.random().toString(36).slice(2, 10)}`;
    db.insert(workflows)
      .values({
        id: wfId,
        missionId,
        habitatId,
        status: "active",
        createdBy: "test-user",
      })
      .run();

    createWorkflowGate(wfId, taskA.id, taskB.id, true);

    const result = getTasksByHabitatId(habitatId, {
      hasUnmetWorkflowGates: true,
    });

    expect(result.tasks).toHaveLength(0);
  });

  it("returns all tasks when filter is not provided", () => {
    const taskA = createTask("Task A");
    const taskB = createTask("Task B");
    createTask("Task C");

    const db = getDb();
    const wfId = `wf-${Math.random().toString(36).slice(2, 10)}`;
    db.insert(workflows)
      .values({
        id: wfId,
        missionId,
        habitatId,
        status: "active",
        createdBy: "test-user",
      })
      .run();

    createWorkflowGate(wfId, taskA.id, taskB.id, false);

    const result = getTasksByHabitatId(habitatId);
    expect(result.tasks.length).toBeGreaterThanOrEqual(3);
  });

  it("combines with status filter", () => {
    const taskA = createTask("Task A");
    const taskB = createTask("Task B");

    const db = getDb();
    const wfId = `wf-${Math.random().toString(36).slice(2, 10)}`;
    db.insert(workflows)
      .values({
        id: wfId,
        missionId,
        habitatId,
        status: "active",
        createdBy: "test-user",
      })
      .run();

    createWorkflowGate(wfId, taskA.id, taskB.id, false);

    const result = getTasksByHabitatId(habitatId, {
      hasUnmetWorkflowGates: true,
      status: "pending",
    });

    const taskIds = result.tasks.map((t) => t.id);
    expect(taskIds).toContain(taskB.id);
    expect(taskIds).not.toContain(taskA.id);
  });

  it("handles tasks with no workflow gates at all", () => {
    createTask("Free Task 1");
    createTask("Free Task 2");

    const result = getTasksByHabitatId(habitatId, {
      hasUnmetWorkflowGates: true,
    });

    expect(result.tasks).toHaveLength(0);
  });
});
