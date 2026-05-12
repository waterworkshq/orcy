import { getDb } from '../db/index.js';
import { pulseReactions } from '../db/schema/index.js';
import { eq, and, count } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

export type ReactionType = 'seen' | 'ack' | 'question';

export interface PulseReaction {
  id: string;
  pulseId: string;
  reactorType: 'human' | 'agent';
  reactorId: string;
  reaction: ReactionType;
  createdAt: string;
}

export function toggleReaction(input: {
  pulseId: string;
  reactorType: 'human' | 'agent';
  reactorId: string;
  reaction: ReactionType;
}): { added: boolean } {
  const db = getDb();

  const existing = db.select().from(pulseReactions).where(
    and(
      eq(pulseReactions.pulseId, input.pulseId),
      eq(pulseReactions.reactorType, input.reactorType),
      eq(pulseReactions.reactorId, input.reactorId),
      eq(pulseReactions.reaction, input.reaction),
    )
  ).all();

  if (existing.length > 0) {
    db.delete(pulseReactions).where(
      and(
        eq(pulseReactions.pulseId, input.pulseId),
        eq(pulseReactions.reactorType, input.reactorType),
        eq(pulseReactions.reactorId, input.reactorId),
        eq(pulseReactions.reaction, input.reaction),
      )
    ).run();
    return { added: false };
  }

  db.insert(pulseReactions).values({
    id: uuid(),
    pulseId: input.pulseId,
    reactorType: input.reactorType,
    reactorId: input.reactorId,
    reaction: input.reaction,
  }).run();

  return { added: true };
}

export function getReactionCounts(pulseId: string): Record<ReactionType, number> {
  const db = getDb();
  const counts: Record<string, number> = { seen: 0, ack: 0, question: 0 };

  const rows = db.select({
    reaction: pulseReactions.reaction,
    total: count(),
  }).from(pulseReactions)
    .where(eq(pulseReactions.pulseId, pulseId))
    .groupBy(pulseReactions.reaction)
    .all();

  for (const row of rows) {
    counts[row.reaction] = row.total;
  }

  return counts as Record<ReactionType, number>;
}

export function getReactionsByPulse(pulseId: string): PulseReaction[] {
  const db = getDb();
  const rows = db.select().from(pulseReactions)
    .where(eq(pulseReactions.pulseId, pulseId))
    .all();

  return rows.map(row => ({
    id: row.id as string,
    pulseId: row.pulseId as string,
    reactorType: row.reactorType as 'human' | 'agent',
    reactorId: row.reactorId as string,
    reaction: row.reaction as ReactionType,
    createdAt: row.createdAt as string,
  }));
}
