/**
 * REC-06 (automation-release batch) — the `release_assignment` action's
 * canonical-release execution, shared by both automation paths.
 *
 * Adjudicated mechanism (contract review, automation-release ticket):
 *
 *  - LIVE path (`attemptLiveRuleRun` → `executeActions` → executor): the
 *    plain repo release is replaced by the release act-tx
 *    (`releaseTaskWithEffects`) fenced on the EVALUATED `ctx.task` epoch —
 *    the pre-image is the evaluation snapshot, never a fresh read. A
 *    same-agent release+re-claim between evaluation and action mints a new
 *    token and the seam refuses with zero writes. The evaluated token is
 *    recorded in the action result.
 *
 *  - FROZEN path (`attemptFrozenRuleDelivery`'s ordered action loop):
 *    O-B′ — the first attempt pins the EVALUATED identity
 *    `{taskId, assignedAgentId, executionToken}` into the action
 *    checkpoint's `idempotency_key` BEFORE execution; successors reuse the
 *    pin, never refresh it. O-C — the release bundle
 *    (`releaseTaskWithEffectsWithClient`) and the checkpoint proof
 *    (`recordCheckpointOutcomeWithClient`, receipt citing the stamped event
 *    id) commit in ONE outer `BEGIN IMMEDIATE` under the lease fence. A
 *    crash before commit leaves the checkpoint pending WITH the pin and
 *    nothing fired; a proof that affects zero rows rolls the WHOLE bundle
 *    back — there is never a fired-but-unproved release.
 *
 * Both paths meter the system actor (`automation-executor`, ADR-0051) via
 * `guardTransition` ("released" is a metered action); the rule AUTHOR is
 * provenance only, never the actor. Post-commit non-required effects (the
 * shared postlude: non-required emitter mask + eager deliverer pass) run
 * BEST-EFFORT outside the truthful committed result.
 *
 * Honest limits (no invented guarantees): NULL→NULL epoch ABA is admitted
 * (pre-migration both-NULL rows are unfenceable by token — the in-tx pinned
 * assignee guard is the residual fence); a pre-pin crash (evaluation →
 * first-checkpoint creation) leaves nothing durable, so a successor's fresh
 * re-evaluation is its own authority.
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { tasks, automationRuleDeliveries } from "../db/schema/index.js";
import type {
  AutomationAction,
  AutomationActionResult,
  AutomationRule,
  AutomationRuleRun,
} from "@orcy/shared";
import type { AutomationEvaluationContext } from "./automationContextBuilder.js";
import { releaseTaskWithEffectsWithClient } from "./effects/releaseEffects.js";
import {
  habitatIdForTaskWithClient,
  type TransitionBudgetClient,
} from "./tasks/transitionBudget.js";
import * as transitionBudget from "./tasks/transitionBudget.js";
import { emitTransitionNonRequired } from "./tasks/transition-emitter.js";
import { requestEffectDeliveryPass } from "./effects/effectDeliverer.js";
import * as deliveryRepo from "../repositories/automationRuleDelivery.js";
import { logger } from "../lib/logger.js";
import type { Task } from "../models/index.js";

/** Durable system provenance for every automation release write. */
export const AUTOMATION_RELEASE_ACTOR_ID = "automation-executor";

/** Stable reason token persisted in the `released` event metadata and receipts. */
export const AUTOMATION_RELEASE_REASON = "automation_rule_action";

/** The pinned evaluated intent for one `release_assignment` checkpoint (O-B′). */
export interface ReleaseIntentPin {
  taskId: string;
  assignedAgentId: string | null;
  executionToken: string | null;
}

/** The versioned checkpoint-pin storage contract (`idempotency_key` payload). */
export function encodeReleaseIntentPin(pin: ReleaseIntentPin): string {
  return JSON.stringify({
    v: 1,
    taskId: pin.taskId,
    assignedAgentId: pin.assignedAgentId ?? null,
    executionToken: pin.executionToken ?? null,
  });
}

/** Parses a stored pin; `null` on absent/malformed payloads (fail closed). */
export function decodeReleaseIntentPin(raw: string | null): ReleaseIntentPin | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as {
      v?: unknown;
      taskId?: unknown;
      assignedAgentId?: unknown;
      executionToken?: unknown;
    };
    if (parsed?.v !== 1 || typeof parsed.taskId !== "string" || parsed.taskId.length === 0) {
      return null;
    }
    return {
      taskId: parsed.taskId,
      assignedAgentId: typeof parsed.assignedAgentId === "string" ? parsed.assignedAgentId : null,
      executionToken: typeof parsed.executionToken === "string" ? parsed.executionToken : null,
    };
  } catch {
    return null;
  }
}

function releaseFailure(index: number, error: string): AutomationActionResult {
  return { actionType: "release_assignment", actionIndex: index, status: "failed", error };
}

