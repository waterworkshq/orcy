import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  agents,
  columns,
  habitats,
  missions,
  notificationEvents,
  taskCreationAttempts,
  taskEvents,
  taskRecoveryHandoffs,
  tasks,
  taskWorkflowGates,
  workflows,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskCrudRepo from "../repositories/taskCrud.js";
import {
  advanceGates,
  type GateTrigger,
} from "../services/workflow/workflowGateAdvancer.js";
import type { GateEvaluationDecision } from "../services/workflow/workflowGateEvaluator.js";
import type { WorkflowGateRecord } from "../services/workflow/workflowGateStore.js";

const publication = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock("../services/taskRecoveryPublication.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/taskRecoveryPublication.js")>();
  return { ...actual, publishRecoveryTask: publication.fn };
});

import { runRecoveryReconciliationPass } from "../services/workflow/recoveryCoordinator.js";

let habitatId: string;
let missionId: string;
let upstreamTaskId: string;
let downstreamTaskId: string;

const frozenHandler = {
  recoveryTaskTemplate: {
    title: "Frozen recovery for {{failedTaskTitle}}",
    description: "{{failureReason}}",
  },
  agentSelector: { requiredDomain: "ops", requiredCapabilities: ["debug"] },
};

beforeEach(async () => {
  publication.fn.mockReset();
  publication.fn.mockReturnValue({
    outcome: "created",
    attemptId: "attempt-created-by-publisher",
    publication: { task: { id: "recovery-task-1" } },
    recovering: true,
    recoveringState: "published_pending_observation",
  });

  await initTestDb();
  const db = getDb();
  db.delete(taskRecoveryHandoffs).run();
  db.delete(taskCreationAttempts).run();
  db.delete(taskEvents).run();
  db.delete(notificationEvents).run();
  db.delete(taskWorkflowGates).run();
  db.delete(workflows).run();
  db.delete(tasks).run();
  db.delete(agents).run();
  db.delete(missions).run();
  db.delete(columns).run();
  db.delete(habitats).run();

  const habitat = habitatRepo.createHabitat({ name: "Coordinator Habitat" });
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
    title: "Coordinator Mission",
    createdBy: "test",
  });
  missionId = mission.id;
  upstreamTaskId = taskCrudRepo.createTask({ missionId, title: "Upstream", createdBy: "test" }).id;
  downstreamTaskId = taskCrudRepo.createTask({
    missionId,
    title: "Downstream",
    createdBy: "test",
  }).id;
});

afterEach(() => {
  closeDb();
});

function seedHandoff(id: string): string {
  const db = getDb();
  const workflowId = `workflow-${id}`;
  const gateId = `gate-${id}`;
  db.insert(workflows)
    .values({
      id: workflowId,
      missionId,
      habitatId,
      status: "active",
      createdBy: "test",
      failureHandler: { recoveryTaskTemplate: { title: "Live handler" } },
    })
    .run();
  db.insert(taskWorkflowGates)
    .values({
      id: gateId,
      workflowId,
      missionId,
      habitatId,
      upstreamTaskId,
      downstreamTaskId,
      gateType: "on_fail",
      satisfied: true,
      recoveryDepth: 0,
    })
    .run();
  db.insert(taskRecoveryHandoffs)
    .values({
      id,
      gateId,
      workflowId,
      habitatId,
      missionId,
      downstreamTaskId,
      recoveryDepth: 0,
      triggerEventId: `event-${id}`,
      frozenHandlerConfig: JSON.stringify(frozenHandler),
      handlerFingerprint: `handler:${id}`,
      status: "expected",
    })
    .run();
  return gateId;
}

