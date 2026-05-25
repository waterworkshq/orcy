import { v4 as uuid } from 'uuid';
import { getDb } from '../db/index.js';
import { taskCommentMentions } from '../db/schema/index.js';
import { inArray, asc } from 'drizzle-orm';
import type { TaskCommentMention } from '../models/index.js';

export function createMentions(input: Array<Omit<TaskCommentMention, 'id' | 'createdAt' | 'mentionedName'>>): TaskCommentMention[] {
  const db = getDb();
  const now = new Date().toISOString();

  const created: TaskCommentMention[] = [];
  for (const item of input) {
    const id = uuid();
    db.insert(taskCommentMentions)
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

export function getMentionsByCommentIds(commentIds: string[]): TaskCommentMention[] {
  if (commentIds.length === 0) return [];
  const db = getDb();
  return db
    .select()
    .from(taskCommentMentions)
    .where(inArray(taskCommentMentions.commentId, commentIds))
    .orderBy(asc(taskCommentMentions.createdAt))
    .all() as TaskCommentMention[];
}
