/**
 * REC-06 (automation-release batch) — the automation `release_assignment`
 * action's canonical-release restoration discriminators (adjudicated
 * mechanism: O-B′ first-checkpoint intent pin + O-C atomic release/proof
 * bundle on the frozen path; evaluated-preImage fence on the live path).
 *
 * Written RED-first against HEAD (d0e28aa): every `it` here fails on at
 * least one assertion against the current unfenced, event-less repo
 * release. The pin JSON contract asserted throughout is
 * `{"v":1,"taskId","assignedAgentId","executionToken"}` stored in
 * `automation_delivery_action_checkpoints.idempotency_key`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { closeDb, initTestDb, getDb } from "../db/index.js";
import {
  tasks,
  taskEvents,
  effectReceipts,
  habitats,
  automationDeliveryActionCheckpoints,
} from "../db/schema/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as revisionRepo from "../repositories/automationRuleRevision.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as deliveryRepo from "../repositories/automationRuleDelivery.js";
import { createEvent } from "../repositories/events/event-crud.js";
import { admitReleaseShippedEventToInbox } from "../services/automationInboxService.js";
import { countMeteredTransitions } from "../services/tasks/transitionBudget.js";
import { executeActions } from "../services/automationExecutor.js";
import { executeFrozenReleaseAssignment } from "../services/automationReleaseAssignment.js";
import { releaseTaskWithEffects } from "../services/effects/releaseEffects.js";
import { attemptRuleRun } from "../services/automationAttemptLifecycle.js";
import type { AutomationEvaluationContext } from "../services/automationContextBuilder.js";
import type { AutomationRule, AutomationRuleRun, Task } from "@orcy/shared";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:10:00.000Z"; // T0 + 10min — every short lease is expired

const RELEASE_ACTOR_ID = "automation-executor";
const RELEASE_REASON = "automation_rule_action";

function pinJson(pin: {
  taskId: string;
  assignedAgentId: string | null | undefined;
  executionToken: string | null | undefined;
}): string {
  return JSON.stringify({
    v: 1,
    taskId: pin.taskId,
    assignedAgentId: pin.assignedAgentId ?? null,
    executionToken: pin.executionToken ?? null,
  });
}

function setupHabitat() {
  const h = boardRepo.createHabitat({ name: "Automation Release Habitat" });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  return h;
}

function setupAgent(name: string) {
  return agentRepo.createAgent({ name, type: "claude-code", domain: "backend" }).agent;
}

function setupMission(habitatId: string) {
  return missionRepo.createMission({ habitatId, title: "M", createdBy: "user-1" });
}

function createReleaseRule(habitatId: string) {
  return ruleRepo.createAutomationRule({
    habitatId,
    name: "Release Rule",
    priority: 0,
    trigger: { type: "event", eventType: "release.shipped" } as never,
    condition: { type: "always" } as never,
    actions: [{ type: "release_assignment" }] as never,
    cooldownSeconds: 0,
    maxRunsPerHour: 100,
    enabled: true,
    createdBy: "test",
  });
}

function buildRun(habitatId: string, ruleId: string, targetId: string): AutomationRuleRun {
  return {
    id: "run-release-1",
    ruleId,
    habitatId,
    triggerType: "release.shipped",
    triggerEventId: null,
    targetType: "task",
    targetId,
    fingerprint: `${habitatatIdFingerprint(habitatId, ruleId, targetId)}`,
    status: "running",
    skipReason: null,
    conditionResult: null,
    actionResults: null,
    metadata: null,
    startedAt: T0,
    finishedAt: null,
  };
}

function habitatatIdFingerprint(habitatId: string, ruleId: string, targetId: string) {
  return `${habitatId}:${ruleId}:release.shipped:::task:${targetId}`;
}

function ctxFor(task: Task | null, habitatId: string | null): AutomationEvaluationContext {
  return {
    habitat: habitatId ? ({ id: habitatId, name: "h" } as never) : null,
    task,
    mission: null,
    agent: null,
    sprint: null,
    warnings: [],
    missingFields: [],
    raw: {},
  };
}

function taskRow(taskId: string) {
  return getDb()
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get() as typeof tasks.$inferSelect;
}

function releasedEvents(taskId: string) {
  return getDb()
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.action, "released")))
    .all();
}

function receiptsForEvent(eventId: string) {
  return getDb().select().from(effectReceipts).where(eq(effectReceipts.subjectId, eventId)).all();
}

function checkpointFor(deliveryId: string) {
  return getDb()
    .select()
    .from(automationDeliveryActionCheckpoints)
    .where(eq(automationDeliveryActionCheckpoints.deliveryId, deliveryId))
    .all()[0] as
    | {
        id: string;
        idempotencyKey: string | null;
        state: string;
        receipt: Record<string, unknown> | null;
      }
    | undefined;
}

/** Claimed task row (with the minted execution token) for ctx building. */
function claimedTask(taskId: string, agentId: string): Task {
  const r = taskRepo.claimTask(taskId, agentId);
  if (!r.success) throw new Error(`claim failed: ${r.reason}`);
  return taskRepo.getTaskById(taskId)!;
}

function makeClaimedTask(habitatId: string, agentName = "agent-a") {
  const agent = setupAgent(agentName);
  const mission = setupMission(habitatId);
  const created = taskRepo.createTask({ missionId: mission.id, title: "T", createdBy: "user-1" });
  return { agent, mission, task: claimedTask(created.id, agent.id) };
}

