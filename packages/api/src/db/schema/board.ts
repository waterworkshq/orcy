import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { RetryPolicy, AnomalySettings, AutoAssignSettings, CodeReviewSettings, CiCdSettings, GitWorktreeSettings } from '../../models/index.js';
import { teams } from './user.js';
import { users } from './user.js';

export const boards = sqliteTable('boards', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
  updatedAt: text('updated_at').notNull().default("(datetime('now'))"),
  retrySettings: text('retry_settings', { mode: 'json' }).$type<RetryPolicy | null>(),
  anomalySettings: text('anomaly_settings', { mode: 'json' }).$type<AnomalySettings | null>(),
  autoAssignSettings: text('auto_assign_settings', { mode: 'json' }).$type<AutoAssignSettings | null>(),
  codeReviewSettings: text('code_review_settings', { mode: 'json' }).$type<CodeReviewSettings | null>(),
  eventRetentionDays: integer('event_retention_days').default(90),
  ciCdSettings: text('ci_cd_settings', { mode: 'json' }).$type<CiCdSettings | null>(),
  gitWorktreeSettings: text('git_worktree_settings', { mode: 'json' }).$type<GitWorktreeSettings | null>(),
  teamId: text('team_id').references(() => teams.id, { onDelete: 'set null' }),
}, (table) => [
  index('idx_boards_name').on(table.name),
  index('idx_boards_team_id').on(table.teamId),
]);

export const features = sqliteTable('features', {
  id: text('id').primaryKey(),
  boardId: text('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  columnId: text('column_id').notNull().references(() => columns.id),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  acceptanceCriteria: text('acceptance_criteria').notNull().default(''),
  priority: text('priority').notNull().default('medium'),
  labels: text('labels', { mode: 'json' }).$type<string[]>().notNull().$defaultFn(() => []),
  status: text('status').notNull().default('not_started'),
  displayOrder: integer('display_order').notNull().default(0),
  dependsOn: text('depends_on', { mode: 'json' }).$type<string[]>().notNull().$defaultFn(() => []),
  blocks: text('blocks', { mode: 'json' }).$type<string[]>().notNull().$defaultFn(() => []),
  dueAt: text('due_at'),
  slaMinutes: integer('sla_minutes'),
  slaDeadlineAt: text('sla_deadline_at'),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  version: integer('version').notNull().default(1),
  actualMinutes: integer('actual_minutes'),
  plannedMinutes: integer('planned_minutes'),
  planningAccuracy: integer('planning_accuracy'),
  completedAt: text('completed_at'),
  isArchived: integer('is_archived', { mode: 'boolean' }).notNull().default(false),
}, (table) => [
  index('idx_features_board_column').on(table.boardId, table.columnId),
  index('idx_features_status').on(table.status),
  index('idx_features_priority').on(table.priority),
  index('idx_features_column_order').on(table.columnId, table.displayOrder),
  index('idx_features_due_at').on(table.dueAt),
]);

export const featureDependencies = sqliteTable('feature_dependencies', {
  featureId: text('feature_id').notNull().references(() => features.id, { onDelete: 'cascade' }),
  dependsOnId: text('depends_on_id').notNull().references(() => features.id, { onDelete: 'cascade' }),
}, (table) => [
  primaryKey({ columns: [table.featureId, table.dependsOnId] }),
  index('idx_feature_deps_depends_on').on(table.dependsOnId),
]);

export const featureEvents = sqliteTable('feature_events', {
  id: text('id').primaryKey(),
  featureId: text('feature_id').notNull().references(() => features.id, { onDelete: 'cascade' }),
  actorType: text('actor_type', { enum: ['human', 'agent', 'system'] }).notNull(),
  actorId: text('actor_id').notNull(),
  action: text('action', { enum: ['created', 'updated', 'moved', 'status_changed', 'completed', 'deleted', 'dependency_resolved'] }).notNull(),
  fromColumnId: text('from_column_id'),
  toColumnId: text('to_column_id'),
  fromStatus: text('from_status'),
  toStatus: text('to_status'),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().$defaultFn(() => ({})),
  timestamp: text('timestamp').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_feature_events_feature').on(table.featureId),
  index('idx_feature_events_timestamp').on(table.timestamp),
]);

export const featureWatchers = sqliteTable('feature_watchers', {
  featureId: text('feature_id').notNull().references(() => features.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  primaryKey({ columns: [table.featureId, table.userId] }),
  index('idx_feature_watchers_user').on(table.userId),
]);

const columnsColumns = {
  id: text('id').primaryKey(),
  boardId: text('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  order: integer('order').notNull(),
  wipLimit: integer('wip_limit'),
  autoAdvance: integer('auto_advance', { mode: 'boolean' }).notNull().default(false),
  requiresClaim: integer('requires_claim', { mode: 'boolean' }).notNull().default(true),
  nextColumnId: text('next_column_id').references((): ReturnType<typeof text> => columns.id as ReturnType<typeof text>),
  isTerminal: integer('is_terminal', { mode: 'boolean' }).notNull().default(false),
};

export const columns = sqliteTable('columns', columnsColumns, (table) => [
  uniqueIndex('idx_columns_board_order').on(table.boardId, table.order),
  index('idx_columns_board_id').on(table.boardId),
  index('idx_columns_next').on(table.nextColumnId),
]);

export const featureTemplates = sqliteTable('feature_templates', {
  id: text('id').primaryKey(),
  boardId: text('board_id').references(() => boards.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  titlePattern: text('title_pattern').notNull().default(''),
  descriptionPattern: text('description_pattern').notNull().default(''),
  priority: text('priority', { enum: ['low', 'medium', 'high', 'critical'] }).default('medium'),
  labels: text('labels', { mode: 'json' }).$type<string[]>().notNull().$defaultFn(() => []),
  requiredDomain: text('required_domain'),
  requiredCapabilities: text('required_capabilities', { mode: 'json' }).$type<string[]>().notNull().$defaultFn(() => []),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  usageCount: integer('usage_count').notNull().default(0),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
  tasksTemplate: text('tasks_template', { mode: 'json' }).$type<unknown[]>().notNull().$defaultFn(() => []),
}, (table) => [
  index('idx_templates_board').on(table.boardId),
  index('idx_templates_default').on(table.isDefault),
]);

export const savedFilters = sqliteTable('saved_filters', {
  id: text('id').primaryKey(),
  boardId: text('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  filterConfig: text('filter_config', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  isBuiltin: integer('is_builtin', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').default("(datetime('now'))"),
});

export const chatIntegrations = sqliteTable('chat_integrations', {
  id: text('id').primaryKey(),
  boardId: text('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  provider: text('provider', { enum: ['slack', 'discord'] }).notNull(),
  webhookUrl: text('webhook_url').notNull(),
  channelId: text('channel_id'),
  botToken: text('bot_token'),
  enabled: integer('enabled').notNull().default(1),
  events: text('events', { mode: 'json' }).$type<string[]>().notNull().$defaultFn(() => ['task_created', 'task_claimed', 'task_submitted', 'task_approved', 'task_rejected', 'task_overdue']),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
  updatedAt: text('updated_at').notNull().default("(datetime('now'))"),
}, (table) => [
  index('idx_chat_integrations_board').on(table.boardId),
  index('idx_chat_integrations_provider').on(table.provider),
  index('idx_chat_integrations_enabled').on(table.enabled),
]);
