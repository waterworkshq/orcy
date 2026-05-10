import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { Artifact, RetryPolicy, AnomalySettings, AutoAssignSettings, CodeReviewSettings, CiCdSettings, GitWorktreeSettings } from '../models/index.js';

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

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  type: text('type', { enum: ['claude-code', 'codex', 'opencode'] }).notNull(),
  domain: text('domain').notNull(),
  capabilities: text('capabilities', { mode: 'json' }).$type<string[]>().notNull().$defaultFn(() => []),
  status: text('status', { enum: ['idle', 'working', 'offline'] }).notNull().default('idle'),
  currentTaskId: text('current_task_id'),
  apiKey: text('api_key').notNull().unique(),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
  lastHeartbeat: text('last_heartbeat').notNull().default("(datetime('now'))"),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().$defaultFn(() => ({})),
  rateLimitPerMinute: integer('rate_limit_per_minute'),
}, (table) => [
  index('idx_agents_domain').on(table.domain),
  index('idx_agents_status').on(table.status),
  index('idx_agents_current_task').on(table.currentTaskId),
]);

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  featureId: text('feature_id').notNull().references(() => features.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  labels: text('labels', { mode: 'json' }).$type<string[]>().notNull().$defaultFn(() => []),
  priority: text('priority', { enum: ['low', 'medium', 'high', 'critical'] }).notNull().default('medium'),
  assignedAgentId: text('assigned_agent_id').references(() => agents.id),
  requiredDomain: text('required_domain'),
  requiredCapabilities: text('required_capabilities', { mode: 'json' }).$type<string[]>().notNull().$defaultFn(() => []),
  status: text('status', { enum: ['pending', 'claimed', 'in_progress', 'submitted', 'approved', 'rejected', 'done', 'failed'] }).notNull().default('pending'),
  claimedAt: text('claimed_at'),
  startedAt: text('started_at'),
  submittedAt: text('submitted_at'),
  completedAt: text('completed_at'),
  rejectedCount: integer('rejected_count').notNull().default(0),
  rejectionReason: text('rejection_reason'),
  result: text('result'),
  artifacts: text('artifacts', { mode: 'json' }).$type<Artifact[]>().notNull().$defaultFn(() => []),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
  updatedAt: text('updated_at').notNull().default("(datetime('now'))"),
  version: integer('version').notNull().default(1),
  order: integer('order').notNull().default(0),
  delegatedToAgentId: text('delegated_to_agent_id').references(() => agents.id),
  estimatedMinutes: integer('estimated_minutes'),
  retryPolicy: text('retry_policy', { mode: 'json' }).$type<RetryPolicy | null>(),
  retryCount: integer('retry_count').notNull().default(0),
  nextRetryAt: text('next_retry_at'),
  actualMinutes: integer('actual_minutes'),
  cycleTimeMinutes: integer('cycle_time_minutes'),
  leadTimeMinutes: integer('lead_time_minutes'),
  estimationAccuracy: integer('estimation_accuracy'),
}, (table) => [
  index('idx_tasks_feature').on(table.featureId),
  index('idx_tasks_feature_order').on(table.featureId, table.order),
  index('idx_tasks_status').on(table.status),
  index('idx_tasks_assigned_agent').on(table.assignedAgentId),
  index('idx_tasks_required_domain').on(table.requiredDomain),
  index('idx_tasks_priority').on(table.priority),
  index('idx_tasks_delegated').on(table.delegatedToAgentId),
]);

export const taskEvents = sqliteTable('task_events', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  actorType: text('actor_type', { enum: ['human', 'agent', 'system'] }).notNull(),
  actorId: text('actor_id').notNull(),
  action: text('action', { enum: ['created', 'claimed', 'started', 'submitted', 'approved', 'rejected', 'completed', 'failed', 'moved', 'released', 'dependency_resolved', 'updated', 'delegated', 'cloned', 'retry_scheduled', 'retry_executed', 'escalated'] }).notNull(),
  fromColumnId: text('from_column_id'),
  toColumnId: text('to_column_id'),
  fromStatus: text('from_status'),
  toStatus: text('to_status'),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().$defaultFn(() => ({})),
  timestamp: text('timestamp').notNull().default("(datetime('now'))"),
}, (table) => [
  index('idx_task_events_task_id').on(table.taskId),
  index('idx_task_events_timestamp').on(table.timestamp),
  index('idx_task_events_actor').on(table.actorType, table.actorId),
]);

