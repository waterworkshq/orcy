/**
 * Plugin task operations — the READ-OR-CLAIMED restoration (REC-06 plugin
 * scope; root-adjudicated contract, superseding the historical sticky-first
 * and own-claim-priority proposals).
 *
 * A plugin run may release an existing assignment it OBSERVED earlier in the
 * same invocation (a successful habitat-checked `taskReader.getTask` read) or
 * one it claimed itself (`assignTask`), same assignment epoch only. The
 * per-invocation context records a UNIFORM set of distinct
 * `{executionToken, assignedAgentId}` pairs — no priority classes, no
 * overwrites, no history reset, own claims included. The pair values are
 * immutable SCALAR COPIES captured at observation time: no later mutation of
 * a returned Task object can forge a pin.
 *
 *   - `assignTask` routes through the claim authority (`claimWithAuthority`)
 *     with the EXPLICIT system actor `plugin:<pluginId>:<contributionId>` and
 *     the in-tx `onClaimCommitted` hook writing the `claimed` event — state +
 *     token + event commit atomically with ONE budget meter (the authority's
 *     in-tx guard; the event row IS the next count). The post-commit postlude
 *     emits from the EXISTING event (full emitter mask, no duplicate) and a
 *     postlude failure never false-fails the committed claim.
 *   - `releaseTask` resolves the observed set to exactly one still-current
 *     pair (one-arg uniqueness, or `expectedToken` selecting exactly one
 *     observed pair; the same token under multiple observed assignees —
 *     including NULL — is ambiguous and fails closed) and then runs ONE
 *     `BEGIN IMMEDIATE` transaction: the authoritative in-tx system budget
 *     guard + CURRENT habitat + epoch + assignee fences + the production
 *     release bundle (`releaseTaskWithEffectsWithClient`: CAS release write,
 *     stamped `released` event, the two required receipts — all atomic). The
 *     row is read in-tx ONLY for these guards and the effect snapshot; it
 *     never refreshes the observed pin. NULL→NULL epochs admit (the disclosed
 *     legacy ceiling); NULL→minted refuses. Post-commit the postlude runs
 *     best-effort ONCE.
 *   - `updatePriority` composes the priority update + the `updated` event in
 *     one tx (unmetered — `updated` is not in METERED_ACTIONS) with the
 *     habitat verified INSIDE the authority tx, not only at the precheck.
 *
 * Interceptor status quo (documented, nothing inferred from the NOTIFY-set
 * absence): these call sites dispatch NO pre/post lifecycle interceptors —
 * the plugin path opts the system actor + in-tx event directly at the
 * authority, mirroring the auto-assign precedent rather than the agent
 * service wrapper.
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { tasks } from "../db/schema/index.js";
import type { Task, TaskPriority } from "@orcy/shared";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import { createEventWithClient } from "../repositories/events/event-crud.js";
import * as taskRepo from "../repositories/task.js";
import {
  releaseTaskWithEffectsWithClient,
  type PluginReleaseProvenance,
} from "./effects/releaseEffects.js";
import * as transitionBudget from "./tasks/transitionBudget.js";
import { habitatIdForTaskWithClient } from "./tasks/transitionBudget.js";
import { emitTransition, emitTransitionNonRequired } from "./tasks/transition-emitter.js";
import { requestEffectDeliveryPass } from "./effects/effectDeliverer.js";
import { logger } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// Observation set
// ---------------------------------------------------------------------------

/** One observed assignment epoch — immutable scalar copies, never a row reference. */
export interface ObservedAssignmentPair {
  executionToken: string | null;
  assignedAgentId: string | null;
}

/** Per-invocation observation store: taskId → distinct observed pairs (deduped). */
export type TaskObservationSet = Map<string, ObservedAssignmentPair[]>;

