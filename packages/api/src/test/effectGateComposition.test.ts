/**
 * Receipt-gate transaction composition (sql.js nested-BEGIN defect).
 *
 * The defect: `deliverWorkflowGates` opens the receipt unit tx (BEGIN
 * IMMEDIATE) and `advanceGates → satisfyOne` opened a SECOND transaction
 * through the global handle. better-sqlite3 nests that via driver
 * SAVEPOINT; sql.js issues a literal nested `BEGIN IMMEDIATE` and throws —
 * every attached-gate receipt died as `write_error`. The existing suites
 * only exercised the zero-gate shape, which returns before `advanceGates`.
 *
 * These tests drive the REAL consumer (`processEffectReceipts` on receipts
 * minted by the real act-txes) with ≥1 attached active `on_fail` gate:
 *
 *   1. sql.js discriminator — `failed` (failure-pointer fence) and
 *      `released` (pending ∧ token-NULL ∧ pointer fence) receipts deliver
 *      gates atomically (satisfaction + audit + handoff).
 *   2. better-sqlite3 file-backed parity — the same two shapes on the
 *      production driver.
 *   3. Rollback completeness — a throw after the satisfaction UPDATE rolls
 *      back that gate's whole savepoint (no audit, no handoff); under the
 *      composed unit earlier independent gates stay committed, the outer
 *      consumer detects `write_error`, and the re-drive delivers cleanly.
 *   4. Pointer-fence zero-op — a stale failure pointer / a successor claim
 *      after release prohibits every gate write (superseded).
 *   5. Live-path isolation pin — `advanceGates` WITHOUT a client keeps the
 *      per-gate transaction isolation (one gate's write_error never undoes
 *      an already-committed independent gate).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, initDb, initTestDb } from "../db/index.js";
import {
  tasks,
  taskEvents,
  taskWorkflowGates,
  taskRecoveryHandoffs,
  workflows,
  effectReceipts,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import { failTask } from "../services/tasks/task-lifecycle.js";
import { releaseTaskWithEffects } from "../services/effects/releaseEffects.js";
import { processEffectReceipts } from "../services/effects/effectDeliverer.js";
import {
  advanceGates,
  registerRecoveryHandoffWriter,
  type GateTrigger,
} from "../services/workflow/workflowGateAdvancer.js";
import type { WorkflowGateRecord } from "../services/workflow/workflowGateStore.js";

const FAILURE_HANDLER = { recoveryTaskTemplate: { title: "R" } } as const;

let habitatId: string;
let columnId: string;
let missionId: string;
let upstreamTaskId: string;
let downstreamTaskId: string;

/** Minimal world: habitat → column → mission → upstream+downstream tasks. */
function seedWorld() {
  const habitat = habitatRepo.createHabitat({ name: "Gate Composition Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: "Gate Composition Mission",
    createdBy: "user-1",
  });
  missionId = mission.id;
  const upstream = taskRepo.createTask({ missionId, title: "Upstream", createdBy: "user-1" });
  const downstream = taskRepo.createTask({ missionId, title: "Downstream", createdBy: "user-1" });
  upstreamTaskId = upstream.id;
  downstreamTaskId = downstream.id;
}

