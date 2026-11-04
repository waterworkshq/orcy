import { logger } from "../../lib/logger.js";
import { enqueueNotificationWithIntents, type NotificationAudienceIntent } from "../notificationIntentCommand.js";
import * as taskRepo from "../../repositories/task.js";

export type RecoveryNotificationEventType =
  | "workflow.recovery_started"
  | "workflow.recovery_succeeded"
  | "workflow.recovery_unrecoverable";

/** Emits a workflow recovery notification event. */
export function emitRecoveryNotification(
  habitatId: string,
  eventType: RecoveryNotificationEventType,
  title: string,
  payload: Record<string, unknown>,
): void {
  try {
    const targetId =
      (payload.recoveryTaskId as string | undefined) ??
      (payload.failedTaskId as string | undefined);
    // P6 preserved pool: task-targeted when an id exists (byte-equal to today's
    // augmentation). NO ids ⇒ operators only, NO remote audience — an untargeted
    // event must never become remote broadcast (adopted policy); classified.
    const intents: NotificationAudienceIntent[] = [{ kind: "habitat_operators" }];
    // The remote intent requires a persisted task row IN THIS HABITAT (the
    // intent module's task-scope validation throws on a synthetic id AND on a
    // cross-habitat id — which would drop the whole event, operators
    // included); a payload id without a row in the habitat classifies as no
    // supported target — operators only.
    if (targetId && taskRepo.getHabitatIdForTask(targetId) === habitatId) {
      intents.push({ kind: "remote_visible", targetType: "task", targetId });
    } else {
      logger.warn({ eventType, habitatId }, "Recovery notification has no supported task target — remote audience omitted");
    }
    enqueueNotificationWithIntents({
      habitatId,
      eventType,
      sourceType: "workflow",
      targetType: "task",     // event-row metadata parity with today's row
      targetId,
      severity: eventType === "workflow.recovery_succeeded" ? "info" : "warning",
      title,
      payload,
      createdByType: "system",
      createdById: "workflow-service",
      intents,
    });
  } catch (err) {
    logger.error({ err, eventType, habitatId }, "Failed to emit workflow recovery notification");
  }
}

/** Substitutes `{{key}}` placeholders in `text` with values from `vars`, leaving unknown keys intact as empty strings. */
export function substituteTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}
