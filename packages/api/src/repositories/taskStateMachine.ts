import { getDb } from "../db/index.js";
import { tasks } from "../db/schema/index.js";
import { eq, and, inArray, sql } from "drizzle-orm";
import type { Task, Artifact } from "../models/index.js";
import { repositoryTransactionError } from "../errors/repository.js";
import { getTaskById } from "./taskCrud.js";
import { claimWithAuthority, progressWithAuthority, type ClaimResult } from "./claimAuthority.js";

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
): { success: true; task: Task } | { success: false; reason: string } {
  // Routed through the claim authority (T2): the authority owns gates +
  // checkClaimability + TOCTOU + infra mapping in one transaction. The typed
  // ClaimResult is flattened back to the legacy shape every caller depends on.
  return flattenClaimResult(claimWithAuthority(getDb(), taskId, { kind: "local", id: agentId }));
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
  const db = getDb();
  const now = new Date().toISOString();

  const task = getTaskById(taskId);
  if (!task) return null;
  if (
    (task.status !== "claimed" && task.status !== "in_progress") ||
    task.remoteAssignedParticipantId !== remoteParticipantId
  ) {
    return null;
  }

  db.update(tasks)
    .set({
      remoteAssignedParticipantId: null,
      status: "pending",
      claimedAt: null,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.remoteAssignedParticipantId, remoteParticipantId)))
    .run();

  return getTaskById(taskId);
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

export function startTask(taskId: string, agentId: string): Task | null {
  // Routed through the progression authority (T2 remediation M3): the
  // claimed → in_progress transition runs identity/status re-read + gates +
  // conditional UPDATE + post-write verify in ONE transaction, closing the
  // TOCTOU race the pre-remediation gate-check-then-separate-UPDATE left open.
  // Public Task | null shape and null-on-missing/wrong-agent/wrong-status
  // semantics are preserved (manifest §4). Gates are open for every legacy
  // task; a future post-cutover reservation for another identity blocks → null.
  return progressWithAuthority(getDb(), taskId, { kind: "local", id: agentId });
}

export function submitTask(
  taskId: string,
  agentId: string,
  result: string,
  artifacts: Artifact[],
): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "in_progress" || task.assignedAgentId !== agentId) return null;

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
        eq(tasks.assignedAgentId, agentId),
        eq(tasks.status, "in_progress"),
      ),
    )
    .run();

  return getTaskById(taskId);
}

export function releaseTask(taskId: string, _reason: string): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "claimed" && task.status !== "in_progress") return null;

  db.update(tasks)
    .set({
      assignedAgentId: null,
      status: "pending",
      claimedAt: null,
      startedAt: null,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(eq(tasks.id, taskId))
    .run();

  return getTaskById(taskId);
}

export function failTask(taskId: string, _reason: string): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "in_progress" && task.status !== "claimed") return null;

  db.update(tasks)
    .set({
      status: "failed",
      assignedAgentId: null,
      completedAt: now,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(eq(tasks.id, taskId))
    .run();

  return getTaskById(taskId);
}

export function approveTask(taskId: string): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  db.update(tasks)
    .set({
      status: "approved",
      completedAt: now,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, "submitted")))
    .run();

  return getTaskById(taskId);
}

export function markTaskDone(taskId: string): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  db.update(tasks)
    .set({
      status: "done",
      completedAt: now,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(and(eq(tasks.id, taskId), inArray(tasks.status, ["submitted", "approved"])))
    .run();

  return getTaskById(taskId);
}

export function rejectTask(taskId: string, reason: string): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  db.update(tasks)
    .set({
      status: "rejected",
      rejectionReason: reason,
      rejectedCount: sql`${tasks.rejectedCount} + 1`,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, "submitted")))
    .run();

  return getTaskById(taskId);
}
