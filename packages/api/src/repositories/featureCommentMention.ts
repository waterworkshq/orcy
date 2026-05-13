import { v4 as uuid } from 'uuid';
import { getDb } from '../db/index.js';
import { featureCommentMentions } from '../db/schema/index.js';
import { eq, inArray, asc } from 'drizzle-orm';
import type { FeatureCommentMention } from '../models/index.js';

export function createMentions(input: Array<Omit<FeatureCommentMention, 'id' | 'createdAt' | 'mentionedName'>>): FeatureCommentMention[] {
  const db = getDb();
  const now = new Date().toISOString();

  const created: FeatureCommentMention[] = [];
  for (const item of input) {
    const id = uuid();
    db.insert(featureCommentMentions)
      .values({
        id,
        commentId: item.commentId,
        mentionedType: item.mentionedType,
        mentionedId: item.mentionedId,
        mentionText: item.mentionText,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
    created.push({ ...item, id, createdAt: now });
  }
  return created;
}

export function getMentionsByCommentIds(commentIds: string[]): FeatureCommentMention[] {
  if (commentIds.length === 0) return [];
  const db = getDb();
  return db
    .select()
    .from(featureCommentMentions)
    .where(inArray(featureCommentMentions.commentId, commentIds))
    .orderBy(asc(featureCommentMentions.createdAt))
    .all() as FeatureCommentMention[];
}
