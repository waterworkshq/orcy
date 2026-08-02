import { logger } from "../../lib/logger.js";
import { enqueueNotification } from "../notificationCommandService.js";

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
    enqueueNotification({
      habitatId,
      eventType,
      sourceType: "workflow",
      targetType: "task",
      targetId:
        (payload.recoveryTaskId as string | undefined) ??
        (payload.failedTaskId as string | undefined),
      severity: eventType === "workflow.recovery_succeeded" ? "info" : "warning",
      title,
      payload,
      createdByType: "system",
      createdById: "workflow-service",
    });
  } catch (err) {
    logger.error({ err, eventType, habitatId }, "Failed to emit workflow recovery notification");
  }
}

/** Substitutes `{{key}}` placeholders in `text` with values from `vars`, leaving unknown keys intact as empty strings. */
export function substituteTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}
