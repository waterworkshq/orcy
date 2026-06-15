import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as retentionRepo from "../repositories/notificationRetentionPolicy.js";
import * as habitatRepo from "../repositories/board.js";
import type { NotificationDelivery, NotificationDeliveryStatus } from "@orcy/shared";

const STATUS_CLEARABLE_BY_ACKNOWLEDGED = ["acknowledged"] as NotificationDeliveryStatus[];
const STATUS_CLEARABLE_BY_RESOLVED = ["acknowledged"];
const STATUS_CLEARABLE_BY_FAILED = ["failed"] as NotificationDeliveryStatus[];

/** Outcome of clearing deliveries for a habitat or admin scope, including the count cleared and any errors. */
export interface ClearanceResult {
  habitatId: string;
  cleared: number;
  errors: string[];
}

/** Clears deliveries across all habitats that have aged past their retention policy thresholds, persisting `cleared` status to the DB. */
export function runScheduledClearance(): ClearanceResult[] {
  const results: ClearanceResult[] = [];
  const habitats = habitatRepo.listHabitats();

  for (const h of habitats) {
    const result = clearHabitat(h.id);
    results.push(result);
  }

  return results;
}

function clearHabitat(habitatId: string): ClearanceResult {
  const errors: string[] = [];
  let cleared = 0;

  try {
    const policy = retentionRepo.getRetentionPolicyByHabitat(habitatId);
    if (!policy) {
      return { habitatId, cleared: 0, errors: [] };
    }

    const now = new Date();
    const nowIso = now.toISOString();

    if (policy.acknowledgedClearAfterDays > 0) {
      const threshold = new Date(
        now.getTime() - policy.acknowledgedClearAfterDays * 86400000,
      ).toISOString();
      const candidates = deliveryRepo.getClearanceCandidates(
        habitatId,
        STATUS_CLEARABLE_BY_ACKNOWLEDGED,
        threshold,
      );
      for (const d of candidates) {
        try {
          processClearance(d);
          cleared++;
        } catch (err) {
          errors.push(`ack-clear ${d.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (policy.failedClearAfterDays > 0) {
      const threshold = new Date(
        now.getTime() - policy.failedClearAfterDays * 86400000,
      ).toISOString();
      const candidates = deliveryRepo.getClearanceCandidates(
        habitatId,
        STATUS_CLEARABLE_BY_FAILED,
        threshold,
      );
      for (const d of candidates) {
        try {
          processClearance(d);
          cleared++;
        } catch (err) {
          errors.push(`fail-clear ${d.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return { habitatId, cleared, errors };
}

/** Force-clears the given delivery IDs regardless of retention policy (admin override) and returns one aggregated result. */
export function adminClearDeliveries(deliveryIds: string[]): ClearanceResult {
  const errors: string[] = [];
  let cleared = 0;
  const habitatId = "admin";

  for (const id of deliveryIds) {
    try {
      const d = deliveryRepo.getNotificationDeliveryById(id);
      if (!d) {
        errors.push(`Delivery not found: ${id}`);
        continue;
      }
      processClearance(d);
      cleared++;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { habitatId, cleared, errors };
}

function processClearance(delivery: NotificationDelivery): void {
  if (delivery.status === "cleared") return;

  const event = eventRepo.getNotificationEventById(delivery.eventId);
  if (event) {
    const summary: Record<string, unknown> = {
      clearedAt: new Date().toISOString(),
      eventType: event.eventType,
      title: event.title,
    };
    try {
      eventRepo.updateEventHistorySummary(delivery.eventId, summary);
    } catch {
      // best-effort: event may already be deleted/cleared
    }
  }

  deliveryRepo.batchUpdateDeliveryStatus([delivery.id], "cleared", {
    clearedAt: new Date().toISOString(),
  });
}
