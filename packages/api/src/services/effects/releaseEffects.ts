/**
 * Daemon worker contract — the release act-tx (REC-05, N3).
 *
 * The SEPARATE release seam: it is its own `BEGIN IMMEDIATE` transaction
 * with its own in-tx revalidation and must NEVER be routed through the
 * plain repo `taskStateMachine.releaseTask` path (that path has no receipts,
 * no event-in-tx ownership, and clears the provenance pointer it would need
 * to set). One transaction owns, atomically:
 *   1. the epoch revalidation — same B1 discipline as the fail act-tx: the
 *      row's stored token must equal the PRE-IMAGE's conveyed epoch (the
 *      session's execution token — never a mutation-time fresh read);
 *   2. the CAS release write `status IN ('claimed','in_progress') → 'pending'`,
 *      `assignedAgentId=NULL`, token cleared, `last_release_event_id=:eventId`;
 *   3. the `released` event row in-tx, stamped with the winning row's token;
 *   4. receipts for EXACTLY `{workflow_gates, failure_context}` (the closed
 *      census — `NOTIFY_TASK_EVENT_ACTIONS` excludes `released` so no
 *      detector/skill consumer exists, and `ACTION_EFFECTS.released` has no
 *      `triggerRetry` so no ladder receipt exists) with the causal snapshot
 *      carrying `action: "released"`.
 *
 * Post-commit the caller runs ONLY the non-required mask
 * (`emitTransitionNonRequired`) + the eager deliverer pass — the shared
 * postlude, no new framework.
 *
 * Refusal (status moved / epoch moved / task gone) returns `null` with ZERO
 * release-bundle writes — the caller's branch logic decides what that means
 * (`no_op_epoch_mismatch` / `no_op_task_terminal`); there is deliberately NO
 * failover to another seam.
 */
