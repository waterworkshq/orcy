import * as agentRepo from "../repositories/agent.js";
import * as taskRepo from "../repositories/task.js";
import { getHabitatIdForTask } from "../repositories/task.js";
import * as timeTrackingService from "./timeTrackingService.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import {
  releaseTaskWithEffects,
  releaseTaskWithEffectsWithClient,
} from "./effects/releaseEffects.js";
import { emitTransitionNonRequired } from "./tasks/transition-emitter.js";
import { guardTransition, guardTransitionTop } from "./tasks/transitionBudget.js";
import type { BudgetActorType } from "./tasks/transitionBudget.js";
import { habitatIdForTaskWithClient } from "./tasks/transitionBudget.js";
import { requestEffectDeliveryPass } from "./effects/effectDeliverer.js";
import { getDb } from "../db/index.js";
import { tasks, agents, taskReviewRequirements } from "../db/schema/index.js";
import { eq, sql } from "drizzle-orm";
import { createEventWithClient } from "../repositories/events/event-crud.js";
import { getRequirementWithClient, endOwnershipWithClient } from "../repositories/reviewSafety.js";
import { AgentDeletionBlockedError, conflict } from "../errors.js";
import type { Agent, AgentStatus, Task } from "../models/index.js";
import { logger } from "../lib/logger.js";

/**
 * Creates a new {@link Agent} and returns it with a freshly generated
 * plaintext API key.
 */
export function createAgent(input: Parameters<typeof agentRepo.createAgent>[0]): {
  agent: Omit<Agent, "apiKeyHash">;
  plainApiKey: string;
} {
  const result = agentRepo.createAgent(input);
  return result;
}

/**
 * Returns the {@link Agent} with the given id, or `null` if no such agent exists.
 */
export function getAgent(agentId: string): Omit<Agent, "apiKeyHash"> | null {
  return agentRepo.getAgentById(agentId);
}

/**
 * Lists all {@link Agent}s, optionally filtered by `status` and `domain`.
 */
export function listAgents(status?: string, domain?: string): Omit<Agent, "apiKeyHash">[] {
  const agents = agentRepo.listAgents();
  return agents.filter((a) => {
    if (status && a.status !== status) return false;
    if (domain && a.domain !== domain) return false;
    return true;
  });
}

/**
 * Lists {@link Agent}s with their current {@link Task} title joined in, applying
 * the same `status`/`domain` filters as {@link listAgents}.
 */
export function listAgentsWithTasks(
  status?: string,
  domain?: string,
): {
  agent: Omit<Agent, "apiKeyHash">;
  currentTaskTitle: string | null;
}[] {
  const agents = listAgents(status, domain);
  const taskIds = [...new Set(agents.filter((a) => a.currentTaskId).map((a) => a.currentTaskId!))];
  const taskMap = new Map<string, string>();
  for (const task of taskRepo.getTasksByIds(taskIds)) {
    taskMap.set(task.id, task.title);
  }
  return agents.map((agent) => ({
    agent,
    currentTaskTitle: agent.currentTaskId ? (taskMap.get(agent.currentTaskId) ?? null) : null,
  }));
}

/**
 * Updates an {@link Agent} and returns the updated record. Publishes an
 * `agent.status_changed` SSE event on the `global` channel when the agent's
 * status field actually changes.
 */
export function updateAgent(
  agentId: string,
  input: Parameters<typeof agentRepo.updateAgent>[1],
): Omit<Agent, "apiKeyHash"> | null {
  const current = agentRepo.getAgentById(agentId);
  const agent = agentRepo.updateAgent(agentId, input);

  if (agent && current && agent.status !== current.status) {
    sseBroadcaster.publish("global", {
      type: "agent.status_changed",
      data: { agentId, status: agent.status },
    });
  }

  return agent;
}