function seedUnsatisfiedGate(id: string): string {
  const db = getDb();
  const workflowId = `workflow-${id}`;
  const gateId = `gate-${id}`;
  db.insert(workflows)
    .values({
      id: workflowId,
      missionId,
      habitatId,
      status: "active",
      createdBy: "test",
      failureHandler: frozenHandler,
    })
    .run();
  db.insert(taskWorkflowGates)
    .values({
      id: gateId,
      workflowId,
      missionId,
      habitatId,
      upstreamTaskId,
      downstreamTaskId,
      gateType: "on_fail",
      satisfied: false,
      recoveryDepth: 0,
    })
    .run();
  return gateId;
}

function readGate(gateId: string): WorkflowGateRecord {
  const gate = getDb()
    .select()
    .from(taskWorkflowGates)
    .where(eq(taskWorkflowGates.id, gateId))
    .get();
  if (!gate) throw new Error(`gate ${gateId} not found`);
  return gate as WorkflowGateRecord;
}

function seedAttempt(gateId: string, state: string, terminalResult?: unknown): void {
  getDb()
    .insert(taskCreationAttempts)
    .values({
      id: `attempt-${gateId}`,
      source: "workflow",
      sourceScopeKind: "recovery_run",
      sourceScopeId: gateId,
      attemptKey: "spawn_recovery",
      requestFingerprint: `recovery:${gateId}`,
      publicationKind: "create",
      actorType: "system",
      actorId: "workflow-recovery",
      habitatId,
      state: state as never,
      terminalOutcome:
        typeof terminalResult === "object" && terminalResult !== null && "outcome" in terminalResult
          ? String((terminalResult as { outcome: unknown }).outcome)
          : null,
      terminalResult: terminalResult as never,
      reservedAt: new Date().toISOString(),
    })
    .run();
}

function readHandoff(id: string) {
  return getDb().select().from(taskRecoveryHandoffs).where(eq(taskRecoveryHandoffs.id, id)).get()!;
}

function readHandoffForGate(gateId: string) {
  return getDb()
    .select()
    .from(taskRecoveryHandoffs)
    .where(eq(taskRecoveryHandoffs.gateId, gateId))
    .get()!;
}

