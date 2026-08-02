import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { stableHash, stableStringify } from "@orcy/shared";
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
import {
  advanceGates,
  registerRecoveryHandoffWriter,
  resetRecoveryHandoffWriter,
  resolveEffectiveFailureHandlerWithClient,
  type GateTrigger,
} from "../services/workflow/workflowGateAdvancer.js";
import type { GateEvaluationDecision } from "../services/workflow/workflowGateEvaluator.js";
import type { WorkflowGateRecord } from "../services/workflow/workflowGateStore.js";

let habitatId: string;
let missionId: string;
let upstreamTaskId: string;
let downstreamTaskId: string;

beforeEach(async () => {
  await initTestDb();
  resetRecoveryHandoffWriter();
  const db = getDb();
  db.delete(taskEvents).run();
  db.delete(taskWorkflowGates).run();
  db.delete(workflows).run();
  db.delete(tasks).run();
  db.delete(agents).run();
  db.delete(missions).run();
  db.delete(columns).run();
  db.delete(habitats).run();

  const habitat = habitatRepo.createHabitat({ name: "Advancer Habitat" });
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
    title: "Advancer Mission",
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
  recoveryDepth?: number;
  failureHandlerOverride?: unknown;
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
      upstreamTaskId,
      downstreamTaskId,
      gateType: opts.gateType,
      satisfied: opts.satisfied ?? false,
      recoveryDepth: opts.recoveryDepth ?? 0,
    })
    .run();

  return { workflowId, gateId };
}

/** Read the full gate row (including `satisfiedByEventId`, which the record type omits). */
function readGate(gateId: string) {
  const row = getDb()
    .select()
    .from(taskWorkflowGates)
    .where(eq(taskWorkflowGates.id, gateId))
    .get();
  if (!row) throw new Error(`gate ${gateId} not found`);
  return row as WorkflowGateRecord & {
    satisfiedByEventId: string | null;
    satisfiedAt: string | null;
  };
}

/** Build a `satisfy` decision for a gate record. */
function satisfyDecision(gate: WorkflowGateRecord): GateEvaluationDecision {
  return { status: "satisfy", gate };
}

const lifecycleTrigger: GateTrigger = {
  kind: "lifecycle",
  eventId: "evt-lifecycle-1",
  action: "completed",
  actorType: "system",
  actorId: "test-harness",
};

function readTaskEvents(taskId: string, action: string) {
  return getDb()
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .all()
    .filter((e) => e.action === action);
}

describe("advanceGates — result zip contract", () => {
  it("returns exactly one result per input decision, positionally aligned (skip + satisfy)", () => {
    const { gateId: skipGateId } = seedGate({ gateType: "on_complete", satisfied: true });
    const { gateId: satisfyGateId } = seedGate({ gateType: "on_complete", satisfied: false });
    const skipGate = readGate(skipGateId);
    const satisfyGate = readGate(satisfyGateId);

    const decisions: GateEvaluationDecision[] = [
      { status: "skip", gate: skipGate, reason: "already_satisfied" },
      satisfyDecision(satisfyGate),
    ];

    const results = advanceGates(decisions, lifecycleTrigger);

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("skip");
    expect(results[0].gateId).toBe(skipGateId);
    expect(results[0].skipReason).toBe("already_satisfied");
    expect(results[0].triggerKind).toBe("lifecycle");
    expect(results[0].triggerEventId).toBe("evt-lifecycle-1");
    expect(results[1].status).toBe("satisfied");
    expect(results[1].gateId).toBe(satisfyGateId);
  });
});

