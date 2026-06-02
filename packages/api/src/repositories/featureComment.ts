import { getDb } from "../db/index.js";
import { missionComments } from "../db/schema/index.js";
import { eq, desc, count } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import * as missionCommentMentionRepo from "./featureCommentMention.js";
import type { MissionCommentMention } from "@orcy/shared/types";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
  repositoryDeleteError,
} from "../errors/repository.js";

export interface MissionCommentRow {
  id: string;
  missionId: string;
  parentId: string | null;
  authorType: "human" | "agent";
  authorId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

function attachMentions(comments: MissionCommentRow[]): MissionCommentRow[] {
  const mentions = missionCommentMentionRepo.getMentionsByCommentIds(comments.map((c) => c.id));
  const byCommentId = new Map<string, MissionCommentMention[]>();
  for (const mention of mentions) {
    byCommentId.set(mention.commentId, [...(byCommentId.get(mention.commentId) ?? []), mention]);
  }
  return comments.map((comment) => ({
    ...comment,
    mentions: byCommentId.get(comment.id) ?? [],
  }));
}

export function createComment(input: {
  missionId: string;
  authorType: "human" | "agent";
  authorId: string;
  content: string;
  parentId?: string | null;
}): MissionCommentRow {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(missionComments)
      .values({
        id,
        missionId: input.missionId,
        parentId: input.parentId ?? null,
        authorType: input.authorType,
        authorId: input.authorId,
        content: input.content,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("missionComment", err as Error, id);
  }

  const comment = getCommentById(id);
  if (!comment) throw repositoryNotFoundError("missionComment", id);
  return comment;
}

export function getCommentsByMissionId(
  missionId: string,
  limit = 50,
  offset = 0,
): { comments: MissionCommentRow[]; total: number } {
  const db = getDb();

  const comments = db
    .select()
    .from(missionComments)
    .where(eq(missionComments.missionId, missionId))
    .orderBy(desc(missionComments.createdAt))
    .limit(limit)
    .offset(offset)
    .all() as MissionCommentRow[];

  const totalResult = db
    .select({ count: count() })
    .from(missionComments)
    .where(eq(missionComments.missionId, missionId))
    .get();

  return { comments: attachMentions(comments), total: totalResult?.count ?? 0 };
}

export function getCommentById(commentId: string): MissionCommentRow | null {
  const db = getDb();
  const row = db.select().from(missionComments).where(eq(missionComments.id, commentId)).get();
  if (!row) return null;
  return attachMentions([row as MissionCommentRow])[0] ?? null;
}

export function updateComment(commentId: string, content: string): MissionCommentRow | null {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    db.update(missionComments)
      .set({ content, updatedAt: now })
      .where(eq(missionComments.id, commentId))
      .run();
  } catch (err) {
    throw repositoryUpdateError("missionComment", err as Error, commentId);
  }

  return getCommentById(commentId);
}

export function deleteComment(commentId: string): boolean {
  const db = getDb();
  try {
    db.delete(missionComments).where(eq(missionComments.id, commentId)).run();
  } catch (err) {
    throw repositoryDeleteError("missionComment", err as Error, commentId);
  }
  return true;
}

export function isCommentAuthor(commentId: string, authorType: string, authorId: string): boolean {
  const db = getDb();
  const row = db
    .select({ authorType: missionComments.authorType, authorId: missionComments.authorId })
    .from(missionComments)
    .where(eq(missionComments.id, commentId))
    .get();
  if (!row) return false;
  return row.authorType === authorType && row.authorId === authorId;
}