/** Records one observation, deduping identical `{token, assignee}` pairs. */
export function recordTaskObservation(
  set: TaskObservationSet,
  taskId: string,
  pair: ObservedAssignmentPair,
): void {
  const existing = set.get(taskId) ?? [];
  const dup = existing.some(
    (p) =>
      (p.executionToken ?? null) === (pair.executionToken ?? null) &&
      (p.assignedAgentId ?? null) === (pair.assignedAgentId ?? null),
  );
  if (!dup) existing.push(pair);
  set.set(taskId, existing);
}

/** The explicit-epoch selector, boundary-validated. */
export interface ReleaseSelectorInput {
  expectedToken?: string | null;
}

/** Typed outcome of resolving the observed set to one releasable pair. */
export type ReleasePairSelection =
  | { kind: "selected"; pair: ObservedAssignmentPair }
  | { kind: "not_observed" }
  | { kind: "unassigned_observation" }
  | { kind: "ambiguous" }
  | { kind: "token_not_observed" }
  | { kind: "invalid_selector" };

/**
 * Resolves the observed pairs to exactly one releasable assignment. One-arg
 * (`selector === undefined` or `expectedToken === undefined`) proceeds only on
 * EXACTLY ONE observed pair with a non-null assignee; multiple distinct pairs
 * are ambiguous (typed refusal demanding `expectedToken`). An explicit token
 * (string or `null`) must match EXACTLY ONE observed pair — the same token
 * under multiple observed assignees stays ambiguous; a never-observed token
 * refuses. Empty-string tokens are invalid input.
 */
export function selectReleasePair(
  observations: ObservedAssignmentPair[],
  selector?: ReleaseSelectorInput,
): ReleasePairSelection {
  if (selector !== undefined && selector.expectedToken !== undefined) {
    const token = selector.expectedToken;
    if (typeof token !== "string" && token !== null) return { kind: "invalid_selector" };
    if (typeof token === "string" && token.length === 0) return { kind: "invalid_selector" };
    const matching = observations.filter((p) => (p.executionToken ?? null) === (token ?? null));
    if (matching.length === 0) return { kind: "token_not_observed" };
    if (matching.length > 1) return { kind: "ambiguous" };
    if (matching[0].assignedAgentId === null) return { kind: "unassigned_observation" };
    return { kind: "selected", pair: matching[0] };
  }
  if (observations.length === 0) return { kind: "not_observed" };
  if (observations.length > 1) return { kind: "ambiguous" };
  if (observations[0].assignedAgentId === null) return { kind: "unassigned_observation" };
  return { kind: "selected", pair: observations[0] };
}

// ---------------------------------------------------------------------------
// Claim — authority-routed, event-atomic, one meter
// ---------------------------------------------------------------------------

/** The system transition principal for every plugin task-op write. */
export function pluginActorId(pluginId: string, contributionId: string): string {
  return `plugin:${pluginId}:${contributionId}`;
}

export interface PluginClaimOutcome {
  /** The LEGACY flattened claim result (single flatten implementation — `taskStateMachine.claimTask`). */
  result: { success: true; task: Task } | { success: false; reason: string };
  /** The in-tx `claimed` event id (present only on success). */
  eventId?: string;
}

/**
 * Claims `taskId` for `agentId` through the PUBLIC claim seam
 * (`taskStateMachine.claimTask`) with the EXPLICIT system plugin actor — the
 * authority's own flatten mapping stays the single implementation of the
 * legacy reason vocabulary (`already_claimed`, `claim_failed`,
 * `transition_budget_exhausted`, …). The `onClaimCommitted` hook writes the
 * `claimed` event INSIDE the authority's transaction: state + token + event
 * commit atomically or not at all, with a single budget meter (the
 * authority's in-tx guard; the event row is what the next count sees). The
 * metadata preserves the assignee (`agentId`) alongside the bounded plugin
 * invocation identity so downstream consumers never misattribute a
 * plugin-assisted claim. Post-commit the postlude emits from the EXISTING
 * event (full emitter mask) best-effort — a postlude failure is logged,
 * never a false failure for a committed claim.
 */
