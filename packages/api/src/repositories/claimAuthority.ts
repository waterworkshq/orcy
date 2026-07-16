/**
 * Claim Authority — the transactional mutation authority for Task claims.
 *
 * T2 Phase 2. ADDITIVE + DORMANT: no production caller routes through here yet.
 * Phase 3 will migrate `claimTask`, `claimTaskByRemoteParticipant`,
 * `claimDelegatedTask`, `startTask`, and `startTaskByRemoteParticipant` in
 * `repositories/taskStateMachine.ts` to delegate to this authority.
 *
 * Owns the mutation-time claim decision in ONE transaction (ADR-0038
 * consequence — closes TOCTOU races):
 *
 *   1. not_found                       — task missing
 *   2. occupancy / state               — already_claimed / not_pending
 *   3. task-intrinsic                  — checkClaimability(taskId), REUSED
 *      (plain-claim mode only; delegated mode preserves the legacy contract
 *      which does not re-run the four guards — see claimDelegatedTask model)
 *   4. observation gate                — creationIntegrity (T1 Legacy Partial
 *                                        History → open for every prod task)
 *   5. reservation gate                — task_creation_assignment_reservations
 *                                        (T1; table empty today → gate open)
 *   6. mutation                        — write assignee, status, version++
 *
 * Returns a typed {@link ClaimResult} carrying BOTH a coarse category (the
 * plan's layer) AND the specific preserved reason (ADR-0038 vocabulary).
 * Exceptions are mapped to typed `infrastructure_failure` / `version_conflict`
 * — NEVER collapsed to `already_claimed`. That collapse bug is the defect T2
 * fixes: under the legacy functions, SQLITE_BUSY / disk I/O / any thrown
 * exception becomes indistinguishable from real contention.
 *
 * Authority boundary (ADR-0038):
 *   - Task-intrinsic authority is `checkClaimability` (reused, NOT reimplemented
 *     here). Occupancy and not_found are mutation-state, owned here.
 *   - Agent-relative fitness (capability_mismatch) is resolved at the transport
 *     seam (service wrapper), NOT here. `claimant` is transport-agnostic: a
 *     local agent id OR a remote participant id.
 *   - Governance veto stays a THROW (InterceptorVetoError) at the service
 *     wrapper; this authority does not emit `governance_veto`. The category is
 *     included in {@link ClaimResult} for vocabulary completeness so callers
 *     that aggregate claim outcomes can account for it uniformly.
 */
import { getDb } from "../db/index.js";
import { tasks, taskCreationAssignmentReservations } from "../db/schema/index.js";
import {
  TASK_CREATION_INTEGRITY_VERSION,
  isLegacyPartialHistory,
} from "../db/schema/taskPublication.js";
import { and, eq, sql } from "drizzle-orm";
import type { Task } from "../models/index.js";
import { logger } from "../lib/logger.js";
import { isSqliteError } from "../errors/sqlite.js";
import { checkClaimability } from "./taskQueries.js";
import type { TaskPublicationDbClient } from "./taskPublication.js";

// ---------------------------------------------------------------------------
// Coarse failure categories (the plan's layer)
// ---------------------------------------------------------------------------

/**
 * The coarse claim-failure category. This is the NEW layer T2 adds so callers
 * can distinguish infra failure from domain refusal and route the new
 * observation / reservation gates. It NEVER replaces the specific
 * {@link ClaimRefusalReason} — both are carried on every failure result.
 *
 * `governance_veto` is included for vocabulary completeness; this authority
 * does not emit it (the service wrapper throws InterceptorVetoError instead —
 * ADR-0038 §3, route layer pattern-matches on the throw class).
 */
export type ClaimFailureCategory =
  | "reserved_for_other"
  | "not_pending"
  | "already_claimed"
  | "ineligible"
  | "governance_veto"
  | "version_conflict"
  | "infrastructure_failure"
  | "observation_pending"
  | "not_found";

// ---------------------------------------------------------------------------
// Preserved specific reasons (ADR-0038 ordered vocabulary + delegated +
// occupancy + publication gates + infra detail)
// ---------------------------------------------------------------------------

