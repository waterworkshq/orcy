import type { AuditEvent, AuditQueryEntityType } from "@orcy/shared/types";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import {
  webhookDeliveries,
  webhookSubscriptions,
} from "../../db/schema/index.js";
import type { AuditProjectionCollector } from "./types.js";

type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
type WebhookSubscriptionRow = typeof webhookSubscriptions.$inferSelect;

function projectWebhookDeliveryRow(
  row: WebhookDeliveryRow,
  subscription: WebhookSubscriptionRow | undefined,
): AuditEvent | null {
  if (!subscription?.habitatId) return null;

  return {
    id: `webhook_delivery:${row.id}`,
    habitatId: subscription.habitatId,
    occurredAt: row.lastAttemptAt ?? row.createdAt,
    entity: { type: "webhook_delivery", id: row.id, title: row.eventType },
    action: row.status,
    actor: { type: "system", id: "system:webhook-dispatcher" },
    source: "webhook",
    provenance: { webhookDeliveryId: row.id, reason: `subscription:${row.subscriptionId}` },
    linkedEntities: [],
    summary: `Webhook delivery ${row.status}: ${row.eventType}`,
    metadata: {
      subscriptionId: row.subscriptionId,
      subscriptionName: subscription.name,
      eventType: row.eventType,
      status: row.status,
      statusCode: row.statusCode,
      attempts: row.attempts,
      createdAt: row.createdAt,
      lastAttemptAt: row.lastAttemptAt,
      nextRetryAt: row.nextRetryAt,
    },
    completeness: {
      status: "complete",
      caveats: ["Webhook payload and response body are intentionally excluded from audit output."],
    },
  };
}

export const webhookDeliveryCollector: AuditProjectionCollector = {
  key: "webhook_delivery",
  entityTypes: ["webhook_delivery"],
  failurePolicy: "warning",
  warningSource: "webhook",
  collect(request) {
    const db = getDb();
    const habitatId = request.habitatId;
    const sel: ReadonlySet<AuditQueryEntityType> = request.selectedEntityTypes;
    if (sel.size > 0 && !sel.has("webhook_delivery")) {
      return { events: [], warnings: [], caveats: [] };
    }
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
    const subscriptionById = new Map(subscriptionRows.map((row) => [row.id, row]));

    const events: AuditEvent[] = [];
    let skippedRows = 0;
    for (const row of deliveryRows) {
      const event = projectWebhookDeliveryRow(row, subscriptionById.get(row.subscriptionId));
      if (event) events.push(event);
      else skippedRows++;
    }
    return { events, warnings: [], caveats: [] };
  },
};