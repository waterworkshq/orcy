import { getDb } from "../db/index.js";
import { missionComments } from "../db/schema/index.js";
import { eq, and, desc, count, sql } from "drizzle-orm";
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
  authorType: "human" | "agent" | "remote_human" | "remote_orcy";
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
  authorType: "human" | "agent" | "remote_human" | "remote_orcy";
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

/**
 * Reply-only creation primitive: one conditional `INSERT … SELECT … WHERE
 * EXISTS (parent.id = requestedParent AND parent.mission_id = missionId)
 * RETURNING` statement, so the reply reference is validated at INSERT time on
 * both SQLite drivers. Returns the matched row with its mention projection, or
 * null when the parent no longer exists or no longer belongs to the required
 * Mission at the moment the statement evaluates — never an unrestricted ID
 * refetch fallback. Root creation and other non-reply callers keep using
 * {@link createComment}.
 */
export function createReplyComment(input: {
  missionId: string;
  parentId: string;
  authorType: "human" | "agent" | "remote_human" | "remote_orcy";
  authorId: string;
  content: string;
}): MissionCommentRow | null {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    const matched = db.all(sql`
      INSERT INTO mission_comments (id, mission_id, parent_id, author_type, author_id, content, created_at, updated_at)
      SELECT ${id}, ${input.missionId}, ${input.parentId}, ${input.authorType}, ${input.authorId}, ${input.content}, ${now}, ${now}
      WHERE EXISTS (
        SELECT 1 FROM mission_comments parent
        WHERE parent.id = ${input.parentId} AND parent.mission_id = ${input.missionId}
      )
      RETURNING
        id,
        mission_id AS missionId,
        parent_id AS parentId,
        author_type AS authorType,
        author_id AS authorId,
        content,
        created_at AS createdAt,
        updated_at AS updatedAt
    `) as MissionCommentRow[];
    const row = matched[0] ?? null;
    return row ? (attachMentions([row])[0] ?? null) : null;
  } catch (err) {
    throw repositoryCreateError("missionComment", err as Error, id);
  }
}

/**
 * Updates a comment ONLY under its required Mission and exact typed author: the
 * actual UPDATE statement matches `id AND mission_id AND author_type AND
 * author_id` and returns the row THIS statement matched via `UPDATE … RETURNING`,
 * so a zero-match — absent comment, belonging to another Mission, or author
 * changed — is a null result, never a false success or a foreign row. Mentions
 * are attached to the returned row, with no post-write ID refetch.
 */
export function updateComment(
  missionId: string,
  commentId: string,
  authorType: "human" | "agent",
  authorId: string,
  content: string,
): MissionCommentRow | null {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    const matched = db
      .update(missionComments)
      .set({ content, updatedAt: now })
      .where(
        and(
          eq(missionComments.id, commentId),
          eq(missionComments.missionId, missionId),
          eq(missionComments.authorType, authorType),
          eq(missionComments.authorId, authorId),
        ),
      )
      .returning()
      .all();
    const row = (matched[0] as MissionCommentRow | undefined) ?? null;
    return row ? (attachMentions([row])[0] ?? null) : null;
  } catch (err) {
    throw repositoryUpdateError("missionComment", err as Error, commentId);
  }
}

/**
 * Deletes the SELECTED root comment ONLY when the final statement matches
 * `id AND mission_id AND author_type AND author_id` AND the entire descendant
 * closure reachable through `parent_id` (recursive CTE, UNION so revisited
 * cycles terminate) — evaluated AT PREDICATE TIME — contains no comment
 * belonging to another Mission (the cascade-consistency fence). The guarantee
 * is bounded to that snapshot: a trigger or other writer mutating the closure,
 * author or Mission scope AFTER the predicate has evaluated is outside this
 * fence. Same-Mission descendants (any author) and their mentions are removed
 * by the existing self-FK cascade; the statement returns only the selected
 * root's id, so success reflects the rows THIS statement actually removed. A
 * foreign-Mission descendant anywhere in the closure at predicate time is a
 * zero-match (no row loss), not a collateral deletion.
 */
export function deleteComment(
  missionId: string,
  commentId: string,
  authorType: "human" | "agent",
  authorId: string,
): boolean {
  const db = getDb();
  try {
    const matched = db.all(sql`
      WITH RECURSIVE comment_closure(id, mission_id) AS (
        SELECT id, mission_id FROM mission_comments WHERE id = ${commentId}
        UNION
        SELECT child.id, child.mission_id
        FROM mission_comments child
        JOIN comment_closure ON child.parent_id = comment_closure.id
      )
      DELETE FROM mission_comments
      WHERE id = ${commentId}
        AND mission_id = ${missionId}
        AND author_type = ${authorType}
        AND author_id = ${authorId}
        AND NOT EXISTS (
          SELECT 1 FROM comment_closure WHERE mission_id <> ${missionId}
        )
      RETURNING id
    `) as Array<{ id: string }>;
    return matched.length > 0;
  } catch (err) {
    throw repositoryDeleteError("missionComment", err as Error, commentId);
  }
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