describe("advanceGates — module satisfaction contract (migrated from workflowGateStore)", () => {
  it("satisfies an unsatisfied gate: result + gate row + audit committed, satisfiedByEventId stamped", () => {
    const { gateId } = seedGate({ gateType: "on_complete", satisfied: false });
    const gate = readGate(gateId);

    const results = advanceGates([satisfyDecision(gate)], lifecycleTrigger);

    expect(results[0].status).toBe("satisfied");
    expect(results[0].satisfiedAt).toBeTruthy();

    const after = readGate(gateId);
    expect(after.satisfied).toBe(true);
    // Lifecycle stamps the real forwarded causal event id.
    expect(after.satisfiedByEventId).toBe("evt-lifecycle-1");

    const audits = readTaskEvents(downstreamTaskId, "workflow_gate_satisfied");
    expect(audits).toHaveLength(1);
    const meta = audits[0].metadata as Record<string, unknown>;
    expect(meta.gateId).toBe(gateId);
    expect(meta.triggeredBy).toBe("completed");
    expect(meta.gateType).toBe("on_complete");
    expect(meta.audit).toEqual({ source: "workflow" });
  });

  it("a second call after satisfaction returns already_satisfied without re-writing (sequential idempotency)", () => {
    const { gateId } = seedGate({ gateType: "on_complete", satisfied: false });
    const gate = readGate(gateId);

    const first = advanceGates([satisfyDecision(gate)], lifecycleTrigger);
    expect(first[0].status).toBe("satisfied");
    const firstSatisfiedAt = readGate(gateId).satisfiedAt;
    const firstAuditCount = readTaskEvents(downstreamTaskId, "workflow_gate_satisfied").length;

    // Second call with the now-satisfied gate (fresh read — not a stale snapshot).
    const refreshed = readGate(gateId);
    const second = advanceGates([satisfyDecision(refreshed)], lifecycleTrigger);

    expect(second[0].status).toBe("already_satisfied");
    // DB state stable: satisfiedAt unchanged, no extra audit, satisfiedByEventId unchanged.
    const after = readGate(gateId);
    expect(after.satisfiedAt).toBe(firstSatisfiedAt);
    expect(after.satisfiedByEventId).toBe("evt-lifecycle-1");
    expect(readTaskEvents(downstreamTaskId, "workflow_gate_satisfied")).toHaveLength(
      firstAuditCount,
    );
  });

  it("returns already_satisfied when the gate is already satisfied on first call (stale-snapshot protection)", () => {
    const { gateId } = seedGate({ gateType: "on_complete", satisfied: true });
    const gate = readGate(gateId);

    const results = advanceGates([satisfyDecision(gate)], lifecycleTrigger);

    expect(results[0].status).toBe("already_satisfied");
    // No audit, no mutation.
    expect(readTaskEvents(downstreamTaskId, "workflow_gate_satisfied")).toHaveLength(0);
  });

  it("lifecycle/pulse/automation/redemption already_satisfied emit NO audit (the four-kind asymmetry)", () => {
    const { gateId } = seedGate({ gateType: "on_complete", satisfied: true });
    const gate = readGate(gateId);

    for (const trigger of [
      lifecycleTrigger,
      { kind: "pulse", eventId: "pulse-1" },
      { kind: "automation", eventId: "run-1", ruleId: "rule-1" },
      { kind: "recovery_redemption", eventId: "ctx-1", contextId: "ctx-1" },
    ] as GateTrigger[]) {
      advanceGates([satisfyDecision(gate)], trigger);
    }

    expect(readTaskEvents(downstreamTaskId, "workflow_gate_satisfied")).toHaveLength(0);
    expect(readTaskEvents(downstreamTaskId, "workflow_gate_unblocked")).toHaveLength(0);
  });
});

describe("advanceGates — trigger-specific causal stamps and audit metadata", () => {
  it("stamps pulse, automation, and recovery-redemption trigger ids and metadata", () => {
    const pulse = seedGate({ gateType: "on_signal", satisfied: false });
    const automation = seedGate({ gateType: "on_automation", satisfied: false });
    const redemption = seedGate({ gateType: "on_complete", satisfied: false });

    const pulseTrigger: GateTrigger = { kind: "pulse", eventId: "pulse-42" };
    const automationTrigger: GateTrigger = {
      kind: "automation",
      eventId: "run-42",
      ruleId: "rule-42",
    };
    const redemptionTrigger: GateTrigger = {
      kind: "recovery_redemption",
      eventId: "context-42",
      contextId: "context-42",
    };

    const pulseResult = advanceGates(
      [satisfyDecision(readGate(pulse.gateId))],
      pulseTrigger,
    )[0];
    const automationResult = advanceGates(
      [satisfyDecision(readGate(automation.gateId))],
      automationTrigger,
    )[0];
    const redemptionResult = advanceGates(
      [satisfyDecision(readGate(redemption.gateId))],
      redemptionTrigger,
    )[0];

    expect(pulseResult.status).toBe("satisfied");
    expect(pulseResult.triggerEventId).toBe(pulseTrigger.eventId);
    expect(readGate(pulse.gateId).satisfiedByEventId).toBe(pulseTrigger.eventId);
    const pulseAudit = readTaskEvents(downstreamTaskId, "workflow_gate_satisfied").find(
      (event) => (event.metadata as Record<string, unknown>).gateId === pulse.gateId,
    );
    expect(pulseAudit).toBeDefined();
    expect((pulseAudit!.metadata as Record<string, unknown>).pulseId).toBe(pulseTrigger.eventId);

    expect(automationResult.status).toBe("satisfied");
    expect(automationResult.triggerEventId).toBe(automationTrigger.eventId);
    expect(readGate(automation.gateId).satisfiedByEventId).toBe(automationTrigger.eventId);
    const automationAudit = readTaskEvents(downstreamTaskId, "workflow_gate_satisfied").find(
      (event) => (event.metadata as Record<string, unknown>).gateId === automation.gateId,
    );
    expect(automationAudit).toBeDefined();
    const automationMeta = automationAudit!.metadata as Record<string, unknown>;
    expect(automationMeta.runId).toBe(automationTrigger.eventId);
    expect(automationMeta.ruleId).toBe(automationTrigger.ruleId);

    expect(redemptionResult.status).toBe("satisfied");
    expect(redemptionResult.triggerEventId).toBe(redemptionTrigger.eventId);
    expect(readGate(redemption.gateId).satisfiedByEventId).toBe(redemptionTrigger.eventId);
    const redemptionAudit = readTaskEvents(downstreamTaskId, "workflow_gate_satisfied").find(
      (event) => (event.metadata as Record<string, unknown>).gateId === redemption.gateId,
    );
    expect(redemptionAudit).toBeDefined();
    expect((redemptionAudit!.metadata as Record<string, unknown>).contextId).toBe(
      redemptionTrigger.contextId,
    );
  });
});

