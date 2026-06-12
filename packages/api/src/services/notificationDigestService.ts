import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as digestRepo from "../repositories/notificationDigest.js";
import * as habitatRepo from "../repositories/board.js";
import type { NotificationSubscription, NotificationCadence } from "@orcy/shared";

export interface DigestGroupResult {
  cadence: NotificationCadence;
  habitatId: string;
  recipientType: string;
  recipientId: string;
  deliveriesGrouped: number;
  digestEventId: string | null;
  errors: string[];
}

export function generateHourlyDigests(): DigestGroupResult[] {
  return generateDigestsForCadence("hourly");
}

export function generateDailyDigests(): DigestGroupResult[] {
  return generateDigestsForCadence("daily");
}

export function generateWeeklyDigests(): DigestGroupResult[] {
  return generateDigestsForCadence("weekly");
}

export function generateAllDigests(): DigestGroupResult[] {
  return [...generateHourlyDigests(), ...generateDailyDigests(), ...generateWeeklyDigests()];
}

function generateDigestsForCadence(cadence: NotificationCadence): DigestGroupResult[] {
  const results: DigestGroupResult[] = [];
  const subscriptions = findSubscriptionsForCadence(cadence);
  if (subscriptions.length === 0) return results;
  const groups = groupSubscriptionsByRecipient(subscriptions);
  for (const group of groups) {
    results.push(processDigestGroup(cadence, group));
  }
  return results;
}

function findSubscriptionsForCadence(cadence: NotificationCadence): NotificationSubscription[] {
  const habitats = habitatRepo.listHabitats();
  const matching: NotificationSubscription[] = [];
  for (const h of habitats) {
    const subs = subscriptionRepo.getAllSubscriptionsByHabitat(h.id);
    for (const sub of subs) {
      if (sub.enabled && sub.cadence === cadence && sub.recipientType && sub.recipientId) {
        matching.push(sub);
      }
    }
  }
  return matching;
}

interface RecipientGroup {
  habitatId: string;
  recipientType: string;
  recipientId: string;
  timezone: string | null;
  localSendTime: string | null;
}

function groupSubscriptionsByRecipient(subs: NotificationSubscription[]): RecipientGroup[] {
  const map = new Map<string, RecipientGroup>();
  for (const sub of subs) {
    if (!sub.recipientType || !sub.recipientId) continue;
    const key = `${sub.habitatId}:${sub.recipientType}:${sub.recipientId}`;
    if (!map.has(key)) {
      map.set(key, {
        habitatId: sub.habitatId,
        recipientType: sub.recipientType,
        recipientId: sub.recipientId,
        timezone: sub.timezone,
        localSendTime: sub.localSendTime,
      });
    }
  }
  return Array.from(map.values());
}

function processDigestGroup(
  cadence: NotificationCadence,
  group: RecipientGroup,
): DigestGroupResult {
  const errors: string[] = [];
  try {
    if (!shouldProcessAtThisTime(cadence, group.timezone, group.localSendTime)) {
      return {
        cadence,
        habitatId: group.habitatId,
        recipientType: group.recipientType,
        recipientId: group.recipientId,
        deliveriesGrouped: 0,
        digestEventId: null,
        errors: [],
      };
    }

    const { deliveries } = deliveryRepo.getActiveInbox(
      group.habitatId,
      group.recipientType as any,
      group.recipientId,
      { limit: 200 },
    );

    const pending = deliveries.filter((d) => d.status === "pending" || d.status === "delivered");
    if (pending.length === 0) {
      return {
        cadence,
        habitatId: group.habitatId,
        recipientType: group.recipientType,
        recipientId: group.recipientId,
        deliveriesGrouped: 0,
        digestEventId: null,
        errors: [],
      };
    }

    const titles = pending.map(
      (d) => eventRepo.getNotificationEventById(d.eventId)?.title ?? "Unknown",
    );
    const digestEvent = eventRepo.createNotificationEvent({
      habitatId: group.habitatId,
      eventType: "digest.ready",
      sourceType: "digest",
      severity: "info",
      title: `Digest (${cadence}): ${titles.length} notification(s)`,
      body: `You have ${titles.length} notifications:\n${titles.map((t) => `- ${t}`).join("\n")}`,
      payload: { cadence, itemCount: titles.length, titles, digestSummary: `${cadence} digest` },
      createdByType: "system",
    });

    for (const d of pending) {
      digestRepo.createDigestItem({
        digestEventId: digestEvent.id,
        includedEventId: d.eventId,
        includedDeliveryId: d.id,
      });
    }

    return {
      cadence,
      habitatId: group.habitatId,
      recipientType: group.recipientType,
      recipientId: group.recipientId,
      deliveriesGrouped: pending.length,
      digestEventId: digestEvent.id,
      errors,
    };
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    return {
      cadence,
      habitatId: group.habitatId,
      recipientType: group.recipientType,
      recipientId: group.recipientId,
      deliveriesGrouped: 0,
      digestEventId: null,
      errors,
    };
  }
}

/**
 * Determines whether a digest should fire at the current wall-clock minute.
 *
 * Relies on `Date.prototype.toLocaleString(..., { timeZone })` to resolve the
 * caller's preferred local time.  This API depends on **full-icu** support
 * from the Node runtime.  If the runtime was built with the default small-icu
 * (`--with-intl=small-icu`), only the host's system timezone is available
 * and arbitrary IANA timezone strings will produce "Invalid time zone";
 * in that case this function returns `false` so digest cadences quietly
 * fall back to UTC-based defaults.
 */
function shouldProcessAtThisTime(
  cadence: NotificationCadence,
  timezone: string | null,
  localSendTime: string | null,
): boolean {
  if (cadence === "hourly") return true;
  if ((cadence === "daily" || cadence === "weekly") && localSendTime) {
    const now = new Date();
    const tz = timezone ?? "UTC";
    try {
      const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
      const [h, m] = localSendTime.split(":").map(Number);
      if (h === undefined || m === undefined) return false;
      const expected = h * 60 + m;
      const current = local.getHours() * 60 + local.getMinutes();
      return Math.abs(current - expected) <= 5;
    } catch {
      return false;
    }
  }
  if (cadence === "daily") {
    return new Date().getUTCHours() === 0 && new Date().getUTCMinutes() < 5;
  }
  if (cadence === "weekly") {
    const d = new Date();
    return d.getUTCDay() === 1 && d.getUTCHours() === 0 && d.getUTCMinutes() < 5;
  }
  return false;
}
