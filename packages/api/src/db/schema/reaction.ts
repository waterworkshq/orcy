import { sqliteTable, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { pulses } from './pulse.js';

export const pulseReactions = sqliteTable('pulse_reactions', {
  id: text('id').primaryKey(),
  pulseId: text('pulse_id').notNull()
    .references(() => pulses.id, { onDelete: 'cascade' }),
  reactorType: text('reactor_type', { enum: ['human', 'agent'] }).notNull(),
  reactorId: text('reactor_id').notNull(),
  reaction: text('reaction', { enum: ['seen', 'ack', 'question'] }).notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_reactions_pulse').on(table.pulseId),
  uniqueIndex('idx_reactions_unique').on(table.pulseId, table.reactorType, table.reactorId, table.reaction),
]);