/** Seeds an agent, then claims+starts the upstream task (real mint path). */
function seedStartedUpstream() {
  const { agent } = agentRepo.createAgent({
    name: "gate-composition-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  const claimed = taskStateMachine.claimTask(upstreamTaskId, agent.id);
  if (!claimed.success) throw new Error("seed claim failed");
  const started = taskStateMachine.startTask(upstreamTaskId, agent.id);
  if (!started) throw new Error("seed start failed");
  return { agent, started };
}

/**
 * Attaches an active workflow with `n` unsatisfied `on_fail` gates from the
 * upstream (failing/releasing) task to the downstream task. Gates evaluate
 * `satisfy` (condition null) for both `failed` and `released` triggers.
 */
function seedOnFailGates(n: number, handler: object | null = FAILURE_HANDLER) {
  const db = getDb();
  const workflowId = `wf-gc-${Math.random().toString(36).slice(2)}`;
  db.insert(workflows)
    .values({
      id: workflowId,
      missionId,
      habitatId,
      status: "active",
      createdBy: "user-1",
      ...(handler !== null ? { failureHandler: handler as never } : {}),
    })
    .run();
  const gateIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const gateId = `gate-gc-${Math.random().toString(36).slice(2)}`;
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
    gateIds.push(gateId);
  }
  return { workflowId, gateIds };
}

function readGate(gateId: string) {
  const row = getDb()
    .select()
    .from(taskWorkflowGates)
    .where(eq(taskWorkflowGates.id, gateId))
    .get();
  if (!row) throw new Error(`gate ${gateId} not found`);
  return row;
}

function gatesReceiptFor(eventId: string) {
  return getDb()
    .select()
    .from(effectReceipts)
    .where(
      and(eq(effectReceipts.subjectId, eventId), eq(effectReceipts.consumer, "workflow_gates")),
    )
    .all();
}

function satisfiedAuditRows(gateId: string) {
  return getDb()
    .select()
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, downstreamTaskId),
        eq(taskEvents.action, "workflow_gate_satisfied"),
      ),
    )
    .all()
    .filter((e) => (e.metadata as Record<string, unknown>).gateId === gateId);
}

function handoffRows(gateId: string) {
  return getDb()
    .select()
    .from(taskRecoveryHandoffs)
    .where(eq(taskRecoveryHandoffs.gateId, gateId))
    .all();
}

function eventRow(taskId: string, action: "failed" | "released") {
  return getDb()
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.action, action)))
    .all();
}

/**
 * The production handoff insert, registered fresh in every composition
 * `beforeEach` so the injectable-writer module state can never leak between
 * describes (individual tests override it with failure shapes).
 */
function registerRealHandoffWriter(): void {
  registerRecoveryHandoffWriter(({ tx, gate, trigger, frozenHandler, handlerFingerprint }) => {
    tx.insert(taskRecoveryHandoffs)
      .values({
        id: crypto.randomUUID(),
        gateId: gate.id,
        workflowId: gate.workflowId,
        habitatId: gate.habitatId,
        missionId: gate.missionId,
        downstreamTaskId: gate.downstreamTaskId,
        recoveryDepth: gate.recoveryDepth,
        triggerEventId: trigger.eventId,
        frozenHandlerConfig: JSON.stringify(frozenHandler),
        handlerFingerprint,
        status: "expected",
        blockedReason: null,
        consumedAt: null,
      })
      .run();
  });
}

/** Asserts the full atomic delivery slice for one gate + its receipt event. */
function expectGateDelivered(gateId: string, eventId: string, receiptId: string) {
  const gate = readGate(gateId);
  expect(gate.satisfied).toBe(true);
  expect(gate.satisfiedByEventId).toBe(eventId);
  expect(gate.satisfiedAt).not.toBeNull();
  expect(satisfiedAuditRows(gateId)).toHaveLength(1);
  expect(handoffRows(gateId)).toHaveLength(1);
  const receipt = getDb()
    .select()
    .from(effectReceipts)
    .where(eq(effectReceipts.id, receiptId))
    .get()!;
  expect(receipt.state).toBe("delivered");
}

// ─── 1. sql.js discriminator — real consumer, attached gates ─────────────────

