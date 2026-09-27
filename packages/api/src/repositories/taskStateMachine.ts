import { getDb } from "../db/index.js";
import { tasks } from "../db/schema/index.js";
import { eq, and, inArray, isNull, sql } from "drizzle-orm";
import type { Task, Artifact } from "../models/index.js";
import { repositoryTransactionError } from "../errors/repository.js";
import { ExecutionEpochMismatchError } from "../errors.js";
import { getTaskById } from "./taskCrud.js";
import { endOwnershipWithClient, stampApprovedGenerationWithClient } from "./reviewSafety.js";
import {
  claimWithAuthority,
  progressWithAuthority,
  type ClaimAuthorityOptions,
  type ClaimResult,
} from "./claimAuthority.js";

/**
 * Epoch-mutation guard predicate fragment (agent wire): the legacy-allowing
 * disjunction. Bound with the CLIENT's expected token (possibly null —
 * typed-null ≡ omitted). SQL `= NULL` is never true, so a non-NULL stored row
 * with a null client token rejects; a stored-NULL row always passes.
 */
function epochGuardSql(expected: string | null) {
  return sql`(${tasks.executionToken} IS NULL OR ${tasks.executionToken} = ${expected})`;
}

/**
 * In-tx typed refusal half of the epoch guard: throws
 * {@link ExecutionEpochMismatchError} when the guard is ACTIVE
 * (`expected !== undefined`, i.e. an agent-wire caller) and the stored token
 * is non-NULL and differs from the client's expectation. Callers must be
 * inside the same transaction as the guarded write — never a pre-check
 * beside it.
 */
function epochGuardAssert(storedToken: string | null, expected: string | null | undefined): void {
  if (expected !== undefined && storedToken !== null && storedToken !== expected) {
    throw new ExecutionEpochMismatchError();
  }
}

/**
 * Legacy repo claim-result shape consumed unchanged by the service wrappers
 * (`task-lifecycle.ts`, `task-delegation.ts`), routes, batch/autoAssign/
 * automation/plugin/daemonEngine callers. T2 Phase 3 keeps this contract
 * identical; the typed {@link ClaimResult} lives in the authority and is
 * flattened back to this shape at the repo boundary.
 */
type LegacyClaimResult = { success: true; task: Task } | { success: false; reason: string };

/**
 * Maps the typed authority {@link ClaimResult} back to the legacy
 * `{success:true, task} | {success:false, reason}` shape so every existing
 * caller (wrapper, route, batch, autoAssign, automation, plugin, daemonEngine)
 * stays byte-for-byte compatible. Implements the T2 Phase 3 flatten mapping:
 *
 *   - success                       → `{success:true, task}`
 *   - not_found                     → `"not_found"`
 *   - already_claimed               → `"already_claimed"`
 *   - not_pending (not_pending)     → `"already_claimed"`  (legacy collapses
 *                                     status≠pending into already_claimed)
 *   - not_pending (invalid_status)  → `"invalid_status"`   (delegated reason)
 *   - ineligible                    → the specific ADR-0038 reason verbatim
 *                                     (dependencies_unmet / mission_dependencies_unmet /
 *                                     release_gate_unmet / workflow_gates_unmet /
 *                                     capability_mismatch / not_delegated_to_you)
 *   - reserved_for_other            → `"reserved_for_other"` (NEW, dormant until T5)
 *   - observation_pending           → `"observation_pending"` (NEW, dormant)
 *   - budget_exhausted              → `"transition_budget_exhausted"` (NEW —
 *                                     the per-task transition budget refusal,
 *                                     plan §5. Never collapsed into
 *                                     `claim_failed`/`already_claimed`:
 *                                     callers/routes distinguish exhaustion
 *                                     from contention by the literal string)
 *   - version_conflict              → `"claim_failed"`  (serialization conflict)
 *   - infrastructure_failure        → `"claim_failed"`  (THE COLLAPSE FIX — was
 *                                     `already_claimed` under claimTask/
 *                                     claimTaskByRemoteParticipant; matches
 *                                     claimDelegatedTask's existing pattern)
 *   - governance_veto               → defensive `"claim_failed"` (never emitted
 *                                     by the authority — the wrapper throws
 *                                     InterceptorVetoError)
 */
