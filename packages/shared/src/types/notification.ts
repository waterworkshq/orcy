/** Canonical event kinds the notification system can emit across task, mission, automation, pulse, and digest sources. */
export type NotificationEventType =
  | "task.blocked"
  | "task.review_requested"
  | "task.assigned"
  | "mission.risk_marked"
  | "automation.rule_matched"
  | "automation.action_failed"
  | "digest.ready"
  | "pulse.signal_posted";

/** Identifies the originating domain of a notification. */
export type NotificationSourceType =
  | "task"
  | "mission"
  | "automation"
  | "pulse"
  | "digest"
  | "system";

/** Describes the kind of entity a notification is about. */
export type NotificationTargetType =
  | "task"
  | "mission"
  | "agent"
  | "pulse"
  | "habitat"
  | "automation_rule"
  | "none";

/** Classifies who a notification is delivered to: a local human, agent, or remote participant. */
export type NotificationRecipientType = "human" | "agent" | "remote_human" | "remote_orcy";

/** Urgency tier for a notification event: informational, warning, or critical. */
export type NotificationSeverity = "info" | "warning" | "critical";

/** Transport over which a notification may be delivered: in-app, webhook, Slack, or Discord. */
export type NotificationChannel = "in_app" | "webhook" | "slack" | "discord";

/** Lifecycle state of a {@link NotificationDelivery}, from pending through delivered, acknowledged, or cleared. */
export type NotificationDeliveryStatus =
  | "pending"
  | "delivered"
  | "acknowledged"
  | "snoozed"
  | "muted"
  | "failed"
  | "cleared";

/** Outcome state of an individual delivery attempt. */
export type NotificationAttemptStatus =
  | "pending"
  | "sent"
  | "failed"
  | "retry_scheduled"
  | "skipped";

/** Distinguishes a habitat-wide default subscription from a per-recipient override. */
export type NotificationSubscriptionScope = "habitat_default" | "recipient_override";

/** Frequency at which a subscription batches notifications: immediate, hourly, daily, or weekly. */
export type NotificationCadence = "immediate" | "hourly" | "daily" | "weekly";

/** Identifies the kind of actor that created a notification event. */
export type NotificationActorType =
  | "human"
  | "agent"
  | "remote_human"
  | "remote_orcy"
  | "automation"
  | "system";

/** A single notification event emitted within a habitat, carrying its type, source, target, severity, and payload. */
export interface NotificationEvent {
  id: string;
  habitatId: string;
  eventType: NotificationEventType;
  sourceType: NotificationSourceType;
  sourceId: string | null;
  targetType: NotificationTargetType | null;
  targetId: string | null;
  severity: NotificationSeverity;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  createdByType: NotificationActorType;
  createdById: string | null;
  createdAt: string;
  historySummary: Record<string, unknown> | null;
}

/** A single recipient's delivery obligation for a {@link NotificationEvent}. */
export interface NotificationDelivery {
  id: string;
  eventId: string;
  habitatId: string;
  recipientType: NotificationRecipientType;
  recipientId: string;
  status: NotificationDeliveryStatus;
  required: boolean;
  channels: NotificationChannel[];
  deliveredAt: string | null;
  acknowledgedAt: string | null;
  snoozedUntil: string | null;
  mutedAt: string | null;
  clearedAt: string | null;
  clearAfter: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A single send attempt for a {@link NotificationDelivery} over one channel. */
export interface NotificationDeliveryAttempt {
  id: string;
  deliveryId: string;
  channel: NotificationChannel;
  status: NotificationAttemptStatus;
  attempt: number;
  statusCode: number | null;
  error: string | null;
  responseBody: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** A subscription rule governing which events a recipient receives, on which channels, and at what cadence. */
export interface NotificationSubscription {
  id: string;
  habitatId: string;
  scope: NotificationSubscriptionScope;
  recipientType: NotificationRecipientType | null;
  recipientId: string | null;
  eventType: string;
  enabled: boolean;
  required: boolean;
  channels: NotificationChannel[];
  cadence: NotificationCadence;
  timezone: string | null;
  localSendTime: string | null;
  muteUntil: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Join record linking one included event into a digest. */
export interface NotificationDigestItem {
  id: string;
  digestEventId: string;
  includedEventId: string;
  includedDeliveryId: string | null;
  createdAt: string;
}

/** Per-habitat policy controlling how long notifications are retained before clearance. */
export interface NotificationRetentionPolicy {
  id: string;
  habitatId: string;
  acknowledgedClearAfterDays: number;
  resolvedClearAfterDays: number;
  failedClearAfterDays: number;
  historySummaryRetentionDays: number | null;
  updatedBy: string | null;
  updatedAt: string;
}

/** Input payload for enqueuing a new {@link NotificationEvent}. */
export interface EnqueueNotificationInput {
  habitatId: string;
  eventType: NotificationEventType;
  sourceType: NotificationSourceType;
  sourceId?: string;
  targetType?: NotificationTargetType;
  targetId?: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
  createdByType: NotificationActorType;
  createdById?: string;
}

/** Aggregated read model for a notifications dashboard with active, unread, and recent counts. */
export interface NotificationDashboardView {
  activeCount: number;
  unreadCount: number;
  snoozedCount: number;
  mutedCount: number;
  recentEvents: NotificationEvent[];
}