/**
 * The real operator principal of an agent deletion, threaded end-to-end:
 * the admin route passes the authenticated human (`request.user.id`), the
 * self route passes the agent's own id, and hypothetical non-operator
 * callers get the bare system actor. Never a body-supplied flag — the
 * mapping is request-auth-derived only. No credentials are ever recorded.
 */
export interface AgentDeletionActor {
  actorType: BudgetActorType;
  actorId: string;
}

/** Post-commit postlude payload for one committed release bundle. */
interface ReleasePostlude {
  taskId: string;
  habitatId: string;
  oldStatus: string;
  task: Task;
  eventId: string;
}

/**
 * Deletes an {@link Agent} ATOMICALLY (REC-06 — all-or-nothing, settled user
 * policy). ONE outer `BEGIN IMMEDIATE` writer transaction composes, in order:
 *
 *   1. existence read (missing agent → 204-style no-op return, preserved);
 *   2. eligibility: any assigned `submitted|rejected` holding BLOCKS the
 *      deletion (typed 409 `deletion_blocked_review_in_flight`) BEFORE the
 *      budget preflight and before ANY write — review-in-flight must survive;
 *   3. budget preflight per `claimed|in_progress` holding —
 *      `guardTransition` on the in-tx client with the REAL actor: the admin
 *      human is unmetered by the standing exemption; a self-delete refusal
 *      REFUSES the whole deletion (typed 409 `deletion_blocked_budget`;
 *      the guard's emit-once breach escalation is disclosure-only and fires
 *      post-settle via queueMicrotask — it is not a task/agent state write);
 *   4. release bundles: EVERY `claimed|in_progress` holding goes through
 *      `releaseTaskWithEffectsWithClient` on the SAME tx — the `released`
 *      event (stamped with the real actor) plus the
 *      `{workflow_gates, failure_context}` receipts land in-tx; a bundle
 *      refusal aborts the whole deletion (epoch/state moved — rollback);
 *   5. terminal/legacy unassign: every OTHER row still carrying
 *      `assignedAgentId` (done/approved/failed/legacy pending-assigned
 *      residue) keeps its status and history, gains an `updated` audit
 *      event (actor + `deletedAgentId` metadata) BEFORE the FK clear, then
 *      clears the reference — `updated` is unmetered (METERED_ACTIONS
 *      census), so no budget question arises here;
 *   6. inbound delegation offers (`delegatedToAgentId` = the doomed id) are
 *      cleared with an `updated` audit event (`delegationCancelled`
 *      metadata, existing canonical action — no new event enum); owners'
 *      assignments and current tasks are untouched;
 *   7. PRE-DELETE assert + agent-row delete (`agentRepo.deleteAgentWithClient`)
 *      — zero remaining references verified under the writer lock before the
 *      DELETE; cascades sessions/aux rows via FK, PRESERVES task/review
 *      history (agent-reviewer plaintext rows are a known retained
 *      limitation — auto-removal would silently weaken review gates).
 *
 * Every refusal path (eligibility, budget, mid-composition throw) leaves
 * task/mapping/agent rows byte-identical — the outer tx rolls back; no
 * partial release exists by construction. AFTER commit, each release bundle
 * gets the shared postlude ONLY outside the tx: the non-required emitter
 * mask plus the receipt-worker nudge (`requestEffectDeliveryPass`) — the
 * required effects already flowed in-tx through the event row + receipts.
 */
