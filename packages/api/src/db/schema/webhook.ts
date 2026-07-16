import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { habitats } from './habitat.js';

export const webhookSubscriptions = sqliteTable('webhook_subscriptions', {
  id: text('id').primaryKey(),
  habitatId: text('habitat_id').references(() => habitats.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  url: text('url').notNull(),
  secret: text('secret'),
  events: text('events', { mode: 'json' }).$type<string[]>().notNull().$defaultFn(() => []),
  headers: text('headers', { mode: 'json' }).$type<Record<string, string>>().notNull().$defaultFn(() => ({})),
  format: text('format', { enum: ['standard', 'slack', 'discord'] }).notNull().default('standard'),
  enabled: integer('enabled').notNull().default(1),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
  updatedAt: text('updated_at').notNull().default("(datetime('now'))"),
}, (table) => [
  index('idx_webhook_subscriptions_habitat').on(table.habitatId),
  index('idx_webhook_subscriptions_enabled').on(table.enabled),
]);

export const webhookDeliveries = sqliteTable('webhook_deliveries', {
  id: text('id').primaryKey(),
  subscriptionId: text('subscription_id').notNull().references(() => webhookSubscriptions.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  payload: text('payload').notNull(),
  status: text('status', { enum: ['pending', 'success', 'failed'] }).notNull().default('pending'),
  statusCode: integer('status_code'),
  responseBody: text('response_body'),
  attempts: integer('attempts').notNull().default(0),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
  lastAttemptAt: text('last_attempt_at'),
  nextRetryAt: text('next_retry_at'),
}, (table) => [
  index('idx_webhook_deliveries_subscription').on(table.subscriptionId),
  index('idx_webhook_deliveries_status').on(table.status),
  index('idx_webhook_deliveries_retry').on(table.nextRetryAt),
]);