export function claimTaskForPlugin(input: {
  pluginId: string;
  contributionId: string;
  runId: string;
  taskId: string;
  agentId: string;
}): PluginClaimOutcome {
  const actorId = pluginActorId(input.pluginId, input.contributionId);
  const metadata: Record<string, unknown> = {
    pluginId: input.pluginId,
    runId: input.runId,
    contributionId: input.contributionId,
    agentId: input.agentId,
  };
  let committedEventId: string | undefined;
  const result = taskStateMachine.claimTask(
    input.taskId,
    input.agentId,
    (tx, task) => {
      const event = createEventWithClient(tx, {
        taskId: task.id,
        actorType: "system",
        actorId,
        action: "claimed",
        fromStatus: "pending",
        toStatus: "claimed",
        metadata: { ...metadata },
      });
      committedEventId = event.id;
    },
    { actorType: "system" },
  );
  if (result.success) {
    const habitatId = taskRepo.getHabitatIdForTask(input.taskId) ?? "";
    try {
      emitTransition(input.taskId, "claimed", habitatId, {
        actorType: "system",
        actorId,
        oldStatus: "pending",
        newStatus: "claimed",
        assignedAgentId: input.agentId,
        metadata: { ...metadata },
        task: result.task,
        existingEventId: committedEventId!,
      });
    } catch (err) {
      logger.error(
        {
          err,
          taskId: input.taskId,
          eventId: committedEventId,
          errorCode: "plugin_claim_postlude_failed",
        },
        "Plugin claim postlude failed after commit; committed state stands",
      );
    }
  }
  return { result, eventId: committedEventId };
}

// ---------------------------------------------------------------------------
// Release — observed-pair fenced act-tx
// ---------------------------------------------------------------------------

/** Typed refusal vocabulary for the plugin release path (all zero-write). */
export type PluginReleaseRefusalKind =
  | "not_found"
  | "habitat_mismatch"
  | "budget_exhausted"
  | "epoch_moved"
  | "assignee_changed"
  | "state_moved";

export type PluginReleaseOutcome =
  | { ok: true; task: Task; eventId: string; habitatId: string; oldStatus: string }
  | { ok: false; refusal: PluginReleaseRefusalKind; message: string };

export interface PluginReleaseInput {
  pluginId: string;
  contributionId: string;
  runId: string;
  /** The context's bound habitat — the CURRENT in-tx habitat must still match. */
  habitatId: string;
  taskId: string;
  /** The observed pair this release resolves to (never a mutation-time read). */
  pair: ObservedAssignmentPair;
}

/**
 * The one-transaction release: `BEGIN IMMEDIATE` → the in-tx body
 * ({@link pluginReleaseBundleInTx}) → COMMIT/ROLLBACK, then the best-effort
 * postlude ONCE. Every refusal rolls back with zero writes and a typed
 * message; a throw rolls back and propagates.
 */
export function releaseTaskForPlugin(input: PluginReleaseInput): PluginReleaseOutcome {
  const db = getDb();
  let committed: Extract<PluginReleaseOutcome, { ok: true }> | null = null;
  db.run(sql`BEGIN IMMEDIATE`);
  try {
    const inTx = pluginReleaseBundleInTx(db, input);
    if (inTx.ok) {
      committed = inTx;
      db.run(sql`COMMIT`);
    } else {
      db.run(sql`ROLLBACK`);
      return inTx;
    }
  } catch (err) {
    try {
      db.run(sql`ROLLBACK`);
    } catch {
      // already rolled back
    }
    throw err;
  }
  runPluginReleasePostludeBestEffort(input, committed);
  return committed;
}

/**
 * The in-tx release body (the `releaseTaskWithEffectsWithClient` caller-tx
 * precedent): in-tx current-habitat guard, the AUTHORITATIVE system budget
 * guard (ADR-0051 — "released" is metered; no preflight shadow), the epoch
 * and assignee fences against the observed pair, then the production release
 * bundle. The current row is read ONLY for these guards and the effect
 * snapshot — never to refresh the observed pin.
 */
