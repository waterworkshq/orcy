/**
 * T5a — Remote-task-lifecycle seam.
 *
 * Three wrappers (claim / submit / release) that compose the tx-injecting
 * primitives (`claimWithAuthorityClient`, `submitWithAuthorityClient`,
 * `createEventWithClient`) into ONE atomic transaction each, then emit the
 * transition + notification OUTSIDE the tx. This module is the service-layer
 * counterpart to the local `task-lifecycle.ts`, specialized for the remote
 * participant model.
 *
 * Boundary (ADR-0038): the wrappers do ONLY eligibility (D2 capability
 * check), interceptors (D1 pre/post), actor mapping, and notification. The
 * four task-intrinsic guards live inside `claimWithAuthorityClient` and are
 * NOT re-checked here.
 *
 * Invariants:
 *   #8 no nested transactions — inside `db.transaction`, only `*WithClient(tx)`
 *      primitives are called. NEVER `claimWithAuthority(db)` (opens its own tx).
 *   #9 no double event — `existingEventId` is always passed to `emitTransition`
 *      so it reuses the tx-committed event and skips its own `createEvent`.
 *
 * Both governance flags (`applyInterceptorsToRemote`,
 * `enforceHostApprovedCapability`) default OFF. With flags off, the wrappers
 * behave like today's remote path minus the manual event (they use
 * `emitTransition` with `existingEventId`).
 */
import { getDb } from "../../db/index.js";
import { tasks } from "../../db/schema/index.js";
import { eq, and, sql } from "drizzle-orm";
import type { Task, Artifact } from "../../models/index.js";
import type { ActorType } from "@orcy/shared";
import * as taskRepo from "../../repositories/task.js";
import { claimWithAuthorityClient, type ClaimResult } from "../../repositories/claimAuthority.js";
import { submitWithAuthorityClient } from "../../repositories/taskStateMachine.js";
import { createEventWithClient } from "../../repositories/events/event-crud.js";
import { emitTransition } from "./transition-emitter.js";
import * as pluginManager from "../../plugins/pluginManager.js";
import { validateAgentCapabilities } from "./helpers.js";
import * as qualityGateService from "../qualityGateService.js";
import * as reviewAssignment from "../reviewAssignmentService.js";
import { getRemoteGovernanceSettings } from "../remoteGovernance.js";
import {
  mapParticipantToActorType,
  type RemoteParticipantContext,
} from "../../middleware/remoteAuth.js";
import { InterceptorVetoError } from "../../errors.js";
import { withAuditProvenanceMetadata } from "../auditProvenanceContext.js";
import { emitRemoteOriginatedNotification } from "../remoteNotifications.js";
import { logger } from "../../lib/logger.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Maps the remote participant to the actor pair used throughout the wrappers. */
function remoteActor(ctx: RemoteParticipantContext): { actorType: ActorType; actorId: string } {
  return {
    actorType: mapParticipantToActorType(
      ctx.participant.participantType as "remote_human" | "remote_orcy",
    ),
    actorId: ctx.participant.id,
  };
}

/** Extracts the flat reason string from a {@link ClaimResult} failure. */
function claimFailureReason(r: ClaimResult): string {
  if (r.success) return "";
  return r.reason;
}

// ---------------------------------------------------------------------------
// claimTaskForRemote
// ---------------------------------------------------------------------------

/**
 * Atomically claims a task for a remote participant. Resolves governance flags
 * (both default OFF), runs D2 eligibility + D1 pre-interceptor BEFORE the tx,
 * then composes `claimWithAuthorityClient` + `createEventWithClient` in ONE
 * transaction. On success, emits the transition (reusing the tx-committed
 * event via `existingEventId` — invariant #9) and fires the step-4.5
 * notification.
 *
 * Returns `{success:true, task}` or `{success:false, reason, missingCapabilities?}`.
 * Throws `InterceptorVetoError` when a D1 pre-interceptor vetoes.
 */
