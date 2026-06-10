import { getDb } from "../db/index.js";
import { notificationDigestItems } from "../db/schema/index.js";
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { repositoryCreateError } from "../errors/repository.js";
import type { NotificationDigestItem } from "@orcy/shared";

export interface CreateDigestItemInput {
  digestEventId: string;
  includedEventId: string;
  includedDeliveryId?: string;
}

export function createDigestItem(input: CreateDigestItemInput): NotificationDigestItem {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(notificationDigestItems)
      .values({
        id,
        digestEventId: input.digestEventId,
        includedEventId: input.includedEventId,
        includedDeliveryId: input.includedDeliveryId ?? null,
        createdAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("notificationDigestItem", err as Error, id);
  }

  const created = getDigestItemById(id);
  return created!;
}

export function getDigestItemById(id: string): NotificationDigestItem | null {
  const db = getDb();
  const row = db
    .select()
    .from(notificationDigestItems)
    .where(eq(notificationDigestItems.id, id))
    .get();
  return row ? (row as unknown as NotificationDigestItem) : null;
}

export function getDigestItemsByDigestEvent(digestEventId: string): NotificationDigestItem[] {
  const db = getDb();
  return db
    .select()
    .from(notificationDigestItems)
    .where(eq(notificationDigestItems.digestEventId, digestEventId))
    .all() as unknown as NotificationDigestItem[];
}

export function getDigestItemsByIncludedEvent(includedEventId: string): NotificationDigestItem[] {
  const db = getDb();
  return db
    .select()
    .from(notificationDigestItems)
    .where(eq(notificationDigestItems.includedEventId, includedEventId))
    .all() as unknown as NotificationDigestItem[];
}

export function createDigestItems(
  items: Array<{
    digestEventId: string;
    includedEventId: string;
    includedDeliveryId?: string;
  }>,
): NotificationDigestItem[] {
  const results: NotificationDigestItem[] = [];
  for (const item of items) {
    results.push(createDigestItem(item));
  }
  return results;
}