export function deleteAgent(
  agentId: string,
  actor: AgentDeletionActor = { actorType: "system", actorId: "agent-deletion" },
): void {
  const db = getDb();
  const now = new Date().toISOString();
  type TaskRow = typeof tasks.$inferSelect;

  const postludes = db.transaction(
    (tx) => {
      const agentRow = tx
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, agentId))
        .get();
      if (!agentRow) return [] as ReleasePostlude[]; // 204 no-op contract preserved

      // Authoritative in-tx holdings census (single writer lock — no claim
      // or delegation can interleave with this read).
      const holdings = tx.select().from(tasks).where(eq(tasks.assignedAgentId, agentId)).all() as
        | TaskRow[]
        | undefined;
      const assigned = holdings ?? [];

      // ── 2. Eligibility: review-in-flight blocks BEFORE anything else ────
      const blocked = assigned.filter((t) => t.status === "submitted" || t.status === "rejected");
      if (blocked.length > 0) {
        throw new AgentDeletionBlockedError(
          "deletion_blocked_review_in_flight",
          `Agent not deleted: ${blocked.length} task(s) in submitted/rejected state are still assigned; resolve the reviews first.`,
          {
            blockedTasks: blocked.map((t) => ({ id: t.id, title: t.title, status: t.status })),
          },
        );
      }

      const claimable = assigned.filter(
        (t) => t.status === "claimed" || t.status === "in_progress",
      );

      // ── 3. Budget preflight per holding (in-tx authoritative count) ─────
      for (const t of claimable) {
        const habitatId = habitatIdForTaskWithClient(tx, t.id);
        if (!habitatId) continue; // the bundle below refuses on missing habitat
        const outcome = guardTransition(tx, t.id, habitatId, actor.actorType, "released");
        if (outcome.outcome === "refused") {
          throw new AgentDeletionBlockedError(
            "deletion_blocked_budget",
            "Agent not deleted: the transition budget is exhausted for a held task; an administrator must perform the cleanup.",
            {
              blockedTasks: [
                {
                  id: t.id,
                  title: t.title,
                  status: t.status,
                  count: outcome.count,
                  ceiling: outcome.ceiling,
                },
              ],
            },
          );
        }
      }

      // ── 4. Release bundles — every claimable holding, same tx ───────────
      const bundles: ReleasePostlude[] = [];
      for (const t of claimable) {
        const habitatId = habitatIdForTaskWithClient(tx, t.id);
        if (!habitatId) {
          throw conflict("Agent deletion aborted: a held task has no resolvable habitat.", {
            taskId: t.id,
          });
        }
        const result = releaseTaskWithEffectsWithClient(tx, {
          taskId: t.id,
          actorType: actor.actorType,
          actorId: actor.actorId,
          reason: "agent_deletion",
          preImage: t as unknown as Task,
        });
        if (!result) {
          throw conflict("Agent deletion aborted: a held task changed state mid-deletion; retry.", {
            taskId: t.id,
          });
        }
        bundles.push({
          taskId: t.id,
          habitatId,
          oldStatus: t.status,
          task: result.task,
          eventId: result.eventId,
        });
      }

      // ── 5. Terminal/legacy unassign in place (status NEVER changes) ─────
      const terminal = assigned.filter((t) => t.status !== "claimed" && t.status !== "in_progress");
      for (const t of terminal) {
        createEventWithClient(tx, {
          taskId: t.id,
          actorType: actor.actorType,
          actorId: actor.actorId,
          action: "updated",
          fromStatus: t.status as never,
          toStatus: t.status as never,
          metadata: {
            agentDeleted: true,
            deletedAgentId: agentId,
            operator: { actorType: actor.actorType, actorId: actor.actorId },
            // Actual before-value evidence for the token normalization the
            // unassign write performs (after is always NULL); terminal rows
            // normally already carry NULL — no bogus status transition.
            executionTokenBefore: t.executionToken ?? null,
          },
        });
        tx.update(tasks)
          .set({
            assignedAgentId: null,
            executionToken: null, // ownership ref ends → token goes with it (R4 invariant; terminal rows are normally already NULL)
            updatedAt: now,
            version: sql`${tasks.version} + 1`,
          })
          .where(eq(tasks.id, t.id))
          .run();

        // Fixup-7: FULL intended-postimage verify of this writer's own
        // effects before ANY review leg. This writer intends exactly:
        // assignedAgentId=null, executionToken=null, updatedAt=now,
        // version+1, and NOTHING else — status must be the unchanged
        // terminal pre-image, the remote owner must be untouched, and every
        // other field (lifecycle clocks, provenance pointers, metrics, retry)
        // must equal the pre-image. Any deviation (skipped write, partial or
        // injected rewrite) ABORTS the whole agent deletion.
        const verifyRow = tx
          .select()
          .from(tasks)
          .where(eq(tasks.id, t.id))
          .get() as
          | (typeof tasks.$inferSelect & {
              updatedAt: string;
            })
          | undefined;
        if (!verifyRow) {
          throw conflict("Agent deletion aborted: terminal unassign verify lost the row; retry.", {
            taskId: t.id,
          });
        }
        const unassignNoop =
          t.assignedAgentId === null && t.executionToken === null;
        if (!unassignNoop) {
          const unassignWon =
            verifyRow.assignedAgentId === null &&
            verifyRow.executionToken === null &&
            verifyRow.status === t.status &&
            verifyRow.remoteAssignedParticipantId === t.remoteAssignedParticipantId &&
            verifyRow.lastFailureEventId === t.lastFailureEventId &&
            verifyRow.lastReleaseEventId === t.lastReleaseEventId &&
            verifyRow.lastActivityAt === t.lastActivityAt &&
            verifyRow.nextRetryAt === t.nextRetryAt &&
            verifyRow.rejectedCount === t.rejectedCount &&
            verifyRow.rejectionReason === t.rejectionReason &&
            verifyRow.completedAt === t.completedAt &&
            verifyRow.claimedAt === t.claimedAt &&
            verifyRow.startedAt === t.startedAt &&
            verifyRow.submittedAt === t.submittedAt &&
            verifyRow.actualMinutes === t.actualMinutes &&
            verifyRow.cycleTimeMinutes === t.cycleTimeMinutes &&
            verifyRow.leadTimeMinutes === t.leadTimeMinutes &&
            verifyRow.estimationAccuracy === t.estimationAccuracy &&
            verifyRow.version === t.version + 1;
          if (!unassignWon) {
            throw conflict("Agent deletion aborted: terminal unassign CAS lost; retry.", {
              taskId: t.id,
            });
          }
        }

        // Review-safety custody ending (same tx) — UNCONDITIONAL on the task
        // write's shape: a row whose current typed requirement claimant IS the
        // deleted agent has its claimant/generation/override invalidated
        // (baseline restored immediately) and its approval proof cleared —
        // stale proof must never satisfy approved→done after deletion. When
        // custody is already ambiguous (assignee set but requirement claimant
        // absent/different) the contract's rule still applies: stay unknown,
        // clear any stale proof, fabricate no typed custody. A pre-read no-op
        // (custody already gone) does NOT introduce a skip path here: a
        // matching claimant is still invalidated and stale proof is still
        // cleared, exactly as when the write wins.
        const requirement = getRequirementWithClient(tx, t.id);
        if (requirement) {
          if (requirement.claimantType === "local_agent" && requirement.claimantId === agentId) {
            endOwnershipWithClient(tx, t.id, { advanceGeneration: true });
          } else if (requirement.approvedGeneration !== null) {
            tx.update(taskReviewRequirements)
              .set({ approvedGeneration: null, updatedAt: now })
              .where(eq(taskReviewRequirements.taskId, t.id))
              .run();
          }
        }
      }

      // ── 6. Inbound delegation offers: clear + audit, owner unharmed ─────
      const offers = tx.select().from(tasks).where(eq(tasks.delegatedToAgentId, agentId)).all() as
        | TaskRow[]
        | undefined;
      for (const t of offers ?? []) {
        createEventWithClient(tx, {
          taskId: t.id,
          actorType: actor.actorType,
          actorId: actor.actorId,
          action: "updated",
          fromStatus: t.status as never,
          toStatus: t.status as never,
          metadata: {
            delegationCancelled: true,
            dueTo: "agent_deletion",
            deletedAgentId: agentId,
            operator: { actorType: actor.actorType, actorId: actor.actorId },
          },
        });
        tx.update(tasks)
          .set({
            delegatedToAgentId: null,
            updatedAt: now,
            version: sql`${tasks.version} + 1`,
          })
          .where(eq(tasks.id, t.id))
          .run();
      }

      // ── 7. PRE-DELETE assert + the agent-row delete (same tx) ───────────
      agentRepo.deleteAgentWithClient(tx, agentId);

      return bundles;
    },
    { behavior: "immediate" },
  );

  // Post-commit ONLY: the shared release postlude (non-required emitter mask
  // + the receipt-worker nudge) — never inside the tx. Each bundle's postlude
  // is ISOLATED (F2): the deletion already committed, so an observer failure
  // here must never manufacture a false HTTP failure — it is recorded with a
  // fixed code + the task/event ids and the remaining postludes + nudges
  // still run (receipts are durable; the boot deliverer backstops them).
  for (const p of postludes) {
    try {
      emitTransitionNonRequired(p.taskId, "released", p.habitatId, {
        actorType: actor.actorType,
        actorId: actor.actorId,
        oldStatus: p.oldStatus as never,
        newStatus: "pending" as never,
        reason: "agent_deletion",
        metadata: { reason: "agent_deletion" },
        task: p.task,
        existingEventId: p.eventId,
      });
    } catch (err) {
      logger.error(
        { err, taskId: p.taskId, eventId: p.eventId, errorCode: "agent_deletion_postlude_failed" },
        "Agent-deletion release postlude failed after commit; committed state stands",
      );
    }
    try {
      requestEffectDeliveryPass();
    } catch (err) {
      logger.error(
        { err, taskId: p.taskId, errorCode: "agent_deletion_delivery_nudge_failed" },
        "Agent-deletion receipt-worker nudge failed after commit; boot deliverer backstops",
      );
    }
  }
}

