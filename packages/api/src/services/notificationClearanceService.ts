import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as retentionRepo from "../repositories/notificationRetentionPolicy.js";
import * as habitatRepo from "../repositories/habitat.js";
import type {
  NotificationDelivery,
  NotificationDeliveryStatus,
  NotificationEvent,
} from "@orcy/shared";

const STATUS_CLEARABLE_BY_ACKNOWLEDGED = ["acknowledged"] as NotificationDeliveryStatus[];

const STATUS_CLEARABLE_BY_FAILED = ["failed"] as NotificationDeliveryStatus[];

/** Outcome of clearing deliveries for a habitat or admin scope, including the count cleared and any errors. */
export interface ClearanceResult {
  habitatId: string;
  cleared: number;
  errors: string[];
}

/** Outcome of one clearance attempt.
 *
 * `transitioned` is the truth about the delivery row. `error` carries a
 * failure that happened AFTER the transition was already committed — the
 * transition still counts, and the failure is still reported. It is `undefined`
 * when there was no such failure; an empty message is still a failure and is
 * still reported, like every other error on these paths. */
interface ClearanceOutcome {
  transitioned: boolean;
  error?: string;
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
          const outcome = processClearance(d);
          if (outcome.transitioned) cleared++;
          if (outcome.error !== undefined) {
            errors.push(`ack-clear ${d.id}: ${outcome.error}`);
          }
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
          const outcome = processClearance(d);
          if (outcome.transitioned) cleared++;
          if (outcome.error !== undefined) {
            errors.push(`fail-clear ${d.id}: ${outcome.error}`);
          }
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
      const outcome = processClearance(d);
      if (outcome.transitioned) cleared++;
      if (outcome.error !== undefined) errors.push(outcome.error);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { habitatId, cleared, errors };
}

/**
 * Clears one delivery and reports what actually happened.
 *
 * The count is derived from the guarded write, never from the pre-read row: a
 * repeat or a concurrent clear of the same delivery transitions nothing and
 * reports no transition.
 *
 * Ordering keeps the two failure kinds apart.
 *
 *  - The event lookup stays AHEAD of the transition, as it was before. It is
 *    a read, and a failed lookup leaves the delivery live with nothing
 *    written, so a later retry can still clear it and record its history.
 *  - The history summary is written AFTER the transition. The transition is
 *    already committed by then, so a failed summary write cannot un-commit
 *    it: the transition still counts and the failure is still reported.
 */
function processClearance(delivery: NotificationDelivery): ClearanceOutcome {
  // A delivery already in the terminal cleared state transitions nothing.
  // Skip it entirely, as before, so a repeat stays a silent no-op.
  if (delivery.status === "cleared") {
    return { transitioned: false };
  }

  let event: NotificationEvent | null = null;
  try {
    event = eventRepo.getNotificationEventById(delivery.eventId);
  } catch (err) {
    // Nothing is written yet: the delivery stays live and a retry can still
    // clear it and record its history.
    return { transitioned: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!deliveryRepo.transitionDeliveryToCleared(delivery.id)) {
    return { transitioned: false };
  }

  if (event) {
    const summary: Record<string, unknown> = {
      clearedAt: new Date().toISOString(),
      eventType: event.eventType,
      title: event.title,
    };
    try {
      eventRepo.updateEventHistorySummary(delivery.eventId, summary);
    } catch (err) {
      // The delivery row is already cleared; the history summary failed. The
      // transition still counts — the receipt must not contradict the row.
      return { transitioned: true, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return { transitioned: true };
}
