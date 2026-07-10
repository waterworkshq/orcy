import type { AuditEvent, AuditWarning } from "@orcy/shared/types";
import { listEventsForAudit } from "../../repositories/auditProjection/notificationEvents.js";
import { listDeliveriesForAudit } from "../../repositories/auditProjection/notificationDeliveries.js";
import {
  projectNotificationDeliveryToAudit,
  projectNotificationEventToAudit,
} from "../automationAuditProjection.js";
import type { NotificationDelivery, NotificationEvent } from "@orcy/shared";
import type { AuditProjectionCollector } from "./types.js";
import { resolveEntityReferences } from "./helpers.js";

interface SourceRef {
  type: "task" | "mission";
  id: string;
}

function readRefs(event: NotificationEvent): SourceRef[] {
  const refs: SourceRef[] = [];
  const seen = new Set<string>();
  for (const ref of [
    { type: event.targetType, id: event.targetId },
    { type: event.sourceType, id: event.sourceId },
  ]) {
    if (typeof ref.id !== "string" || ref.id.length === 0) continue;
    if (ref.type !== "task" && ref.type !== "mission") continue;
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ type: ref.type, id: ref.id });
  }
  return refs;
}

export const notificationCollector: AuditProjectionCollector = {
  key: "notification",
  entityTypes: ["notification_event", "notification_delivery"],
  failurePolicy: "warning",
  warningSource: "notification",
  collect(request) {
    const events = listEventsForAudit(request.habitatId);
    const deliveryRows = listDeliveriesForAudit(request.habitatId);

    const deliveryByEventId = new Map<string, NotificationDelivery[]>();
    for (const row of deliveryRows) {
      const list = deliveryByEventId.get(row.delivery.eventId) ?? [];
      list.push(row.delivery);
      deliveryByEventId.set(row.delivery.eventId, list);
    }

    const allRefs = events.flatMap((event) => readRefs(event));
    const { byKey, unresolved } = resolveEntityReferences(request.habitatId, allRefs);

    const eventLinkedById = new Map<string, AuditEvent["linkedEntities"]>();
    for (const event of events) {
      const refs = readRefs(event);
      const linked: AuditEvent["linkedEntities"] = [];
      const seenKeys = new Set<string>();
      for (const ref of refs) {
        const targetEntry = byKey.get(`${ref.type}:${ref.id}`);
        if (!targetEntry) continue;
        const targetKey = `${targetEntry.ref.type}:${targetEntry.ref.id}`;
        if (seenKeys.has(targetKey)) continue;
        seenKeys.add(targetKey);
        linked.push({
          type: targetEntry.ref.type as "task" | "mission",
          id: targetEntry.ref.id,
          title: targetEntry.ref.title ?? null,
        });
        if (targetEntry.owningMissionId) {
          const owningKey = `mission:${targetEntry.owningMissionId}`;
          if (!seenKeys.has(owningKey)) {
            const owning = byKey.get(owningKey);
            if (owning) {
              seenKeys.add(owningKey);
              linked.push({
                type: "mission",
                id: owning.ref.id,
                title: owning.ref.title ?? null,
              });
            }
          }
        }
      }
      const dedup = new Map<string, AuditEvent["linkedEntities"][number]>();
      for (const l of linked) dedup.set(`${l.type}:${l.id}`, l);
      eventLinkedById.set(event.id, Array.from(dedup.values()));
    }

    const projectedEvents: AuditEvent[] = events.map((event) => {
      const deliveries = deliveryByEventId.get(event.id);
      const projected = projectNotificationEventToAudit(event, deliveries);
      projected.linkedEntities = eventLinkedById.get(event.id) ?? [];
      return projected;
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
      const deliveryEvent = projectNotificationDeliveryToAudit(row.delivery, row.event);
      deliveryEvent.linkedEntities = eventLinkedById.get(row.delivery.eventId) ?? [];
      projectedDeliveries.push(deliveryEvent);
    }

    for (const u of unresolved) {
      warnings.push({
        code: "notification_event_reference_unresolved",
        source: "notification",
        message: `Notification event reference ${u.type}:${u.id} could not be resolved within this habitat.`,
      });
    }

    return {
      events: [...projectedEvents, ...projectedDeliveries],
      warnings,
      caveats: [],
    };
  },
};