/**
 * Records a heartbeat for an agent and, when a `taskId` is supplied and that
 * {@link Task} is in `claimed` or `in_progress` state, records 5 minutes of
 * work time tracking. Publishes an `agent.heartbeat` SSE event on the `global`
 * channel and returns the agent's current {@link AgentStatus} along with a
 * fixed 300s next-check-in hint.
 */
export function heartbeat(
  agentId: string,
  taskId?: string,
): { status: AgentStatus; nextCheckIn: number; taskStatus: string | null } | null {
  const agent = agentRepo.heartbeat(agentId, taskId);
  if (!agent) return null;

  sseBroadcaster.publish("global", {
    type: "agent.heartbeat",
    data: { agentId, taskId: taskId ?? null },
  });

  let taskStatus: string | null = null;
  if (taskId) {
    const task = taskRepo.getTaskById(taskId);
    taskStatus = task?.status ?? null;

    if (task && (task.status === "in_progress" || task.status === "claimed")) {
      try {
        timeTrackingService.recordWork(taskId, agentId, 5, task.status);
      } catch (err) {
        logger.warn({ err, taskId, agentId }, "Failed to record work during heartbeat");
      }
    }
  }

  return {
    status: agent.status,
    nextCheckIn: 300,
    taskStatus,
  };
}