function flattenClaimResult(r: ClaimResult): LegacyClaimResult {
  if (r.success) return { success: true, task: r.task };
  switch (r.category) {
    case "not_found":
      return { success: false, reason: "not_found" };
    case "already_claimed":
      return { success: false, reason: "already_claimed" };
    case "not_pending":
      // Legacy parity: a plain-claim task whose status isn't pending collapses
      // to already_claimed. Delegated mode emits invalid_status, which is a
      // load-bearing reason preserved verbatim.
      return {
        success: false,
        reason: r.reason === "invalid_status" ? "invalid_status" : "already_claimed",
      };
    case "ineligible":
      // ADR-0038 ordered vocabulary + delegated not_delegated_to_you preserved
      // verbatim — routes, MCP, and ~15 test files depend on the literal string.
      return { success: false, reason: r.reason };
    case "reserved_for_other":
      return { success: false, reason: "reserved_for_other" };
    case "observation_pending":
      return { success: false, reason: "observation_pending" };
    case "budget_exhausted":
      return { success: false, reason: "transition_budget_exhausted" };
    case "version_conflict":
      return { success: false, reason: "claim_failed" };
    case "infrastructure_failure":
      return { success: false, reason: "claim_failed" };
    case "governance_veto":
      return { success: false, reason: "claim_failed" };
  }
}

export function claimTask(
  taskId: string,
  agentId: string,
  onClaimCommitted?: ClaimAuthorityOptions["onClaimCommitted"],
  /**
   * Additive authority opts for system-actor claimers (the plugin task-op
   * path): threads `actorType` through to the transition-budget guard while
   * THIS seam keeps owning the legacy result flattening — a single flatten
   * implementation, no duplicate mapping. Existing callers are unaffected
   * (the parameter is optional and defaults to today's behavior exactly).
   */
  opts?: Omit<ClaimAuthorityOptions, "onClaimCommitted">,
): { success: true; task: Task } | { success: false; reason: string } {
  // Routed through the claim authority (T2): the authority owns gates +
  // checkClaimability + TOCTOU + infra mapping in one transaction. The typed
  // ClaimResult is flattened back to the legacy shape every caller depends on.
  // onClaimCommitted (T1): optional in-tx success hook — the daemon claim+session
  // join. Undefined for every other caller = today's behavior exactly.
  const authorityOpts: ClaimAuthorityOptions | undefined = {
    ...opts,
    ...(onClaimCommitted ? { onClaimCommitted } : {}),
  };
  return flattenClaimResult(
    claimWithAuthority(getDb(), taskId, { kind: "local", id: agentId }, authorityOpts),
  );
}

/**
 * Phase D — claim a task by a remote participant. Writes to
 * `remote_assigned_participant_id` (no FK) instead of `assigned_agent_id` so
 * the FK to `agents(id)` is not violated. The remote participant model is
 * intentionally separate from local agents (see techspec §2.2).
 */
export function claimTaskByRemoteParticipant(
  taskId: string,
  remoteParticipantId: string,
): { success: true; task: Task } | { success: false; reason: string } {
  return flattenClaimResult(
    claimWithAuthority(getDb(), taskId, { kind: "remote", id: remoteParticipantId }),
  );
}

/**
 * Phase D — submit a task claimed by a remote participant. Mirrors
 * `submitTask` but checks `remote_assigned_participant_id` instead of
 * `assigned_agent_id`.
 *
 * Fixup-4 sibling census: NOT an ownership end — the claimant fencing
 * (status = in_progress AND remoteAssignedParticipantId = caller, version
 * CAS) means only the current owner can submit, and finality remains gated
 * downstream by the one-reservation finality service. No review invalidation
 * is due on this path; left unchanged after verification.
 */