export function claimTaskForRemote(
  taskId: string,
  ctx: RemoteParticipantContext,
):
  | { success: true; task: Task }
  | { success: false; reason: string; missingCapabilities?: string[] } {
  // 1. Load task
  const task = taskRepo.getTaskById(taskId);
  if (!task) return { success: false, reason: "not_found" };

  const habitatId = ctx.habitatId;
  const participantId = ctx.participant.id;
  const { actorType, actorId } = remoteActor(ctx);

  // Resolve governance flags (both default OFF)
  const governance = getRemoteGovernanceSettings(habitatId);

  // 2. D2 eligibility (only if enforceHostApprovedCapability flag ON)
  if (governance.enforceHostApprovedCapability) {
    if (task.requiredCapabilities && task.requiredCapabilities.length > 0) {
      const missing = validateAgentCapabilities(
        ctx.participant.approvedCapabilities ?? [],
        task.requiredCapabilities as string[],
      );
      if (missing.length > 0) {
        return { success: false, reason: "capability_mismatch", missingCapabilities: missing };
      }
    }
  }

  // 3. D1 pre-interceptor (only if applyInterceptorsToRemote flag ON), BEFORE the tx
  if (governance.applyInterceptorsToRemote) {
    const veto = pluginManager.runPreInterceptors(taskId, "taskClaimed", habitatId, {
      actorType,
      actorId,
      oldStatus: task.status,
      newStatus: "claimed",
      task,
    });
    if (veto) throw new InterceptorVetoError(veto);
  }

  // 4. The atomic tx — only *WithClient(tx) primitives inside (invariant #8)
  const { result, eventId } = getDb().transaction((tx) => {
    const r = claimWithAuthorityClient(tx, taskId, { kind: "remote", id: participantId });
    let evId: string | undefined;
    if (r.success) {
      const event = createEventWithClient(tx, {
        taskId,
        action: "claimed",
        actorType,
        actorId,
        fromStatus: task.status as never,
        toStatus: "claimed" as never,
        metadata: withAuditProvenanceMetadata({}),
      });
      evId = event.id;
    }
    return { result: r, eventId: evId };
  });

  if (!result.success) {
    return { success: false, reason: claimFailureReason(result) };
  }

  // 5. emitTransition with existingEventId (invariant #9 — no double event)
  emitTransition(taskId, "claimed", habitatId, {
    actorType,
    actorId,
    existingEventId: eventId,
    oldStatus: task.status,
    newStatus: "claimed",
    task: result.task,
  });

  // 6. Step-4.5 notification (best-effort)
  emitRemoteOriginatedNotification({
    habitatId,
    eventType: "task.assigned",
    sourceType: "task",
    sourceId: task.id,
    targetType: "task",
    targetId: task.id,
    severity: "info",
    title: `Task claimed: ${task.title}`,
    body: `${ctx.participant.displayName} claimed task ${task.title}`,
    payload: { taskId: task.id, missionId: task.missionId, action: "claimed" },
    actorType: ctx.participant.participantType as "remote_human" | "remote_orcy",
    actorId,
    podId: ctx.pod.id,
  });

  // 7. D1 post-interceptor (if flag ON)
  if (governance.applyInterceptorsToRemote) {
    pluginManager.runPostInterceptors(taskId, "taskClaimed", habitatId, {
      actorType,
      actorId,
      oldStatus: task.status,
      newStatus: "claimed",
      task: result.task,
    });
  }

  // 8. Return success
  return { success: true, task: result.task };
}

// ---------------------------------------------------------------------------
// submitTaskForRemote
// ---------------------------------------------------------------------------

/**
 * Submits an in-progress remote-claimed task for review. Mirrors local
 * `submitTask` parity (§E): D1 pre-interceptor → quality-gate validation →
 * atomic tx (`submitWithAuthorityClient` + `createEventWithClient`) →
 * transition emit → D1 post-interceptor → reviewer assignment (best-effort)
 * → notification.
 *
 * Returns `{success:true, task}` or `{success:false, reason, missingQualityItems?}`.
 * Throws `InterceptorVetoError` when a D1 pre-interceptor vetoes.
 */
export function submitTaskForRemote(
  taskId: string,
  ctx: RemoteParticipantContext,
  result: string,
  artifacts: Artifact[],
):
  | { success: true; task: Task }
  | {
      success: false;
      reason: string;
      missingQualityItems?: { category: string; missingItems: string[] }[];
    } {
  // 1. Load task; ownership pre-check
  const task = taskRepo.getTaskById(taskId);
  if (!task) return { success: false, reason: "not_found" };

  const participantId = ctx.participant.id;
  if (task.remoteAssignedParticipantId !== participantId) {
    return { success: false, reason: "not_owned" };
  }

  const habitatId = ctx.habitatId;
  const { actorType, actorId } = remoteActor(ctx);
  const governance = getRemoteGovernanceSettings(habitatId);

  // 2. D1 pre-interceptor (if flag ON) — BEFORE quality gate, matching local order
  if (governance.applyInterceptorsToRemote) {
    const veto = pluginManager.runPreInterceptors(taskId, "taskSubmitted", habitatId, {
      actorType,
      actorId,
      oldStatus: task.status,
      newStatus: "submitted",
      metadata: { result },
      task,
    });
    if (veto) throw new InterceptorVetoError(veto);
  }

  // 3. Quality gate validation
  const qualityValidation = qualityGateService.validateQualityGates(taskId);
  if (!qualityValidation.passed) {
    return {
      success: false,
      reason: "quality_gates_not_met",
      missingQualityItems: qualityValidation.failures,
    };
  }

  // 4. Atomic tx — submitWithAuthorityClient + createEventWithClient (invariant #8)
  const { submittedTask, eventId } = getDb().transaction((tx) => {
    const submitted = submitWithAuthorityClient(tx, taskId, participantId, result, artifacts);
    let evId: string | undefined;
    if (submitted) {
      const event = createEventWithClient(tx, {
        taskId,
        action: "submitted",
        actorType,
        actorId,
        fromStatus: task.status as never,
        toStatus: "submitted" as never,
        metadata: withAuditProvenanceMetadata({ result }),
      });
      evId = event.id;
    }
    return { submittedTask: submitted, eventId: evId };
  });

  if (!submittedTask) {
    return { success: false, reason: "submit_failed" };
  }

  // 5. emitTransition with existingEventId (invariant #9)
  emitTransition(taskId, "submitted", habitatId, {
    actorType,
    actorId,
    existingEventId: eventId,
    oldStatus: task.status,
    newStatus: "submitted",
    metadata: { result },
    task: submittedTask,
  });

  // 6. D1 post-interceptor (if flag ON)
  if (governance.applyInterceptorsToRemote) {
    pluginManager.runPostInterceptors(taskId, "taskSubmitted", habitatId, {
      actorType,
      actorId,
      oldStatus: task.status,
      newStatus: "submitted",
      metadata: { result },
      task: submittedTask,
    });
  }

  // 7. Reviewer assignment (best-effort, like local)
  try {
    reviewAssignment.assignReviewers(taskId, habitatId, participantId);
  } catch (err) {
    logger.warn({ err, taskId }, "Failed to assign reviewers — task still submitted");
  }

  // 8. Step-4.5 notification (best-effort)
  emitRemoteOriginatedNotification({
    habitatId,
    eventType: "task.review_requested",
    sourceType: "task",
    sourceId: submittedTask.id,
    targetType: "task",
    targetId: submittedTask.id,
    severity: "info",
    title: `Task submitted for review: ${submittedTask.title}`,
    body: `${ctx.participant.displayName} submitted task ${submittedTask.title} for review`,
    payload: {
      taskId: submittedTask.id,
      missionId: submittedTask.missionId,
      action: "submitted",
    },
    actorType: ctx.participant.participantType as "remote_human" | "remote_orcy",
    actorId,
    podId: ctx.pod.id,
  });

  // 9. Return success
  return { success: true, task: submittedTask };
}

