import { getDb } from "../../db/index.js";
import { notificationEvents } from "../../db/schema/index.js";
import { eq } from "drizzle-orm";
import type { NotificationEvent } from "@orcy/shared";

export function listEventsForAudit(habitatId: string): NotificationEvent[] {
  const db = getDb();
  const rows = db
    .select()
    .from(notificationEvents)
    .where(eq(notificationEvents.habitatId, habitatId))
    .all();
  return rows as unknown as NotificationEvent[];
}