describe("runRecoveryReconciliationPass", () => {
  it("fresh coordinator replays a committed advancement exactly once and uses frozen config", () => {
    const gateId = seedUnsatisfiedGate("fresh");
    const decisions: GateEvaluationDecision[] = [{ status: "satisfy", gate: readGate(gateId) }];
    const trigger: GateTrigger = {
      kind: "lifecycle",
      eventId: "event-fresh",
      action: "failed",
      actorType: "system",
      actorId: "test-harness",
    };

    // Deliberately omit the coordinator: the WG-3 advancement transaction
    // must commit both its audit and durable handoff before the simulated
    // process death.
    const advancement = advanceGates(decisions, trigger);
    expect(advancement[0]?.status).toBe("satisfied");
    expect(
      getDb()
        .select()
        .from(taskEvents)
        .all()
        .some((event) => event.action === "workflow_gate_satisfied"),
    ).toBe(true);
    expect(readHandoffForGate(gateId)).toMatchObject({
      gateId,
      status: "expected",
      triggerEventId: "event-fresh",
    });

    // Drift the live workflow after the advancement commit. The fresh pass
    // must use the immutable handler payload stored on the handoff.
    getDb()
      .update(workflows)
      .set({ failureHandler: { recoveryTaskTemplate: { title: "Live drift" } } })
      .where(eq(workflows.id, `workflow-fresh`))
      .run();

    publication.fn.mockImplementation((input: { runId: string }) => {
      const recoveryTaskId = `recovery-${input.runId}`;
      seedAttempt(input.runId, "published_pending_observation");
      getDb()
        .update(taskWorkflowGates)
        .set({ recoveryTaskId })
        .where(eq(taskWorkflowGates.id, input.runId))
        .run();
      return {
        outcome: "created",
        attemptId: `attempt-${input.runId}`,
        publication: { task: { id: recoveryTaskId } },
        recovering: true,
        recoveringState: "published_pending_observation",
      };
    });

    // Fresh coordinator after the simulated death: exactly one publication.
    const firstPass = runRecoveryReconciliationPass();
    expect(firstPass).toMatchObject({ scanned: 1, spawned: 1, consumed: 0, blocked: 0 });
    expect(publication.fn).toHaveBeenCalledTimes(1);
    expect(publication.fn.mock.calls[0]?.[0]).toMatchObject({
      runId: gateId,
      actionKey: "spawn_recovery",
      title: "Frozen recovery for Upstream",
      targetMissionId: missionId,
      linkage: { gateId, downstreamTaskId, recoveryDepth: 0 },
    });
    expect(readHandoffForGate(gateId).status).toBe("expected");

    const notificationsAfterFirstPass = getDb()
      .select()
      .from(notificationEvents)
      .all()
      .filter((event) => event.eventType === "workflow.recovery_started");
    expect(notificationsAfterFirstPass).toHaveLength(1);

    // A second fresh pass sees the durable attempt checkpoint and must not
    // re-publish or duplicate the started notification.
    const secondPass = runRecoveryReconciliationPass();
    expect(secondPass).toMatchObject({ scanned: 1, spawned: 0, resumed: 1 });
    expect(publication.fn).toHaveBeenCalledTimes(1);
    expect(
      getDb()
        .select()
        .from(notificationEvents)
        .all()
        .filter((event) => event.eventType === "workflow.recovery_started"),
    ).toHaveLength(1);
  });

  it("retries pending attempts under the same key", () => {
    const pendingGate = seedHandoff("pending");
    seedAttempt(pendingGate, "pending");
    publication.fn.mockReturnValue({
      outcome: "guard_mismatch",
      attemptId: `attempt-${pendingGate}`,
      reasons: [{ kind: "task_changed" }],
    });

    const summary = runRecoveryReconciliationPass();

    expect(summary).toMatchObject({ scanned: 1, resumed: 1, spawned: 0 });
    expect(publication.fn).toHaveBeenCalledTimes(1);
    expect(publication.fn.mock.calls[0]?.[0]).toMatchObject({
      runId: pendingGate,
      actionKey: "spawn_recovery",
    });
    expect(readHandoff("pending").status).toBe("expected");
  });

  it("leaves published recovery checkpoints for their existing workers", () => {
    const observedGate = seedHandoff("published-observed");
    const assignedGate = seedHandoff("published-assigned");
    seedAttempt(observedGate, "published_pending_observation");
    seedAttempt(assignedGate, "published_pending_assignment");

    const summary = runRecoveryReconciliationPass();

    expect(summary).toMatchObject({ scanned: 2, resumed: 2, spawned: 0 });
    expect(publication.fn).not.toHaveBeenCalled();
    expect(readHandoff("published-observed").status).toBe("expected");
    expect(readHandoff("published-assigned").status).toBe("expected");
  });

  it("is a no-op when no durable handoff exists", () => {
    const summary = runRecoveryReconciliationPass();

    expect(summary).toEqual({ scanned: 0, spawned: 0, resumed: 0, consumed: 0, blocked: 0 });
    expect(publication.fn).not.toHaveBeenCalled();
  });

  it("consumes terminal success and blocks terminal refusal with an audit", () => {
    const createdGate = seedHandoff("created");
    const vetoedGate = seedHandoff("vetoed");
    seedAttempt(createdGate, "created", { outcome: "created", taskId: "recovery-1" });
    seedAttempt(vetoedGate, "vetoed", {
      outcome: "vetoed",
      veto: { reason: "policy refusal" },
    });

    const summary = runRecoveryReconciliationPass();

    expect(summary).toMatchObject({ scanned: 2, consumed: 1, blocked: 1 });
    expect(readHandoff("created")).toMatchObject({ status: "consumed" });
    expect(readHandoff("vetoed")).toMatchObject({
      status: "blocked",
      blockedReason: "policy refusal",
    });
    expect(
      getDb()
        .select()
        .from(taskEvents)
        .all()
        .some((event) => event.action === "workflow_evaluation_error"),
    ).toBe(true);
  });
});