export function submitTaskByRemoteParticipant(
  taskId: string,
  remoteParticipantId: string,
  result: string,
  artifacts: Artifact[],
): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "in_progress" || task.remoteAssignedParticipantId !== remoteParticipantId) {
    return null;
  }

  db.update(tasks)
    .set({
      status: "submitted",
      submittedAt: now,
      result,
      artifacts,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.remoteAssignedParticipantId, remoteParticipantId),
        eq(tasks.status, "in_progress"),
      ),
    )
    .run();

  return getTaskById(taskId);
}

/**
 * T5a — tx-aware submit primitive for remote participants. Mirrors
 * `submitTaskByRemoteParticipant`'s gate (status === "in_progress" &&
 * remoteAssignedParticipantId === participantId) and SET clause, but operates
 * on the caller-supplied `tx` so it can compose inside a wrapper's atomic
 * transaction alongside `createEventWithClient`. Never calls `getDb()`.
 *
 * Returns the updated `Task` on success, or `null` if the task is missing or
 * the gate check fails. Infrastructure errors propagate (the caller's tx owns
 * the rollback).
 */
export function submitWithAuthorityClient(
  tx: ReturnType<typeof getDb>,
  taskId: string,
  remoteParticipantId: string,
  result: string,
  artifacts: Artifact[],
): Task | null {
  type TaskRow = typeof tasks.$inferSelect;
  const row = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as TaskRow | undefined;
  if (!row) return null;
  if (row.status !== "in_progress" || row.remoteAssignedParticipantId !== remoteParticipantId) {
    return null;
  }

  const now = new Date().toISOString();
  tx.update(tasks)
    .set({
      status: "submitted",
      submittedAt: now,
      result,
      artifacts,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.remoteAssignedParticipantId, remoteParticipantId),
        eq(tasks.status, "in_progress"),
      ),
    )
    .run();

  const updated = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as TaskRow | undefined;
  return (updated as unknown as Task) ?? null;
}

/**
 * Phase D — start a task claimed by a remote participant. Mirrors `startTask`.
 */
export function startTaskByRemoteParticipant(
  taskId: string,
  remoteParticipantId: string,
): Task | null {
  // Routed through the progression authority (T2 remediation M3): the
  // claimed → in_progress transition runs identity/status re-read + gates +
  // conditional UPDATE + post-write verify in ONE transaction, closing the
  // TOCTOU race the pre-remediation gate-check-then-separate-UPDATE left open.
  // Public Task | null shape and null-on-missing/wrong-participant/wrong-status
  // semantics are preserved (manifest §5). Gates are open for every legacy
  // task; a future post-cutover reservation for another identity blocks → null.
  return progressWithAuthority(getDb(), taskId, { kind: "remote", id: remoteParticipantId });
}

/**
 * Phase D — release a task claimed by a remote participant. Mirrors
 * `releaseTask` but checks `remote_assigned_participant_id`.
 */