/** Lease the (only) delivery of a freshly admitted release.shipped event. */
function leaseFirstDelivery(habitatId: string, eventId: string, now = T0, ttlMs = 60_000) {
  admitReleaseShippedEventToInbox({ habitatId, eventId, payload: { eventId }, now });
  const inbox = deliveryRepo.listInboxEntriesForHabitat(habitatId)[0]!;
  const deliveryId = deliveryRepo.listDeliveriesForInbox(inbox.id)[0]!.id;
  const lease = deliveryRepo.leaseDelivery({ deliveryId, leaseOwner: "worker-1", now, ttlMs });
  if (!lease.acquired) throw new Error("test setup: lease not acquired");
  return { inboxId: inbox.id, deliveryId, fence: lease.fence, delivery: lease.delivery };
}

/** Direct frozen attempt with a task-targeted trigger (the lifecycle seam). */
async function attemptFrozenDelivery(args: {
  habitatId: string;
  rule: AutomationRule;
  deliveryId: string;
  fence: string;
  inboxId: string;
  taskId: string;
  now?: string;
  resume?: boolean;
}) {
  const delivery = deliveryRepo.getDeliveryById(args.deliveryId)!;
  const revision = revisionRepo.getRuleRevisionById(delivery.ruleRevisionId)!;
  return attemptRuleRun({
    rule: args.rule,
    source: "event",
    trigger: {
      triggerType: "release.shipped",
      triggerEventId: "evt-frozen",
      habitatId: args.habitatId,
      targetType: "task",
      targetId: args.taskId,
      payload: {},
    },
    now: args.now ?? T1,
    frozen: {
      delivery: {
        id: args.deliveryId,
        generation: delivery.generation,
        fence: args.fence,
        eventDedupeKey: delivery.eventDedupeKey,
      },
      inbox: { id: args.inboxId, eventType: "release.shipped", eventId: "evt-frozen" },
      revision,
      resumeAfterReservation: args.resume,
    },
  } as never);
}

/** Simulate a crashed worker that created + pinned the release checkpoint. */
function crashedPinnedCheckpoint(args: {
  deliveryId: string;
  fence: string;
  pin: string;
  now?: string;
}) {
  const delivery = deliveryRepo.getDeliveryById(args.deliveryId)!;
  const revision = revisionRepo.getRuleRevisionById(delivery.ruleRevisionId)!;
  const checkpoint = deliveryRepo.ensureCheckpointRow({
    deliveryId: args.deliveryId,
    actionIndex: 0,
    actionKey: deliveryRepo.computeActionKey(revision.actions[0] as never),
    actionType: "release_assignment",
    now: args.now ?? T0,
  });
  getDb()
    .update(automationDeliveryActionCheckpoints)
    .set({ idempotencyKey: args.pin })
    .where(eq(automationDeliveryActionCheckpoints.id, checkpoint.id))
    .run();
  return checkpoint;
}

