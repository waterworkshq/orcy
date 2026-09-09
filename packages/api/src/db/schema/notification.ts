import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { habitats } from "./habitat.js";

export const notificationEvents = sqliteTable(
  "notification_events",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    severity: text("severity").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    payload: text("payload", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .$defaultFn(() => ({})),
    createdByType: text("created_by_type").notNull(),
    createdById: text("created_by_id"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    historySummary: text("history_summary", { mode: "json" }).$type<Record<
      string,
      unknown
    > | null>(),
  },
  (table) => [
    index("idx_notification_events_habitat_created").on(table.habitatId, table.createdAt),
    index("idx_notification_events_type").on(table.habitatId, table.eventType),
    index("idx_notification_events_source").on(table.sourceType, table.sourceId),
  ],
);

export const notificationDeliveries = sqliteTable(
  "notification_deliveries",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => notificationEvents.id, { onDelete: "cascade" }),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    recipientType: text("recipient_type").notNull(),
    recipientId: text("recipient_id").notNull(),
    status: text("status").notNull().default("pending"),
    required: integer("required", { mode: "boolean" }).notNull().default(false),
    channels: text("channels", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    deliveredAt: text("delivered_at"),
    acknowledgedAt: text("acknowledged_at"),
    snoozedUntil: text("snoozed_until"),
    mutedAt: text("muted_at"),
    clearedAt: text("cleared_at"),
    clearAfter: text("clear_after"),
    // Upgrade epoch marker (migration 0077): 'legacy' rows predate push
    // restoration and are never sent; 'restored' is the storage default for
    // every insert since. INSERT-only — no code path writes it on update.
    pushEpoch: text("push_epoch").notNull().default("restored"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    index("idx_notification_deliveries_recipient_active").on(
      table.habitatId,
      table.recipientType,
      table.recipientId,
      table.status,
      table.createdAt,
    ),
    index("idx_notification_deliveries_event").on(table.eventId),
    index("idx_notification_deliveries_clearance").on(
      table.habitatId,
      table.clearAfter,
      table.status,
    ),
  ],
);

/**
 * Per-(delivery, channel, destination) delivery unit — the state machine the
 * notification delivery worker scans. One unit per base channel, except the
 * webhook channel which expands to one unit per authorized destination with
 * `channel_key = 'webhook:<subscriptionId>'` (the worker splits that key back
 * into base channel + destination id, so plugin dispatch keys on the BASE
 * channel and never sees the namespaced key).
 */
export const notificationDeliveryChannelStates = sqliteTable(
  "notification_delivery_channel_states",
  {
    id: text("id").primaryKey(),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => notificationDeliveries.id, { onDelete: "cascade" }),
    channelKey: text("channel_key").notNull(),
    baseChannel: text("base_channel"),
    destinationId: text("destination_id"),
    state: text("state").notNull().default("available"),
    reservationsTotal: integer("reservations_total").notNull().default(3),
    reservationsUsed: integer("reservations_used").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseFence: text("lease_fence"),
    leaseExpiresAt: text("lease_expires_at"),
    nextEligibleAt: text("next_eligible_at"),
    disposition: text("disposition"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    uniqueIndex("idx_ndcs_delivery_channel").on(table.deliveryId, table.channelKey),
    index("idx_ndcs_state_eligible").on(
      table.state,
      table.nextEligibleAt,
      table.leaseExpiresAt,
    ),
  ],
);

export const notificationDeliveryAttempts = sqliteTable(
  "notification_delivery_attempts",
  {
    id: text("id").primaryKey(),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => notificationDeliveries.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    // Set by the delivery worker when the attempt belongs to a multi-destination
    // webhook unit — ties the worker-authored attempt row to its channel-state
    // unit. Null for legacy rows and non-destination units.
    destinationId: text("destination_id"),
    status: text("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(1),
    statusCode: integer("status_code"),
    error: text("error"),
    responseBody: text("response_body"),
    nextRetryAt: text("next_retry_at"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    finishedAt: text("finished_at"),
  },
  (table) => [
    index("idx_notification_attempts_delivery").on(table.deliveryId),
    index("idx_notification_attempts_retry").on(table.channel, table.status, table.nextRetryAt),
  ],
);

export const notificationSubscriptions = sqliteTable(
  "notification_subscriptions",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    recipientType: text("recipient_type"),
    recipientId: text("recipient_id"),
    eventType: text("event_type").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    required: integer("required", { mode: "boolean" }).notNull().default(false),
    channels: text("channels", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    cadence: text("cadence").notNull().default("immediate"),
    timezone: text("timezone"),
    localSendTime: text("local_send_time"),
    muteUntil: text("mute_until"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    index("idx_notification_subscriptions_habitat").on(table.habitatId, table.eventType),
    index("idx_notification_subscriptions_recipient").on(
      table.habitatId,
      table.recipientType,
      table.recipientId,
    ),
  ],
);

export const notificationDigestItems = sqliteTable("notification_digest_items", {
  id: text("id").primaryKey(),
  digestEventId: text("digest_event_id")
    .notNull()
    .references(() => notificationEvents.id, { onDelete: "cascade" }),
  includedEventId: text("included_event_id")
    .notNull()
    .references(() => notificationEvents.id, { onDelete: "cascade" }),
  includedDeliveryId: text("included_delivery_id").references(() => notificationDeliveries.id, {
    onDelete: "set null",
  }),
  createdAt: text("created_at").notNull().default("(datetime('now'))"),
});

export const notificationRetentionPolicies = sqliteTable(
  "notification_retention_policies",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    acknowledgedClearAfterDays: integer("acknowledged_clear_after_days").notNull().default(30),
    resolvedClearAfterDays: integer("resolved_clear_after_days").notNull().default(30),
    failedClearAfterDays: integer("failed_clear_after_days").notNull().default(90),
    historySummaryRetentionDays: integer("history_summary_retention_days"),
    updatedBy: text("updated_by"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
  },
  (table) => [uniqueIndex("idx_notification_retention_habitat").on(table.habitatId)],
);