import { getDb } from "../../db/index.js";
import { tasks, taskEvents, taskWorkflowGates, workflows, agents } from "../../db/schema/index.js";
import { eq, and, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { createEventWithClient } from "../../repositories/events/event-crud.js";
import { insertReceipt, type EffectDbClient } from "../../repositories/effectReceipts.js";
import { habitatIdForTaskWithClient } from "../tasks/transitionBudget.js";
import type { Task } from "../../models/index.js";

/** The two required consumers enqueued per `released` event (closed census). */
export const RELEASED_EFFECT_CONSUMERS = ["workflow_gates", "failure_context"] as const;

/**
 * Bounded typed provenance for automation-driven releases (REC-06 F2): the
 * rule lineage persisted on the actual `released` event and its receipts.
 * Omitted entirely by the existing seam callers (stale sweep, recovery
 * drive, agent deletion) — their events keep the exact legacy shape.
 */
export interface ReleaseProvenance {
  ruleId: string;
  runId?: string | null;
  deliveryId?: string | null;
  actionIndex?: number | null;
}

export interface ReleaseWithEffectsResult {
  task: Task;
  eventId: string;
}

/**
 * Optional server-only release guard (the stale sweep's authority fences,
 * evaluated INSIDE the act-tx alongside the epoch fence — D2/D3):
 *   - `expectedAssigneeAgentId` — the task row's `assignedAgentId` must
 *     equal this agent exactly (a corrupted/foreign pointer never releases
 *     another agent's task), and the agent row must still exist;
 *   - `staleHeartbeatBefore` — the agent's `lastHeartbeat`, re-read fresh
 *     in-tx, must still parse and be older than this ISO threshold. A
 *     revived (fresh) or unparseable heartbeat refuses with zero writes —
 *     same-epoch revival is invisible to the token fence, this closes it.
 * The sweep additionally requires `agents.currentTaskId === taskId` in-tx —
 * the epoch fence cannot see pointer movement within one epoch.
 * The recovery drive passes nothing (sole-caller contract byte-preserved).
 */
export interface ReleaseStaleGuard {
  expectedAssigneeAgentId: string;
  staleHeartbeatBefore: string;
}

/**
 * The act-tx. Returns the released task + the stamped event id, or `null` on
 * any refusal (zero release-bundle writes).
 */
export function releaseTaskWithEffects(input: {
  taskId: string;
  /**
   * Durable system provenance — the recovery drive and the stale sweep are
   * the two callers (both system actors).
   */
  actorId: string;
  reason: string;
  /**
   * Pre-tx pre-image whose `executionToken` is the INTENDED epoch (the
   * session's conveyed token — never re-fetched from current task state).
   * A task re-claimed under a new epoch refuses with zero writes; both-NULL
   * is the accepted legacy degradation (the drive's legacy gate no-ops long
   * before reaching here in practice).
   */
  preImage: Task;
  /** Optional server-only guard — see {@link ReleaseStaleGuard}. */
  guard?: ReleaseStaleGuard;
  /** Optional bounded rule provenance (see {@link ReleaseProvenance}). */
  provenance?: ReleaseProvenance;
}): ReleaseWithEffectsResult | null {
  return getDb().transaction((tx) => releaseTaskWithEffectsWithClient(tx, input), {
    behavior: "immediate",
  });
}

/** Input for the client-parameterized composition form of the release bundle. */
export interface ReleaseWithEffectsWithClientInput {
  taskId: string;
  /**
   * The REAL transition principal. Defaults to `"system"` (the standalone
   * act-tx callers — recovery drive, stale sweep — stay byte-identical);
   * the atomic agent-deletion composition threads the actual operator
   * (admin human / self agent) so events, receipts, and the meter all see
   * the true actor.
   */
  actorType?: "human" | "agent" | "system" | "remote_human" | "remote_orcy" | "remote_pod";
  /** Durable provenance — the principal's id (never a credential). */
  actorId: string;
  reason: string;
  /** Pre-image whose `executionToken` is the INTENDED epoch (see above). */
  preImage: Task;
  /** Optional server-only guard — see {@link ReleaseStaleGuard}. */
  guard?: ReleaseStaleGuard;
  /** Optional bounded rule provenance (see {@link ReleaseProvenance}). */
  provenance?: ReleaseProvenance;
}

/**
 * The caller-tx composition form of the release bundle (`submitWithAuthorityClient`
 * precedent): the SAME act — epoch revalidation, CAS release write, stamped
 * `released` event, the two required receipts — executed on the CALLER's open
 * transaction instead of opening its own `BEGIN IMMEDIATE` (nested BEGIN is
 * forbidden on both the sql.js and better-sqlite3 drivers). The caller owns
 * atomicity: any refusal returns `null` with zero writes; any throw (the CAS
 * verification) propagates and rolls back the CALLER's transaction.
 */
export function releaseTaskWithEffectsWithClient(
  tx: EffectDbClient,
  input: ReleaseWithEffectsWithClientInput,
): ReleaseWithEffectsResult | null {
  const { taskId, actorId, reason, preImage, guard, provenance } = input;
  const actorType = input.actorType ?? "system";
  const now = new Date().toISOString();
  const eventId = uuid();
  const receiptBase = uuid();

  // Freeze habitat at the AUTHORITATIVE in-tx read — a missing habitat is
  // a REFUSAL (zero bundle writes), mirroring the fail act-tx.
  const habitatId = habitatIdForTaskWithClient(tx, taskId);
  if (!habitatId) return null;

  // ── 1. Epoch revalidation (B1 discipline, intended-epoch) ────────────
  const row = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as
    | { status: string; executionToken: string | null; assignedAgentId: string | null }
    | undefined;
  if (!row) return null;
  if (row.status !== "claimed" && row.status !== "in_progress") return null;
  if ((row.executionToken ?? null) !== (preImage.executionToken ?? null)) return null;

  // ── 1b. Server-only stale-sweep guard (D2/D3) — final authority ──────
  // Evaluated inside the act-tx on FRESH reads: owner equality, the
  // agent's pointer still naming this task, and the heartbeat still
  // stale. Malformed heartbeat fails FRESH (refuse) — never compared as
  // a string, never silently treated stale.
  if (guard) {
    if (row.assignedAgentId !== guard.expectedAssigneeAgentId) return null;
    const agentRow = tx
      .select({ currentTaskId: agents.currentTaskId, lastHeartbeat: agents.lastHeartbeat })
      .from(agents)
      .where(eq(agents.id, guard.expectedAssigneeAgentId))
      .get() as { currentTaskId: string | null; lastHeartbeat: string | null } | undefined;
    if (!agentRow) return null;
    if (agentRow.currentTaskId !== taskId) return null; // pointer moved
    const beat = Date.parse(agentRow.lastHeartbeat ?? "");
    if (Number.isNaN(beat)) return null; // unparseable → fail fresh
    if (beat >= Date.parse(guard.staleHeartbeatBefore)) return null; // revived
  }

  // ── 2. CAS release write + the release-provenance pointer ────────────
  tx.update(tasks)
    .set({
      assignedAgentId: null,
      status: "pending",
      claimedAt: null,
      startedAt: null,
      executionToken: null,
      lastReleaseEventId: eventId,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(and(eq(tasks.id, taskId), sql`${tasks.status} IN ('claimed', 'in_progress')`))
    .run();
  // Cross-backend CAS verification: the re-read status is the authority
  // (sql.js run() carries no changes); a mismatch aborts by throwing.
  const verify = tx
    .select({ status: tasks.status, ptr: tasks.lastReleaseEventId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  if (!verify || verify.status !== "pending" || verify.ptr !== eventId) {
    throw new Error("release_actx_cas_lost");
  }

  // ── 3. The stamped `released` event row (in-tx, epoch token) ─────────
  createEventWithClient(tx, {
    id: eventId,
    taskId,
    actorType,
    actorId,
    action: "released",
    fromStatus: row.status as never,
    toStatus: "pending" as never,
    metadata: provenance ? { reason, provenance } : { reason },
  });
  tx.update(taskEvents)
    .set({ executionToken: row.executionToken ?? null })
    .where(eq(taskEvents.id, eventId))
    .run();

  // ── 4. Receipts — exactly the two required consumers ─────────────────
  const snapshot: Record<string, unknown> = {
    taskId,
    action: "released",
    habitatId,
    missionId: preImage.missionId,
    taskTitle: preImage.title,
    actorType,
    actorId,
    reason,
    statusAtFailure: preImage.status,
    retryCount: preImage.retryCount ?? 0,
    rejectionReason: preImage.rejectionReason ?? null,
    retryPolicy: preImage.retryPolicy ?? null,
    assignedAgentIdAtFailure: preImage.assignedAgentId ?? null,
    executionToken: row.executionToken ?? null,
    frozenOnFailGateIds: freezeOnFailGateIds(tx, taskId),
    ...(provenance ? { provenance } : {}),
    releasedAt: now,
  };
  for (let i = 0; i < RELEASED_EFFECT_CONSUMERS.length; i++) {
    insertReceipt({
      id: `${receiptBase}-${i}`,
      subjectType: "task_event",
      subjectId: eventId,
      habitatId,
      taskId,
      consumer: RELEASED_EFFECT_CONSUMERS[i],
      state: "pending",
      causalSnapshot: snapshot,
      createdAt: now,
      tx,
    });
  }

  const released = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as Task | undefined;
  if (!released) return null;
  return { task: released, eventId };
}

/**
 * Freezes the `on_fail` gate id list for the releasing task — the T2 C1
 * pattern, shared verbatim with the failure act-tx: the failure_context
 * consumer's eligibility predicate queries these ids DIRECTLY for
 * `satisfied_by_event_id = :releaseEventId`, so historical capture survives
 * even after the release fence has been superseded by a successor claim.
 */
function freezeOnFailGateIds(tx: EffectDbClient, taskId: string): string[] {
  // Same query and active-workflow-at-act-time semantics as the fail act-tx's
  // freeze (T2 C1); duplicated here deliberately so the two act-txes stay
  // independent provenance streams with no private-helper coupling.
  const rows = tx
    .select({ id: taskWorkflowGates.id })
    .from(taskWorkflowGates)
    .innerJoin(workflows, eq(taskWorkflowGates.workflowId, workflows.id))
    .where(
      and(
        eq(taskWorkflowGates.upstreamTaskId, taskId),
        eq(taskWorkflowGates.gateType, "on_fail"),
        eq(workflows.status, "active"),
      ),
    )
    .all();
  return rows.map((r) => r.id);
}