export function pluginReleaseBundleInTx(
  db: ReturnType<typeof getDb>,
  input: PluginReleaseInput,
): PluginReleaseOutcome {
  const { taskId, pair, habitatId } = input;
  const actorId = pluginActorId(input.pluginId, input.contributionId);
  const reason = `plugin:${input.pluginId}`;
  const provenance: PluginReleaseProvenance = {
    pluginId: input.pluginId,
    runId: input.runId,
    contributionId: input.contributionId,
  };
  const refuse = (refusal: PluginReleaseRefusalKind, message: string): PluginReleaseOutcome => ({
    ok: false,
    refusal,
    message,
  });

  // Current in-tx habitat (mutation-time ownership, not only the precheck).
  const currentHabitatId = habitatIdForTaskWithClient(db, taskId);
  if (!currentHabitatId) return refuse("not_found", `Task not found: ${taskId}`);
  if (currentHabitatId !== habitatId) {
    return refuse("habitat_mismatch", `Task ${taskId} does not belong to this habitat`);
  }

  // Authoritative in-tx system budget guard.
  const budget = transitionBudget.guardTransition(db, taskId, habitatId, "system", "released");
  if (budget.outcome === "refused") {
    return refuse(
      "budget_exhausted",
      `transition_budget_exhausted — the task's transition budget is spent ` +
        `(metered count ${budget.count} >= ceiling ${budget.ceiling}); raise ` +
        `habitats.lifecycleSettings.taskTransitionCeiling or resolve the task's lifecycle`,
    );
  }

  // Live row: guards + snapshot only — never a pin refresh.
  const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get() as
    | typeof tasks.$inferSelect
    | undefined;
  if (!row) return refuse("not_found", `Task not found: ${taskId}`);
  if ((row.executionToken ?? null) !== (pair.executionToken ?? null)) {
    return refuse(
      "epoch_moved",
      `Release refused — the task's assignment epoch moved away from the one this run observed ` +
        `(observed token ${pair.executionToken ?? "NULL"}, current ${row.executionToken ?? "NULL"}); zero writes`,
    );
  }
  if ((row.assignedAgentId ?? null) !== (pair.assignedAgentId ?? null)) {
    return refuse(
      "assignee_changed",
      `Release refused — the observed assignee ${pair.assignedAgentId} no longer owns the task ` +
        `(current: ${row.assignedAgentId}); zero writes`,
    );
  }

  // The pre-image carries the OBSERVED epoch identity over the live snapshot.
  const preImage = {
    ...row,
    executionToken: pair.executionToken,
    assignedAgentId: pair.assignedAgentId,
  } as unknown as Task;

  const result = releaseTaskWithEffectsWithClient(db, {
    taskId,
    actorType: "system",
    actorId,
    reason,
    preImage,
    provenance,
  });
  if (!result) {
    return refuse(
      "state_moved",
      `Release refused — the task's epoch or state moved away from the observed assignment ` +
        `(observed-epoch fence); zero writes`,
    );
  }
  return {
    ok: true,
    task: result.task,
    eventId: result.eventId,
    habitatId,
    oldStatus: row.status,
  };
}

