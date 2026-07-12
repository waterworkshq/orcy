import { getDb } from "../../db/index.js";
import { webhookDeliveries, webhookSubscriptions } from "../../db/schema/index.js";
import { eq, sql } from "drizzle-orm";

export type WebhookSubscriptionRow = typeof webhookSubscriptions.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;

export interface WebhookDeliveryAuditData {
  subscriptionRows: WebhookSubscriptionRow[];
  deliveryRows: WebhookDeliveryRow[];
}

/**
 * Habitat-scoped IN-list join: subscriptions in the habitat, plus all deliveries
 * whose subscription belongs to the habitat. Caller joins the two sets on
 * subscriptionId to project audit events.
 *
 * Returns two flat arrays (not pre-joined) so the caller can track orphan
 * deliveries (delivery whose subscriptionId is missing from the result set).
 */
export function listForAudit(habitatId: string): WebhookDeliveryAuditData {
  const db = getDb();
  const subscriptionRows = db
    .select()
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.habitatId, habitatId))
    .all() as WebhookSubscriptionRow[];

  const subscriptionIds = new Set(subscriptionRows.map((r) => r.id));
  const deliveryRows =
    subscriptionIds.size > 0
      ? (db
          .select()
          .from(webhookDeliveries)
          .where(
            sql`${webhookDeliveries.subscriptionId} IN (${sql.join([...subscriptionIds], sql`, `)})`,
          )
          .all() as WebhookDeliveryRow[])
      : [];

  return { subscriptionRows, deliveryRows };
}