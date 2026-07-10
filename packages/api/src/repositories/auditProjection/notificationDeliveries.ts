import { getDb } from "../../db/index.js";
import { notificationDeliveries, notificationEvents } from "../../db/schema/index.js";
import { eq } from "drizzle-orm";
import type { NotificationDelivery, NotificationEvent } from "@orcy/shared";

export interface NotificationDeliveryAuditRow {
  delivery: NotificationDelivery;
  event: NotificationEvent | null;
}

export function listDeliveriesForAudit(habitatId: string): NotificationDeliveryAuditRow[] {
  const db = getDb();
  const rows = db
    .select({
      delivery: notificationDeliveries,
      event: notificationEvents,
    })
    .from(notificationDeliveries)
    .leftJoin(notificationEvents, eq(notificationDeliveries.eventId, notificationEvents.id))
    .where(eq(notificationDeliveries.habitatId, habitatId))
    .all();

  return rows.map((row) => ({
    delivery: row.delivery as unknown as NotificationDelivery,
    event: row.event ? (row.event as unknown as NotificationEvent) : null,
  }));
}