export function releaseTaskByRemoteParticipant(
  taskId: string,
  remoteParticipantId: string,
): Task | null {
  // Fixup-4 blocker 3 (sibling): the raw remote release now runs under ONE
  // immediate writer reservation with the SAME ownership-end invalidation as
  // every guarded release (review claimant/proof cleared, override expired
  // with immediate baseline restore, generation advanced once). Token and
  // provenance-pointer clears preserve the existing release contract; a lost
  // CAS returns null with zero writes.
  const db = getDb();
  const now = new Date().toISOString();

  return db.transaction(
    (tx) => {
      type TaskRow = typeof tasks.$inferSelect;
      const row = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as TaskRow | undefined;
      if (!row) return null;
      if (
        (row.status !== "claimed" && row.status !== "in_progress") ||
        row.remoteAssignedParticipantId !== remoteParticipantId
      ) {
        return null;
      }

      tx.update(tasks)
        .set({
          remoteAssignedParticipantId: null,
          status: "pending",
          claimedAt: null,
          executionToken: null,
          lastFailureEventId: null,
          lastReleaseEventId: null,
          updatedAt: now,
          version: sql`${tasks.version} + 1`,
        })
        .where(
          and(
            eq(tasks.id, taskId),
            // Fixup-5: winning predicate — the re-read participant in a
            // releasable status (partial/skipped writes match 0 rows).
            inArray(tasks.status, ["claimed", "in_progress"]),
            eq(tasks.remoteAssignedParticipantId, remoteParticipantId),
          ),
        )
        .run();

      // Fixup-5: cross-backend WINNING-POSTIMAGE verify — full intended
      // postimage before any invalidation; skipped/partial write throws and
      // rolls back BOTH legs; a legitimate already-released row is a no-op.
      const verify = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as
        | TaskRow
        | undefined;
      if (!verify) return null;
      const fullPostimage =
        verify.status === "pending" &&
        verify.remoteAssignedParticipantId === null &&
        verify.assignedAgentId === null &&
        verify.executionToken === null &&
        verify.lastFailureEventId === null &&
        verify.lastReleaseEventId === null &&
        verify.version > row.version;
      if (!fullPostimage) {
        // Fixup-6: no post-write no-op classification — a partial rewrite
        // (e.g. pending with a NEW local assignee) or a skipped write rolls
        // back. Genuine no-ops are classified on the PRE-WRITE gate above.
        throw new Error("remote_release_lost_cas_rollback");
      }

      endOwnershipWithClient(tx, taskId, { advanceGeneration: true });
      return verify as unknown as Task;
    },
    { behavior: "immediate" },
  );
}

export function claimDelegatedTask(
  taskId: string,
  agentId: string,
): { success: true; task: Task } | { success: false; reason: string } {
  // Routed through the claim authority (T2) in delegated mode. The authority
  // owns the not_delegated_to_you / invalid_status / mutation contract and
  // maps SQLITE_BUSY + CONSTRAINT failures to infrastructure_failure /
  // version_conflict — which flatten back to `claim_failed`, matching this
  // function's pre-T2 better-than-collapse behavior.
  const result = claimWithAuthority(
    getDb(),
    taskId,
    { kind: "local", id: agentId },
    { delegated: true },
  );

  // PRESERVE manifest row 3.6: a non-SQLite (unmapped) infrastructure failure
  // must still surface as a thrown repositoryTransactionError (AppError 500),
  // not collapse to a returned claim_failed. The authority converts such
  // throws to { category: "infrastructure_failure", reason: "infrastructure_error" };
  // re-throw here so the delegated contract is byte-identical to pre-T2.
  if (
    !result.success &&
    result.category === "infrastructure_failure" &&
    result.reason === "infrastructure_error"
  ) {
    throw repositoryTransactionError("task", result.cause as Error, taskId);
  }

  return flattenClaimResult(result);
}

export function startTask(
  taskId: string,
  agentId: string,
  expectedExecutionToken?: string | null,
): Task | null {
  // Routed through the progression authority (T2 remediation M3; REC-10
  // widening): the claimed/rejected → in_progress transition (rejected = the
  // owner's rework continuation) runs identity/status re-read + gates +
  // conditional UPDATE + post-write verify in ONE transaction, closing the
  // TOCTOU race the pre-remediation gate-check-then-separate-UPDATE left open.
  // Public Task | null shape and null-on-missing/wrong-agent/wrong-status
  // semantics are preserved (manifest §4). Gates are open for every legacy
  // task; a future post-cutover reservation for another identity blocks → null.
  //
  // Epoch-mutation guard: `expectedExecutionToken` threads the agent wire's
  // client token into the authority tx (disjunction in the re-read AND the
  // UPDATE WHERE). `undefined` (system callers) = predicate absent.
  return progressWithAuthority(
    getDb(),
    taskId,
    { kind: "local", id: agentId },
    expectedExecutionToken !== undefined ? { expectedExecutionToken } : undefined,
  );
}