/** Best-effort post-commit postlude — never part of the truthful result. */
function runPluginReleasePostludeBestEffort(
  input: PluginReleaseInput,
  committed: Extract<PluginReleaseOutcome, { ok: true }>,
): void {
  const actorId = pluginActorId(input.pluginId, input.contributionId);
  const reason = `plugin:${input.pluginId}`;
  try {
    emitTransitionNonRequired(input.taskId, "released", committed.habitatId, {
      actorType: "system",
      actorId,
      oldStatus: committed.oldStatus as never,
      newStatus: "pending" as never,
      reason,
      metadata: { reason },
      task: committed.task,
      existingEventId: committed.eventId,
    });
  } catch (err) {
    logger.error(
      {
        err,
        taskId: input.taskId,
        eventId: committed.eventId,
        errorCode: "plugin_release_postlude_failed",
      },
      "Plugin release postlude failed after commit; committed state stands",
    );
  }
  try {
    requestEffectDeliveryPass();
  } catch (err) {
    logger.error(
      { err, taskId: input.taskId, errorCode: "plugin_release_delivery_nudge_failed" },
      "Plugin release receipt-worker nudge failed after commit; boot deliverer backstops",
    );
  }
}

// ---------------------------------------------------------------------------
// updatePriority — atomic update + event, unmetered
// ---------------------------------------------------------------------------

export type PluginPriorityOutcome =
  | { ok: true; task: Task; eventId: string }
  | { ok: false; message: string };

/**
 * Updates the task priority and writes the `updated` event in ONE transaction
 * with the system plugin principal — `updated` is unmetered (not in
 * METERED_ACTIONS), the habitat is verified INSIDE the tx (current mutation-
 * time ownership, not only the precheck), and an event-write failure rolls
 * the priority change back with it. The post-commit postlude (SSE/watchers,
 * from the EXISTING event) is best-effort and never false-fails the commit.
 */
export function updatePriorityForPlugin(input: {
  pluginId: string;
  contributionId: string;
  runId: string;
  habitatId: string;
  taskId: string;
  priority: TaskPriority;
}): PluginPriorityOutcome {
  const db = getDb();
  const actorId = pluginActorId(input.pluginId, input.contributionId);
  const metadata: Record<string, unknown> = {
    changedFields: ["priority"],
    priority: input.priority,
    pluginId: input.pluginId,
    runId: input.runId,
    contributionId: input.contributionId,
  };
  db.run(sql`BEGIN IMMEDIATE`);
  let committed: { task: Task; eventId: string; habitatId: string; oldStatus: string } | null =
    null;
  try {
    const currentHabitatId = habitatIdForTaskWithClient(db, input.taskId);
    if (!currentHabitatId) {
      db.run(sql`ROLLBACK`);
      return { ok: false, message: `Task not found: ${input.taskId}` };
    }
    if (currentHabitatId !== input.habitatId) {
      db.run(sql`ROLLBACK`);
      return { ok: false, message: `Task ${input.taskId} does not belong to this habitat` };
    }
    const result = taskRepo.updateTask(input.taskId, { priority: input.priority });
    if (!result.success) {
      db.run(sql`ROLLBACK`);
      return {
        ok: false,
        message: `updatePriority failed — task ${input.taskId} not found or update rejected`,
      };
    }
    const event = createEventWithClient(db, {
      taskId: input.taskId,
      actorType: "system",
      actorId,
      action: "updated",
      fromStatus: result.task.status,
      toStatus: result.task.status,
      metadata: { ...metadata },
    });
    committed = {
      task: result.task,
      eventId: event.id,
      habitatId: currentHabitatId,
      oldStatus: result.task.status,
    };
    db.run(sql`COMMIT`);
  } catch (err) {
    try {
      db.run(sql`ROLLBACK`);
    } catch {
      // already rolled back
    }
    throw err;
  }

  try {
    emitTransition(input.taskId, "updated", committed.habitatId, {
      actorType: "system",
      actorId,
      oldStatus: committed.oldStatus,
      newStatus: committed.oldStatus,
      changedFields: ["priority"],
      metadata: { ...metadata },
      task: committed.task,
      existingEventId: committed.eventId,
    });
  } catch (err) {
    logger.error(
      {
        err,
        taskId: input.taskId,
        eventId: committed.eventId,
        errorCode: "plugin_priority_postlude_failed",
      },
      "Plugin priority postlude failed after commit; committed state stands",
    );
  }
  return { ok: true, task: committed.task, eventId: committed.eventId };
}
