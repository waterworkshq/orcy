import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { boards } from './board.js';
import { pulses } from './pulse.js';

export const projectInsights = sqliteTable('project_insights', {
  id: text('id').primaryKey(),
  boardId: text('board_id').notNull()
    .references(() => boards.id, { onDelete: 'cascade' }),
  sourcePulseId: text('source_pulse_id')
    .references(() => pulses.id, { onDelete: 'set null' }),
  sourceMission: text('source_mission'),
  signalType: text('signal_type').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull().default(''),
  relevanceTags: text('relevance_tags', { mode: 'json' }).$type<string[]>()
    .notNull().$defaultFn(() => []),
  promotedBy: text('promoted_by').notNull(),
  promotedAt: text('promoted_at').notNull(),
  isActive: integer('is_active').notNull().default(1),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_insights_board').on(table.boardId),
  index('idx_insights_active').on(table.isActive),
  index('idx_insights_type').on(table.signalType),
]);