export const taskDependencies = sqliteTable('task_dependencies', {
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  dependsOnId: text('depends_on_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
}, (table) => [
  primaryKey({ columns: [table.taskId, table.dependsOnId] }),
  index('idx_task_dependencies_depends_on').on(table.dependsOnId),
  index('idx_task_dependencies_task_id').on(table.taskId),
]);

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull().default(''),
  role: text('role', { enum: ['admin', 'editor', 'viewer'] }).notNull().default('admin'),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
  updatedAt: text('updated_at').notNull().default("(datetime('now'))"),
  lastLoginAt: text('last_login_at'),
  email: text('email'),
}, (table) => [
  uniqueIndex('idx_users_username').on(table.username),
]);

const taskCommentsColumns = {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  parentId: text('parent_id').references((): ReturnType<typeof text> => taskComments.id as ReturnType<typeof text>, { onDelete: 'cascade' }),
  authorType: text('author_type', { enum: ['human', 'agent'] }).notNull(),
  authorId: text('author_id').notNull(),
  content: text('content').notNull(),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
  updatedAt: text('updated_at').notNull().default("(datetime('now'))"),
};

export const taskComments = sqliteTable('task_comments', taskCommentsColumns, (table) => [
  index('idx_comments_task_id').on(table.taskId, table.createdAt),
  index('idx_comments_parent').on(table.parentId),
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

export const webhookSubscriptions = sqliteTable('webhook_subscriptions', {
  id: text('id').primaryKey(),
  boardId: text('board_id').references(() => boards.id, { onDelete: 'cascade' }),
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
  index('idx_webhook_subscriptions_board').on(table.boardId),
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

export const taskSubtasks = sqliteTable('task_subtasks', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  order: integer('order').notNull().default(0),
  assigneeId: text('assignee_id').references(() => agents.id),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
  updatedAt: text('updated_at').notNull().default("(datetime('now'))"),
}, (table) => [
  index('idx_subtasks_task_id').on(table.taskId, table.order),
  index('idx_subtasks_assignee').on(table.assigneeId),
]);

export const taskWatchers = sqliteTable('task_watchers', {
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
}, (table) => [
  primaryKey({ columns: [table.taskId, table.userId] }),
  index('idx_task_watchers_user_id').on(table.userId),
]);

export const taskCommentMentions = sqliteTable('task_comment_mentions', {
  id: text('id').primaryKey(),
  commentId: text('comment_id').notNull().references(() => taskComments.id, { onDelete: 'cascade' }),
  mentionedType: text('mentioned_type', { enum: ['human', 'agent'] }).notNull(),
  mentionedId: text('mentioned_id').notNull(),
  mentionText: text('mention_text').notNull(),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
}, (table) => [
  index('idx_comment_mentions_comment_id').on(table.commentId),
  index('idx_comment_mentions_target').on(table.mentionedType, table.mentionedId),
  uniqueIndex('idx_comment_mentions_unique').on(table.commentId, table.mentionedType, table.mentionedId, table.mentionText),
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

export const taskAttachments = sqliteTable('task_attachments', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  originalName: text('original_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  uploadedBy: text('uploaded_by'),
  createdAt: text('created_at').default("(datetime('now'))"),
}, (table) => [
  index('idx_attachments_task_id').on(table.taskId),
]);

export const notificationPreferences = sqliteTable('notification_preferences', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  boardId: text('board_id').references(() => boards.id, { onDelete: 'cascade' }),
  taskAssigned: integer('task_assigned').notNull().default(1),
  taskSubmitted: integer('task_submitted').notNull().default(1),
  taskApproved: integer('task_approved').notNull().default(0),
  taskRejected: integer('task_rejected').notNull().default(1),
  taskOverdue: integer('task_overdue').notNull().default(1),
  taskMentioned: integer('task_mentioned').notNull().default(1),
  taskWatching: integer('task_watching').notNull().default(1),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
  updatedAt: text('updated_at').notNull().default("(datetime('now'))"),
}, (table) => [
  uniqueIndex('idx_notif_prefs_user_board').on(table.userId, table.boardId),
]);

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

export const agentMessages = sqliteTable('agent_messages', {
  id: text('id').primaryKey(),
  boardId: text('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  fromAgentId: text('from_agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  toAgentId: text('to_agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  messageType: text('message_type', { enum: ['info', 'request', 'response', 'alert'] }).notNull().default('info'),
  priority: text('priority', { enum: ['low', 'normal', 'high', 'urgent'] }).notNull().default('normal'),
  readAt: text('read_at'),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
}, (table) => [
  index('idx_agent_messages_to_agent').on(table.toAgentId),
  index('idx_agent_messages_from_agent').on(table.fromAgentId),
  index('idx_agent_messages_board').on(table.boardId),
  index('idx_agent_messages_task').on(table.taskId),
  index('idx_agent_messages_read').on(table.readAt),
]);

export const pulses = sqliteTable('pulses', {
  id: text('id').primaryKey(),
  missionId: text('mission_id').notNull()
    .references(() => features.id, { onDelete: 'cascade' }),
  boardId: text('board_id').notNull()
    .references(() => boards.id, { onDelete: 'cascade' }),
  fromType: text('from_type', { enum: ['human', 'agent', 'system'] }).notNull(),
  fromId: text('from_id').notNull(),
  toType: text('to_type', { enum: ['human', 'agent'] }),
  toId: text('to_id'),
  signalType: text('signal_type', {
    enum: ['finding', 'blocker', 'offer', 'warning',
           'question', 'answer', 'directive', 'context', 'handoff']
  }).notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull().default(''),
  taskId: text('task_id')
    .references(() => tasks.id, { onDelete: 'set null' }),
  replyToId: text('reply_to_id'),
  linkedTaskId: text('linked_task_id')
    .references(() => tasks.id, { onDelete: 'set null' }),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>()
    .notNull().$defaultFn(() => ({})),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  pinned: integer('pinned').notNull().default(0),
  isAuto: integer('is_auto', { mode: 'boolean' }).notNull().default(false),
}, (table) => [
  index('idx_pulses_mission').on(table.missionId),
  index('idx_pulses_board').on(table.boardId),
  index('idx_pulses_signal_type').on(table.signalType),
  index('idx_pulses_from').on(table.fromType, table.fromId),
  index('idx_pulses_to').on(table.toType, table.toId),
  index('idx_pulses_task').on(table.taskId),
  index('idx_pulses_created').on(table.createdAt),
  index('idx_pulses_reply_to').on(table.replyToId),
]);

export const pulseCursors = sqliteTable('pulse_cursors', {
  missionId: text('mission_id').notNull()
    .references(() => features.id, { onDelete: 'cascade' }),
  readerType: text('reader_type', { enum: ['human', 'agent'] }).notNull(),
  readerId: text('reader_id').notNull(),
  lastCheckedAt: text('last_checked_at').notNull()
    .default(sql`(datetime('now'))`),
}, (table) => [
  primaryKey({ columns: [table.missionId, table.readerType, table.readerId] }),
]);

export const pullRequests = sqliteTable('pull_requests', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  provider: text('provider', { enum: ['github', 'gitlab'] }).notNull(),
  repo: text('repo').notNull(),
  prNumber: integer('pr_number').notNull(),
  prTitle: text('pr_title'),
  prUrl: text('pr_url').notNull(),
  branchName: text('branch_name'),
  state: text('state').default('open'),
  reviewStatus: text('review_status').default('pending'),
  createdAt: text('created_at').default("(datetime('now'))"),
  updatedAt: text('updated_at').default("(datetime('now'))"),
});

export const pipelineEvents = sqliteTable('pipeline_events', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  provider: text('provider', { enum: ['github', 'gitlab'] }).notNull(),
  repo: text('repo').notNull(),
  runId: text('run_id').notNull(),
  status: text('status', { enum: ['queued', 'in_progress', 'success', 'failure', 'cancelled'] }).notNull(),
  branch: text('branch').notNull(),
  commitSha: text('commit_sha'),
  createdAt: text('created_at').default("(datetime('now'))"),
});

export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
}, (table) => [
  uniqueIndex('idx_organizations_slug').on(table.slug),
]);

export const taskTimeRecords = sqliteTable('task_time_records', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  minutesSpent: integer('minutes_spent').notNull(),
  recordedAt: text('recorded_at').notNull().default(sql`(datetime('now'))`),
  statusDuringWork: text('status_during_work').notNull(),
}, (table) => [
  index('idx_time_records_task').on(table.taskId),
  index('idx_time_records_agent').on(table.agentId),
]);

export const qualityChecklistTemplates = sqliteTable('quality_checklist_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  category: text('category').notNull(),
  isRequired: integer('is_required', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_quality_templates_category').on(table.category),
]);

export const qualityChecklistItems = sqliteTable('quality_checklist_items', {
  id: text('id').primaryKey(),
  templateId: text('template_id').notNull().references(() => qualityChecklistTemplates.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  required: integer('required', { mode: 'boolean' }).notNull().default(true),
  orderIndex: integer('order_index').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_quality_items_template').on(table.templateId),
]);

export const taskQualityChecklists = sqliteTable('task_quality_checklists', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  templateId: text('template_id').references(() => qualityChecklistTemplates.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('pending'),
  completedAt: text('completed_at'),
  completedBy: text('completed_by'),
  notes: text('notes').notNull().default(''),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_task_quality_checklists_task').on(table.taskId),
]);

export const taskQualityChecklistItems = sqliteTable('task_quality_checklist_items', {
  id: text('id').primaryKey(),
  checklistId: text('checklist_id').notNull().references(() => taskQualityChecklists.id, { onDelete: 'cascade' }),
  itemId: text('item_id').notNull().references(() => qualityChecklistItems.id, { onDelete: 'cascade' }),
  isCompleted: integer('is_completed', { mode: 'boolean' }).notNull().default(false),
  completedBy: text('completed_by'),
  completedAt: text('completed_at'),
  evidenceUrl: text('evidence_url'),
  notes: text('notes').notNull().default(''),
}, (table) => [
  index('idx_task_quality_items_checklist').on(table.checklistId),
]);

export const teams = sqliteTable('teams', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
}, (table) => [
  index('idx_teams_organization_id').on(table.organizationId),
  uniqueIndex('idx_teams_slug').on(table.slug),
]);

export const teamMembers = sqliteTable('team_members', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull().default('member'),
  joinedAt: text('joined_at').notNull().default("(datetime('now'))"),
}, (table) => [
  uniqueIndex('idx_team_members_unique').on(table.teamId, table.userId),
  index('idx_team_members_team_id').on(table.teamId),
  index('idx_team_members_user_id').on(table.userId),
]);