describe("receipt gate composition — sql.js (test driver)", () => {
  beforeEach(async () => {
    await initTestDb();
    seedWorld();
    registerRealHandoffWriter();
  });
  afterEach(() => closeDb());

  it("failed receipt with an attached on_fail gate delivers atomically", async () => {
    const { agent } = seedStartedUpstream();
    const { gateIds } = seedOnFailGates(1);

    const failed = failTask(upstreamTaskId, agent.id, "agent", "boom");
    expect(failed).not.toBeNull();
    const [ev] = eventRow(upstreamTaskId, "failed");
    const receipt = gatesReceiptFor(ev!.id)[0]!;

    await processEffectReceipts();
    expectGateDelivered(gateIds[0]!, ev!.id, receipt.id);
  });

  it("released receipt with an attached on_fail gate delivers atomically (release fence)", async () => {
    const { agent, started } = seedStartedUpstream();
    const { gateIds } = seedOnFailGates(1);

    const released = releaseTaskWithEffects({
      taskId: upstreamTaskId,
      actorId: "daemon-recovery",
      reason: "daemon_session_failed",
      preImage: started,
    });
    expect(released).not.toBeNull();
    const [ev] = eventRow(upstreamTaskId, "released");
    const receipt = gatesReceiptFor(ev!.id)[0]!;

    await processEffectReceipts();
    expectGateDelivered(gateIds[0]!, ev!.id, receipt.id);
    // The release fence shape itself: pending, token NULL, pointer = event.
    const row = getDb().select().from(tasks).where(eq(tasks.id, upstreamTaskId)).get()!;
    expect(row.status).toBe("pending");
    expect(row.executionToken).toBeNull();
    expect(row.lastReleaseEventId).toBe(ev!.id);
    void agent;
  });

  it("late write_error (throw after the satisfaction UPDATE) rolls back the whole gate savepoint; re-drive delivers", async () => {
    const { agent } = seedStartedUpstream();
    const { gateIds } = seedOnFailGates(1);
    const gateId = gateIds[0]!;

    registerRecoveryHandoffWriter(() => {
      // Throws AFTER the satisfaction UPDATE and audit INSERT inside
      // satisfyOne — the per-gate savepoint must roll all three back.
      throw new Error("simulated late handoff write failure");
    });

    const failed = failTask(upstreamTaskId, agent.id, "agent", "boom");
    expect(failed).not.toBeNull();
    const [ev] = eventRow(upstreamTaskId, "failed");
    const receipt = gatesReceiptFor(ev!.id)[0]!;

    await processEffectReceipts();

    // Gate rolled back entirely: not satisfied, no audit, no handoff.
    const gate = readGate(gateId);
    expect(gate.satisfied).toBe(false);
    expect(gate.satisfiedByEventId).toBeNull();
    expect(satisfiedAuditRows(gateId)).toHaveLength(0);
    expect(handoffRows(gateId)).toHaveLength(0);
    // The outer consumer detected write_error: receipt failed fenced
    // (attempt recorded, never delivered) — NOT silently delivered.
    const afterFirst = getDb()
      .select()
      .from(effectReceipts)
      .where(eq(effectReceipts.id, receipt.id))
      .get()!;
    expect(afterFirst.state).not.toBe("delivered");
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.lastErrorCode).toBe("write_error");

    // Re-drive with the real writer: clean recovery, gate delivered.
    registerRealHandoffWriter();
    await processEffectReceipts();
    expectGateDelivered(gateId, ev!.id, receipt.id);
  });

  it("multi-gate composition: a LATER gate's write_error keeps the EARLIER gate committed; retry completes the unit", async () => {
    const { agent } = seedStartedUpstream();
    const { gateIds } = seedOnFailGates(2);
    const [gate1, gate2] = gateIds as [string, string];

    // Real handoff insert for gate 1; throw for gate 2 (late write error).
    registerRecoveryHandoffWriter(({ tx, gate, trigger, frozenHandler, handlerFingerprint }) => {
      if (gate.id === gate2) throw new Error("simulated gate-2 handoff failure");
      tx.insert(taskRecoveryHandoffs)
        .values({
          id: crypto.randomUUID(),
          gateId: gate.id,
          workflowId: gate.workflowId,
          habitatId: gate.habitatId,
          missionId: gate.missionId,
          downstreamTaskId: gate.downstreamTaskId,
          recoveryDepth: gate.recoveryDepth,
          triggerEventId: trigger.eventId,
          frozenHandlerConfig: JSON.stringify(frozenHandler),
          handlerFingerprint,
          status: "expected",
          blockedReason: null,
          consumedAt: null,
        })
        .run();
    });

    const failed = failTask(upstreamTaskId, agent.id, "agent", "boom");
    expect(failed).not.toBeNull();
    const [ev] = eventRow(upstreamTaskId, "failed");
    const receipt = gatesReceiptFor(ev!.id)[0]!;

    await processEffectReceipts();

    // Gate 1 committed (its savepoint released inside the unit); gate 2
    // rolled back; the outer consumer saw write_error.
    expect(readGate(gate1).satisfied).toBe(true);
    expect(satisfiedAuditRows(gate1)).toHaveLength(1);
    expect(handoffRows(gate1)).toHaveLength(1);
    expect(readGate(gate2).satisfied).toBe(false);
    expect(satisfiedAuditRows(gate2)).toHaveLength(0);
    const afterFirst = getDb()
      .select()
      .from(effectReceipts)
      .where(eq(effectReceipts.id, receipt.id))
      .get()!;
    expect(afterFirst.state).not.toBe("delivered");
    expect(afterFirst.lastErrorCode).toBe("write_error");

    // Retry with a clean writer: gate 1 already_satisfied (no double
    // audit), gate 2 satisfied — receipt delivered.
    registerRealHandoffWriter();
    await processEffectReceipts();
    expect(readGate(gate2).satisfied).toBe(true);
    expect(satisfiedAuditRows(gate2)).toHaveLength(1);
    expect(satisfiedAuditRows(gate1)).toHaveLength(1); // exactly one audit, ever
    expect(handoffRows(gate2)).toHaveLength(1);
    const afterRetry = getDb()
      .select()
      .from(effectReceipts)
      .where(eq(effectReceipts.id, receipt.id))
      .get()!;
    expect(afterRetry.state).toBe("delivered");
    expect(afterRetry.attempts).toBe(2);
  });

  it("stale failure pointer → zero gate writes, superseded ack", async () => {
    const { agent } = seedStartedUpstream();
    const { gateIds } = seedOnFailGates(1);
    const gateId = gateIds[0]!;

    const failed = failTask(upstreamTaskId, agent.id, "agent", "boom");
    expect(failed).not.toBeNull();
    const [ev] = eventRow(upstreamTaskId, "failed");
    const receipt = gatesReceiptFor(ev!.id)[0]!;

    // A successor epoch moved the failure pointer: this event no longer owns it.
    getDb()
      .update(tasks)
      .set({ lastFailureEventId: "a-newer-failure-event" })
      .where(eq(tasks.id, upstreamTaskId))
      .run();

    await processEffectReceipts();

    expect(readGate(gateId).satisfied).toBe(false);
    expect(satisfiedAuditRows(gateId)).toHaveLength(0);
    expect(handoffRows(gateId)).toHaveLength(0);
    const after = getDb()
      .select()
      .from(effectReceipts)
      .where(eq(effectReceipts.id, receipt.id))
      .get()!;
    expect(after.state).toBe("delivered"); // superseded acks delivered
  });

  it("successor claim after release → release fence broken, zero gate writes, superseded ack", async () => {
    const { started } = seedStartedUpstream();
    const { gateIds } = seedOnFailGates(1);
    const gateId = gateIds[0]!;

    const released = releaseTaskWithEffects({
      taskId: upstreamTaskId,
      actorId: "daemon-recovery",
      reason: "daemon_session_failed",
      preImage: started,
    });
    expect(released).not.toBeNull();
    const [ev] = eventRow(upstreamTaskId, "released");
    const receipt = gatesReceiptFor(ev!.id)[0]!;

    // Successor claim mints a token → pending ∧ token-NULL fence is broken.
    const successor = agentRepo.createAgent({
      name: "successor-agent",
      type: "claude-code",
      domain: "fullstack",
      capabilities: [],
    });
    const claimed = taskStateMachine.claimTask(upstreamTaskId, successor.agent.id);
    expect(claimed.success).toBe(true);

    await processEffectReceipts();

    expect(readGate(gateId).satisfied).toBe(false);
    expect(satisfiedAuditRows(gateId)).toHaveLength(0);
    const after = getDb()
      .select()
      .from(effectReceipts)
      .where(eq(effectReceipts.id, receipt.id))
      .get()!;
    expect(after.state).toBe("delivered"); // superseded acks delivered
  });
});

