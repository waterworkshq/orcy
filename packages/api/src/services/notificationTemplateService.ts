import type {
  NotificationEventType,
  NotificationRecipientType,
  NotificationSeverity,
} from "@orcy/shared";

export interface RenderedNotification {
  title: string;
  body: string;
  payload: Record<string, unknown>;
}

export interface TemplateContext {
  eventType: NotificationEventType;
  sourceType: string;
  sourceId?: string;
  targetType?: string;
  targetId?: string;
  severity: NotificationSeverity;
  recipientType: NotificationRecipientType;
  payload?: Record<string, unknown>;
}

const EVENT_TITLES: Record<string, (ctx: TemplateContext) => string> = {
  "task.blocked": (ctx) => `Task blocked: ${ctx.payload?.taskTitle ?? ctx.sourceId ?? "Unknown"}`,
  "task.review_requested": (ctx) =>
    `Review requested: ${ctx.payload?.taskTitle ?? ctx.sourceId ?? "Unknown"}`,
  "task.assigned": (ctx) => `Task assigned: ${ctx.payload?.taskTitle ?? ctx.sourceId ?? "Unknown"}`,
  "mission.risk_marked": (ctx) =>
    `Risk flagged on mission: ${ctx.payload?.missionName ?? ctx.sourceId ?? "Unknown"}`,
  "automation.rule_matched": (ctx) =>
    `Automation rule triggered: ${ctx.payload?.ruleName ?? ctx.sourceId ?? "Unknown"}`,
  "automation.action_failed": (ctx) =>
    `Automation action failed: ${ctx.payload?.ruleName ?? ctx.sourceId ?? "Unknown"}`,
  "digest.ready": (ctx) => `Notification digest: ${ctx.payload?.digestSummary ?? "Summary"}`,
  "pulse.signal_posted": (ctx) =>
    `Pulse signal: ${ctx.payload?.signalContent ?? ctx.sourceId ?? "New signal"}`,
};

const EVENT_BODIES: Record<string, (ctx: TemplateContext) => string> = {
  "task.blocked": (ctx) => {
    const taskTitle = ctx.payload?.taskTitle ?? "a task";
    const blocker = ctx.payload?.blockerReason ?? "unspecified reason";
    return `Task "${taskTitle}" is blocked: ${blocker}.`;
  },
  "task.review_requested": (ctx) => {
    const taskTitle = ctx.payload?.taskTitle ?? "a task";
    const requester = ctx.payload?.requesterName ?? "Someone";
    return `${requester} has requested your review on "${taskTitle}".`;
  },
  "task.assigned": (ctx) => {
    const taskTitle = ctx.payload?.taskTitle ?? "a task";
    const assigner = ctx.payload?.assignerName ?? "System";
    return `${assigner} assigned you "${taskTitle}".`;
  },
  "mission.risk_marked": (ctx) => {
    const missionName = ctx.payload?.missionName ?? "a mission";
    const riskLevel = ctx.payload?.riskLevel ?? "unknown";
    return `Mission "${missionName}" has been flagged with risk level: ${riskLevel}.`;
  },
  "automation.rule_matched": (ctx) => {
    const ruleName = ctx.payload?.ruleName ?? "a rule";
    const triggerEvent = ctx.payload?.triggerEvent ?? "an event";
    return `Automation rule "${ruleName}" matched on ${triggerEvent}.`;
  },
  "automation.action_failed": (ctx) => {
    const ruleName = ctx.payload?.ruleName ?? "a rule";
    const action = ctx.payload?.actionType ?? "an action";
    const error = ctx.payload?.errorMessage ?? "unknown error";
    return `Action "${action}" in rule "${ruleName}" failed: ${error}.`;
  },
  "digest.ready": (ctx) => {
    const count = ctx.payload?.itemCount ?? 0;
    return `You have ${count} notification(s) in your digest.`;
  },
  "pulse.signal_posted": (ctx) => {
    const author = ctx.payload?.authorName ?? "Someone";
    const content = ctx.payload?.signalContent ?? "";
    return `${author} posted: ${content}`;
  },
};

export function renderNotification(ctx: TemplateContext): RenderedNotification {
  const titleFn = EVENT_TITLES[ctx.eventType];
  const bodyFn = EVENT_BODIES[ctx.eventType];

  const title = titleFn ? titleFn(ctx) : `Notification: ${ctx.eventType}`;
  const body = bodyFn ? bodyFn(ctx) : `Event ${ctx.eventType} occurred.`;

  const payload: Record<string, unknown> = {
    eventType: ctx.eventType,
    sourceType: ctx.sourceType,
    severity: ctx.severity,
    recipientType: ctx.recipientType,
    ...ctx.payload,
  };

  if (ctx.sourceId) payload.sourceId = ctx.sourceId;
  if (ctx.targetType) payload.targetType = ctx.targetType;
  if (ctx.targetId) payload.targetId = ctx.targetId;

  return { title, body, payload };
}
