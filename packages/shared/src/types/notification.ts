export type NotificationEventType =
  | "task.blocked"
  | "task.review_requested"
  | "task.assigned"
  | "mission.risk_marked"
  | "automation.rule_matched"
  | "automation.action_failed"
  | "digest.ready"
  | "pulse.signal_posted";

export type NotificationSourceType =
  | "task"
  | "mission"
  | "automation"
  | "pulse"
  | "digest"
  | "system";

export type NotificationTargetType =
  | "task"
  | "mission"
  | "agent"
  | "pulse"
  | "habitat"
  | "automation_rule"
  | "none";

export type NotificationRecipientType = "human" | "agent" | "remote_human" | "remote_orcy";

export type NotificationSeverity = "info" | "warning" | "critical";

export type NotificationChannel = "in_app" | "webhook" | "slack" | "discord";

export type NotificationDeliveryStatus =
  | "pending"
  | "delivered"
  | "acknowledged"
  | "snoozed"
  | "muted"
  | "failed"
  | "cleared";

export type NotificationAttemptStatus =
  | "pending"
  | "sent"
  | "failed"
  | "retry_scheduled"
  | "skipped";

export type NotificationSubscriptionScope = "habitat_default" | "recipient_override";

export type NotificationCadence = "immediate" | "hourly" | "daily" | "weekly";

export type NotificationActorType =
  | "human"
  | "agent"
  | "remote_human"
  | "remote_orcy"
  | "automation"
  | "system";

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

export interface NotificationDigestItem {
  id: string;
  digestEventId: string;
  includedEventId: string;
  includedDeliveryId: string | null;
  createdAt: string;
}

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

export interface NotificationDashboardView {
  activeCount: number;
  unreadCount: number;
  snoozedCount: number;
  mutedCount: number;
  recentEvents: NotificationEvent[];
}