// ---------------------------------------------------------------------------
// releaseTaskForRemote
// ---------------------------------------------------------------------------

/**
 * Releases a remote-claimed task back to pending. Simpler than claim/submit:
 * no quality gate, no review, NO notification (release carries none today).
 * Composes the release mutation + `createEventWithClient` in ONE transaction,
 * then emits the transition.
 *
 * Returns `{success:true, task}` or `{success:false, reason}`.
 */
export function releaseTaskForRemote(
  taskId: string,
  ctx: RemoteParticipantContext,
  reason?: string,
): { success: true; task: Task } | { success: false; reason: string } {
  // 1. Load task; ownership pre-check
  const task = taskRepo.getTaskById(taskId);
  if (!task) return { success: false, reason: "not_found" };

  const participantId = ctx.participant.id;
  if (task.remoteAssignedParticipantId !== participantId) {
    return { success: false, reason: "not_owned" };
  }

  const habitatId = ctx.habitatId;
  const { actorType, actorId } = remoteActor(ctx);

  // 2. Atomic tx — release mutation (inline, mirroring releaseTaskByRemoteParticipant)
  //    + createEventWithClient (invariant #8)
  const { releasedTask, eventId } = getDb().transaction((tx) => {
    type TaskRow = typeof tasks.$inferSelect;
    const row = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as TaskRow | undefined;
    if (!row) return { releasedTask: null as Task | null, eventId: undefined };

    // Gate: status must be claimed or in_progress, and owned by this participant
    if (
      (row.status !== "claimed" && row.status !== "in_progress") ||
      row.remoteAssignedParticipantId !== participantId
    ) {
      return { releasedTask: null as Task | null, eventId: undefined };
    }

    const now = new Date().toISOString();
    tx.update(tasks)
      .set({
        remoteAssignedParticipantId: null,
        status: "pending",
        claimedAt: null,
        updatedAt: now,
        version: sql`${tasks.version} + 1`,
      })
      .where(
        and(eq(tasks.id, taskId), eq(tasks.remoteAssignedParticipantId, participantId)),
      )
      .run();

    const updated = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as
      | TaskRow
      | undefined;
    const released = (updated as unknown as Task) ?? null;
    if (!released) return { releasedTask: null, eventId: undefined };

    const event = createEventWithClient(tx, {
      taskId,
      action: "released",
      actorType,
      actorId,
      fromStatus: task.status as never,
      toStatus: "pending" as never,
      metadata: withAuditProvenanceMetadata({ reason }),
    });
    return { releasedTask: released, eventId: event.id };
  });

  if (!releasedTask) {
    return { success: false, reason: "release_failed" };
  }

  // 3. emitTransition with existingEventId (invariant #9)
  emitTransition(taskId, "released", habitatId, {
    actorType,
    actorId,
    existingEventId: eventId,
    oldStatus: task.status,
    newStatus: "pending",
    reason,
    metadata: { reason },
    task: releasedTask,
  });

  // 4. Return success (NO step-4.5 notification — release carries none)
  return { success: true, task: releasedTask };
}