describe("advanceGates — manual unblock (module SUPPORTS it; WG-7 wires the route)", () => {
  const manualTrigger1: GateTrigger = {
    kind: "manual",
    eventId: "manual-unblock-req-1",
    unblockerId: "admin-1",
  };
  const manualTrigger2: GateTrigger = {
    kind: "manual",
    eventId: "manual-unblock-req-2",
    unblockerId: "admin-1",
  };

  it("satisfies an on_manual gate, emits workflow_gate_unblocked, self-referential satisfiedByEventId", () => {
    const { gateId } = seedGate({ gateType: "on_manual", satisfied: false });
    const gate = readGate(gateId);

    const results = advanceGates([satisfyDecision(gate)], manualTrigger1);

    expect(results[0].status).toBe("satisfied");
    expect(results[0].triggerKind).toBe("manual");
    expect(results[0].triggerEventId).toBe(manualTrigger1.eventId);

    const after = readGate(gateId);
    expect(after.satisfied).toBe(true);

    const audits = readTaskEvents(downstreamTaskId, "workflow_gate_unblocked");
    expect(audits).toHaveLength(1);
    expect(audits[0].id).toBe(manualTrigger1.eventId);
    expect((audits[0].metadata as Record<string, unknown>).unblockedBy).toBe("admin-1");

    // Self-referential: the gate's satisfiedByEventId IS the audit event's own id.
    expect(after.satisfiedByEventId).toBe(audits[0].id);
    expect(after.satisfiedByEventId).toBe(manualTrigger1.eventId);
  });

  it("repeat manual call emits a NEW workflow_gate_unblocked attempt audit, never mutates the gate (CR-13/TG-1)", () => {
    const { gateId } = seedGate({ gateType: "on_manual", satisfied: false });
    const gate = readGate(gateId);

    const first = advanceGates([satisfyDecision(gate)], manualTrigger1);
    expect(first[0].status).toBe("satisfied");
    const firstAfter = readGate(gateId);
    const firstSatisfiedAt = firstAfter.satisfiedAt;
    const firstCausalId = firstAfter.satisfiedByEventId;
    const firstAuditId = readTaskEvents(downstreamTaskId, "workflow_gate_unblocked")[0].id;
    expect(first[0].triggerEventId).toBe(manualTrigger1.eventId);
    expect(firstAuditId).toBe(manualTrigger1.eventId);
    expect(firstCausalId).toBe(manualTrigger1.eventId);
    expect(firstCausalId).toBe(firstAuditId);

    // Second manual call on the now-satisfied gate supplies a distinct
    // preallocated audit id, as the WG-7 adapter does for each attempt.
    const refreshed = readGate(gateId);
    const second = advanceGates([satisfyDecision(refreshed)], manualTrigger2);

    expect(second[0].status).toBe("already_satisfied");
    expect(second[0].triggerEventId).toBe(manualTrigger2.eventId);

    // The gate is NEVER mutated; satisfiedAt + satisfiedByEventId are preserved.
    const after = readGate(gateId);
    expect(after.satisfiedAt).toBe(firstSatisfiedAt);
    expect(after.satisfiedByEventId).toBe(firstCausalId);

    // A SECOND workflow_gate_unblocked audit exists, carrying the alreadySatisfied marker.
    const audits = readTaskEvents(downstreamTaskId, "workflow_gate_unblocked");
    expect(audits).toHaveLength(2);
    const attemptAudit = audits.find((audit) => audit.id === manualTrigger2.eventId);
    expect(attemptAudit).toBeDefined();
    expect(attemptAudit!.id).toBe(manualTrigger2.eventId);
    expect((attemptAudit!.metadata as Record<string, unknown>).alreadySatisfied).toBe(true);
    expect((attemptAudit!.metadata as Record<string, unknown>).unblockedBy).toBe("admin-1");
  });
});