function budgetRefusalError(count: number, ceiling: number): string {
  return (
    `transition_budget_exhausted — the task's transition budget is spent ` +
    `(metered count ${count} >= ceiling ${ceiling}); raise ` +
    `habitats.lifecycleSettings.taskTransitionCeiling or resolve the task's lifecycle`
  );
}

/** The best-effort post-commit postlude — never part of the truthful result. */
export function runReleasePostludeBestEffort(input: {
  taskId: string;
  habitatId: string;
  oldStatus: string;
  releasedTask: Task;
  eventId: string;
}): void {
  try {
    emitTransitionNonRequired(input.taskId, "released", input.habitatId, {
      actorType: "system",
      actorId: AUTOMATION_RELEASE_ACTOR_ID,
      oldStatus: input.oldStatus as never,
      newStatus: "pending" as never,
      reason: AUTOMATION_RELEASE_REASON,
      metadata: { reason: AUTOMATION_RELEASE_REASON },
      task: input.releasedTask,
      existingEventId: input.eventId,
    });
  } catch (err) {
    // The bundle already committed: an observer failure must never turn a
    // committed release into a false failure (the boot deliverer backstops).
    logger.error(
      {
        err,
        taskId: input.taskId,
        eventId: input.eventId,
        errorCode: "automation_release_postlude_failed",
      },
      "Automation release postlude failed after commit; committed state stands",
    );
  }
  try {
    requestEffectDeliveryPass();
  } catch (err) {
    logger.error(
      { err, taskId: input.taskId, errorCode: "automation_release_delivery_nudge_failed" },
      "Automation release receipt-worker nudge failed after commit; boot deliverer backstops",
    );
  }
}

/**
 * LIVE path: release through the canonical act-tx fenced on the EVALUATED
 * epoch (`ctx.task` is the evaluation snapshot — never a fresh read). The
 * budget guard and the evaluated-assignee check run AUTHORITATIVELY inside
 * the release mutation's own `BEGIN IMMEDIATE` (composed via the shared
 * `guardTransition` WithClient primitive) — the cheap `guardTransitionTop`
 * preflight keeps the fast typed refusal, but a cross-writer race that
 * meters the task past the ceiling between preflight and mutation (or moves
 * the holder within the same epoch) is refused by the in-tx checks with
 * zero writes.
 */
export function executeReleaseAssignmentLive(
  action: AutomationAction & { type: "release_assignment" },
  index: number,
  rule: AutomationRule,
  run: AutomationRuleRun,
  ctx: AutomationEvaluationContext,
): AutomationActionResult {
  void action;
  const task = ctx.task;
  if (!task) return releaseFailure(index, "No task context available for release");
  if (!task.assignedAgentId) return releaseFailure(index, "Task is not currently assigned");

  const db = getDb();
  const habitatId = habitatIdForTaskWithClient(db, task.id);
  if (!habitatId)
    return releaseFailure(index, "Release failed — the task's habitat is unresolvable");

  // ADR-0051: the system actor is metered ("released" is a metered action);
  // the rule author is provenance only and never the actor. Cheap preflight
  // first (stale-sweep parity); the in-tx guard below is the authority.
  const preflight = transitionBudget.guardTransitionTop(task.id, habitatId, "system", "released");
  if (preflight.outcome === "refused") {
    return releaseFailure(index, budgetRefusalError(preflight.count, preflight.ceiling));
  }

  let committed: { releasedTask: Task; eventId: string };
  db.run(sql`BEGIN IMMEDIATE`);
  try {
    // ── Authoritative in-tx checks, then the seam ───────────────────────
    const budget = transitionBudget.guardTransition(db, task.id, habitatId, "system", "released");
    if (budget.outcome === "refused") {
      db.run(sql`ROLLBACK`);
      return releaseFailure(index, budgetRefusalError(budget.count, budget.ceiling));
    }
    // Evaluated-assignee vs the CURRENT in-tx row: a same-epoch holder
    // change is invisible to the token fence — refuse it here.
    const row = db
      .select({ assignedAgentId: tasks.assignedAgentId })
      .from(tasks)
      .where(eq(tasks.id, task.id))
      .get() as { assignedAgentId: string | null } | undefined;
    if (!row) {
      db.run(sql`ROLLBACK`);
      return releaseFailure(index, "Release refused — the task no longer exists");
    }
    if ((row.assignedAgentId ?? null) !== (task.assignedAgentId ?? null)) {
      db.run(sql`ROLLBACK`);
      return releaseFailure(
        index,
        `Release refused — the evaluated assignee ${task.assignedAgentId} no longer owns the task (current: ${row.assignedAgentId}); zero writes`,
      );
    }
    const result = releaseTaskWithEffectsWithClient(db, {
      taskId: task.id,
      actorId: AUTOMATION_RELEASE_ACTOR_ID,
      reason: AUTOMATION_RELEASE_REASON,
      preImage: task as unknown as Task,
      provenance: { ruleId: rule.id, runId: run.id, actionIndex: index },
    });
    if (!result) {
      db.run(sql`ROLLBACK`);
      return releaseFailure(
        index,
        "Release refused — the task's epoch or state moved between rule evaluation and the action (evaluated-epoch fence); zero writes",
      );
    }
    committed = { releasedTask: result.task, eventId: result.eventId };
    db.run(sql`COMMIT`);
  } catch (err) {
    try {
      db.run(sql`ROLLBACK`);
    } catch {
      // already rolled back
    }
    throw err;
  }

  runReleasePostludeBestEffort({
    taskId: task.id,
    habitatId,
    oldStatus: task.status,
    releasedTask: committed.releasedTask,
    eventId: committed.eventId,
  });

  return {
    actionType: "release_assignment",
    actionIndex: index,
    status: "succeeded",
    // The evaluated token is the recorded release intent (adjudication).
    result: {
      taskId: task.id,
      eventId: committed.eventId,
      executionToken: task.executionToken ?? null,
    },
  };
}