export const boardsRelations = relations(boards, ({ many, one }) => ({
  columns: many(columns),
  features: many(features),
  team: one(teams, {
    fields: [boards.teamId],
    references: [teams.id],
  }),
}));

export const columnsRelations = relations(columns, ({ one, many }) => ({
  board: one(boards, {
    fields: [columns.boardId],
    references: [boards.id],
  }),
  nextColumn: one(columns, {
    fields: [columns.nextColumnId],
    references: [columns.id],
    relationName: 'nextColumn',
  }),
  features: many(features),
}));

export const featuresRelations = relations(features, ({ one, many }) => ({
  board: one(boards, {
    fields: [features.boardId],
    references: [boards.id],
  }),
  column: one(columns, {
    fields: [features.columnId],
    references: [columns.id],
  }),
  tasks: many(tasks),
  events: many(featureEvents),
  watchers: many(featureWatchers),
  dependencies: many(featureDependencies, { relationName: 'featureDeps' }),
  dependents: many(featureDependencies, { relationName: 'featureDependents' }),
  pulses: many(pulses),
  pulseCursors: many(pulseCursors),
}));

export const featureDependenciesRelations = relations(featureDependencies, ({ one }) => ({
  feature: one(features, {
    fields: [featureDependencies.featureId],
    references: [features.id],
    relationName: 'featureDeps',
  }),
  dependsOn: one(features, {
    fields: [featureDependencies.dependsOnId],
    references: [features.id],
    relationName: 'featureDependents',
  }),
}));