/** Task-intrinsic refusal reasons — ADR-0038 ordered vocabulary (first-error). */
export type ClaimIneligibleReason =
  | "dependencies_unmet"
  | "mission_dependencies_unmet"
  | "release_gate_unmet"
  | "workflow_gates_unmet"
  | "capability_mismatch";

/**
 * The specific refusal reason, preserved verbatim from the legacy
 * `{success:false, reason}` vocabulary. Routes, MCP, and ~15 test files depend
 * on these literal strings (see `docs/plans/t02-claim-authority-manifest.md`
 * §10 "load-bearing exact strings"). The coarse {@link ClaimFailureCategory}
 * is ADDED; this `reason` is PRESERVED as a field.
 */
export type ClaimRefusalReason =
  // mutation-state
  | "not_found"
  // occupancy
  | "already_claimed"
  | "not_pending"
  // task-intrinsic (ADR-0038)
  | ClaimIneligibleReason
  // delegated-specific (claimDelegatedTask model)
  | "not_delegated_to_you"
  | "invalid_status"
  // publication gates
  | "reserved_for_other"
  | "observation_pending"
  // infra / serialization detail
  | "claim_failed"
  | "version_conflict"
  | "infrastructure_error"
  // governance (transport seam; not emitted by this authority)
  | "governance_veto";

// ---------------------------------------------------------------------------
// ClaimResult — discriminated union (success | failure), failure narrowing on
// `category` so callers can switch on the coarse layer while retaining reason.
// ---------------------------------------------------------------------------

export interface ClaimSuccess {
  success: true;
  task: Task;
}

export type ClaimFailure =
  | { success: false; category: "not_found"; reason: "not_found" }
  | { success: false; category: "already_claimed"; reason: "already_claimed" }
  | {
      success: false;
      category: "not_pending";
      reason: "not_pending" | "invalid_status";
    }
  | {
      success: false;
      category: "ineligible";
      reason: ClaimIneligibleReason | "not_delegated_to_you";
    }
  | {
      success: false;
      category: "reserved_for_other";
      reason: "reserved_for_other";
      /** Identity holding the conflicting active reservation (diagnostics). */
      reservedFor?: string;
    }
  | { success: false; category: "observation_pending"; reason: "observation_pending" }
  | {
      success: false;
      category: "version_conflict";
      reason: "version_conflict";
      /** SQLite code when the conflict was raised by a constraint violation. */
      causeCode?: string;
      /** The original thrown error, retained for logs/diagnostics. */
      cause?: unknown;
    }
  | {
      success: false;
      category: "infrastructure_failure";
      reason: "claim_failed" | "infrastructure_error";
      /** SQLite code (e.g. SQLITE_BUSY, SQLITE_CONSTRAINT_NOTNULL) when available. */
      causeCode?: string;
      /** The original thrown error, retained for logs/diagnostics. */
      cause?: unknown;
    }
  | {
      success: false;
      category: "governance_veto";
      reason: "governance_veto";
      /**
       * Veto details from the interceptor decision. NOT emitted by this
       * authority — populated at the transport seam if a caller bridges the
       * throw into the result union.
       */
      details?: unknown;
    };

export type ClaimResult = ClaimSuccess | ClaimFailure;

// ---------------------------------------------------------------------------
// Claimant + options
// ---------------------------------------------------------------------------

/**
 * Transport-agnostic claimant identity (ADR-0038 §3). `kind` selects which
 * assignment column the authority writes:
 *   - `"local"`  → `assigned_agent_id`        (FK to agents(id))
 *   - `"remote"` → `remote_assigned_participant_id` (plain text, no FK)
 *
 * Agent-relative fitness (required-capabilities / domain) is NOT resolved here
 * — it depends on the transport model and stays at the service-wrapper seam.
 */
export interface Claimant {
  kind: "local" | "remote";
  /** Local agent id (`kind === "local"`) OR remote participant id (`"remote"`). */
  id: string;
}