/** Discriminated outcome of one frozen-path release action execution. */
export type FrozenReleaseExecution =
  | { kind: "fenced_out" }
  | {
      kind: "committed";
      result: AutomationActionResult;
      postlude: {
        taskId: string;
        habitatId: string;
        oldStatus: string;
        releasedTask: Task;
        eventId: string;
      };
    }
  /**
   * A typed failure with zero fired writes — the caller records it through
   * the ordinary fenced checkpoint write (state `failed`). `checkpointId` is
   * the pinned row when the failure happened after pinning; `null` for
   * pre-pin guard failures (no evaluated target to pin) — the caller
   * ensures the plain checkpoint row itself, preserving the legacy shape.
   */
  | { kind: "recordable"; checkpointId: string | null; result: AutomationActionResult };

/**
 * FROZEN path: pin (O-B′) then the atomic release+proof bundle (O-C). The
 * caller MUST have already established this action is not proved-skip
 * eligible, and owns the post-commit postlude (`runReleasePostludeBestEffort`)
 * for `committed` outcomes.
 */
export function executeFrozenReleaseAssignment(input: {
  action: AutomationAction & { type: "release_assignment" };
  index: number;
  rule: AutomationRule;
  run: AutomationRuleRun;
  ctx: AutomationEvaluationContext;
  delivery: { id: string; fence: string };
  actionKey: string;
  now: string;
}): FrozenReleaseExecution {
  void input.action;
  void input.rule;
  void input.run;
  const task = input.ctx.task;
  if (!task) {
    return {
      kind: "recordable",
      checkpointId: null,
      result: releaseFailure(input.index, "No task context available for release"),
    };
  }
  if (!task.assignedAgentId) {
    return {
      kind: "recordable",
      checkpointId: null,
      result: releaseFailure(input.index, "Task is not currently assigned"),
    };
  }

  // ── O-B′: pin the EVALUATED intent before any execution ────────────────
  const pinned = deliveryRepo.ensureReleaseCheckpointWithPin({
    deliveryId: input.delivery.id,
    actionIndex: input.index,
    actionKey: input.actionKey,
    actionType: "release_assignment",
    fence: input.delivery.fence,
    pin: encodeReleaseIntentPin({
      taskId: task.id,
      assignedAgentId: task.assignedAgentId,
      executionToken: task.executionToken ?? null,
    }),
    now: input.now,
  });
  if (pinned.fencedOut || !pinned.checkpoint) return { kind: "fenced_out" };

  // Fail closed on absent/malformed/foreign pins — never an unfenced release.
  const pin = decodeReleaseIntentPin(pinned.checkpoint.idempotencyKey);
  if (!pin) {
    return {
      kind: "recordable",
      checkpointId: pinned.checkpoint.id,
      result: releaseFailure(
        input.index,
        `Release failed closed — the checkpoint's pinned intent is malformed: ${String(
          pinned.checkpoint.idempotencyKey,
        ).slice(0, 120)}`,
      ),
    };
  }
  if (pin.taskId !== task.id) {
    return {
      kind: "recordable",
      checkpointId: pinned.checkpoint.id,
      result: releaseFailure(
        input.index,
        `Release failed closed — the pinned intent targets task ${pin.taskId}, not the evaluated target ${task.id}`,
      ),
    };
  }

  // ── O-C: one outer BEGIN IMMEDIATE — fence → budget → owner → bundle → proof
  const db = getDb();
  db.run(sql`BEGIN IMMEDIATE`);
  let outcome: FrozenReleaseExecution;
  try {
    outcome = releaseBundleInTx(db, pin, input, task, pinned.checkpoint.id);
    if (outcome.kind === "committed") {
      db.run(sql`COMMIT`);
    } else {
      // fenced_out / recordable: zero bundle writes — rollback is the
      // explicit never-partial guarantee.
      db.run(sql`ROLLBACK`);
    }
  } catch (err) {
    try {
      db.run(sql`ROLLBACK`);
    } catch {
      // already rolled back
    }
    throw err;
  }
  return outcome;
}