export function submitTask(
  taskId: string,
  agentId: string,
  result: string,
  artifacts: Artifact[],
  expectedExecutionToken?: string | null,
): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  // The guarded submit runs re-read + epoch assert + conditional UPDATE in
  // ONE IMMEDIATE transaction (the epoch-mutation guard lives INSIDE the
  // authoritative write, never a pre-check beside it). `undefined` token =
  // system caller: today's predicate exactly, no epoch clause.
  return db.transaction(
    (tx) => {
      type TaskRow = typeof tasks.$inferSelect;
      const row = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as TaskRow | undefined;
      if (!row) return null;
      if (row.status !== "in_progress" || row.assignedAgentId !== agentId) return null;
      epochGuardAssert(row.executionToken, expectedExecutionToken);

      tx.update(tasks)
        .set({
          status: "submitted",
          submittedAt: now,
          result,
          artifacts,
          updatedAt: now,
          version: sql`${tasks.version} + 1`,
        })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.assignedAgentId, agentId),
            eq(tasks.status, "in_progress"),
            ...(expectedExecutionToken !== undefined
              ? [epochGuardSql(expectedExecutionToken)]
              : []),
          ),
        )
        .run();

      const updated = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as
        | TaskRow
        | undefined;
      if (!updated || updated.status !== "submitted") return null;
      return updated as unknown as Task;
    },
    { behavior: "immediate" },
  );
}

export function releaseTask(
  taskId: string,
  _reason: string,
  expectedExecutionToken?: string | null,
): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  // Same discipline as submitTask: the epoch guard (when the agent wire
  // activates it) joins the re-read assert AND the UPDATE WHERE inside one
  // IMMEDIATE transaction. System callers (stale sweep, automation executor,
  // plugin runtime) pass no token — predicate absent, behavior unchanged.
  return db.transaction(
    (tx) => {
      type TaskRow = typeof tasks.$inferSelect;
      const row = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as TaskRow | undefined;
      if (!row) return null;
      if (row.status !== "claimed" && row.status !== "in_progress") return null;
      epochGuardAssert(row.executionToken, expectedExecutionToken);

      tx.update(tasks)
        .set({
          assignedAgentId: null,
          status: "pending",
          claimedAt: null,
          startedAt: null,
          executionToken: null,
          lastFailureEventId: null,
          lastReleaseEventId: null,
          updatedAt: now,
          version: sql`${tasks.version} + 1`,
        })
        .where(
          and(
            eq(tasks.id, taskId),
            // Fixup-5: winning predicate — only the re-read owner in a
            // releasable status transitions (partial/skipped writes match 0).
            inArray(tasks.status, ["claimed", "in_progress"]),
            row.assignedAgentId === null
              ? isNull(tasks.assignedAgentId)
              : eq(tasks.assignedAgentId, row.assignedAgentId),
            ...(expectedExecutionToken !== undefined
              ? [epochGuardSql(expectedExecutionToken)]
              : []),
          ),
        )
        .run();

      // Fixup-5: cross-backend WINNING-POSTIMAGE verify (sql.js exposes no
      // {changes}) — the FULL intended postimage: status pending, BOTH
      // assignment columns NULL, token + both provenance pointers NULL,
      // version moved past the pre-image. A skipped/partial write throws and
      // rolls back BOTH legs; a legitimate pre-existing already-released row
      // is a true no-op (returns the row, NO invalidation, no error).
      const verify = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as
        | TaskRow
        | undefined;
      if (!verify) return null;
      const wonRelease =
        verify.status === "pending" &&
        verify.assignedAgentId === null &&
        verify.remoteAssignedParticipantId === null &&
        verify.executionToken === null &&
        verify.lastFailureEventId === null &&
        verify.lastReleaseEventId === null &&
        verify.version > row.version;
      if (!wonRelease) {
        // Fixup-6: after an ATTEMPTED write there is no no-op branch — any
        // deviation from the full intended postimage (skipped write, PARTIAL
        // rewrite, foreign shape) rolls the whole reservation back. A genuine
        // no-op is classified ONCE, on the PRE-WRITE read above, which never
        // attempts a write.
        throw new Error("release_lost_cas_rollback");
      }

      // Review-safety ownership end (same immediate tx): clear typed claimant
      // and approval proof, expire any active override restoring the baseline,
      // advance the generation once when an owner actually ended.
      endOwnershipWithClient(tx, taskId, {
        advanceGeneration: row.assignedAgentId !== null || row.remoteAssignedParticipantId !== null,
      });
      return verify as unknown as Task;
    },
    { behavior: "immediate" },
  );
}