/**
 * Resolves the {@link Agent} that owns the given plaintext API key, or `null`
 * if no match.
 */
export function getAgentByApiKey(plainKey: string): Omit<Agent, "apiKeyHash"> | null {
  return agentRepo.getAgentByApiKey(plainKey);
}

/**
 * Returns the {@link Agent} together with its current {@link Task} in a single
 * call, or `null` if the agent does not exist.
 */
export function getAgentWithTask(agentId: string): {
  agent: Omit<Agent, "apiKeyHash">;
  currentTask: Task | null;
} | null {
  const agent = agentRepo.getAgentById(agentId);
  if (!agent) return null;

  const currentTask = agent.currentTaskId ? taskRepo.getTaskById(agent.currentTaskId) : null;
  return { agent, currentTask };
}

/** Durable system provenance for every stale-sweep release write. */
export const STALE_SWEEP_ACTOR = "stale-sweep";

/**
 * Marks agents that have not checked in within `thresholdMinutes` as
 * `offline` and releases their current {@link Task} through the canonical
 * release seam (`releaseTaskWithEffects`) — the `released` event, the
 * `{workflow_gates, failure_context}` receipts (ADR-0005 `on_fail`
 * heartbeat-lost machinery), and the non-required mask all land on this
 * path now (REC-06; the plain repo release with no event is gone).
 *
 * Per-candidate control flow (guards cheap→authoritative):
 *   1. candidacy: stale heartbeat ∧ (¬offline ∨ retained pointer) — a
 *      budget-refused candidate stays discoverable next tick (the retained
 *      pointer IS the pending-retry state; no new table);
 *   2. offline marking: sweep-only CAS on the still-stale heartbeat that
 *      KEEPS `currentTaskId` (a revived agent is never flipped offline; the
 *      general `setAgentOffline` stays untouched for other callers). The
 *      `agent.status_changed` SSE fires only on the first flip — a
 *      point-in-time notification, no finality claim;
 *   3. release: cheap stale/pointer/task checks BEFORE the budget
 *      preflight, then the act-tx's in-tx {assignee, pointer, heartbeat}
 *      guard is the FINAL authority. Refusal (epoch ABA, pointer moved,
 *      revival, budget) = zero release-bundle writes, task stays claimed,
 *      the pointer keeps the candidate discoverable next tick. A budget
 *      refusal retains everything but the guard's own emit-once escalation
 *      (event + SSE + human notification); for this shape (task claimed by
 *      the dead agent) the operative remedy is raising the habitat's
 *      `lifecycleSettings.taskTransitionCeiling` — the release route is
 *      agent-key gated, so a human cannot release an agent-claimed task;
 *   4. after a successful release: the exact three-part postlude
 *      (non-required mask + eager deliverer pass) and THEN best-effort
 *      pointer cleanup — atomic under `BEGIN IMMEDIATE` (agent id ∧
 *      observed pointer ∧ still-stale heartbeat ∧ NOT a live claim owned by
 *      this agent): a re-claim landing in the commit→cleanup gap retains
 *      the pointer for the next tick's guard path, while a cleanup throw is
 *      logged and never skips the postlude (receipts are durable and the
 *      boot deliverer backstops them).
 *
 * Pre-existing limitation, unchanged: the `currentTaskId` single pointer is
 * the release scope — a stale agent's non-current claimed tasks are
 * untouched. Terminal/foreign/pending-unowned pointers are cleanup-only
 * (never a release, never a new assignment).
 */