/** The in-tx bundle body — checks first, then writes, then the proof. */
function releaseBundleInTx(
  db: TransitionBudgetClient,
  pin: ReleaseIntentPin,
  input: Parameters<typeof executeFrozenReleaseAssignment>[0],
  task: NonNullable<AutomationEvaluationContext["task"]>,
  checkpointId: string,
): FrozenReleaseExecution {
  const fail = (error: string): FrozenReleaseExecution => ({
    kind: "recordable",
    checkpointId,
    result: releaseFailure(input.index, error),
  });

  // Lease fencing BEFORE any mutation: a superseded fence writes nothing.
  const fenceRow = db
    .select({ fence: automationRuleDeliveries.leaseFence })
    .from(automationRuleDeliveries)
    .where(eq(automationRuleDeliveries.id, input.delivery.id))
    .get() as { fence: string | null } | undefined;
  if (!fenceRow || fenceRow.fence !== input.delivery.fence) {
    return { kind: "fenced_out" };
  }

  const habitatId = habitatIdForTaskWithClient(db, task.id);
  if (!habitatId) return fail("Release failed — the task's habitat is unresolvable");

  // Same-tx budget gate (ADR-0051): the system actor is metered; refusal is
  // a typed failure with zero writes and the breach escalation stays a
  // post-commit microtask owned by the guard.
  const budget = transitionBudget.guardTransition(db, task.id, habitatId, "system", "released");
  if (budget.outcome === "refused") {
    return fail(budgetRefusalError(budget.count, budget.ceiling));
  }

  // Ownership guard against the PINNED assignee on the FRESH in-tx row —
  // the token fence is blind to a both-NULL re-claim by a different agent.
  const row = db
    .select({ assignedAgentId: tasks.assignedAgentId })
    .from(tasks)
    .where(eq(tasks.id, task.id))
    .get() as { assignedAgentId: string | null } | undefined;
  if (!row) return fail("Release refused — the task no longer exists");
  if ((row.assignedAgentId ?? null) !== (pin.assignedAgentId ?? null)) {
    return fail(
      `Release refused — the pinned assignee ${pin.assignedAgentId} no longer owns the task (current: ${row.assignedAgentId}); zero writes`,
    );
  }

  // The pinned pre-image: the evaluated snapshot's payload fields carrying
  // the PINNED epoch identity (the fence the release must honor).
  const pinnedPreImage = {
    ...task,
    executionToken: pin.executionToken,
    assignedAgentId: pin.assignedAgentId,
  } as unknown as Task;

  const result = releaseTaskWithEffectsWithClient(db, {
    taskId: task.id,
    actorId: AUTOMATION_RELEASE_ACTOR_ID,
    reason: AUTOMATION_RELEASE_REASON,
    preImage: pinnedPreImage,
    provenance: {
      ruleId: input.rule.id,
      runId: input.run.id,
      deliveryId: input.delivery.id,
      actionIndex: input.index,
    },
  });
  if (!result) {
    return fail(
      "Release refused — the task's epoch or state moved away from the pinned intent (pinned-epoch fence); zero writes",
    );
  }

  // The proof: proved checkpoint citing the stamped event id, under the SAME
  // tx and lease fence. Zero affected rows rolls back the WHOLE bundle — a
  // fired-but-unproved release can never be returned as success.
  const proved = deliveryRepo.recordCheckpointOutcomeWithClient(
    {
      checkpointId,
      deliveryId: input.delivery.id,
      fence: input.delivery.fence,
      state: "proved",
      receipt: {
        taskId: task.id,
        eventId: result.eventId,
        executionToken: pin.executionToken ?? null,
      },
      terminalDisposition: "succeeded",
      now: input.now,
    },
    db,
  );
  if (!proved) {
    logger.error(
      {
        deliveryId: input.delivery.id,
        taskId: task.id,
        errorCode: "automation_release_proof_zero_rows",
      },
      "Release proof affected zero rows — rolling back the whole release bundle",
    );
    return { kind: "fenced_out" };
  }

  return {
    kind: "committed",
    result: {
      actionType: "release_assignment",
      actionIndex: input.index,
      status: "succeeded",
      result: {
        taskId: task.id,
        eventId: result.eventId,
        executionToken: pin.executionToken ?? null,
      },
    },
    postlude: {
      taskId: task.id,
      habitatId,
      oldStatus: task.status,
      releasedTask: result.task,
      eventId: result.eventId,
    },
  };
}