export const featureEventsRelations = relations(featureEvents, ({ one }) => ({
  feature: one(features, {
    fields: [featureEvents.featureId],
    references: [features.id],
  }),
}));

export const featureWatchersRelations = relations(featureWatchers, ({ one }) => ({
  feature: one(features, {
    fields: [featureWatchers.featureId],
    references: [features.id],
  }),
  user: one(users, {
    fields: [featureWatchers.userId],
    references: [users.id],
  }),
}));

export const agentsRelations = relations(agents, ({ many }) => ({
  assignedTasks: many(tasks, { relationName: 'assignedAgent' }),
  delegatedTasks: many(tasks, { relationName: 'delegatedAgent' }),
  subtasks: many(taskSubtasks),
  sentMessages: many(agentMessages, { relationName: 'fromAgent' }),
  receivedMessages: many(agentMessages, { relationName: 'toAgent' }),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  feature: one(features, {
    fields: [tasks.featureId],
    references: [features.id],
  }),
  assignedAgent: one(agents, {
    fields: [tasks.assignedAgentId],
    references: [agents.id],
    relationName: 'assignedAgent',
  }),
  delegatedAgent: one(agents, {
    fields: [tasks.delegatedToAgentId],
    references: [agents.id],
    relationName: 'delegatedAgent',
  }),
  events: many(taskEvents),
  comments: many(taskComments),
  subtasks: many(taskSubtasks),
  attachments: many(taskAttachments),
  pullRequests: many(pullRequests),
  pipelineEvents: many(pipelineEvents),
  timeRecords: many(taskTimeRecords),
  qualityChecklists: many(taskQualityChecklists),
  pulses: many(pulses, { relationName: 'taskPulses' }),
  linkedPulses: many(pulses, { relationName: 'linkedTaskPulses' }),
}));

