/**
 * Transition-budget breach escalation — the plan §6 breach side effects.
 *
 * Split from `transitionBudget.ts` and loaded ONLY via dynamic import from
 * the guard's `scheduleBreachEscalation`: this module's static graph
 * (transition-emitter, notification command service → remote notification
 * resolver → grant/participant repos) must not become an eager import of
 * every `transitionBudget` consumer, because mock-based suites with partial
 * `db/schema` module factories would fail at import time on symbols they
 * never list (the extend-not-replace mock trap — same reasoning as the
 * T2 lazy-`getDb()` seam, at module granularity). The dynamic import
 * resolves once, inside the post-commit microtask, on first real breach.
 */
import { logger } from "../../lib/logger.js";
import { getDb } from "../../db/index.js";
import { emitTransition } from "./transition-emitter.js";
import { enqueueNotificationForRecipients } from "../notificationCommandService.js";
import {
  BUDGET_BREACH_MARKER,
  BUDGET_ESCALATION_ACTOR_ID,
  hasBudgetBreachEscalation,
  type BudgetActorType,
  type BudgetRefusedOutcome,
  type MeteredTaskAction,
} from "./transitionBudget.js";
import * as taskRepo from "../../repositories/task.js";
import * as habitatRepo from "../../repositories/habitat.js";
import * as teamMemberRepo from "../../repositories/teamMember.js";

/**
 * THE breach site (plan §6): on the first refusal, emit the existing
 * `escalated` TaskAction with breach metadata, then direct-call the human
 * notification — the `retryService.escalateToHuman` / `recoveryNotifications`
 * direct-call precedent (`escalated` is deliberately absent from
 * NOTIFY_TASK_EVENT_ACTIONS per the v0.17.1 consumer-audit rule). Emit-once
 * via {@link hasBudgetBreachEscalation}. Never throws into the refusing
 * caller: escalation failure is logged and swallowed.
 *
 * Runs OUTSIDE the refusing caller's transaction (the guard schedules this
 * post-commit via queueMicrotask) — the emitter's mission-recalc and
 * notification side effects must never join the caller's tx.
 */
export function escalateTransitionBudgetBreach(
  taskId: string,
  habitatId: string,
  refused: BudgetRefusedOutcome,
  attemptedAction: MeteredTaskAction,
  attemptedActorType: BudgetActorType,
): void {
  try {
    if (hasBudgetBreachEscalation(getDb(), taskId)) return;

    const task = taskRepo.getTaskById(taskId);
    emitTransition(taskId, "escalated", habitatId, {
      actorType: "system",
      actorId: BUDGET_ESCALATION_ACTOR_ID,
      reason: "transition budget exhausted",
      metadata: {
        [BUDGET_BREACH_MARKER]: {
          attemptedAction,
          attemptedActorType,
          ceiling: refused.ceiling,
          count: refused.count,
        },
      },
    });

    notifyHabitatHumansOfBreach(
      taskId,
      habitatId,
      task?.title,
      refused,
      attemptedAction,
      attemptedActorType,
    );
  } catch (err) {
    logger.warn({ err, taskId, habitatId }, "Transition-budget breach escalation failed");
  }
}

/** Best-effort human notification at the breach site; failures are logged, never thrown. */
function notifyHabitatHumansOfBreach(
  taskId: string,
  habitatId: string,
  taskTitle: string | undefined,
  refused: BudgetRefusedOutcome,
  attemptedAction: MeteredTaskAction,
  attemptedActorType: BudgetActorType,
): void {
  if (!habitatId) return; // unresolvable habitat — the escalated event row is the durable record; SSE has no audience here
  try {
    const breach = {
      attemptedAction,
      attemptedActorType,
      ceiling: refused.ceiling,
      count: refused.count,
    };
    enqueueNotificationForRecipients(
      habitatId,
      "task.blocked",
      "task",
      "warning",
      habitatHumanRecipients(habitatId),
      {
        sourceId: taskId,
        targetType: "task",
        targetId: taskId,
        title: "Task blocked: transition budget exhausted",
        body: `Task "${taskTitle ?? taskId}" exhausted its transition budget: ${refused.count} of ${refused.ceiling} metered transitions used; the ${attemptedAction} attempt by a ${attemptedActorType} actor was refused. Raise lifecycleSettings.taskTransitionCeiling or resolve the task as a human.`,
        payload: { taskId, taskTitle, transitionBudget: breach },
        createdByType: "system",
        createdById: BUDGET_ESCALATION_ACTOR_ID,
      },
    );
  } catch (err) {
    logger.warn({ err, taskId, habitatId }, "Transition-budget breach notification failed");
  }
}

/** The habitat's human team members (the `releaseReconciliationService` recipient precedent). */
function habitatHumanRecipients(
  habitatId: string,
): Array<{ recipientType: "human"; recipientId: string }> {
  const habitat = habitatRepo.getHabitatById(habitatId);
  if (!habitat?.teamId) return [];
  return teamMemberRepo.listMembers(habitat.teamId).map((m) => ({
    recipientType: "human" as const,
    recipientId: m.userId,
  }));
}
