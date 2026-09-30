import { getDb } from "../db/index.js";
import { taskComments, missionComments, tasks, missions } from "../db/schema/index.js";
import { eq, and, desc, count, gt, gte, lte, sql } from "drizzle-orm";
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

/**
 * Reply-only creation primitive: one conditional `INSERT … SELECT … WHERE EXISTS
 * (parent.id = requestedParent AND parent.task_id = taskId) RETURNING`
 * statement, so the reply reference is validated at INSERT time on both SQLite
 * drivers. Returns the matched row with its mention projection, or null when
 * the parent no longer exists or no longer belongs to the required Task at the
 * moment the statement evaluates — never an unrestricted ID refetch fallback.
 * Root creation, clone/import/fixture callers keep using {@link createComment}.
 */
export function createReplyComment(input: {
  taskId: string;
  parentId: string;
  authorType: "human" | "agent" | "remote_human" | "remote_orcy";
  authorId: string;
  content: string;
}): Comment | null {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    const matched = db.all(sql`
      INSERT INTO task_comments (id, task_id, parent_id, author_type, author_id, content, created_at, updated_at)
      SELECT ${id}, ${input.taskId}, ${input.parentId}, ${input.authorType}, ${input.authorId}, ${input.content}, ${now}, ${now}
      WHERE EXISTS (
        SELECT 1 FROM task_comments parent
        WHERE parent.id = ${input.parentId} AND parent.task_id = ${input.taskId}
      )
      RETURNING
        id,
        task_id AS taskId,
        parent_id AS parentId,
        author_type AS authorType,
        author_id AS authorId,
        content,
        created_at AS createdAt,
        updated_at AS updatedAt
    `) as Comment[];
    const row = matched[0] ?? null;
    return row ? (attachMentions([row])[0] ?? null) : null;
  } catch (err) {
    throw repositoryCreateError("comment", err as Error, id);
  }
}

/**
 * Updates a comment ONLY under its required Task and exact typed author: the
 * actual UPDATE statement matches `id AND task_id AND author_type AND
 * author_id` and returns the row THIS statement matched via
 * `UPDATE … RETURNING` (the cross-driver pattern from `updateSubtask`), so a
 * zero-match — absent comment, reparented to another Task, or author changed —
 * is a null result, never a false success or a foreign row. Mentions are
 * attached to the returned row, with no post-write ID refetch.
 */
export function updateComment(
  taskId: string,
  commentId: string,
  authorType: "human" | "agent",
  authorId: string,
  content: string,
): Comment | null {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    const matched = db
      .update(taskComments)
      .set({ content, updatedAt: now })
      .where(
        and(
          eq(taskComments.id, commentId),
          eq(taskComments.taskId, taskId),
          eq(taskComments.authorType, authorType),
          eq(taskComments.authorId, authorId),
        ),
      )
      .returning()
      .all();
    const row = (matched[0] as Comment | undefined) ?? null;
    return row ? (attachMentions([row])[0] ?? null) : null;
  } catch (err) {
    throw repositoryUpdateError("comment", err as Error, commentId);
  }
}

/**
 * Deletes the SELECTED root comment ONLY when the final statement matches
 * `id AND task_id AND author_type AND author_id` AND the entire descendant
 * closure reachable through `parent_id` (recursive CTE, UNION so revisited
 * cycles terminate) — evaluated AT PREDICATE TIME — contains no comment
 * belonging to another Task (the cascade-consistency fence). The guarantee
 * is bounded to that snapshot: a trigger or other writer mutating the
 * closure, author or Task scope AFTER the predicate has evaluated is
 * outside this fence (an independently reproduced accepted limit; the FK
 * cascade then follows whatever the closure became). Same-Task descendants
 * (any author) are removed by the existing self-FK cascade; the statement
 * returns only the selected root's id, so success reflects the rows THIS
 * statement actually removed. A foreign-Task descendant anywhere in the
 * closure at predicate time is a zero-match (no row loss), not a collateral
 * deletion.
 */
export function deleteComment(
  taskId: string,
  commentId: string,
  authorType: "human" | "agent",
  authorId: string,
): boolean {
  const db = getDb();
  try {
    const matched = db.all(sql`
      WITH RECURSIVE comment_closure(id, task_id) AS (
        SELECT id, task_id FROM task_comments WHERE id = ${commentId}
        UNION
        SELECT child.id, child.task_id
        FROM task_comments child
        JOIN comment_closure ON child.parent_id = comment_closure.id
      )
      DELETE FROM task_comments
      WHERE id = ${commentId}
        AND task_id = ${taskId}
        AND author_type = ${authorType}
        AND author_id = ${authorId}
        AND NOT EXISTS (
          SELECT 1 FROM comment_closure WHERE task_id <> ${taskId}
        )
      RETURNING id
    `) as Array<{ id: string }>;
    return matched.length > 0;
  } catch (err) {
    throw repositoryDeleteError("comment", err as Error, commentId);
  }
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

/**
 * Returns comments in a habitat (both task and mission) with `created_at` in the inclusive window
 * `[from, to]`. Backs the `wikiAugmentationService` chunk mode (SQL-bounded window instead of
 * newest-`limit*4`-since-1970 filtered in memory). `limit` is a soft cap on the combined result
 * (per-source caps are `limit` each; combined then trimmed). No side effects.
 */
export function listByHabitatBetween(
  habitatId: string,
  from: string,
  to: string,
  limit = 100,
): ScopedComment[] {
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
    .where(
      and(
        eq(missions.habitatId, habitatId),
        gte(taskComments.createdAt, from),
        lte(taskComments.createdAt, to),
      ),
    )
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
    .where(
      and(
        eq(missions.habitatId, habitatId),
        gte(missionComments.createdAt, from),
        lte(missionComments.createdAt, to),
      ),
    )
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
