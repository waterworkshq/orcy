import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import {
  validateEventType,
  resolveRecipients,
  type SubscriptionResolutionInput,
  type ResolvedRecipient,
} from "./notificationSubscriptionResolver.js";
import { findRemoteRecipientsForEvent } from "./remoteNotificationResolver.js";
import { renderNotification, type TemplateContext } from "./notificationTemplateService.js";
import type {
  NotificationEvent,
  NotificationDelivery,
  NotificationEventType,
  NotificationSeverity,
  NotificationActorType,
  NotificationSourceType,
  NotificationTargetType,
  NotificationRecipientType,
  NotificationChannel,
  NotificationCadence,
} from "@orcy/shared";

/** Command describing a notification to create: event type, source, severity, and optional explicit recipients. */
export interface EnqueueNotificationCommand {
  habitatId: string;
  eventType: NotificationEventType;
  sourceType: NotificationSourceType;
  sourceId?: string;
  targetType?: NotificationTargetType;
  targetId?: string;
  severity: NotificationSeverity;
  title?: string;
  body?: string;
  payload?: Record<string, unknown>;
  createdByType: NotificationActorType;
  createdById?: string;
  explicitRecipients?: Array<{
    recipientType: NotificationRecipientType;
    recipientId: string;
  }>;
}

/** Result of enqueueing a notification: the persisted event, created deliveries, and any recipients that were suppressed. */
export interface EnqueueNotificationResult {
  event: NotificationEvent;
  deliveries: NotificationDelivery[];
  suppressed: Array<{
    recipientType: NotificationRecipientType;
    recipientId: string;
    reason: string;
  }>;
}

/** Creates a notification event, renders its template, and persists a delivery row for each resolved recipient (including remote participants). */
export function enqueueNotification(
  command: EnqueueNotificationCommand,
): EnqueueNotificationResult {
  validateEventType(command.eventType);

  const templateCtx: TemplateContext = {
    eventType: command.eventType,
    sourceType: command.sourceType,
    sourceId: command.sourceId,
    targetType: command.targetType,
    targetId: command.targetId,
    severity: command.severity,
    recipientType: "human",
    payload: command.payload,
  };

  const rendered = renderNotification(templateCtx);

  const event = eventRepo.createNotificationEvent({
    habitatId: command.habitatId,
    eventType: command.eventType,
    sourceType: command.sourceType,
    sourceId: command.sourceId,
    targetType: command.targetType,
    targetId: command.targetId,
    severity: command.severity,
    title: command.title ?? rendered.title,
    body: command.body ?? rendered.body,
    payload: command.payload ?? rendered.payload,
    createdByType: command.createdByType,
    createdById: command.createdById,
  });

  const resolution = resolveRecipients({
    habitatId: command.habitatId,
    eventType: command.eventType,
    explicitRecipients: augmentWithRemoteRecipients(command),
  });

  const deliveries: NotificationDelivery[] = [];
  const suppressed: EnqueueNotificationResult["suppressed"] = [];

  for (const resolved of resolution) {
    if (resolved.suppressed && !resolved.required) {
      suppressed.push({
        recipientType: resolved.recipientType,
        recipientId: resolved.recipientId,
        reason: resolved.suppressReason ?? "unknown",
      });
      continue;
    }

    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: command.habitatId,
      recipientType: resolved.recipientType,
      recipientId: resolved.recipientId,
      required: resolved.required,
      channels: resolved.channels,
    });

    deliveries.push(delivery);
  }

  return { event, deliveries, suppressed };
}

/** Convenience wrapper around `enqueueNotification` for the common case of notifying an explicit recipient list. */
export function enqueueNotificationForRecipients(
  habitatId: string,
  eventType: NotificationEventType,
  sourceType: NotificationSourceType,
  severity: NotificationSeverity,
  recipients: Array<{
    recipientType: NotificationRecipientType;
    recipientId: string;
  }>,
  options?: {
    sourceId?: string;
    targetType?: NotificationTargetType;
    targetId?: string;
    payload?: Record<string, unknown>;
    createdByType?: NotificationActorType;
    createdById?: string;
    title?: string;
    body?: string;
  },
): EnqueueNotificationResult {
  return enqueueNotification({
    habitatId,
    eventType,
    sourceType,
    sourceId: options?.sourceId,
    targetType: options?.targetType,
    targetId: options?.targetId,
    severity,
    title: options?.title,
    body: options?.body,
    payload: options?.payload,
    createdByType: options?.createdByType ?? "system",
    createdById: options?.createdById,
    explicitRecipients: recipients,
  });
}

/** Returns the full resolved recipient list (including remote participants) for an event without persisting anything. */
export function getResolvedRecipients(
  habitatId: string,
  eventType: NotificationEventType,
  explicitRecipients?: Array<{
    recipientType: NotificationRecipientType;
    recipientId: string;
  }>,
): ResolvedRecipient[] {
  return resolveRecipients({
    habitatId,
    eventType,
    explicitRecipients: augmentRecipientsWithRemote({
      habitatId,
      eventType,
      targetType: explicitRecipients ? undefined : undefined,
      targetId: explicitRecipients ? undefined : undefined,
      explicit: explicitRecipients,
    }),
  });
}

/**
 * Merge explicit recipients with any remote participants/pods whose
 * grants cover the event's target. This is how remote participants get
 * notifications — they are not in the explicitRecipients list normally,
 * but their grant visibility makes them eligible.
 */
function augmentRecipientsWithRemote(input: {
  habitatId: string;
  eventType: NotificationEventType;
  targetType?: NotificationTargetType;
  targetId?: string;
  explicit?: Array<{
    recipientType: NotificationRecipientType;
    recipientId: string;
  }>;
}): Array<{ recipientType: NotificationRecipientType; recipientId: string }> {
  const result: Array<{ recipientType: NotificationRecipientType; recipientId: string }> = [
    ...(input.explicit ?? []),
  ];
  const seen = new Set(result.map((r) => `${r.recipientType}:${r.recipientId}`));

  // Translate the NotificationTargetType to the grant visibility target type
  const targetType =
    input.targetType === "mission" || input.targetType === "task" || input.targetType === "habitat"
      ? input.targetType
      : undefined;

  const remote = findRemoteRecipientsForEvent({
    habitatId: input.habitatId,
    eventType: input.eventType,
    targetType: targetType as "task" | "mission" | "habitat" | undefined,
    targetId: input.targetId,
  });

  for (const r of remote) {
    const key = `${r.recipientType}:${r.recipientId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(r);
  }

  return result;
}

/**
 * Wrap the command's explicitRecipients to also include remote participants
 * whose grants cover the command's target.
 */
function augmentWithRemoteRecipients(
  command: EnqueueNotificationCommand,
): Array<{ recipientType: NotificationRecipientType; recipientId: string }> {
  return augmentRecipientsWithRemote({
    habitatId: command.habitatId,
    eventType: command.eventType,
    targetType: command.targetType,
    targetId: command.targetId,
    explicit: command.explicitRecipients,
  });
}
