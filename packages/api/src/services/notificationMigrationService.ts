import * as prefRepo from "../repositories/notificationPreferences.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";

const LEGACY_FIELD_TO_V2_EVENT: Record<string, string> = {
  taskAssigned: "task.assigned",
  taskReviewAssigned: "task.review_requested",
};

const CANDIDATE_V2_EVENTS: string[] = [
  "task.assigned",
  "task.review_requested",
  "mission.risk_marked",
];

/** Outcome of converting a user's legacy notification preferences into v2 subscriptions, with created/updated/skipped counts and any errors. */
export interface MigrationResult {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}

/** Reads legacy boolean preference fields for a user and creates or updates v2 recipient-override subscriptions to match, persisting changes to the DB. */
export function migrateLegacyPreferences(userId: string, habitatId: string): MigrationResult {
  const result: MigrationResult = { created: 0, updated: 0, skipped: 0, errors: [] };
  const prefs = prefRepo.getPreferences(userId, habitatId);

  for (const [legacyField, v2Event] of Object.entries(LEGACY_FIELD_TO_V2_EVENT)) {
    const value = (prefs as unknown as Record<string, boolean | undefined>)[legacyField];
    if (value === undefined || value === null) continue;

    const enabled = value === true;
    const existing = subscriptionRepo.getRecipientOverrides(habitatId, "human", userId, v2Event);

    if (existing.length === 0) {
      try {
        subscriptionRepo.createSubscription({
          habitatId,
          scope: "recipient_override",
          recipientType: "human",
          recipientId: userId,
          eventType: v2Event,
          enabled,
          channels: enabled ? ["in_app"] : [],
          cadence: "immediate",
        });
        result.created++;
      } catch (err) {
        result.errors.push(
          `create ${legacyField}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      try {
        subscriptionRepo.updateSubscription(existing[0].id, {
          enabled,
          channels: enabled ? existing[0].channels : [],
        });
        result.updated++;
      } catch (err) {
        result.errors.push(
          `update ${legacyField}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return result;
}

/** Placeholder for scheduler-driven migration of all users in a habitat; currently a no-op returning an empty result. */
export function migrateAllLegacyPreferencesForHabitat(habitatId: string): MigrationResult {
  const total: MigrationResult = { created: 0, updated: 0, skipped: 0, errors: [] };
  // Migration is exposed for test purposes; production deployment should
  // iterate (user, habitat) pairs via the scheduler.
  return total;
}

/** Returns whether every legacy preference field for a user has a corresponding v2 subscription on record. */
export function isLegacyMigrationComplete(userId: string, habitatId: string): boolean {
  const prefs = prefRepo.getPreferences(userId, habitatId);
  for (const legacyField of Object.keys(LEGACY_FIELD_TO_V2_EVENT)) {
    if ((prefs as unknown as Record<string, unknown>)[legacyField] !== undefined) {
      const v2Event = LEGACY_FIELD_TO_V2_EVENT[legacyField];
      const existing = subscriptionRepo.getRecipientOverrides(habitatId, "human", userId, v2Event);
      if (existing.length === 0) return false;
    }
  }
  return true;
}

/** Returns the list of v2 event types that are candidates for legacy preference migration. */
export function getMigrationTargetEvents(): string[] {
  return [...CANDIDATE_V2_EVENTS];
}
