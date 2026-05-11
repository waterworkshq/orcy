import { getDb } from '../db/index.js';
import { taskComments } from '../db/schema/index.js';
import { eq, desc, asc, sql, count } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import * as commentMentionRepo from './commentMention.js';
import type { TaskCommentMention } from '../models/index.js';

export interface Comment {
  id: string;
  taskId: string;
  parentId: string | null;
  authorType: 'human' | 'agent';
  authorId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

function attachMentions(comments: Comment[]): Comment[] {
  const mentions = commentMentionRepo.getMentionsByCommentIds(comments.map((c) => c.id));
  const byCommentId = new Map<string, TaskCommentMention[]>();
  for (const mention of mentions) {
    byCommentId.set(mention.commentId, [...(byCommentId.get(mention.commentId) ?? []), mention]);
  }
  return comments.map((comment) => ({
    ...comment,
    mentions: byCommentId.get(comment.id) ?? [],
  }));
}

export function createComment(input: {
  taskId: string;
  authorType: 'human' | 'agent';
  authorId: string;
  content: string;
  parentId?: string | null;
}): Comment {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(taskComments).values({
    id,
    taskId: input.taskId,
    parentId: input.parentId ?? null,
    authorType: input.authorType,
    authorId: input.authorId,
    content: input.content,
    createdAt: now,
    updatedAt: now,
  }).run();

  return getCommentById(id)!;
}

export function getCommentsByTaskId(taskId: string, limit = 50, offset = 0): { comments: Comment[]; total: number } {
  const db = getDb();

  const comments = db
    .select()
    .from(taskComments)
    .where(eq(taskComments.taskId, taskId))
    .orderBy(desc(taskComments.createdAt))
    .limit(limit)
    .offset(offset)
    .all() as Comment[];

  const totalResult = db
    .select({ count: count() })
    .from(taskComments)
    .where(eq(taskComments.taskId, taskId))
    .get();

  return { comments: attachMentions(comments), total: totalResult?.count ?? 0 };
}

export function getCommentById(commentId: string): Comment | null {
  const db = getDb();
  const row = db
    .select()
    .from(taskComments)
    .where(eq(taskComments.id, commentId))
    .get();
  if (!row) return null;
  return attachMentions([row as Comment])[0] ?? null;
}

export function updateComment(commentId: string, content: string): Comment | null {
  const db = getDb();
  const now = new Date().toISOString();

  db.update(taskComments)
    .set({ content, updatedAt: now })
    .where(eq(taskComments.id, commentId))
    .run();

  return getCommentById(commentId);
}

export function deleteComment(commentId: string): boolean {
  const db = getDb();
  db.delete(taskComments)
    .where(eq(taskComments.id, commentId))
    .run();
  return true;
}

export function isCommentAuthor(commentId: string, authorType: string, authorId: string): boolean {
  const db = getDb();
  const row = db
    .select({ authorType: taskComments.authorType, authorId: taskComments.authorId })
    .from(taskComments)
    .where(eq(taskComments.id, commentId))
    .get();
  if (!row) return false;
  return row.authorType === authorType && row.authorId === authorId;
}