export interface ClaimAuthorityOptions {
  /**
   * Delegated-claim mode: enforce the `claimDelegatedTask` contract instead of
   * the plain pending-claim contract.
   *
   *   - `delegatedToAgentId === claimant.id` (else `not_delegated_to_you`)
   *   - `status ∈ {claimed, in_progress}`     (else `invalid_status`)
   *   - does NOT re-run `checkClaimability` (the four task-intrinsic guards);
   *     the legacy `claimDelegatedTask` never did, and this authority preserves
   *     that contract. Phase 3 may revisit.
   *   - claimant must be `kind === "local"` (delegation targets local agents).
   *
   * Success mutation: `assignedAgentId ← claimant.id`, `delegatedToAgentId ← null`,
   * `status ← "claimed"`, `claimedAt ← COALESCE(claimedAt, now)`, `version++`.
   */
  delegated?: boolean;
}

// ---------------------------------------------------------------------------
// Authority — client primitive + transactional entry point
// ---------------------------------------------------------------------------

/**
 * Transaction-aware client primitive. Runs every gate check + the mutation on
 * the caller-supplied `tx` (the tx from `db.transaction((tx) => …)` or the
 * top-level `getDb()` client). Mirrors the T1 `*WithClient` precedent
 * (`createAssignmentReservationWithClient` in `taskPublication.ts`).
 *
 * Domain refusals are RETURNED as {@link ClaimResult}. Infrastructure errors
 * are RE-THROWN unchanged — the transactional entry point (or a future
 * publication coordinator) is responsible for catching them and mapping to
 * `infrastructure_failure` / `version_conflict`. This preserves the T1
 * primitive contract: never swallow, never open a nested tx, never call
 * `getDb()`.
 *
 * `checkClaimability(taskId)` is called for read-consistency with the legacy
 * functions (they call it from inside their tx callbacks too). It reads from
 * `getDb()` internally — a known limitation preserved verbatim from the
 * legacy semantics (see ADR-0038).
 */
export function claimWithAuthorityClient(
  tx: TaskPublicationDbClient,
  taskId: string,
  claimant: Claimant,
  opts?: ClaimAuthorityOptions,
): ClaimResult {
  type TaskRow = typeof tasks.$inferSelect;
  const row = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as TaskRow | undefined;

  // 1. not_found — mutation-state (ADR-0038 places this outside checkClaimability).
  if (!row) return { success: false, category: "not_found", reason: "not_found" };

  // ---- delegated mode: the claimDelegatedTask contract ---------------------
  // `not_delegated_to_you` is bucketed under `ineligible` (the task-claimant
  // authorization contract is not met). A remote claimant naturally fails this
  // check because delegatedToAgentId references a local agents(id).
  if (opts?.delegated) {
    if (row.delegatedToAgentId !== claimant.id) {
      return { success: false, category: "ineligible", reason: "not_delegated_to_you" };
    }
    if (row.status !== "claimed" && row.status !== "in_progress") {
      return { success: false, category: "not_pending", reason: "invalid_status" };
    }
    return commitDelegatedClaim(tx, row);
  }

  // ---- plain mode: the claimTask / claimTaskByRemoteParticipant contract ---

  // 2. occupancy / state. Order: assignee-set (already_claimed) before
  //    wrong-status (not_pending) — assignee-set is the more informative
  //    reason and implies status flipped on any real claim.
  if (row.assignedAgentId !== null || row.remoteAssignedParticipantId !== null) {
    return { success: false, category: "already_claimed", reason: "already_claimed" };
  }
  if (row.status !== "pending") {
    return { success: false, category: "not_pending", reason: "not_pending" };
  }

  // 3. task-intrinsic authority — REUSED, not reimplemented (ADR-0038).
  const claimability = checkClaimability(taskId);
  if (!claimability.claimable) {
    return {
      success: false,
      category: "ineligible",
      reason: claimability.reason as ClaimIneligibleReason,
    };
  }

  // 4. observation gate (T1 Legacy Partial History → open for every prod task).
  if (!isLegacyPartialHistory(row)) {
    return { success: false, category: "observation_pending", reason: "observation_pending" };
  }

  // 5. reservation gate (T1 task_creation_assignment_reservations; empty today).
  const reservedFor = activeReservationForOther(tx, taskId, claimant.id);
  if (reservedFor !== undefined) {
    return {
      success: false,
      category: "reserved_for_other",
      reason: "reserved_for_other",
      reservedFor,
    };
  }

  return commitPlainClaim(tx, row, claimant);
}

