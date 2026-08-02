import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  taskEvents,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskCrudRepo from "../repositories/taskCrud.js";

// Hoisted toggle for the mocked audit writer. The factory reads `.value` at call
// time so per-test mutation takes effect.
const audit = vi.hoisted(() => ({ shouldThrow: false }));

vi.mock("../repositories/events/event-crud.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/events/event-crud.js")>();
  return {
    ...actual,
    createEventWithClient: (db: unknown, input: unknown) => {
      if (audit.shouldThrow) throw new Error("injected audit write failure");
      return actual.createEventWithClient(db as never, input as never);
    },
  };
});

// Imported AFTER the mock so the advancer picks up the mocked audit writer.
import {
  advanceGates,
  registerRecoveryHandoffWriter,
  resetRecoveryHandoffWriter,
  type GateTrigger,
} from "../services/workflow/workflowGateAdvancer.js";
import type { GateEvaluationDecision } from "../services/workflow/workflowGateEvaluator.js";

let habitatId: string;
let missionId: string;
let downstreamTaskId: string;

beforeEach(async () => {
  audit.shouldThrow = false;
  resetRecoveryHandoffWriter();
  await initTestDb();
  const db = getDb();
  db.delete(taskEvents).run();
  db.delete(taskWorkflowGates).run();
  db.delete(workflows).run();
  db.delete(tasks).run();
  db.delete(agents).run();
  db.delete(missions).run();
  db.delete(columns).run();
  db.delete(habitats).run();

  const habitat = habitatRepo.createHabitat({ name: "Advancer Failure Habitat" });
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
    title: "Advancer Failure Mission",
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
  downstreamTaskId = downstream.id;

  void upstream.id; // upstream task exists so the gate FK resolves
});

afterEach(() => {
  closeDb();
});

function seedGate(opts: { gateType: "on_complete" | "on_fail"; failureHandlerOverride?: unknown }) {
  const db = getDb();
  const workflowId = `wf-${Math.random().toString(36).slice(2)}`;
  db.insert(workflows)
    .values({
      id: workflowId,
      missionId,
      habitatId,
      status: "active",
      createdBy: "user-1",
      ...(opts.failureHandlerOverride !== undefined
        ? { failureHandler: opts.failureHandlerOverride as never }
        : {}),
    })
    .run();
  const gateId = `gate-${Math.random().toString(36).slice(2)}`;
  db.insert(taskWorkflowGates)
    .values({
      id: gateId,
      workflowId,
      missionId,
      habitatId,
      upstreamTaskId: getDb().select({ id: tasks.id }).from(tasks).limit(1).all()[0]!.id,
      downstreamTaskId,
      gateType: opts.gateType,
      satisfied: false,
      recoveryDepth: 0,
    })
    .run();
  return { workflowId, gateId };
}

function readGate(gateId: string) {
  return getDb().select().from(taskWorkflowGates).where(eq(taskWorkflowGates.id, gateId)).get()!;
}

function countAllAuditRowsForDownstream(): number {
  return getDb().select().from(taskEvents).where(eq(taskEvents.taskId, downstreamTaskId)).all()
    .length;
}

const lifecycleTrigger: GateTrigger = {
  kind: "lifecycle",
  eventId: "evt-fail-d1",
  action: "completed",
  actorType: "system",
  actorId: "test-harness",
};

// D1 atomicity contract: an audit-writer throw inside the per-gate tx MUST roll
// back all three writes (satisfaction UPDATE + audit INSERT + handoff INSERT).
// These tests prove ATOMICITY ONLY — rollback ⇒ gate unsatisfied + zero partial
// audit rows. They do NOT assert source-event redelivery / eventual liveness
// (the source hooks are one-shot; D1 is a fail-closed contract, not a replay).
describe("advanceGates — D1 atomicity (fail-closed per-gate tx)", () => {
  it("audit-writer throw rolls back the satisfaction UPDATE — gate stays unsatisfied, zero partial audit rows", () => {
    const { gateId } = seedGate({ gateType: "on_complete" });
    const gate = readGate(gateId);
    const decisions: GateEvaluationDecision[] = [{ status: "satisfy", gate }];

    audit.shouldThrow = true;
    const results = advanceGates(decisions, lifecycleTrigger);
    audit.shouldThrow = false;

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.status).toBe("write_error");
    expect(r.gateId).toBe(gateId);
    expect(r.triggerKind).toBe("lifecycle");
    expect(r.triggerEventId).toBe("evt-fail-d1");
    expect(r.error).toContain("injected audit write failure");

    // Atomicity: the gate was NOT advanced and no audit row survived.
    expect(readGate(gateId).satisfied).toBe(false);
    expect(countAllAuditRowsForDownstream()).toBe(0);
  });

  it("handoff-write throw (eligible on_fail gate) rolls back satisfaction + audit", () => {
    const { gateId } = seedGate({
      gateType: "on_fail",
      failureHandlerOverride: { recoveryTaskTemplate: { title: "R" } },
    });
    const gate = readGate(gateId);

    registerRecoveryHandoffWriter(() => {
      throw new Error("injected handoff write failure");
    });

    const decisions: GateEvaluationDecision[] = [{ status: "satisfy", gate }];
    const results = advanceGates(decisions, {
      kind: "lifecycle",
      eventId: "evt-fail-d1-handoff",
      action: "failed",
      actorType: "system",
      actorId: "test-harness",
    });

    expect(results[0].status).toBe("write_error");
    expect(results[0].gateId).toBe(gateId);
    expect(results[0].error).toContain("injected handoff write failure");

    // Atomicity: gate stays unsatisfied, no satisfaction audit survived the rollback.
    expect(readGate(gateId).satisfied).toBe(false);
    expect(countAllAuditRowsForDownstream()).toBe(0);
  });
});