describe("advanceGates — error decision classification", () => {
  it("an evaluator-error decision emits workflow_evaluation_error and returns evaluation_error", () => {
    const { gateId } = seedGate({ gateType: "on_complete", satisfied: false });
    const gate = readGate(gateId);

    const decisions: GateEvaluationDecision[] = [
      { status: "error", gate, error: new Error("malformed predicate") },
    ];

    const results = advanceGates(decisions, lifecycleTrigger);

    expect(results[0].status).toBe("evaluation_error");
    expect(results[0].error).toBe("malformed predicate");
    expect(results[0].gateId).toBe(gateId);

    const audits = readTaskEvents(downstreamTaskId, "workflow_evaluation_error");
    expect(audits).toHaveLength(1);
    const meta = audits[0].metadata as Record<string, unknown>;
    expect(meta.error).toBe("malformed predicate");
    expect(meta.phase).toBe("gate_satisfaction");
  });
});

describe("advanceGates — per-gate isolation (one gate's write_error does not block a later gate)", () => {
  it("a write_error on gate-1 leaves gate-2 satisfiable in the same batch", () => {
    // gate-1 is an eligible on_fail gate; a throwing handoff writer forces its tx to roll back.
    // gate-2 is a plain on_complete gate that must still advance.
    const { gateId: failGateId } = seedGate({
      gateType: "on_fail",
      failureHandlerOverride: { recoveryTaskTemplate: { title: "R" } },
    });
    const { gateId: okGateId } = seedGate({ gateType: "on_complete", satisfied: false });

    // Register a handoff writer that throws ONLY for the on_fail gate.
    registerRecoveryHandoffWriter(({ gate }) => {
      if (gate.id === failGateId) throw new Error("injected handoff failure");
    });

    const decisions: GateEvaluationDecision[] = [
      satisfyDecision(readGate(failGateId)),
      satisfyDecision(readGate(okGateId)),
    ];

    const results = advanceGates(decisions, {
      kind: "lifecycle",
      eventId: "evt-fail-1",
      action: "failed",
      actorType: "system",
      actorId: "test",
    });

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("write_error");
    expect(results[0].gateId).toBe(failGateId);
    expect(results[0].triggerEventId).toBe("evt-fail-1");
    expect(results[1].status).toBe("satisfied");
    expect(results[1].gateId).toBe(okGateId);

    // gate-1 stays unsatisfied (rolled back); gate-2 is satisfied.
    expect(readGate(failGateId).satisfied).toBe(false);
    expect(readGate(okGateId).satisfied).toBe(true);

    // Proves atomicity, NOT liveness: no source-event redelivery is asserted.
    resetRecoveryHandoffWriter();
  });
});

describe("advanceGates — recovery handoff writer contract", () => {
  it("freezes the effective handler for eligible gates and skips ineligible gates", () => {
    const handler = { recoveryTaskTemplate: { title: "Recovery {{failedTaskTitle}}" } };
    const eligible = seedGate({ gateType: "on_fail", failureHandlerOverride: handler });
    const noHandler = seedGate({ gateType: "on_fail", failureHandlerOverride: null });
    const atDepthCap = seedGate({
      gateType: "on_fail",
      failureHandlerOverride: handler,
      recoveryDepth: 2,
    });
    const expectedHandler = resolveEffectiveFailureHandlerWithClient(
      getDb(),
      readGate(eligible.gateId),
    );
    expect(expectedHandler).toEqual(handler);
    const writer = vi.fn();
    registerRecoveryHandoffWriter(writer);

    const trigger: GateTrigger = {
      kind: "lifecycle",
      eventId: "evt-handoff-contract",
      action: "failed",
      actorType: "system",
      actorId: "test",
    };
    const results = advanceGates(
      [
        satisfyDecision(readGate(eligible.gateId)),
        satisfyDecision(readGate(noHandler.gateId)),
        satisfyDecision(readGate(atDepthCap.gateId)),
      ],
      trigger,
    );

    expect(results.map((result) => result.status)).toEqual([
      "satisfied",
      "satisfied",
      "satisfied",
    ]);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledWith(
      expect.objectContaining({
        gate: expect.objectContaining({ id: eligible.gateId }),
        trigger,
        frozenHandler: expectedHandler,
        handlerFingerprint: `handler:${stableHash(stableStringify(expectedHandler))}`,
      }),
    );
  });
});