export const taskEventsRelations = relations(taskEvents, ({ one }) => ({
  task: one(tasks, {
    fields: [taskEvents.taskId],
    references: [tasks.id],
  }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  comments: many(taskComments),
  watchers: many(taskWatchers),
  featureWatchers: many(featureWatchers),
  notificationPreferences: many(notificationPreferences),
  teamMemberships: many(teamMembers),
}));

export const taskCommentsRelations = relations(taskComments, ({ one, many }) => ({
  task: one(tasks, {
    fields: [taskComments.taskId],
    references: [tasks.id],
  }),
  parent: one(taskComments, {
    fields: [taskComments.parentId],
    references: [taskComments.id],
    relationName: 'commentReplies',
  }),
  replies: many(taskComments, { relationName: 'commentReplies' }),
  mentions: many(taskCommentMentions),
}));

export const featureTemplatesRelations = relations(featureTemplates, ({ one }) => ({
  board: one(boards, {
    fields: [featureTemplates.boardId],
    references: [boards.id],
  }),
}));

export const webhookSubscriptionsRelations = relations(webhookSubscriptions, ({ one, many }) => ({
  board: one(boards, {
    fields: [webhookSubscriptions.boardId],
    references: [boards.id],
  }),
  deliveries: many(webhookDeliveries),
}));

export const webhookDeliveriesRelations = relations(webhookDeliveries, ({ one }) => ({
  subscription: one(webhookSubscriptions, {
    fields: [webhookDeliveries.subscriptionId],
    references: [webhookSubscriptions.id],
  }),
}));

export const taskSubtasksRelations = relations(taskSubtasks, ({ one }) => ({
  task: one(tasks, {
    fields: [taskSubtasks.taskId],
    references: [tasks.id],
  }),
  assignee: one(agents, {
    fields: [taskSubtasks.assigneeId],
    references: [agents.id],
  }),
}));

export const taskWatchersRelations = relations(taskWatchers, ({ one }) => ({
  task: one(tasks, {
    fields: [taskWatchers.taskId],
    references: [tasks.id],
  }),
  user: one(users, {
    fields: [taskWatchers.userId],
    references: [users.id],
  }),
}));

export const taskCommentMentionsRelations = relations(taskCommentMentions, ({ one }) => ({
  comment: one(taskComments, {
    fields: [taskCommentMentions.commentId],
    references: [taskComments.id],
  }),
}));

export const savedFiltersRelations = relations(savedFilters, ({ one }) => ({
  board: one(boards, {
    fields: [savedFilters.boardId],
    references: [boards.id],
  }),
}));

export const taskAttachmentsRelations = relations(taskAttachments, ({ one }) => ({
  task: one(tasks, {
    fields: [taskAttachments.taskId],
    references: [tasks.id],
  }),
}));

export const notificationPreferencesRelations = relations(notificationPreferences, ({ one }) => ({
  board: one(boards, {
    fields: [notificationPreferences.boardId],
    references: [boards.id],
  }),
}));

export const chatIntegrationsRelations = relations(chatIntegrations, ({ one }) => ({
  board: one(boards, {
    fields: [chatIntegrations.boardId],
    references: [boards.id],
  }),
}));

export const agentMessagesRelations = relations(agentMessages, ({ one }) => ({
  board: one(boards, {
    fields: [agentMessages.boardId],
    references: [boards.id],
  }),
  fromAgent: one(agents, {
    fields: [agentMessages.fromAgentId],
    references: [agents.id],
    relationName: 'fromAgent',
  }),
  toAgent: one(agents, {
    fields: [agentMessages.toAgentId],
    references: [agents.id],
    relationName: 'toAgent',
  }),
  task: one(tasks, {
    fields: [agentMessages.taskId],
    references: [tasks.id],
  }),
}));

export const pulsesRelations = relations(pulses, ({ one, many }) => ({
  mission: one(features, {
    fields: [pulses.missionId],
    references: [features.id],
  }),
  board: one(boards, {
    fields: [pulses.boardId],
    references: [boards.id],
  }),
  task: one(tasks, {
    fields: [pulses.taskId],
    references: [tasks.id],
    relationName: 'taskPulses',
  }),
  linkedTask: one(tasks, {
    fields: [pulses.linkedTaskId],
    references: [tasks.id],
    relationName: 'linkedTaskPulses',
  }),
  replyTo: one(pulses, {
    fields: [pulses.replyToId],
    references: [pulses.id],
    relationName: 'pulseThread',
  }),
  replies: many(pulses, { relationName: 'pulseThread' }),
}));

export const pulseCursorsRelations = relations(pulseCursors, ({ one }) => ({
  mission: one(features, {
    fields: [pulseCursors.missionId],
    references: [features.id],
  }),
}));

export const pullRequestsRelations = relations(pullRequests, ({ one }) => ({
  task: one(tasks, {
    fields: [pullRequests.taskId],
    references: [tasks.id],
  }),
}));

export const pipelineEventsRelations = relations(pipelineEvents, ({ one }) => ({
  task: one(tasks, {
    fields: [pipelineEvents.taskId],
    references: [tasks.id],
  }),
}));

export const organizationsRelations = relations(organizations, ({ many }) => ({
  teams: many(teams),
}));

export const teamsRelations = relations(teams, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [teams.organizationId],
    references: [organizations.id],
  }),
  boards: many(boards),
  members: many(teamMembers),
}));

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  team: one(teams, {
    fields: [teamMembers.teamId],
    references: [teams.id],
  }),
  user: one(users, {
    fields: [teamMembers.userId],
    references: [users.id],
  }),
}));

