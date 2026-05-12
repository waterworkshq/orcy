import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { boards, features } from './board.js';
import { tasks } from './task.js';

export const pulses = sqliteTable('pulses', {
  id: text('id').primaryKey(),
  missionId: text('mission_id')
    .references(() => features.id, { onDelete: 'cascade' }),
  boardId: text('board_id').notNull()
    .references(() => boards.id, { onDelete: 'cascade' }),
  scope: text('scope', { enum: ['mission', 'habitat'] }).notNull().default('mission'),
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
  index('idx_pulses_scope').on(table.scope),
  index('idx_pulses_board_scope').on(table.boardId, table.scope),
  index('idx_pulses_signal_type').on(table.signalType),
  index('idx_pulses_from').on(table.fromType, table.fromId),
  index('idx_pulses_to').on(table.toType, table.toId),
  index('idx_pulses_task').on(table.taskId),
  index('idx_pulses_created').on(table.createdAt),
  index('idx_pulses_reply_to').on(table.replyToId),
]);

export const pulseCursors = sqliteTable('pulse_cursors', {
  scopeKey: text('scope_key').notNull(),
  scope: text('scope', { enum: ['mission', 'habitat'] }).notNull().default('mission'),
  readerType: text('reader_type', { enum: ['human', 'agent'] }).notNull(),
  readerId: text('reader_id').notNull(),
  lastCheckedAt: text('last_checked_at').notNull()
    .default(sql`(datetime('now'))`),
}, (table) => [
  primaryKey({ columns: [table.scopeKey, table.readerType, table.readerId] }),
]);