/**
 * Transactional entry point. Opens ONE transaction, delegates to
 * {@link claimWithAuthorityClient}, and catches any thrown exception into a
 * typed `infrastructure_failure` / `version_conflict` — never collapsing to
 * `already_claimed` (the legacy collapse bug fixed by T2).
 *
 * `db` defaults to `getDb()` so a bare `claimWithAuthority(undefined, …)` call
 * works once Phase 3 wires callers. Tests may pass a client whose
 * `.transaction` is wrapped (e.g. a FailingDbClient-injecting shim) to
 * exercise the infra-failure mapping.
 */
export function claimWithAuthority(
  db: TaskPublicationDbClient | undefined,
  taskId: string,
  claimant: Claimant,
  opts?: ClaimAuthorityOptions,
): ClaimResult {
  const client = db ?? getDb();
  try {
    return client.transaction((tx) => claimWithAuthorityClient(tx, taskId, claimant, opts));
  } catch (err) {
    return mapInfraErrorToFailure(err, taskId, claimant);
  }
}

// ---------------------------------------------------------------------------
// Mutation helpers (run on the caller-supplied tx; throw on DB error)
// ---------------------------------------------------------------------------

function commitPlainClaim(
  tx: TaskPublicationDbClient,
  row: typeof tasks.$inferSelect,
  claimant: Claimant,
): ClaimResult {
  const now = new Date().toISOString();
  // `as unknown as Partial<typeof tasks.$inferInsert>` mirrors the legacy cast
  // in taskStateMachine.ts — `version: sql\`${tasks.version} + 1\`` is a SQL
  // expression, not a literal number, so the strict column type must be bypassed.
  const setCommon = {
    status: "claimed",
    claimedAt: now,
    updatedAt: now,
    version: sql`${tasks.version} + 1`,
  } as const;
  // Transport-agnostic column selection (ADR-0038 §3).
  let where;
  let set;
  if (claimant.kind === "local") {
    set = { ...setCommon, assignedAgentId: claimant.id };
    where = and(eq(tasks.id, row.id), eq(tasks.status, "pending"));
  } else {
    set = { ...setCommon, remoteAssignedParticipantId: claimant.id };
    where = and(
      eq(tasks.id, row.id),
      eq(tasks.status, "pending"),
      sql`${tasks.remoteAssignedParticipantId} IS NULL`,
    );
  }
  tx.update(tasks)
    .set(set as unknown as Partial<typeof tasks.$inferInsert>)
    .where(where)
    .run();

  return verifyAndReturn(tx, row.id, claimant);
}

function commitDelegatedClaim(
  tx: TaskPublicationDbClient,
  row: typeof tasks.$inferSelect,
): ClaimResult {
  const now = new Date().toISOString();
  // claimDelegatedTask uses `delegatedToAgentId === agentId` as the identity
  // anchor (the claiming agent IS the delegate). Hand off: assignee ← delegate,
  // delegatedToAgentId ← null, preserve prior claimedAt.
  const delegateId = row.delegatedToAgentId!;
  tx.update(tasks)
    .set({
      assignedAgentId: delegateId,
      delegatedToAgentId: null,
      status: "claimed",
      claimedAt: sql`COALESCE(${tasks.claimedAt}, ${now})`,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    } as unknown as Partial<typeof tasks.$inferInsert>)
    .where(eq(tasks.id, row.id))
    .run();

  return verifyAndReturn(tx, row.id, { kind: "local", id: delegateId });
}

/**
 * Re-selects the task after the UPDATE and asserts the assignee matches the
 * claimant. A mismatch means the row was mutated between the gate checks and
 * the write (TOCTOU) — the UPDATE's WHERE no-op'd under SQLite's serialized
 * isolation. This is the authority's TOCTOU guard that the legacy functions
 * lack (they return `task!` blindly). Driver-agnostic (pure read).
 */