/**
 * RAW failTask — REMOVED from the production surface (fixup-4 blocker 3).
 * The exported primitive could not carry the actor/epoch authority the real
 * failure contract (failTaskWithEffects act-tx: epoch validation, budget,
 * receipts, provenance pointers) requires, and it ended ownership without
 * review invalidation. Production failure runs exclusively through
 * `services/tasks/task-lifecycle.ts` failTask → failTaskWithEffects.
 */


// ---------------------------------------------------------------------------
// Dedicated immediate retry writer (review-safety cutover)
// ---------------------------------------------------------------------------

/**
 * The retry ladder's privileged transition — the ONLY sanctioned writer for
 * the failed→pending retry reset outside the guarded lifecycle. One BEGIN
 * IMMEDIATE owns: the status/assignee/token/pointer reset, the review-safety
 * ownership-end normalization (claimant/proof cleared, any active override
 * expired with immediate baseline restore), and the generation advance ONLY
 * when the pre-image row still carried an owner (a failed task's owner
 * already ended at the fail act-tx — a no-op escalation never manufactures a
 * generation or a known-zero).
 */
export function retryTransitionToPendingWithEffects(taskId: string, newRetryCount: number): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  return db.transaction(
    (tx) => {
      type TaskRow = typeof tasks.$inferSelect;
      const row = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as TaskRow | undefined;
      if (!row) return null;

      // Fixup-8 (Sol-adjudicated): retry-to-pending is a CUSTODY-ENDING
      // transition for EITHER claimant kind. The write clears BOTH owner
      // columns atomically; the review invalidation advances the generation
      // exactly once iff EITHER preimage owner column was present.
      //
      // The ONLY no-op classification is PRE-WRITE, on the writer's FULL
      // intended reset shape (both owners null, token + both provenance
      // pointers null, rejectionReason/nextRetryAt null, retryCount already
      // current): a genuinely complete clean row attempts NO UPDATE (version
      // untouched, no generation change, no invalidation). Any stale field —
      // including a stale execution token on an otherwise-clean pending row —
      // means real work and the write runs.
      const alreadyClean =
        row.status === "pending" &&
        row.assignedAgentId === null &&
        row.remoteAssignedParticipantId === null &&
        row.executionToken === null &&
        row.lastFailureEventId === null &&
        row.lastReleaseEventId === null &&
        row.rejectionReason === null &&
        row.nextRetryAt === null &&
        row.retryCount === newRetryCount;
      if (alreadyClean) {
        return row as unknown as Task;
      }

      tx.update(tasks)
        .set({
          status: "pending",
          assignedAgentId: null,
          remoteAssignedParticipantId: null,
          rejectionReason: null,
          retryCount: newRetryCount,
          nextRetryAt: null,
          executionToken: null,
          lastFailureEventId: null,
          lastReleaseEventId: null,
          updatedAt: now,
          version: sql`${tasks.version} + 1`,
        })
        .where(eq(tasks.id, taskId))
        .run();

      // Fixup-8: after an ATTEMPTED write there is no no-op fallback — the
      // FULL intended postimage (both owners NULL, every cleared field clean,
      // exact retry count, version moved) or the whole reservation rolls
      // back; a skipped or partially rewritten write never returns success.
      const verify = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as
        | TaskRow
        | undefined;
      if (!verify) return null;
      const intendedPostimage =
        verify.status === "pending" &&
        verify.assignedAgentId === null &&
        verify.remoteAssignedParticipantId === null &&
        verify.executionToken === null &&
        verify.lastFailureEventId === null &&
        verify.lastReleaseEventId === null &&
        verify.rejectionReason === null &&
        verify.nextRetryAt === null &&
        verify.retryCount === newRetryCount &&
        verify.version > row.version;
      if (!intendedPostimage) {
        throw new Error("retry_transition_lost_cas_rollback");
      }

      endOwnershipWithClient(tx, taskId, {
        advanceGeneration:
          row.assignedAgentId !== null || row.remoteAssignedParticipantId !== null,
      });
      return verify as unknown as Task;
    },
    { behavior: "immediate" },
  );
}

