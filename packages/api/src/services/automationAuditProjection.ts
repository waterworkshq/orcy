import type {
  AutomationRuleRun,
  AutomationRule,
  NotificationEvent,
  NotificationDelivery,
  AuditEvent,
  AuditCompleteness,
  AuditProvenance,
} from "@orcy/shared";

export function projectAutomationRunToAudit(
  run: AutomationRuleRun,
  rule: AutomationRule | null,
): AuditEvent {
  return {
    id: `automation_run:${run.id}`,
    habitatId: run.habitatId,
    occurredAt: run.finishedAt ?? run.startedAt,
    entity: {
      type: "automation_run",
      id: run.id,
      title: rule?.name ?? `Automation Run ${run.id}`,
    },
    action: `automation.rule_run.${run.status}`,
    actor: { type: "system", id: "system:automation" },
    source: "automation",
    provenance: {
      ruleId: run.ruleId,
      ruleName: rule?.name,
      trigger: run.triggerType,
      status: run.status,
      skipReason: run.skipReason ?? undefined,
    } as unknown as AuditProvenance,
    linkedEntities: [],
    summary: rule
      ? `Automation rule "${rule.name}" ${run.status} (${run.triggerType})`
      : `Automation run ${run.status} (${run.triggerType})`,
    metadata: {
      ruleId: run.ruleId,
      ruleName: rule?.name,
      triggerType: run.triggerType,
      fingerprint: run.fingerprint,
      status: run.status,
      skipReason: run.skipReason,
      conditionResult: run.conditionResult,
      actionResults: run.actionResults,
      targetType: run.targetType,
      targetId: run.targetId,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
    completeness: { status: "complete", caveats: [] },
  } as unknown as AuditEvent;
}

export function projectNotificationEventToAudit(
  event: NotificationEvent,
  deliveries?: NotificationDelivery[],
): AuditEvent {
  const deliveryCount = deliveries?.length ?? 0;

  return {
    id: `notification_event:${event.id}`,
    habitatId: event.habitatId,
    occurredAt: event.createdAt,
    entity: {
      type: "notification_event",
      id: event.id,
      title: event.title,
    },
    action: `notification.${event.eventType}`,
    actor: {
      type: event.createdByType === "automation" ? "system" : event.createdByType,
      id: event.createdById ?? "system:notification",
    },
    source: event.createdByType === "automation" ? "automation" : "notification",
    provenance: {
      eventType: event.eventType,
      sourceType: event.sourceType,
      severity: event.severity,
      createdByType: event.createdByType,
      deliveryCount,
    } as unknown as AuditProvenance,
    linkedEntities: [],
    summary:
      deliveryCount > 0
        ? `Notification "${event.title}" delivered to ${deliveryCount} recipient(s)`
        : `Notification "${event.title}" (${event.eventType})`,
    metadata: {
      eventType: event.eventType,
      sourceType: event.sourceType,
      sourceId: event.sourceId,
      severity: event.severity,
      createdByType: event.createdByType,
      deliveryCount,
      payload: event.payload,
    },
    completeness: { status: "complete", caveats: [] },
  } as unknown as AuditEvent;
}

export function projectNotificationDeliveryToAudit(
  delivery: NotificationDelivery,
  event: NotificationEvent | null,
): AuditEvent {
  return {
    id: `notification_delivery:${delivery.id}`,
    habitatId: delivery.habitatId,
    occurredAt: delivery.acknowledgedAt ?? delivery.deliveredAt ?? delivery.createdAt,
    entity: {
      type: "notification_delivery",
      id: delivery.id,
      title: event?.title ?? `Delivery ${delivery.id}`,
    },
    action: `notification.delivery.${delivery.status}`,
    actor: {
      type: delivery.recipientType === "agent" ? "agent" : "human",
      id: delivery.recipientId,
    },
    source: "notification",
    provenance: {
      eventId: delivery.eventId,
      recipientType: delivery.recipientType,
      channels: delivery.channels,
      required: delivery.required,
    } as unknown as AuditProvenance,
    linkedEntities: [],
    summary: delivery.required
      ? `[Required] Notification delivery ${delivery.status} for ${delivery.recipientType}:${delivery.recipientId}`
      : `Notification delivery ${delivery.status} for ${delivery.recipientType}:${delivery.recipientId}`,
    metadata: {
      eventId: delivery.eventId,
      eventType: event?.eventType,
      recipientType: delivery.recipientType,
      recipientId: delivery.recipientId,
      status: delivery.status,
      required: delivery.required,
      channels: delivery.channels,
      deliveredAt: delivery.deliveredAt,
      acknowledgedAt: delivery.acknowledgedAt,
      clearedAt: delivery.clearedAt,
    },
    completeness: { status: "complete", caveats: [] },
  } as unknown as AuditEvent;
}
