import type {
  AutomationAuditProvenance,
  AutomationRuleRun,
  AutomationRule,
  AuditActorRef,
  AuditEvent,
  AuditProvenance,
  AuditSource,
  NotificationAuditProvenance,
  NotificationDelivery,
  NotificationEvent,
  PluginAuditProvenance,
} from "@orcy/shared";
import type { PluginRunRow } from "../db/schema/plugin.js";
import { CONTRIBUTION_KIND_KEYS } from "../plugins/contributionAdapters.js";

function deliveryOccurredAt(delivery: NotificationDelivery): string {
  switch (delivery.status) {
    case "pending":
      return delivery.createdAt;
    case "delivered":
      return delivery.deliveredAt ?? delivery.updatedAt;
    case "acknowledged":
      return delivery.acknowledgedAt ?? delivery.updatedAt;
    case "snoozed":
      return delivery.updatedAt;
    case "muted":
      return delivery.mutedAt ?? delivery.updatedAt;
    case "failed":
      return delivery.updatedAt;
    case "cleared":
      return delivery.clearedAt ?? delivery.updatedAt;
    default:
      return delivery.updatedAt;
  }
}

function isKnownContributionKind(value: string): value is (typeof CONTRIBUTION_KIND_KEYS)[number] {
  return (CONTRIBUTION_KIND_KEYS as readonly string[]).includes(value);
}

function safeAutomationMetadata(run: AutomationRuleRun): Record<string, unknown> {
  const condition = run.conditionResult
    ? {
        matched: run.conditionResult.matched,
        conditionType: run.conditionResult.conditionType,
        reason: run.conditionResult.reason,
      }
    : undefined;
  const actions = run.actionResults?.map((action) => ({
    actionType: action.actionType,
    actionIndex: action.actionIndex,
    status: action.status,
  }));

  const metadata: Record<string, unknown> = {
    triggerEventId: run.triggerEventId,
    targetType: run.targetType,
    targetId: run.targetId,
    fingerprint: run.fingerprint,
    status: run.status,
    skipReason: run.skipReason,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
  if (condition) metadata.condition = condition;
  if (actions) metadata.actions = actions;
  return metadata;
}

function notificationEventActor(event: NotificationEvent): AuditActorRef {
  const actorType: AuditActorRef["type"] =
    event.createdByType === "automation" ? "system" : event.createdByType;
  return {
    type: actorType,
    id: actorType === "system" ? (event.createdById ?? "system:notification") : event.createdById,
  };
}

function notificationEventSource(event: NotificationEvent): AuditSource {
  if (event.sourceType === "workflow") return "workflow";
  if (event.createdByType === "automation") return "automation";
  return "notification";
}

/** Projects an {@link AutomationRuleRun} and its owning rule into a canonical {@link AuditEvent} for the audit read model. */
export function projectAutomationRunToAudit(
  run: AutomationRuleRun,
  rule: AutomationRule | null,
): AuditEvent {
  const automation: AutomationAuditProvenance = {
    runId: run.id,
    ruleId: run.ruleId,
    triggerType: run.triggerType,
    status: run.status,
  };
  if (rule?.name !== undefined) automation.ruleName = rule.name;
  if (run.skipReason) automation.skipReason = run.skipReason;

  const provenance: AuditProvenance = { automation };

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
    provenance,
    linkedEntities: [],
    summary: rule
      ? `Automation rule "${rule.name}" ${run.status} (${run.triggerType})`
      : `Automation run ${run.status} (${run.triggerType})`,
    metadata: safeAutomationMetadata(run),
    completeness: { status: "complete", caveats: [] },
  };
}

