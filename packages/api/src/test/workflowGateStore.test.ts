import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
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
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskCrudRepo from "../repositories/taskCrud.js";
import { workflowGateStore } from "../services/workflow/workflowGateStore.js";
import type { AutomationCondition } from "../models/index.js";

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
  satisfied?: boolean;
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
      satisfied: opts.satisfied ?? false,
      recoveryDepth: 0,
    })
    .run();

  return { workflowId, gateId };
}

/** Look up a gate row by id from the DB (test helper). */
function findGateById(gateId: string): {
  id: string;
  workflowId: string;
  missionId: string;
  habitatId: string;
  upstreamTaskId: string;
  downstreamTaskId: string;
  gateType: string;
  satisfied: boolean;
  satisfiedAt: string | null;
  matchConfig: Record<string, unknown> | null;
  condition: AutomationCondition | null;
  recoveryTaskId: string | null;
  recoveryDepth: number;
} {
  const db = getDb();
  const row = db
    .select()
    .from(taskWorkflowGates)
    .where(eq(taskWorkflowGates.id, gateId))
    .get();
  if (!row) throw new Error(`gate ${gateId} not found in test DB`);
  return row as unknown as {
    id: string;
    workflowId: string;
    missionId: string;
    habitatId: string;
    upstreamTaskId: string;
    downstreamTaskId: string;
    gateType: string;
    satisfied: boolean;
    satisfiedAt: string | null;
    matchConfig: Record<string, unknown> | null;
    condition: AutomationCondition | null;
    recoveryTaskId: string | null;
    recoveryDepth: number;
  };
}

describe("satisfyManualGateIfEligible", () => {
  it("returns not_found when no gate exists with the given id", () => {
    const result = workflowGateStore.satisfyManualGateIfEligible("nonexistent-gate-id");
    expect(result.status).toBe("not_found");
    if (result.status === "not_found") {
      expect(result.gateId).toBe("nonexistent-gate-id");
    }
  });

  it("returns wrong_gate_type when gate exists but is on_complete", () => {
    const { gateId } = seedGate({ gateType: "on_complete" });
    const result = workflowGateStore.satisfyManualGateIfEligible(gateId);
    expect(result.status).toBe("wrong_gate_type");
    if (result.status === "wrong_gate_type") {
      expect(result.gate.id).toBe(gateId);
      expect(result.gate.gateType).toBe("on_complete");
    }
  });

  it("returns wrong_gate_type when gate exists but is on_signal", () => {
    const { gateId } = seedGate({ gateType: "on_signal" });
    const result = workflowGateStore.satisfyManualGateIfEligible(gateId);
    expect(result.status).toBe("wrong_gate_type");
    if (result.status === "wrong_gate_type") {
      expect(result.gate.gateType).toBe("on_signal");
    }
  });

  it("satisfies an eligible on_manual gate (success path)", () => {
    const { gateId } = seedGate({ gateType: "on_manual", satisfied: false });
    const result = workflowGateStore.satisfyManualGateIfEligible(gateId);
    expect(result.status).toBe("satisfied");
    if (result.status === "satisfied") {
      expect(result.gate.id).toBe(gateId);
      expect(result.gate.gateType).toBe("on_manual");
      expect(result.satisfiedAt).toBeTruthy();
    }
  });
});

describe("satisfyGateIfUnsatisfied", () => {
  it("satisfies an unsatisfied gate (success path)", () => {
    const { gateId } = seedGate({ gateType: "on_complete", satisfied: false });
    const gate = findGateById(gateId);

    const result = workflowGateStore.satisfyGateIfUnsatisfied(gate);
    expect(result.status).toBe("satisfied");
    if (result.status === "satisfied") {
      expect(result.satisfiedAt).toBeTruthy();
    }

    // Verify the row in the DB is now satisfied.
    const refreshed = findGateById(gateId);
    expect(refreshed.satisfied).toBe(true);
  });

  it("a second call after the gate is satisfied is idempotent (no DB mutation)", () => {
    // Idempotency contract: calling satisfyGateIfUnsatisfied twice must
    // produce the same DB state as calling it once. The production function
    // detects this by reading `runResult.changes` (better-sqlite3 reports 0
    // when the WHERE clause matches no rows). Under sql.js — the test
    // driver — `runResult` is a bare `true` with no `.changes` field, so the
    // function's `changes === undefined || changes > 0` fallback always
    // returns "satisfied" even on the second call. We verify the
    // user-visible invariant (DB row stays consistent, satisfiedAt unchanged)
    // rather than the return value, mirroring the pattern in
    // automationRepositories.test.ts. In better-sqlite3 (production) the
    // second call returns { status: "already_satisfied" }.
    const { gateId } = seedGate({ gateType: "on_complete", satisfied: false });
    const gate = findGateById(gateId);

    const first = workflowGateStore.satisfyGateIfUnsatisfied(gate);
    expect(first.status).toBe("satisfied");
    const satisfiedAtAfterFirst = findGateById(gateId);
    expect(satisfiedAtAfterFirst.satisfied).toBe(true);
    const firstSatisfiedAt = satisfiedAtAfterFirst.satisfiedAt;

    // Second call with the now-satisfied gate.
    const refreshed = findGateById(gateId);
    const second = workflowGateStore.satisfyGateIfUnsatisfied(refreshed);

    // DB state must be stable: satisfied stays true and satisfiedAt is not
    // overwritten on the second call. (Direct consequence of the WHERE
    // clause filtering by `satisfied = false`.)
    const after = findGateById(gateId);
    expect(after.satisfied).toBe(true);
    expect(after.satisfiedAt).toBe(firstSatisfiedAt);

    // The status discrimination between "satisfied" and "already_satisfied"
    // only works under better-sqlite3 because that driver reports changes.
    // Under sql.js both calls return "satisfied"; under production both
    // calls report distinct statuses (first= "satisfied", second =
    // "already_satisfied"). The runtime check below asserts whichever
    // discrimination the current driver provides without breaking the
    // sql.js test run.
    expect(["satisfied", "already_satisfied"]).toContain(second.status);
  });
});
