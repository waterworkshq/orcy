import { getDb } from "../db/index.js";
import { taskComments, missionComments, tasks, missions } from "../db/schema/index.js";
import { eq, and, desc, count, gt } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import * as commentMentionRepo from "./commentMention.js";
import type { TaskCommentMention } from "../models/index.js";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
  repositoryDeleteError,
} from "../errors/repository.js";

export interface Comment {
  id: string;
  taskId: string;
  parentId: string | null;
  authorType: "human" | "agent" | "remote_human" | "remote_orcy";
  authorId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Unified comment shape returned by {@link listByHabitatSince}. `scope: "task"` rows have a
 * `taskId`; `scope: "mission"` rows have a `missionId`. Both share `content`, `author`, and
 * `createdAt` fields. Backs the `wikiAugmentationService` delta + chunk modes; the consumer
 * groups them all under `comments[]` regardless of scope.
 */
export interface ScopedComment {
  id: string;
  scope: "task" | "mission";
  taskId: string | null;
  missionId: string | null;
  content: string;
  authorType: "human" | "agent" | "remote_human" | "remote_orcy";
  authorId: string;
  createdAt: string;
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
  authorType: "human" | "agent" | "remote_human" | "remote_orcy";
  authorId: string;
  content: string;
  parentId?: string | null;
}): Comment {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(taskComments)
      .values({
        id,
        taskId: input.taskId,
        parentId: input.parentId ?? null,
        authorType: input.authorType,
        authorId: input.authorId,
        content: input.content,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("comment", err as Error, id);
  }

  const comment = getCommentById(id);
  if (!comment) throw repositoryNotFoundError("comment", id);
  return comment;
}

export function getCommentsByTaskId(
  taskId: string,
  limit = 50,
  offset = 0,
): { comments: Comment[]; total: number } {
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
  const row = db.select().from(taskComments).where(eq(taskComments.id, commentId)).get();
  if (!row) return null;
  return attachMentions([row as Comment])[0] ?? null;
}

export function updateComment(commentId: string, content: string): Comment | null {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    db.update(taskComments)
      .set({ content, updatedAt: now })
      .where(eq(taskComments.id, commentId))
      .run();
  } catch (err) {
    throw repositoryUpdateError("comment", err as Error, commentId);
  }

  return getCommentById(commentId);
}

export function deleteComment(commentId: string): boolean {
  const db = getDb();
  try {
    db.delete(taskComments).where(eq(taskComments.id, commentId)).run();
  } catch (err) {
    throw repositoryDeleteError("comment", err as Error, commentId);
  }
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

/**
 * Returns recent comments in a habitat (both task comments and mission comments) with
 * `created_at > since`. Backs the `wikiAugmentationService` delta + chunk modes. Task comments
 * are scoped via `task_comments.task_id → tasks.mission_id → missions.habitat_id`; mission
 * comments are scoped via `mission_comments.mission_id → missions.habitat_id`. `limit` is a
 * soft cap on the combined result (per-source caps are `limit` each; combined then trimmed).
 * No side effects.
 */
export function listByHabitatSince(habitatId: string, since: string, limit = 100): ScopedComment[] {
  const db = getDb();

  const taskRows = db
    .select({
      id: taskComments.id,
      content: taskComments.content,
      authorType: taskComments.authorType,
      authorId: taskComments.authorId,
      createdAt: taskComments.createdAt,
      taskId: taskComments.taskId,
    })
    .from(taskComments)
    .innerJoin(tasks, eq(tasks.id, taskComments.taskId))
    .innerJoin(missions, eq(missions.id, tasks.missionId))
    .where(and(eq(missions.habitatId, habitatId), gt(taskComments.createdAt, since)))
    .orderBy(desc(taskComments.createdAt))
    .limit(limit)
    .all();

  const missionRows = db
    .select({
      id: missionComments.id,
      content: missionComments.content,
      authorType: missionComments.authorType,
      authorId: missionComments.authorId,
      createdAt: missionComments.createdAt,
      missionId: missionComments.missionId,
    })
    .from(missionComments)
    .innerJoin(missions, eq(missions.id, missionComments.missionId))
    .where(and(eq(missions.habitatId, habitatId), gt(missionComments.createdAt, since)))
    .orderBy(desc(missionComments.createdAt))
    .limit(limit)
    .all();

  const combined: ScopedComment[] = [
    ...taskRows.map((r) => ({
      id: r.id,
      scope: "task" as const,
      taskId: r.taskId,
      missionId: null,
      content: r.content,
      authorType: r.authorType,
      authorId: r.authorId,
      createdAt: r.createdAt,
    })),
    ...missionRows.map((r) => ({
      id: r.id,
      scope: "mission" as const,
      taskId: null,
      missionId: r.missionId,
      content: r.content,
      authorType: r.authorType,
      authorId: r.authorId,
      createdAt: r.createdAt,
    })),
  ];

  combined.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return combined.slice(0, limit);
}
