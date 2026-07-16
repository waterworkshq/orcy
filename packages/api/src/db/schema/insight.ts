import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { habitats } from './habitat.js';
import { pulses } from './pulse.js';

export const projectInsights = sqliteTable('project_insights', {
  id: text('id').primaryKey(),
  habitatId: text('habitat_id').notNull()
    .references(() => habitats.id, { onDelete: 'cascade' }),
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
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_insights_habitat').on(table.habitatId),
  index('idx_insights_active').on(table.isActive),
  index('idx_insights_type').on(table.signalType),
]);
