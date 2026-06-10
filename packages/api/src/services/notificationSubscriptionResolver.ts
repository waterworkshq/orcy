import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import type {
  NotificationEventType,
  NotificationRecipientType,
  NotificationChannel,
  NotificationCadence,
  NotificationSubscription,
} from "@orcy/shared";

const V18_EVENT_CATALOG: Set<string> = new Set([
  "task.blocked",
  "task.review_requested",
  "task.assigned",
  "mission.risk_marked",
  "automation.rule_matched",
  "automation.action_failed",
  "digest.ready",
  "pulse.signal_posted",
]);

export function isValidEventType(eventType: string): boolean {
  return V18_EVENT_CATALOG.has(eventType);
}

export function validateEventType(eventType: string): void {
  if (!V18_EVENT_CATALOG.has(eventType)) {
    throw new Error(`INVALID_NOTIFICATION_EVENT_TYPE:${eventType}`);
  }
}

export interface ResolvedRecipient {
  recipientType: NotificationRecipientType;
  recipientId: string;
  channels: NotificationChannel[];
  cadence: NotificationCadence;
  required: boolean;
  suppressed: boolean;
  suppressReason?: "muted" | "disabled" | "no_default";
}

export interface SubscriptionResolutionInput {
  habitatId: string;
  eventType: NotificationEventType;
  explicitRecipients?: Array<{
    recipientType: NotificationRecipientType;
    recipientId: string;
  }>;
}

export function resolveRecipients(input: SubscriptionResolutionInput): ResolvedRecipient[] {
  const defaults = subscriptionRepo.getHabitatDefaults(input.habitatId, input.eventType);

  if (
    defaults.length === 0 &&
    (!input.explicitRecipients || input.explicitRecipients.length === 0)
  ) {
    return [];
  }

  const recipients: ResolvedRecipient[] = [];
  const seen = new Set<string>();

  if (input.explicitRecipients && input.explicitRecipients.length > 0) {
    for (const r of input.explicitRecipients) {
      const key = `${r.recipientType}:${r.recipientId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const resolved = resolveForRecipient(
        input.habitatId,
        input.eventType,
        r.recipientType,
        r.recipientId,
        defaults,
      );
      recipients.push(resolved);
    }
  }

  return recipients;
}

function resolveForRecipient(
  habitatId: string,
  eventType: string,
  recipientType: NotificationRecipientType,
  recipientId: string,
  defaults: NotificationSubscription[],
): ResolvedRecipient {
  const overrides = subscriptionRepo.getRecipientOverrides(
    habitatId,
    recipientType,
    recipientId,
    eventType,
  );

  const override = overrides.length > 0 ? overrides[0] : null;

  if (override && !override.enabled) {
    return {
      recipientType,
      recipientId,
      channels: [],
      cadence: "immediate",
      required: false,
      suppressed: true,
      suppressReason: "disabled",
    };
  }

  if (override) {
    const muted = isMuted(override.muteUntil);
    return {
      recipientType,
      recipientId,
      channels: override.channels as NotificationChannel[],
      cadence: override.cadence as NotificationCadence,
      required: false,
      suppressed: muted,
      suppressReason: muted ? "muted" : undefined,
    };
  }

  const matchingDefault = defaults.length > 0 ? defaults[0] : null;

  if (!matchingDefault) {
    return {
      recipientType,
      recipientId,
      channels: [],
      cadence: "immediate",
      required: false,
      suppressed: true,
      suppressReason: "no_default",
    };
  }

  if (matchingDefault.required) {
    return {
      recipientType,
      recipientId,
      channels: matchingDefault.channels as NotificationChannel[],
      cadence: matchingDefault.cadence as NotificationCadence,
      required: true,
      suppressed: false,
    };
  }

  const muted = isMuted(matchingDefault.muteUntil);
  return {
    recipientType,
    recipientId,
    channels: matchingDefault.channels as NotificationChannel[],
    cadence: matchingDefault.cadence as NotificationCadence,
    required: false,
    suppressed: muted,
    suppressReason: muted ? "muted" : undefined,
  };
}

function isMuted(muteUntil: string | null): boolean {
  if (!muteUntil) return false;
  return new Date(muteUntil) > new Date();
}

export function getDefaultSubscription(
  habitatId: string,
  eventType: string,
): NotificationSubscription | null {
  const defaults = subscriptionRepo.getHabitatDefaults(habitatId, eventType);
  return defaults.length > 0 ? defaults[0] : null;
}

export function getRecipientOverride(
  habitatId: string,
  recipientType: NotificationRecipientType,
  recipientId: string,
  eventType: string,
): NotificationSubscription | null {
  const overrides = subscriptionRepo.getRecipientOverrides(
    habitatId,
    recipientType,
    recipientId,
    eventType,
  );
  return overrides.length > 0 ? overrides[0] : null;
}