export const taskTimeRecordsRelations = relations(taskTimeRecords, ({ one }) => ({
  task: one(tasks, {
    fields: [taskTimeRecords.taskId],
    references: [tasks.id],
  }),
  agent: one(agents, {
    fields: [taskTimeRecords.agentId],
    references: [agents.id],
  }),
}));

export const qualityChecklistTemplatesRelations = relations(qualityChecklistTemplates, ({ many }) => ({
  items: many(qualityChecklistItems),
  taskChecklists: many(taskQualityChecklists),
}));

export const qualityChecklistItemsRelations = relations(qualityChecklistItems, ({ one }) => ({
  template: one(qualityChecklistTemplates, {
    fields: [qualityChecklistItems.templateId],
    references: [qualityChecklistTemplates.id],
  }),
}));

export const taskQualityChecklistsRelations = relations(taskQualityChecklists, ({ one, many }) => ({
  task: one(tasks, {
    fields: [taskQualityChecklists.taskId],
    references: [tasks.id],
  }),
  template: one(qualityChecklistTemplates, {
    fields: [taskQualityChecklists.templateId],
    references: [qualityChecklistTemplates.id],
  }),
  items: many(taskQualityChecklistItems),
}));

export const taskQualityChecklistItemsRelations = relations(taskQualityChecklistItems, ({ one }) => ({
  checklist: one(taskQualityChecklists, {
    fields: [taskQualityChecklistItems.checklistId],
    references: [taskQualityChecklists.id],
  }),
  item: one(qualityChecklistItems, {
    fields: [taskQualityChecklistItems.itemId],
    references: [qualityChecklistItems.id],
  }),
}));
