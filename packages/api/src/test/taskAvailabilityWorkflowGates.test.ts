import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { taskWorkflowGates, workflows } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import { getAvailableTasksForAgent } from "../repositories/taskQueries.js";

let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  const habitat = habitatRepo.createHabitat({ name: "Workflow Availability Habitat" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  }).id;
});

afterEach(() => closeDb());

function seedMissionWithTasks(title: string) {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title,
    createdBy: "user-1",
  });
  const upstream = taskRepo.createTask({
    missionId: mission.id,
    title: `${title}-upstream`,
    createdBy: "user-1",
  });
  const downstream = taskRepo.createTask({
    missionId: mission.id,
    title: `${title}-downstream`,
    createdBy: "user-1",
  });
  return { mission, upstream, downstream };
}

function availableTaskIds(): string[] {
  return getAvailableTasksForAgent(habitatId, "backend", { status: "pending" }).map(
    (task) => task.id,
  );
}

describe("getAvailableTasksForAgent workflow-gate projection", () => {
  it("excludes a task blocked by an active unsatisfied workflow gate", () => {
    const { mission, upstream, downstream } = seedMissionWithTasks("gated");
    getDb()
      .insert(workflows)
      .values({
        id: "wf-availability-gated",
        missionId: mission.id,
        habitatId,
        resolvedVariables: {},
        createdBy: "user-1",
      })
      .run();
    getDb()
      .insert(taskWorkflowGates)
      .values({
        id: "gate-availability-gated",
        workflowId: "wf-availability-gated",
        missionId: mission.id,
        habitatId,
        upstreamTaskId: upstream.id,
        downstreamTaskId: downstream.id,
        gateType: "on_complete",
        satisfied: false,
      })
      .run();

    expect(availableTaskIds()).toContain(upstream.id);
    expect(availableTaskIds()).not.toContain(downstream.id);
  });

  it("leaves tasks in missions without workflows available", () => {
    const { upstream, downstream } = seedMissionWithTasks("plain");

    expect(availableTaskIds()).toEqual(expect.arrayContaining([upstream.id, downstream.id]));
  });
});