/**
 * The retry ladder's escalation clear (status stays `failed`): clears the
 * owner pointer/next-retry and runs the same review-safety normalization.
 * No-op when the row's owner is already gone.
 */
export function retryEscalateClearOwnerWithEffects(taskId: string): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  return db.transaction(
    (tx) => {
      type TaskRow = typeof tasks.$inferSelect;
      const row = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as TaskRow | undefined;
      if (!row) return null;

      // Fixup-8 (Sol-adjudicated): exhausted escalation is a CUSTODY-ENDING
      // transition for EITHER claimant kind. The write clears BOTH owner
      // columns (status stays failed); the review invalidation advances the
      // generation exactly once iff EITHER preimage owner column was present.
      // A genuine no-op is classified PRE-WRITE (nothing to clear): no
      // UPDATE is attempted.
      const nothingNeededClearing =
        row.assignedAgentId === null &&
        row.remoteAssignedParticipantId === null &&
        row.executionToken === null &&
        row.lastFailureEventId === null &&
        row.lastReleaseEventId === null &&
        row.nextRetryAt === null;
      if (nothingNeededClearing) {
        return row as unknown as Task;
      }

      tx.update(tasks)
        .set({
          assignedAgentId: null,
          remoteAssignedParticipantId: null,
          nextRetryAt: null,
          executionToken: null,
          lastFailureEventId: null,
          lastReleaseEventId: null,
          updatedAt: now,
          version: sql`${tasks.version} + 1`,
        })
        .where(eq(tasks.id, taskId))
        .run();

      // Fixup-8: after an ATTEMPTED write there is no no-op fallback — the
      // FULL intended postimage (status unchanged failed, BOTH owners NULL,
      // token + both provenance pointers + nextRetryAt cleared, version
      // moved) or the whole reservation rolls back.
      const verify = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as
        | TaskRow
        | undefined;
      if (!verify) return null;
      const postimageOk =
        verify.status === row.status && // escalation never changes status
        verify.assignedAgentId === null &&
        verify.remoteAssignedParticipantId === null &&
        verify.executionToken === null &&
        verify.lastFailureEventId === null &&
        verify.lastReleaseEventId === null &&
        verify.nextRetryAt === null &&
        verify.version > row.version;
      if (!postimageOk) {
        throw new Error("retry_escalation_lost_cas_rollback");
      }

      endOwnershipWithClient(tx, taskId, {
        advanceGeneration:
          row.assignedAgentId !== null || row.remoteAssignedParticipantId !== null,
      });
      return verify as unknown as Task;
    },
    { behavior: "immediate" },
  );
}

export function rejectTask(taskId: string, reason: string): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  const runResult = db
    .update(tasks)
    .set({
      status: "rejected",
      rejectionReason: reason,
      rejectedCount: sql`${tasks.rejectedCount} + 1`,
      // REC-10 (Design A): the token is PRESERVED as the rejected-continuation
      // token — the still-assigned owner's proof for the rework start (which
      // mints the next epoch). The provenance pointers below still clear (the
      // release fence is pending-scoped; the mint re-arms nothing).
      lastFailureEventId: null,
      lastReleaseEventId: null,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, "submitted")))
    .run();

  // Terminal-write CAS — same contract as approveTask: zero matched rows or a
  // non-terminal refetched status is a lost race, surfaced as null.
  const changes = (runResult as { changes?: number } | undefined)?.changes;
  const updated = getTaskById(taskId);
  if (changes === 0) return null;
  if (!updated || updated.status !== "rejected") return null;
  return updated;
}
