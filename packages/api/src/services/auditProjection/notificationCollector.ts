import type { AuditEvent, AuditWarning } from "@orcy/shared/types";
import { listEventsForAudit } from "../../repositories/auditProjection/notificationEvents.js";
import { listDeliveriesForAudit } from "../../repositories/auditProjection/notificationDeliveries.js";
import {
  projectNotificationDeliveryToAudit,
  projectNotificationEventToAudit,
} from "../automationAuditProjection.js";
import type { AuditProjectionCollector } from "./types.js";

export const notificationCollector: AuditProjectionCollector = {
  key: "notification",
  entityTypes: ["notification_event", "notification_delivery"],
  failurePolicy: "warning",
  warningSource: "notification",
  collect(request) {
    const events = listEventsForAudit(request.habitatId);
    const deliveryRows = listDeliveriesForAudit(request.habitatId);

    const deliveriesByEventId = new Map<string, number>();
    for (const row of deliveryRows) {
      deliveriesByEventId.set(row.delivery.eventId, (deliveriesByEventId.get(row.delivery.eventId) ?? 0) + 1);
    }

    const projectedEvents: AuditEvent[] = events.map((event) => {
      const count = deliveriesByEventId.get(event.id) ?? 0;
      return projectNotificationEventToAudit(
        event,
        count > 0
          ? deliveryRows
              .filter((row) => row.delivery.eventId === event.id)
              .map((row) => row.delivery)
          : undefined,
      );
    });

    const warnings: AuditWarning[] = [];
    const projectedDeliveries: AuditEvent[] = [];
    for (const row of deliveryRows) {
      if (row.event === null) {
        warnings.push({
          code: "notification_delivery_orphan",
          source: "notification",
          message: `Notification delivery ${row.delivery.id} references a missing event.`,
        });
        continue;
      }
      projectedDeliveries.push(projectNotificationDeliveryToAudit(row.delivery, row.event));
    }

    return {
      events: [...projectedEvents, ...projectedDeliveries],
      warnings,
      caveats: [],
    };
  },
};