// ─── 5. Live-path isolation pin — advanceGates WITHOUT a client ──────────────

describe("advanceGates live path — per-gate isolation preserved (no client)", () => {
  beforeEach(async () => {
    await initTestDb();
    seedWorld();
  });
  afterEach(() => closeDb());

  it("gate 2 write_error leaves gate 1 committed (own per-gate tx, DEFERRED live mode)", () => {
    const { gateIds } = seedOnFailGates(2);
    const [gate1, gate2] = gateIds as [string, string];

    registerRecoveryHandoffWriter(({ gate }) => {
      if (gate.id === gate2) throw new Error("simulated gate-2 handoff failure");
    });

    const db = getDb();
    const decisions = [gate1, gate2].map((id) => {
      const gate = db
        .select()
        .from(taskWorkflowGates)
        .where(eq(taskWorkflowGates.id, id))
        .get() as WorkflowGateRecord;
      return { status: "satisfy" as const, gate };
    });
    const trigger: GateTrigger = {
      kind: "lifecycle",
      eventId: "evt-live-1",
      action: "failed",
      actorType: "agent",
      actorId: "test-harness",
    };

    const results = advanceGates(decisions, trigger);

    expect(results[0]!.status).toBe("satisfied");
    expect(results[1]!.status).toBe("write_error");
    expect(readGate(gate1).satisfied).toBe(true); // committed in ITS OWN tx
    expect(satisfiedAuditRows(gate1)).toHaveLength(1);
    expect(readGate(gate2).satisfied).toBe(false);
    expect(satisfiedAuditRows(gate2)).toHaveLength(0);
  });
});

