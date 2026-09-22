import * as agentRepo from "../repositories/agent.js";
import * as taskRepo from "../repositories/task.js";
import { getHabitatIdForTask } from "../repositories/task.js";
import * as timeTrackingService from "./timeTrackingService.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { releaseTaskWithEffects } from "./effects/releaseEffects.js";
import { emitTransitionNonRequired } from "./tasks/transition-emitter.js";
import { guardTransitionTop } from "./tasks/transitionBudget.js";
import { requestEffectDeliveryPass } from "./effects/effectDeliverer.js";
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
 * Deletes an {@link Agent} and, if the agent currently holds one, releases its
 * {@link Task} with reason `system`.
 */
export function deleteAgent(agentId: string): void {
  const agent = agentRepo.getAgentById(agentId);
  if (!agent) return;

  if (agent.currentTaskId) {
    taskRepo.releaseTask(agent.currentTaskId, "system");
  }

  agentRepo.deleteAgent(agentId);
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