export function releaseStaleTasks(thresholdMinutes = 30): void {
  const candidates = agentRepo.getStaleSweepCandidates(thresholdMinutes);
  const thresholdIso = new Date(Date.now() - thresholdMinutes * 60 * 1000).toISOString();

  for (const candidate of candidates) {
    try {
      processStaleCandidate(candidate, thresholdIso);
    } catch (err) {
      // Never abort the sweep on one candidate — the next tick retries with
      // the candidate fully retained (no swallowed false completion: the
      // release bundle either committed atomically or not at all).
      logger.error(
        { err, agentId: candidate.id, errorCode: "stale_sweep_candidate_failed" },
        "Stale sweep candidate failed; next sweep retries",
      );
    }
  }
}

function processStaleCandidate(candidate: Omit<Agent, "apiKeyHash">, thresholdIso: string): void {
  // Numeric recheck on the candidate snapshot (the SQL `datetime()` filter
  // already excluded malformed values; this is the JS parity recheck).
  // Unparseable/absent → skip (fail fresh, fixed code); future/fresh → skip.
  const beat = Date.parse(candidate.lastHeartbeat ?? "");
  if (Number.isNaN(beat)) {
    logger.error(
      { agentId: candidate.id, errorCode: "stale_sweep_heartbeat_unparseable" },
      "Agent heartbeat unparseable; skipping stale sweep candidacy",
    );
    return;
  }
  if (beat >= Date.parse(thresholdIso)) return; // revived/future: not stale

  // ── 2. Offline marking — CAS keeps the pointer, SSE only on first flip ──
  if (candidate.status !== "offline") {
    const flipped = agentRepo.markAgentOfflineKeepingTask(candidate.id, thresholdIso);
    if (!flipped) return; // revival race: never flip a revived agent

    sseBroadcaster.publish("global", {
      type: "agent.status_changed",
      data: { agentId: candidate.id, status: "offline" },
    });
  }
  // Already-offline pointer-retention candidate: skip the mark and the SSE —
  // release eligibility does not require re-marking.

  // ── 3. Cheap checks BEFORE the budget preflight (P6 ordering) ───────────
  const pointer = candidate.currentTaskId;
  if (!pointer) return; // no-task stale agent: marked once, nothing to release

  const task = taskRepo.getTaskById(pointer) as Task | null;
  if (!task) {
    // Dangling pointer (task deleted): residue cleanup only.
    agentRepo.clearAgentTaskPointerIfStale(candidate.id, pointer, thresholdIso);
    return;
  }
  const releasable = task.status === "claimed" || task.status === "in_progress";
  const foreign = task.assignedAgentId !== candidate.id;
  if (!releasable || foreign) {
    // Terminal / foreign / pending-unowned residue: cleanup-only under the
    // same-observed-value guard — never a release, never a foreign-task
    // mutation, never a new assignment.
    agentRepo.clearAgentTaskPointerIfStale(candidate.id, pointer, thresholdIso);
    return;
  }

  const habitatId = getHabitatIdForTask(task.id);
  if (!habitatId) {
    agentRepo.clearAgentTaskPointerIfStale(candidate.id, pointer, thresholdIso);
    return;
  }

  // Budget preflight AFTER the cheap checks — a revived agent's task never
  // reaches it; `released` is metered (ADR-0051). Refusal retains the
  // pointer + candidacy; the guard's emit-once escalation is its own write.
  const budget = guardTransitionTop(task.id, habitatId, "system", "released");
  if (budget.outcome === "refused") return;

  // ── The authority act-tx — in-tx guard is FINAL (revival/pointer/owner) ─
  const result = releaseTaskWithEffects({
    taskId: task.id,
    actorId: STALE_SWEEP_ACTOR,
    reason: "stale_timeout",
    preImage: task,
    guard: { expectedAssigneeAgentId: candidate.id, staleHeartbeatBefore: thresholdIso },
  });
  if (!result) return; // race refusal: disposition deferred to the next tick

  // ── 4. Three-part postlude (exact drive composition) + safe cleanup ────
  emitTransitionNonRequired(task.id, "released", habitatId, {
    actorType: "system",
    actorId: STALE_SWEEP_ACTOR,
    oldStatus: task.status,
    newStatus: "pending",
    reason: "stale_timeout",
    metadata: { reason: "stale_timeout" },
    task: result.task,
    existingEventId: result.eventId,
  });
  requestEffectDeliveryPass();

  try {
    agentRepo.clearAgentTaskPointerIfStale(candidate.id, pointer, thresholdIso);
  } catch (err) {
    // Best-effort post-commit: the release bundle is already durable; the
    // pointer becomes a cleanup-only residue the next tick clears.
    logger.error(
      {
        err,
        agentId: candidate.id,
        taskId: pointer,
        errorCode: "stale_sweep_pointer_cleanup_failed",
      },
      "Stale sweep pointer cleanup failed; next sweep clears the residue",
    );
  }
}
