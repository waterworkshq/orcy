import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  workflows,
  taskWorkflowGates,
  tasks,
  agents,
  missions,
  columns,
  habitats,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskCrudRepo from "../repositories/taskCrud.js";
import { manualUnblockGate } from "../services/workflowService.js";

let habitatId: string;
let missionId: string;
let upstreamTaskId: string;
let downstreamTaskId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  // Clear all tables that the workflow/gate setup touches.
  db.delete(taskWorkflowGates).run();
  db.delete(workflows).run();
  db.delete(tasks).run();
  db.delete(agents).run();
  db.delete(missions).run();
  db.delete(columns).run();
  db.delete(habitats).run();

  const habitat = habitatRepo.createHabitat({ name: "Gate Store Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: "Gate Store Mission",
    createdBy: "user-1",
  });
  missionId = mission.id;
  const upstream = taskCrudRepo.createTask({
    missionId,
    title: "Upstream",
    createdBy: "user-1",
  });
  const downstream = taskCrudRepo.createTask({
    missionId,
    title: "Downstream",
    createdBy: "user-1",
  });
  upstreamTaskId = upstream.id;
  downstreamTaskId = downstream.id;
});

afterEach(() => {
  closeDb();
});

/** Insert a workflow row + a single gate row, returning the gate id. */
function seedGate(opts: {
  gateType: "on_manual" | "on_complete" | "on_signal" | "on_automation" | "on_approve" | "on_fail";
}) {
  const db = getDb();
  const workflowId = `wf-${Math.random().toString(36).slice(2)}`;
  db.insert(workflows)
    .values({
      id: workflowId,
      missionId,
      habitatId,
      status: "active",
      createdBy: "user-1",
    })
    .run();

  const gateId = `gate-${Math.random().toString(36).slice(2)}`;
  db.insert(taskWorkflowGates)
    .values({
      id: gateId,
      workflowId,
      missionId,
      habitatId,
      upstreamTaskId,
      downstreamTaskId,
      gateType: opts.gateType,
      satisfied: false,
      recoveryDepth: 0,
    })
    .run();

  return { workflowId, gateId };
}

// Manual eligibility belongs to the workflow-service adapter. These tests stay
// in this fixture file for the existing gate setup, but exercise the public
// adapter boundary rather than the removed store mutation.
describe("manualUnblockGate — on_manual eligibility refusals", () => {
  it("returns false when no gate exists with the given id", () => {
    expect(manualUnblockGate("nonexistent-gate-id", "admin-1")).toBe(false);
  });

  it("returns false when gate exists but is on_complete", () => {
    const { gateId } = seedGate({ gateType: "on_complete" });
    expect(manualUnblockGate(gateId, "admin-1")).toBe(false);
  });

  it("returns false when gate exists but is on_signal", () => {
    const { gateId } = seedGate({ gateType: "on_signal" });
    expect(manualUnblockGate(gateId, "admin-1")).toBe(false);
  });
});