// ─── 2. better-sqlite3 file-backed parity (production driver) ────────────────

describe("receipt gate composition — better-sqlite3 file-backed parity", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gate-composition-"));
    await initDb(join(dir, "orcy.db"));
    seedWorld();
    registerRealHandoffWriter();
  });
  afterEach(async () => {
    closeDb();
    await rm(dir, { recursive: true, force: true });
  });

  it("failed receipt with an attached on_fail gate delivers atomically", async () => {
    const { agent } = seedStartedUpstream();
    const { gateIds } = seedOnFailGates(1);

    const failed = failTask(upstreamTaskId, agent.id, "agent", "boom");
    expect(failed).not.toBeNull();
    const [ev] = eventRow(upstreamTaskId, "failed");
    const receipt = gatesReceiptFor(ev!.id)[0]!;

    await processEffectReceipts();
    expectGateDelivered(gateIds[0]!, ev!.id, receipt.id);
  });

  it("released receipt with an attached on_fail gate delivers atomically (release fence)", async () => {
    const { started } = seedStartedUpstream();
    const { gateIds } = seedOnFailGates(1);

    const released = releaseTaskWithEffects({
      taskId: upstreamTaskId,
      actorId: "daemon-recovery",
      reason: "daemon_session_failed",
      preImage: started,
    });
    expect(released).not.toBeNull();
    const [ev] = eventRow(upstreamTaskId, "released");
    const receipt = gatesReceiptFor(ev!.id)[0]!;

    await processEffectReceipts();
    expectGateDelivered(gateIds[0]!, ev!.id, receipt.id);
  });
});
