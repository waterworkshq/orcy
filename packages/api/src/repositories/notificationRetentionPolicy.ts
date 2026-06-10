import { getDb } from "../db/index.js";
import { notificationRetentionPolicies } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";
import type { NotificationRetentionPolicy } from "@orcy/shared";

export interface CreateRetentionPolicyInput {
  habitatId: string;
  acknowledgedClearAfterDays?: number;
  resolvedClearAfterDays?: number;
  failedClearAfterDays?: number;
  historySummaryRetentionDays?: number | null;
  updatedBy?: string;
}

export function createRetentionPolicy(
  input: CreateRetentionPolicyInput,
): NotificationRetentionPolicy {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(notificationRetentionPolicies)
      .values({
        id,
        habitatId: input.habitatId,
        acknowledgedClearAfterDays: input.acknowledgedClearAfterDays ?? 30,
        resolvedClearAfterDays: input.resolvedClearAfterDays ?? 30,
        failedClearAfterDays: input.failedClearAfterDays ?? 90,
        historySummaryRetentionDays: input.historySummaryRetentionDays ?? null,
        updatedBy: input.updatedBy ?? null,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("notificationRetentionPolicy", err as Error, id);
  }

  const created = getRetentionPolicyById(id);
  if (!created) throw repositoryNotFoundError("notificationRetentionPolicy", id);
  return created;
}

export function getRetentionPolicyById(id: string): NotificationRetentionPolicy | null {
  const db = getDb();
  const row = db
    .select()
    .from(notificationRetentionPolicies)
    .where(eq(notificationRetentionPolicies.id, id))
    .get();
  return row ? (row as unknown as NotificationRetentionPolicy) : null;
}

export function getRetentionPolicyByHabitat(habitatId: string): NotificationRetentionPolicy | null {
  const db = getDb();
  const row = db
    .select()
    .from(notificationRetentionPolicies)
    .where(eq(notificationRetentionPolicies.habitatId, habitatId))
    .get();
  return row ? (row as unknown as NotificationRetentionPolicy) : null;
}

export function getOrCreateRetentionPolicy(habitatId: string): NotificationRetentionPolicy {
  const existing = getRetentionPolicyByHabitat(habitatId);
  if (existing) return existing;
  return createRetentionPolicy({ habitatId });
}

export function updateRetentionPolicy(
  id: string,
  updates: {
    acknowledgedClearAfterDays?: number;
    resolvedClearAfterDays?: number;
    failedClearAfterDays?: number;
    historySummaryRetentionDays?: number | null;
    updatedBy?: string;
  },
): NotificationRetentionPolicy {
  const db = getDb();
  const now = new Date().toISOString();

  const set: Record<string, unknown> = { updatedAt: now };
  if (updates.acknowledgedClearAfterDays !== undefined)
    set.acknowledgedClearAfterDays = updates.acknowledgedClearAfterDays;
  if (updates.resolvedClearAfterDays !== undefined)
    set.resolvedClearAfterDays = updates.resolvedClearAfterDays;
  if (updates.failedClearAfterDays !== undefined)
    set.failedClearAfterDays = updates.failedClearAfterDays;
  if (updates.historySummaryRetentionDays !== undefined)
    set.historySummaryRetentionDays = updates.historySummaryRetentionDays;
  if (updates.updatedBy !== undefined) set.updatedBy = updates.updatedBy;

  try {
    db.update(notificationRetentionPolicies)
      .set(set)
      .where(eq(notificationRetentionPolicies.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("notificationRetentionPolicy", err as Error, id);
  }

  const updated = getRetentionPolicyById(id);
  if (!updated) throw repositoryNotFoundError("notificationRetentionPolicy", id);
  return updated;
}

export function upsertRetentionPolicy(
  habitatId: string,
  updates: {
    acknowledgedClearAfterDays?: number;
    resolvedClearAfterDays?: number;
    failedClearAfterDays?: number;
    historySummaryRetentionDays?: number | null;
    updatedBy?: string;
  },
): NotificationRetentionPolicy {
  const existing = getRetentionPolicyByHabitat(habitatId);
  if (existing) {
    return updateRetentionPolicy(existing.id, updates);
  }
  return createRetentionPolicy({ habitatId, ...updates });
}