describe("automation release_assignment — canonical release restoration", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    closeDb();
  });

  // ── LIVE PATH ────────────────────────────────────────────────────────────

  it("LIVE: a rule release produces the released event, both receipts, and a metered system row (RED on HEAD)", async () => {
    const h = setupHabitat();
    const { task, agent } = makeClaimedTask(h.id);
    const rule = createReleaseRule(h.id);
    const meterBefore = countMeteredTransitions(getDb(), task.id);

    const { status, actionResults } = await executeActions(
      rule,
      buildRun(h.id, rule.id, task.id),
      ctxFor(task, h.id),
    );

    expect(status).toBe("succeeded");
    expect(actionResults[0]!.status).toBe("succeeded");

    const events = releasedEvents(task.id);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.actorType).toBe("system");
    expect(event.actorId).toBe(RELEASE_ACTOR_ID);
    expect((event.metadata as { reason?: string })?.reason).toBe(RELEASE_REASON);

    const row = taskRow(task.id);
    expect(row.status).toBe("pending");
    expect(row.assignedAgentId).toBeNull();
    expect(row.executionToken).toBeNull();
    expect(row.lastReleaseEventId).toBe(event.id);

    const receipts = receiptsForEvent(event.id);
    expect(receipts.map((r) => r.consumer).sort()).toEqual(["failure_context", "workflow_gates"]);
    expect(receipts.every((r) => r.state === "pending")).toBe(true);
    expect((receipts[0]!.causalSnapshot as { reason?: string })?.reason).toBe(RELEASE_REASON);

    // System actor is metered (ADR-0051): the released event IS the meter row.
    expect(countMeteredTransitions(getDb(), task.id)).toBe(meterBefore + 1);
    void agent;
  });

  it("LIVE: the released event persists bounded rule provenance (ruleId/runId/actionIndex); seam callers without provenance keep metadata = {reason}", async () => {
    const h = setupHabitat();
    const { task } = makeClaimedTask(h.id);
    const rule = createReleaseRule(h.id);
    const run = buildRun(h.id, rule.id, task.id);

    const { actionResults } = await executeActions(rule, run, ctxFor(task, h.id));
    expect(actionResults[0]!.status).toBe("succeeded");

    const event = releasedEvents(task.id)[0]!;
    expect((event.metadata as { provenance?: unknown }).provenance).toEqual({
      ruleId: rule.id,
      runId: run.id,
      actionIndex: 0,
    });
    // The reason token is never overridden by the provenance payload.
    expect((event.metadata as { reason?: string }).reason).toBe(RELEASE_REASON);
    const receipts = receiptsForEvent(event.id);
    expect((receipts[0]!.causalSnapshot as { provenance?: unknown }).provenance).toEqual({
      ruleId: rule.id,
      runId: run.id,
      actionIndex: 0,
    });

    // Existing seam callers (no provenance input) keep the exact legacy
    // metadata shape — the additive field never widens their events.
    const { task: task2 } = makeClaimedTask(h.id, "agent-noproV");
    const bare = releaseTaskWithEffects({
      taskId: task2.id,
      actorId: "stale-sweep",
      reason: "stale_timeout",
      preImage: task2,
    });
    expect(bare).not.toBeNull();
    const bareEvent = releasedEvents(task2.id)[0]!;
    expect(bareEvent.metadata).toEqual({ reason: "stale_timeout" });
    expect((bareEvent.metadata as { provenance?: unknown }).provenance).toBeUndefined();
  });

  it("LIVE: same-agent re-claim ABA between evaluation and action refuses (E1 evaluated, E2 live)", async () => {
    const h = setupHabitat();
    const { task, agent } = makeClaimedTask(h.id);
    const e1 = task.executionToken!;

    // The evaluated snapshot stays at E1; the world moves to E2 (same agent).
    const released = taskRepo.releaseTask(task.id, "manual-between");
    expect(released).not.toBeNull();
    const reclaimed = claimedTask(task.id, agent.id);
    const e2 = reclaimed.executionToken!;
    expect(e2).not.toBe(e1);

    const rule = createReleaseRule(h.id);
    const { status, actionResults } = await executeActions(
      rule,
      buildRun(h.id, rule.id, task.id),
      ctxFor(task, h.id), // evaluated ctx.task still carries E1
    );

    expect(status).toBe("failed");
    expect(actionResults[0]!.status).toBe("failed");
    const row = taskRow(task.id);
    expect(row.status).toBe("claimed");
    expect(row.assignedAgentId).toBe(agent.id);
    expect(row.executionToken).toBe(e2);
    expect(releasedEvents(task.id)).toHaveLength(0);
  });

  it("LIVE: NULL-pinned legacy snapshot refuses a minted (non-NULL) current token", async () => {
    const h = setupHabitat();
    const { task, agent } = makeClaimedTask(h.id);
    // Evaluated snapshot: legacy NULL token (pre-epoch row shape).
    const evaluated = { ...task, executionToken: null } as Task;

    // The live row moved on: a re-claim minted E2.
    taskRepo.releaseTask(task.id, "manual-between");
    const reclaimed = claimedTask(task.id, agent.id);
    const e2 = reclaimed.executionToken!;

    const rule = createReleaseRule(h.id);
    const { actionResults } = await executeActions(
      rule,
      buildRun(h.id, rule.id, task.id),
      ctxFor(evaluated, h.id),
    );

    expect(actionResults[0]!.status).toBe("failed");
    const row = taskRow(task.id);
    expect(row.status).toBe("claimed");
    expect(row.executionToken).toBe(e2);
    expect(releasedEvents(task.id)).toHaveLength(0);
  });

  it("LIVE: budget refusal is a typed truthful failure with zero writes; a ceiling raise retries successfully", async () => {
    const h = setupHabitat();
    const { task } = makeClaimedTask(h.id);
    getDb()
      .update(habitats)
      .set({ lifecycleSettings: { taskTransitionCeiling: 1 } as never })
      .where(eq(habitats.id, h.id))
      .run();
    // Seed the meter to the ceiling (the repo claim writes no task event; a
    // prior metered agent transition occupies the single slot).
    createEvent({
      taskId: task.id,
      actorType: "agent",
      actorId: "agent-meter",
      action: "retry_executed",
    });
    const before = taskRow(task.id);

    const rule = createReleaseRule(h.id);
    const first = await executeActions(rule, buildRun(h.id, rule.id, task.id), ctxFor(task, h.id));

    expect(first.status).toBe("failed");
    expect(first.actionResults[0]!.status).toBe("failed");
    expect(first.actionResults[0]!.error).toContain("transition_budget_exhausted");
    const afterRefusal = taskRow(task.id);
    expect(afterRefusal.status).toBe(before.status);
    expect(afterRefusal.assignedAgentId).toBe(before.assignedAgentId);
    expect(afterRefusal.executionToken).toBe(before.executionToken);
    expect(releasedEvents(task.id)).toHaveLength(0);

    // The operative remedy: raise the ceiling, retry the same action.
    getDb()
      .update(habitats)
      .set({ lifecycleSettings: { taskTransitionCeiling: 10 } as never })
      .where(eq(habitats.id, h.id))
      .run();
    const second = await executeActions(rule, buildRun(h.id, rule.id, task.id), ctxFor(task, h.id));
    expect(second.status).toBe("succeeded");
    expect(taskRow(task.id).status).toBe("pending");
    expect(releasedEvents(task.id)).toHaveLength(1);

    // Drain the guard's post-refusal breach-escalation microtask INSIDE the
    // test (db still open — no post-closeDb teardown warning) and assert it
    // actually landed: the escalated event carries the budget-breach marker.
    await vi.waitFor(
      () => {
        const escalation = getDb()
          .select()
          .from(taskEvents)
          .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.action, "escalated")))
          .all();
        expect(escalation).toHaveLength(1);
        expect(
          (escalation[0]!.metadata as { transitionBudget?: unknown })?.transitionBudget,
        ).toBeDefined();
      },
      { timeout: 2000, interval: 10 },
    );
  });

  it("LIVE: the in-tx budget guard refuses even when the preflight passes (cross-writer race shape)", async () => {
    const h = setupHabitat();
    const { task } = makeClaimedTask(h.id);
    getDb()
      .update(habitats)
      .set({ lifecycleSettings: { taskTransitionCeiling: 1 } as never })
      .where(eq(habitats.id, h.id))
      .run();
    createEvent({
      taskId: task.id,
      actorType: "agent",
      actorId: "agent-meter",
      action: "retry_executed",
    });

    // Simulate the race: the cheap preflight (stale view) says allow while
    // another writer has ALREADY metered the task past the ceiling — the
    // authoritative in-mutation-transaction guard must refuse.
    const transitionBudgetModule = await import("../services/tasks/transitionBudget.js");
    vi.spyOn(transitionBudgetModule, "guardTransitionTop").mockReturnValue({
      outcome: "allow",
      count: 0,
      ceiling: 1,
    } as never);

    const rule = createReleaseRule(h.id);
    const { status, actionResults } = await executeActions(
      rule,
      buildRun(h.id, rule.id, task.id),
      ctxFor(task, h.id),
    );

    expect(status).toBe("failed");
    expect(actionResults[0]!.status).toBe("failed");
    expect(actionResults[0]!.error).toContain("transition_budget_exhausted");
    const row = taskRow(task.id);
    expect(row.status).toBe("claimed");
    expect(releasedEvents(task.id)).toHaveLength(0);

    // Drain the in-tx refusal's breach escalation inside the test.
    await vi.waitFor(
      () => {
        expect(
          getDb()
            .select()
            .from(taskEvents)
            .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.action, "escalated")))
            .all(),
        ).toHaveLength(1);
      },
      { timeout: 2000, interval: 10 },
    );
  });

  it("LIVE: same-epoch changed-holder refuses — evaluated assignee vs the in-tx current row", async () => {
    const h = setupHabitat();
    const { task } = makeClaimedTask(h.id);
    const foreign = setupAgent("agent-foreign-holder");

    // The holder moved WITHIN the evaluated epoch (token unchanged): only
    // the in-tx owner check can see it.
    getDb()
      .update(tasks)
      .set({ assignedAgentId: foreign.id })
      .where(eq(tasks.id, task.id))
      .run();

    const rule = createReleaseRule(h.id);
    const { status, actionResults } = await executeActions(
      rule,
      buildRun(h.id, rule.id, task.id),
      ctxFor(task, h.id),
    );

    expect(status).toBe("failed");
    expect(actionResults[0]!.status).toBe("failed");
    const row = taskRow(task.id);
    expect(row.status).toBe("claimed");
    expect(row.assignedAgentId).toBe(foreign.id);
    expect(row.executionToken).toBe(task.executionToken);
    expect(releasedEvents(task.id)).toHaveLength(0);
  });

  it("LIVE: guards preserved — no task context / unassigned task stay typed failures", async () => {
    const h = setupHabitat();
    const rule = createReleaseRule(h.id);

    const noCtx = await executeActions(rule, buildRun(h.id, rule.id, "t-x"), ctxFor(null, h.id));
    expect(noCtx.actionResults[0]!.status).toBe("failed");
    expect(noCtx.actionResults[0]!.error).toBe("No task context available for release");

    const mission = setupMission(h.id);
    const unassigned = taskRepo.createTask({
      missionId: mission.id,
      title: "U",
      createdBy: "user-1",
    });
    const unassignedCtx = await executeActions(
      rule,
      buildRun(h.id, rule.id, unassigned.id),
      ctxFor(taskRepo.getTaskById(unassigned.id)!, h.id),
    );
    expect(unassignedCtx.actionResults[0]!.status).toBe("failed");
    expect(unassignedCtx.actionResults[0]!.error).toBe("Task is not currently assigned");
  });

  // ── FROZEN PATH ───────────────────────────────────────────────────────────

  it("FROZEN: the release commits atomically with a proved event-ID checkpoint receipt and the pinned intent", async () => {
    const h = setupHabitat();
    const { task, agent } = makeClaimedTask(h.id);
    const rule = createReleaseRule(h.id);
    const { deliveryId, fence, inboxId } = leaseFirstDelivery(h.id, "rel-frozen-ok");

    const disposition = await attemptFrozenDelivery({
      habitatId: h.id,
      rule,
      deliveryId,
      fence,
      inboxId,
      taskId: task.id,
    });

    expect(disposition).toMatchObject({ kind: "executed", outcome: "succeeded" });
    const events = releasedEvents(task.id);
    expect(events).toHaveLength(1);
    const row = taskRow(task.id);
    expect(row.status).toBe("pending");
    expect(row.assignedAgentId).toBeNull();
    expect(row.executionToken).toBeNull();
    expect(row.lastReleaseEventId).toBe(events[0]!.id);

    const checkpoint = checkpointFor(deliveryId)!;
    expect(checkpoint.state).toBe("proved");
    expect((checkpoint.receipt as { eventId?: string })?.eventId).toBe(events[0]!.id);
    expect(checkpoint.idempotencyKey).toBe(
      pinJson({ taskId: task.id, assignedAgentId: agent.id, executionToken: task.executionToken }),
    );

    const receipts = receiptsForEvent(events[0]!.id);
    expect(receipts.map((r) => r.consumer).sort()).toEqual(["failure_context", "workflow_gates"]);
    expect(events[0]!.actorType).toBe("system");
    expect(events[0]!.actorId).toBe(RELEASE_ACTOR_ID);
    // F2: frozen-path provenance carries the delivery lineage too.
    expect((events[0]!.metadata as { provenance?: unknown }).provenance).toEqual({
      ruleId: rule.id,
      runId: expect.any(String),
      deliveryId: deliveryId,
      actionIndex: 0,
    });
    expect((events[0]!.metadata as { reason?: string }).reason).toBe(RELEASE_REASON);
  });

  it("FROZEN: successor attempt on the SAME delivery re-attempts against the pin, never fresh (E1 pinned, E2 live)", async () => {
    const h = setupHabitat();
    const { task, agent } = makeClaimedTask(h.id);
    const rule = createReleaseRule(h.id);
    const { deliveryId, fence, inboxId } = leaseFirstDelivery(h.id, "rel-frozen-aba");

    // Crashed worker pinned E1, died before the bundle committed.
    crashedPinnedCheckpoint({
      deliveryId,
      fence,
      pin: pinJson({
        taskId: task.id,
        assignedAgentId: agent.id,
        executionToken: task.executionToken,
      }),
    });

    // Same agent released + re-claimed before the successor attempt → E2.
    taskRepo.releaseTask(task.id, "manual-between");
    const reclaimed = claimedTask(task.id, agent.id);
    const e2 = reclaimed.executionToken!;

    // Lease expired → successor lease under a NEW fence on the SAME delivery.
    const reLease = deliveryRepo.leaseDelivery({
      deliveryId,
      leaseOwner: "worker-2",
      now: T1,
      ttlMs: 60_000,
    });
    expect(reLease.acquired).toBe(true);

    const disposition = await attemptFrozenDelivery({
      habitatId: h.id,
      rule,
      deliveryId,
      fence: reLease.fence,
      inboxId,
      taskId: task.id,
      now: T1,
    });

    expect(disposition).toMatchObject({ kind: "executed", outcome: "failed" });
    const row = taskRow(task.id);
    expect(row.status).toBe("claimed");
    expect(row.assignedAgentId).toBe(agent.id);
    expect(row.executionToken).toBe(e2);
    expect(releasedEvents(task.id)).toHaveLength(0);
    // The pin is immutable history — never refreshed by the successor.
    expect(checkpointFor(deliveryId)!.idempotencyKey).toBe(
      pinJson({ taskId: task.id, assignedAgentId: agent.id, executionToken: task.executionToken }),
    );
  });

  it("FROZEN: pinned assignee mismatch refuses even when both tokens are NULL (the token-blind ABA)", async () => {
    const h = setupHabitat();
    const { task, agent } = makeClaimedTask(h.id);
    const agentB = setupAgent("agent-b");
    const rule = createReleaseRule(h.id);
    const { deliveryId, fence, inboxId } = leaseFirstDelivery(h.id, "rel-frozen-assignee");

    // Legacy both-NULL epoch shape: pinned assignee A, token NULL.
    getDb().update(tasks).set({ executionToken: null }).where(eq(tasks.id, task.id)).run();
    crashedPinnedCheckpoint({
      deliveryId,
      fence,
      pin: pinJson({ taskId: task.id, assignedAgentId: agent.id, executionToken: null }),
    });

    // A DIFFERENT agent now owns the claim, still token-NULL (token fence is blind).
    taskRepo.releaseTask(task.id, "manual-between");
    claimedTask(task.id, agentB.id);
    getDb().update(tasks).set({ executionToken: null }).where(eq(tasks.id, task.id)).run();

    const reLease = deliveryRepo.leaseDelivery({
      deliveryId,
      leaseOwner: "worker-2",
      now: T1,
      ttlMs: 60_000,
    });
    const disposition = await attemptFrozenDelivery({
      habitatId: h.id,
      rule,
      deliveryId,
      fence: reLease.fence,
      inboxId,
      taskId: task.id,
      now: T1,
    });

    expect(disposition).toMatchObject({ kind: "executed", outcome: "failed" });
    const row = taskRow(task.id);
    expect(row.status).toBe("claimed");
    expect(row.assignedAgentId).toBe(agentB.id);
    expect(releasedEvents(task.id)).toHaveLength(0);
  });

  it("FROZEN: both-NULL legacy pin admits the release (the admitted ABA limit), pin and proof durable", async () => {
    const h = setupHabitat();
    const { task, agent } = makeClaimedTask(h.id);
    const rule = createReleaseRule(h.id);
    const { deliveryId, fence, inboxId } = leaseFirstDelivery(h.id, "rel-frozen-nullnull");

    getDb().update(tasks).set({ executionToken: null }).where(eq(tasks.id, task.id)).run();
    crashedPinnedCheckpoint({
      deliveryId,
      fence,
      pin: pinJson({ taskId: task.id, assignedAgentId: agent.id, executionToken: null }),
    });

    const reLease = deliveryRepo.leaseDelivery({
      deliveryId,
      leaseOwner: "worker-2",
      now: T1,
      ttlMs: 60_000,
    });
    const disposition = await attemptFrozenDelivery({
      habitatId: h.id,
      rule,
      deliveryId,
      fence: reLease.fence,
      inboxId,
      taskId: task.id,
      now: T1,
    });

    expect(disposition).toMatchObject({ kind: "executed", outcome: "succeeded" });
    expect(taskRow(task.id).status).toBe("pending");
    const events = releasedEvents(task.id);
    expect(events).toHaveLength(1);
    const checkpoint = checkpointFor(deliveryId)!;
    expect(checkpoint.state).toBe("proved");
    expect((checkpoint.receipt as { eventId?: string })?.eventId).toBe(events[0]!.id);
  });

  it("FROZEN: a malformed pin fails closed — typed failure, zero writes", async () => {
    const h = setupHabitat();
    const { task, agent } = makeClaimedTask(h.id);
    const rule = createReleaseRule(h.id);
    const { deliveryId, fence, inboxId } = leaseFirstDelivery(h.id, "rel-frozen-malformed");

    crashedPinnedCheckpoint({ deliveryId, fence, pin: "{not-json" });

    const disposition = await attemptFrozenDelivery({
      habitatId: h.id,
      rule,
      deliveryId,
      fence,
      inboxId,
      taskId: task.id,
    });

    expect(disposition).toMatchObject({ kind: "executed", outcome: "failed" });
    const row = taskRow(task.id);
    expect(row.status).toBe("claimed");
    expect(row.assignedAgentId).toBe(agent.id);
    expect(releasedEvents(task.id)).toHaveLength(0);
  });

  it("FROZEN: a pending NULL-pin row is pinned by its next attempt from THAT attempt's evaluated context (conditional first writer)", async () => {
    const h = setupHabitat();
    const { task, agent } = makeClaimedTask(h.id);
    const rule = createReleaseRule(h.id);
    const { deliveryId, fence, inboxId } = leaseFirstDelivery(h.id, "rel-frozen-pinfill");

    // Legacy/crash-window shape: checkpoint exists with NO pin.
    crashedPinnedCheckpoint({ deliveryId, fence, pin: "" });
    getDb()
      .update(automationDeliveryActionCheckpoints)
      .set({ idempotencyKey: null })
      .where(eq(automationDeliveryActionCheckpoints.deliveryId, deliveryId))
      .run();

    const disposition = await attemptFrozenDelivery({
      habitatId: h.id,
      rule,
      deliveryId,
      fence,
      inboxId,
      taskId: task.id,
    });

    expect(disposition).toMatchObject({ kind: "executed", outcome: "succeeded" });
    const checkpoint = checkpointFor(deliveryId)!;
    expect(checkpoint.idempotencyKey).toBe(
      pinJson({ taskId: task.id, assignedAgentId: agent.id, executionToken: task.executionToken }),
    );
    expect(checkpoint.state).toBe("proved");
  });

  it("FROZEN: a stale fence can neither release nor mutate — fenced_out with zero writes (lease-steal)", async () => {
    const h = setupHabitat();
    const { task, agent } = makeClaimedTask(h.id);
    const rule = createReleaseRule(h.id);
    const { deliveryId, fence, inboxId } = leaseFirstDelivery(h.id, "rel-frozen-steal");

    crashedPinnedCheckpoint({
      deliveryId,
      fence,
      pin: pinJson({
        taskId: task.id,
        assignedAgentId: agent.id,
        executionToken: task.executionToken,
      }),
    });

    // The lease expires; a NEWER worker takes over under a new fence.
    const reLease = deliveryRepo.leaseDelivery({
      deliveryId,
      leaseOwner: "worker-2",
      now: T1,
      ttlMs: 60_000,
    });
    expect(reLease.acquired).toBe(true);

    // The OLD worker's attempt (stale fence) must change nothing.
    const disposition = await attemptFrozenDelivery({
      habitatId: h.id,
      rule,
      deliveryId,
      fence,
      inboxId,
      taskId: task.id,
      now: T1,
    });

    expect(disposition).toMatchObject({ kind: "fenced_out" });
    const row = taskRow(task.id);
    expect(row.status).toBe("claimed");
    expect(row.assignedAgentId).toBe(agent.id);
    expect(releasedEvents(task.id)).toHaveLength(0);
    const checkpoint = checkpointFor(deliveryId)!;
    expect(checkpoint.state).toBe("pending");
    expect(checkpoint.idempotencyKey).toBe(
      pinJson({ taskId: task.id, assignedAgentId: agent.id, executionToken: task.executionToken }),
    );
  });

  it("FROZEN: proof zero-rows rolls back the WHOLE release bundle — never a fired-but-unproved state", async () => {
    const h = setupHabitat();
    const { task, agent } = makeClaimedTask(h.id);
    const rule = createReleaseRule(h.id);
    const { deliveryId, fence, inboxId } = leaseFirstDelivery(h.id, "rel-frozen-proofzero");

    // The proof seam reports zero affected rows (fence/checkpoint moved under
    // us mid-tx): the release, event, and receipts must ALL vanish.
    const deliveryModule = await import("../repositories/automationRuleDelivery.js");
    if (typeof deliveryModule.recordCheckpointOutcomeWithClient === "function") {
      vi.spyOn(deliveryModule, "recordCheckpointOutcomeWithClient").mockReturnValue(false);
    }

    const disposition = await attemptFrozenDelivery({
      habitatId: h.id,
      rule,
      deliveryId,
      fence,
      inboxId,
      taskId: task.id,
    });

    expect(disposition).toMatchObject({ kind: "fenced_out" });
    const row = taskRow(task.id);
    expect(row.status).toBe("claimed");
    expect(row.assignedAgentId).toBe(agent.id);
    expect(releasedEvents(task.id)).toHaveLength(0);
    const receipts = getDb().select().from(effectReceipts).all();
    expect(receipts.filter((r) => r.taskId === task.id)).toHaveLength(0);
    const checkpoint = checkpointFor(deliveryId)!;
    expect(checkpoint.state).toBe("pending"); // unproved — the crash window is closed
  });

  it("PIN SEAM: a stale fence cannot pin a legacy NULL-pin row — only the current lease writes (conditional first-writer-wins)", async () => {
    const h = setupHabitat();
    const { task, agent } = makeClaimedTask(h.id);
    const rule = createReleaseRule(h.id);
    const { deliveryId, fence } = leaseFirstDelivery(h.id, "rel-pin-seam");

    // A crashed worker left a pending checkpoint with NO pin (legacy shape).
    const revision = revisionRepo.getRuleRevisionById(
      deliveryRepo.getDeliveryById(deliveryId)!.ruleRevisionId,
    )!;
    deliveryRepo.ensureCheckpointRow({
      deliveryId,
      actionIndex: 0,
      actionKey: deliveryRepo.computeActionKey(revision.actions[0] as never),
      actionType: "release_assignment",
      now: T0,
    });

    // The lease expires; a NEWER worker takes over under F2.
    const reLease = deliveryRepo.leaseDelivery({
      deliveryId,
      leaseOwner: "worker-2",
      now: T1,
      ttlMs: 60_000,
    });
    expect(reLease.acquired).toBe(true);

    // The OLD worker's pin attempt (stale fence) writes NOTHING.
    const staleAttempt = deliveryRepo.ensureReleaseCheckpointWithPin({
      deliveryId,
      actionIndex: 0,
      actionKey: deliveryRepo.computeActionKey(revision.actions[0] as never),
      actionType: "release_assignment",
      fence,
      pin: pinJson({
        taskId: task.id,
        assignedAgentId: agent.id,
        executionToken: "stale-attempt-token",
      }),
      now: T1,
    });
    expect(staleAttempt.fencedOut).toBe(true);
    expect(checkpointFor(deliveryId)!.idempotencyKey).toBeNull();

    // The CURRENT lease holder wins the conditional pin.
    const freshAttempt = deliveryRepo.ensureReleaseCheckpointWithPin({
      deliveryId,
      actionIndex: 0,
      actionKey: deliveryRepo.computeActionKey(revision.actions[0] as never),
      actionType: "release_assignment",
      fence: reLease.fence,
      pin: pinJson({
        taskId: task.id,
        assignedAgentId: agent.id,
        executionToken: task.executionToken,
      }),
      now: T1,
    });
    expect(freshAttempt.fencedOut).toBe(false);
    expect(freshAttempt.checkpoint?.idempotencyKey).toBe(
      pinJson({ taskId: task.id, assignedAgentId: agent.id, executionToken: task.executionToken }),
    );
  });

  it("PIN SEAM: a stale fence cannot INSERT a pin when no row exists — zero rows created, current lease still pins", async () => {
    const h = setupHabitat();
    const { task, agent } = makeClaimedTask(h.id);
    const rule = createReleaseRule(h.id);
    const { deliveryId, fence } = leaseFirstDelivery(h.id, "rel-pin-insert-fence");
    const revision = revisionRepo.getRuleRevisionById(
      deliveryRepo.getDeliveryById(deliveryId)!.ruleRevisionId,
    )!;
    const actionKey = deliveryRepo.computeActionKey(revision.actions[0] as never);

    // The lease expires; a NEWER worker takes over under F2 — the old
    // worker reaches the action with NO checkpoint row present yet.
    const reLease = deliveryRepo.leaseDelivery({
      deliveryId,
      leaseOwner: "worker-2",
      now: T1,
      ttlMs: 60_000,
    });
    expect(reLease.acquired).toBe(true);

    const staleInsert = deliveryRepo.ensureReleaseCheckpointWithPin({
      deliveryId,
      actionIndex: 0,
      actionKey,
      actionType: "release_assignment",
      fence,
      pin: pinJson({ taskId: task.id, assignedAgentId: agent.id, executionToken: "stale-eval" }),
      now: T1,
    });
    expect(staleInsert.fencedOut).toBe(true);
    // Zero rows created by the stale worker.
    expect(
      getDb()
        .select()
        .from(automationDeliveryActionCheckpoints)
        .where(eq(automationDeliveryActionCheckpoints.deliveryId, deliveryId))
        .all(),
    ).toHaveLength(0);

    // The CURRENT lease holder creates + pins normally.
    const freshInsert = deliveryRepo.ensureReleaseCheckpointWithPin({
      deliveryId,
      actionIndex: 0,
      actionKey,
      actionType: "release_assignment",
      fence: reLease.fence,
      pin: pinJson({
        taskId: task.id,
        assignedAgentId: agent.id,
        executionToken: task.executionToken,
      }),
      now: T1,
    });
    expect(freshInsert.fencedOut).toBe(false);
    expect(freshInsert.checkpoint).not.toBeNull();
    expect(freshInsert.checkpoint?.idempotencyKey).toBe(
      pinJson({ taskId: task.id, assignedAgentId: agent.id, executionToken: task.executionToken }),
    );
  });

  it("PIN SEAM: a same-fence pre-existing row is returned as the winner — never an error or a stranded lease", async () => {
    const h = setupHabitat();
    const { task, agent } = makeClaimedTask(h.id);
    const rule = createReleaseRule(h.id);
    const { deliveryId, fence } = leaseFirstDelivery(h.id, "rel-pin-collision");
    const revision = revisionRepo.getRuleRevisionById(
      deliveryRepo.getDeliveryById(deliveryId)!.ruleRevisionId,
    )!;
    const actionKey = deliveryRepo.computeActionKey(revision.actions[0] as never);

    // A concurrent same-fence writer already created the row.
    const winner = deliveryRepo.ensureReleaseCheckpointWithPin({
      deliveryId,
      actionIndex: 0,
      actionKey,
      actionType: "release_assignment",
      fence,
      pin: pinJson({
        taskId: task.id,
        assignedAgentId: agent.id,
        executionToken: task.executionToken,
      }),
      now: T0,
    });
    expect(winner.fencedOut).toBe(false);

    // The racing call returns the SAME winning row — no throw, no duplicate.
    const racer = deliveryRepo.ensureReleaseCheckpointWithPin({
      deliveryId,
      actionIndex: 0,
      actionKey,
      actionType: "release_assignment",
      fence,
      pin: pinJson({ taskId: task.id, assignedAgentId: agent.id, executionToken: "racer-eval" }),
      now: T0,
    });
    expect(racer.fencedOut).toBe(false);
    expect(racer.checkpoint?.id).toBe(winner.checkpoint!.id);
    expect(racer.checkpoint?.idempotencyKey).toBe(
      pinJson({ taskId: task.id, assignedAgentId: agent.id, executionToken: task.executionToken }),
    );
  });

  it("FROZEN: a bundle error after rollback maps to a truthful recorded failed checkpoint — never an escaped throw or a false success", async () => {
    const h = setupHabitat();
    const { task } = makeClaimedTask(h.id);
    const rule = createReleaseRule(h.id);
    const { deliveryId, fence, inboxId } = leaseFirstDelivery(h.id, "rel-frozen-throw");

    // The proof seam THROWS mid-bundle: the service rolls back, and the
    // lifecycle maps it to a typed failed action + failed checkpoint.
    const deliveryModule = await import("../repositories/automationRuleDelivery.js");
    vi.spyOn(deliveryModule, "recordCheckpointOutcomeWithClient").mockImplementation(() => {
      throw new Error("proof seam exploded");
    });

    const disposition = await attemptFrozenDelivery({
      habitatId: h.id,
      rule,
      deliveryId,
      fence,
      inboxId,
      taskId: task.id,
    });

    expect(disposition).toMatchObject({ kind: "executed", outcome: "failed" });
    const executed = disposition as { actionResults: Array<{ status: string; error?: string }> };
    expect(executed.actionResults[0]!.status).toBe("failed");
    expect(executed.actionResults[0]!.error).toContain("proof seam exploded");
    // Truthful rollback: nothing released, checkpoint recorded failed.
    const row = taskRow(task.id);
    expect(row.status).toBe("claimed");
    expect(releasedEvents(task.id)).toHaveLength(0);
    const checkpoint = checkpointFor(deliveryId)!;
    expect(checkpoint.state).toBe("failed");
    expect(checkpoint.idempotencyKey).not.toBeNull();
  });

  it("FROZEN: a proved release checkpoint carries forward — successors skip it citing the durable event id", async () => {
    const h = setupHabitat();
    const { task, agent } = makeClaimedTask(h.id);
    const rule = ruleRepo.createAutomationRule({
      habitatId: h.id,
      name: "Release + Notify",
      priority: 0,
      trigger: { type: "event", eventType: "release.shipped" } as never,
      condition: { type: "always" } as never,
      actions: [
        { type: "release_assignment" },
        {
          type: "notify",
          template: "DONE",
          severity: "info",
          recipients: [{ type: "human", userId: "user-1" }],
        },
      ] as never,
      cooldownSeconds: 0,
      maxRunsPerHour: 100,
      enabled: true,
      createdBy: "test",
    });
    const { deliveryId, fence, inboxId } = leaseFirstDelivery(h.id, "rel-frozen-carry");

    // First worker commits the release atomically (proved + eventId receipt),
    // then DIES before the notify and before terminalization — the delivery
    // stays leased under F1 until the lease expires.
    const releaseAction = (rule.actions as unknown as Array<Record<string, unknown>>)[0]!;
    const releaseOutcome = executeFrozenReleaseAssignment({
      action: releaseAction as never,
      index: 0,
      rule,
      run: buildRun(h.id, rule.id, task.id),
      ctx: ctxFor(task, h.id),
      delivery: { id: deliveryId, fence },
      actionKey: deliveryRepo.computeActionKey(releaseAction),
      now: T0,
    });
    expect(releaseOutcome).toMatchObject({ kind: "committed" });
    const releaseEvent = releasedEvents(task.id)[0]!;
    expect(releaseEvent).toBeDefined();
    // Crash aftermath: checkpoint proved + pinned, delivery still leased.
    const pinned = checkpointFor(deliveryId)!.idempotencyKey;
    expect(pinned).toBe(
      pinJson({ taskId: task.id, assignedAgentId: agent.id, executionToken: task.executionToken }),
    );
    const marked = deliveryRepo.markStaleDeliveryAttention({
      deliveryId,
      fence,
      now: T1,
      reason: "test: notify unproved",
      proofClassification: "unprovable",
    });
    expect(marked).toBe(true);

    const successor = (
      await import("../services/automationInboxService.js")
    ).createAutomationDeliverySuccessorGeneration({
      deliveryId,
      actorType: "human",
      actorId: "user-1",
      reason: "retry notify",
      ackDuplicateRisk: true,
      now: T1,
    });
    expect(successor).toMatchObject({ outcome: "created" });
    const successorId = (successor as { deliveryId: string }).deliveryId;

    const lease2 = deliveryRepo.leaseDelivery({
      deliveryId: successorId,
      leaseOwner: "worker-2",
      now: T1,
      ttlMs: 60_000,
    });
    expect(lease2.acquired).toBe(true);

    const disposition = await attemptFrozenDelivery({
      habitatId: h.id,
      rule,
      deliveryId: successorId,
      fence: lease2.fence,
      inboxId,
      taskId: task.id,
      now: T1,
    });

    expect(disposition).toMatchObject({ kind: "executed", outcome: "succeeded" });
    const executed = disposition as { actionResults: Array<{ status: string; result?: unknown }> };
    expect(executed.actionResults[0]!.status).toBe("skipped");
    expect((executed.actionResults[0]!.result as { eventId?: string })?.eventId).toBe(
      releaseEvent.id,
    );
    // Never re-released: still exactly one released event, task still pending.
    expect(releasedEvents(task.id)).toHaveLength(1);
    expect(taskRow(task.id).status).toBe("pending");
    // The carried-forward checkpoint preserves the pinned intent verbatim.
    expect(checkpointFor(successorId)!.idempotencyKey).toBe(pinned);
  });
});
