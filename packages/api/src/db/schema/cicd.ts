import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { tasks } from './task.js';

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
