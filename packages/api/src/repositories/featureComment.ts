import { getDb } from '../db/index.js';
import { featureComments } from '../db/schema/index.js';
import { eq, desc, count } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import * as featureCommentMentionRepo from './featureCommentMention.js';
import type { FeatureCommentMention } from '../models/index.js';

export interface FeatureCommentRow {
  id: string;
  featureId: string;
  parentId: string | null;
  authorType: 'human' | 'agent';
  authorId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

function attachMentions(comments: FeatureCommentRow[]): FeatureCommentRow[] {
  const mentions = featureCommentMentionRepo.getMentionsByCommentIds(comments.map((c) => c.id));
  const byCommentId = new Map<string, FeatureCommentMention[]>();
  for (const mention of mentions) {
    byCommentId.set(mention.commentId, [...(byCommentId.get(mention.commentId) ?? []), mention]);
  }
  return comments.map((comment) => ({
    ...comment,
    mentions: byCommentId.get(comment.id) ?? [],
  }));
}

export function createComment(input: {
  featureId: string;
  authorType: 'human' | 'agent';
  authorId: string;
  content: string;
  parentId?: string | null;
}): FeatureCommentRow {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(featureComments).values({
    id,
    featureId: input.featureId,
    parentId: input.parentId ?? null,
    authorType: input.authorType,
    authorId: input.authorId,
    content: input.content,
    createdAt: now,
    updatedAt: now,
  }).run();

  return getCommentById(id)!;
}

export function getCommentsByFeatureId(featureId: string, limit = 50, offset = 0): { comments: FeatureCommentRow[]; total: number } {
  const db = getDb();

  const comments = db
    .select()
    .from(featureComments)
    .where(eq(featureComments.featureId, featureId))
    .orderBy(desc(featureComments.createdAt))
    .limit(limit)
    .offset(offset)
    .all() as FeatureCommentRow[];

  const totalResult = db
    .select({ count: count() })
    .from(featureComments)
    .where(eq(featureComments.featureId, featureId))
    .get();

  return { comments: attachMentions(comments), total: totalResult?.count ?? 0 };
}

export function getCommentById(commentId: string): FeatureCommentRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(featureComments)
    .where(eq(featureComments.id, commentId))
    .get();
  if (!row) return null;
  return attachMentions([row as FeatureCommentRow])[0] ?? null;
}

export function updateComment(commentId: string, content: string): FeatureCommentRow | null {
  const db = getDb();
  const now = new Date().toISOString();

  db.update(featureComments)
    .set({ content, updatedAt: now })
    .where(eq(featureComments.id, commentId))
    .run();

  return getCommentById(commentId);
}

export function deleteComment(commentId: string): boolean {
  const db = getDb();
  db.delete(featureComments)
    .where(eq(featureComments.id, commentId))
    .run();
  return true;
}

export function isCommentAuthor(commentId: string, authorType: string, authorId: string): boolean {
  const db = getDb();
  const row = db
    .select({ authorType: featureComments.authorType, authorId: featureComments.authorId })
    .from(featureComments)
    .where(eq(featureComments.id, commentId))
    .get();
  if (!row) return false;
  return row.authorType === authorType && row.authorId === authorId;
}