/** Projects a {@link NotificationEvent} with its optional deliveries into a canonical {@link AuditEvent} for the audit read model. */
export function projectNotificationEventToAudit(
  event: NotificationEvent,
  deliveries?: NotificationDelivery[],
): AuditEvent {
  const deliveryCount = deliveries?.length ?? 0;

  const notification: NotificationAuditProvenance = {
    eventId: event.id,
    eventType: event.eventType,
    sourceType: event.sourceType,
    severity: event.severity,
    deliveryCount,
  };

  const provenance: AuditProvenance = { notification };

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
    actor: notificationEventActor(event),
    source: notificationEventSource(event),
    provenance,
    linkedEntities: [],
    summary:
      deliveryCount > 0
        ? `Notification "${event.title}" delivered to ${deliveryCount} recipient(s)`
        : `Notification "${event.title}" (${event.eventType})`,
    metadata: {
      sourceType: event.sourceType,
      sourceId: event.sourceId,
      targetType: event.targetType,
      targetId: event.targetId,
      severity: event.severity,
      createdByType: event.createdByType,
      deliveryCount,
    },
    completeness: { status: "complete", caveats: [] },
  };
}

/** Projects a single {@link NotificationDelivery} and its parent event into a canonical {@link AuditEvent} for the audit read model. */
export function projectNotificationDeliveryToAudit(
  delivery: NotificationDelivery,
  event: NotificationEvent | null,
): AuditEvent {
  const notification: NotificationAuditProvenance = {
    eventId: delivery.eventId,
    eventType: event?.eventType ?? "digest.ready",
    sourceType: event?.sourceType ?? "system",
    severity: event?.severity ?? "info",
    recipientType: delivery.recipientType,
    channels: delivery.channels,
    required: delivery.required,
    status: delivery.status,
  };
  notification.deliveryId = delivery.id;

  const provenance: AuditProvenance = { notification };

  const actor: AuditActorRef = {
    type: delivery.recipientType,
    id: delivery.recipientId,
  };

  return {
    id: `notification_delivery:${delivery.id}`,
    habitatId: delivery.habitatId,
    occurredAt: deliveryOccurredAt(delivery),
    entity: {
      type: "notification_delivery",
      id: delivery.id,
      title: event?.title ?? `Delivery ${delivery.id}`,
    },
    action: `notification.delivery.${delivery.status}`,
    actor,
    source: "notification",
    provenance,
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
      snoozedUntil: delivery.snoozedUntil,
      mutedAt: delivery.mutedAt,
      clearedAt: delivery.clearedAt,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,
    },
    completeness: { status: "complete", caveats: [] },
  };
}

/** Projects a {@link PluginRunRow} into a canonical {@link AuditEvent} for the audit read model, joining plugin activity into Audit Trail V2 by `runId`. */
export function projectPluginRunToAudit(run: PluginRunRow): AuditEvent {
  const knownKind: PluginAuditProvenance["contributionKind"] = isKnownContributionKind(
    run.contributionKind,
  )
    ? run.contributionKind
    : "unknown";

  const plugin: PluginAuditProvenance = {
    runId: run.id,
    pluginId: run.pluginId,
    contributionId: run.contributionId,
    contributionKind: knownKind,
    triggerType: run.triggerType,
    status: run.status,
  };

  const provenance: AuditProvenance = { plugin };

  const summaryBase = `Plugin ${run.pluginId} ${run.contributionId} ${run.status}`;
  const summary = run.signalsEmitted
    ? `${summaryBase} (${run.signalsEmitted} signals)`
    : summaryBase;

  return {
    id: `plugin_run:${run.id}`,
    habitatId: run.habitatId,
    occurredAt: run.finishedAt ?? run.startedAt,
    entity: {
      type: "plugin_run",
      id: run.id,
      title: `${run.contributionKind}:${run.contributionId} (${run.pluginId})`,
    },
    action: `plugin.${run.status}`,
    actor: { type: "system", id: run.pluginId },
    source: "plugin",
    provenance,
    linkedEntities: [],
    summary,
    metadata: {
      pluginId: run.pluginId,
      contributionId: run.contributionId,
      contributionKind: run.contributionKind,
      triggerType: run.triggerType,
      triggerEventId: run.triggerEventId,
      status: run.status,
      signalsEmitted: run.signalsEmitted,
      hasError: run.error != null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
    completeness: { status: "complete", caveats: [] },
  };
}
