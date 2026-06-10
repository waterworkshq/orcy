import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import {
  validateEventType,
  resolveRecipients,
  type SubscriptionResolutionInput,
  type ResolvedRecipient,
} from "./notificationSubscriptionResolver.js";
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

export interface EnqueueNotificationResult {
  event: NotificationEvent;
  deliveries: NotificationDelivery[];
  suppressed: Array<{
    recipientType: NotificationRecipientType;
    recipientId: string;
    reason: string;
  }>;
}

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
    explicitRecipients: command.explicitRecipients,
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

export function getResolvedRecipients(
  habitatId: string,
  eventType: NotificationEventType,
  explicitRecipients?: Array<{
    recipientType: NotificationRecipientType;
    recipientId: string;
  }>,
): ResolvedRecipient[] {
  return resolveRecipients({ habitatId, eventType, explicitRecipients });
}
