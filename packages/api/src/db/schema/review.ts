import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { habitats } from './board.js';
import { tasks } from './task.js';

export const reviewRules = sqliteTable('review_rules', {
  id: text('id').primaryKey(),
  habitatId: text('habitat_id').notNull().references(() => habitats.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  enabled: integer('enabled').notNull().default(1),
  priority: integer('priority').notNull().default(0),
  matchDomain: text('match_domain'),
  matchLabels: text('match_labels', { mode: 'json' }).$type<string[]>().notNull().$defaultFn(() => []),
  matchPriority: text('match_priority'),
  assignmentStrategy: text('assignment_strategy').notNull().default('domain_expert'),
  requiredReviews: integer('required_reviews').notNull().default(1),
  antiSelfReview: integer('anti_self_review').notNull().default(1),
  fixedReviewerIds: text('fixed_reviewer_ids', { mode: 'json' }).$type<string[]>().notNull().$defaultFn(() => []),
  createdAt: text('created_at').notNull().default("(datetime('now'))"),
  updatedAt: text('updated_at').notNull().default("(datetime('now'))"),
}, (table) => [
  index('idx_review_rules_habitat').on(table.habitatId),
]);

export const taskReviewers = sqliteTable('task_reviewers', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  reviewerType: text('reviewer_type').notNull(),
  reviewerId: text('reviewer_id').notNull(),
  status: text('status').notNull().default('pending'),
  assignedAt: text('assigned_at').notNull().default("(datetime('now'))"),
  reviewedAt: text('reviewed_at'),
  reviewNote: text('review_note'),
}, (table) => [
  index('idx_task_reviewers_task').on(table.taskId),
  index('idx_task_reviewers_reviewer').on(table.reviewerId),
]);