function verifyAndReturn(
  tx: TaskPublicationDbClient,
  taskId: string,
  claimant: Claimant,
): ClaimResult {
  const updated = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as
    | typeof tasks.$inferSelect
    | undefined;
  if (!updated) {
    return { success: false, category: "version_conflict", reason: "version_conflict" };
  }
  const assigneeMatches =
    claimant.kind === "local"
      ? updated.assignedAgentId === claimant.id
      : updated.remoteAssignedParticipantId === claimant.id;
  if (!assigneeMatches || updated.status !== "claimed") {
    return { success: false, category: "version_conflict", reason: "version_conflict" };
  }
  return { success: true, task: updated as unknown as Task };
}

// ---------------------------------------------------------------------------
// Reservation gate — query T1's task_creation_assignment_reservations
// ---------------------------------------------------------------------------

/**
 * Returns the identity of an ACTIVE reservation on `taskId` for a claimant
 * OTHER than `claimantId`, or `undefined` if none. An active reservation for
 * the matching identity is permitted (only the matching reservation identity
 * may claim a targeted task). `requestedAgentId` is the transport-agnostic
 * identity column (nullable text, no FK — see schema).
 *
 * The table is EMPTY in production today (no origin creates reservations —
 * that's T5), so this returns `undefined` for every real task → gate open.
 */
function activeReservationForOther(
  tx: TaskPublicationDbClient,
  taskId: string,
  claimantId: string,
): string | undefined {
  const rows = tx
    .select({ requestedAgentId: taskCreationAssignmentReservations.requestedAgentId })
    .from(taskCreationAssignmentReservations)
    .where(
      and(
        eq(taskCreationAssignmentReservations.taskId, taskId),
        eq(taskCreationAssignmentReservations.state, "active"),
      ),
    )
    .all() as { requestedAgentId: string | null }[];

  for (const r of rows) {
    // A reservation for a different identity blocks. A reservation whose
    // requestedAgentId is null is treated as "no specific identity" and does
    // NOT block (defensive — T5 will define the null semantics).
    if (r.requestedAgentId !== null && r.requestedAgentId !== claimantId) {
      return r.requestedAgentId;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Exception → typed failure mapping (the collapse-bug fix)
// ---------------------------------------------------------------------------

/**
 * Maps a thrown exception to a typed {@link ClaimFailure}. NEVER returns
 * `already_claimed` for an exception — that conflation is the legacy collapse
 * bug (manifest §1.8 / §2.5). Split:
 *   - SQLITE_BUSY / LOCKED / readonly / corrupt / schema / generic I/O →
 *     infrastructure_failure (transient; retryable)
 *   - SQLITE_CONSTRAINT_UNIQUE / PRIMARYKEY → version_conflict (serialization)
 *   - SQLITE_CONSTRAINT_FOREIGNKEY / NOTNULL / CHECK → infrastructure_failure
 *     (data integrity, not a domain refusal)
 *   - non-SqliteError → infrastructure_failure / infrastructure_error
 */
export function mapInfraErrorToFailure(
  err: unknown,
  taskId: string,
  claimant: Claimant,
): ClaimFailure {
  logger.warn(
    { err, taskId, claimant },
    "Transaction failed during claimWithAuthority — mapped to typed failure",
  );

  if (isSqliteError(err)) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE" || err.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      return {
        success: false,
        category: "version_conflict",
        reason: "version_conflict",
        causeCode: err.code,
        cause: err,
      };
    }
    // SQLITE_BUSY, SQLITE_LOCKED, SQLITE_CONSTRAINT_*, SQLITE_READONLY, …
    return {
      success: false,
      category: "infrastructure_failure",
      reason: "claim_failed",
      causeCode: err.code,
      cause: err,
    };
  }

  return {
    success: false,
    category: "infrastructure_failure",
    reason: "infrastructure_error",
    cause: err,
  };
}

// Re-export so Phase 3 callers can read the legacy-observation gate constant
// without reaching into the schema module.
export { TASK_CREATION_INTEGRITY_VERSION };
