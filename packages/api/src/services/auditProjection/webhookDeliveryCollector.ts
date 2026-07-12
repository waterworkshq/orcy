import type { AuditEvent, AuditQueryEntityType, AuditWarning } from "@orcy/shared/types";
import {
  listForAudit,
  type WebhookDeliveryRow,
  type WebhookSubscriptionRow,
} from "../../repositories/auditProjection/webhookDeliveries.js";
import type { AuditProjectionCollector } from "./types.js";

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
    const sel: ReadonlySet<AuditQueryEntityType> = request.selectedEntityTypes;
    if (sel.size > 0 && !sel.has("webhook_delivery")) {
      return { events: [], warnings: [], caveats: [] };
    }
    const { subscriptionRows, deliveryRows } = listForAudit(request.habitatId);
    const subscriptionById = new Map(subscriptionRows.map((row) => [row.id, row]));

    const events: AuditEvent[] = [];
    const warnings: AuditWarning[] = [];
    let skippedRows = 0;
    for (const row of deliveryRows) {
      const event = projectWebhookDeliveryRow(row, subscriptionById.get(row.subscriptionId));
      if (event) events.push(event);
      else skippedRows++;
    }
    if (skippedRows > 0) {
      warnings.push({
        code: "webhook_delivery_orphan",
        message: `${skippedRows} webhook delivery record(s) could not be tied to a subscription and were not projected.`,
      });
    }
    return { events, warnings, caveats: [] };
  },
};