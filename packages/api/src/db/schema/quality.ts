import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { tasks } from './task.js';

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
