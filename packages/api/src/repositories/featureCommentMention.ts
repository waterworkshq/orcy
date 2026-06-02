import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";
import { missionCommentMentions } from "../db/schema/index.js";
import { inArray, asc } from "drizzle-orm";
import type { MissionCommentMention } from "@orcy/shared/types";
import { repositoryCreateError } from "../errors/repository.js";

export function createMentions(
  input: Array<Omit<MissionCommentMention, "id" | "createdAt" | "mentionedName">>,
): MissionCommentMention[] {
  const db = getDb();
  const now = new Date().toISOString();

  const created: MissionCommentMention[] = [];
  for (const item of input) {
    const id = uuid();
    try {
      db.insert(missionCommentMentions)
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
    } catch (err) {
      throw repositoryCreateError("missionCommentMention", err as Error, id);
    }
    created.push({ ...item, id, createdAt: now });
  }
  return created;
}

export function getMentionsByCommentIds(commentIds: string[]): MissionCommentMention[] {
  if (commentIds.length === 0) return [];
  const db = getDb();
  return db
    .select()
    .from(missionCommentMentions)
    .where(inArray(missionCommentMentions.commentId, commentIds))
    .orderBy(asc(missionCommentMentions.createdAt))
    .all() as MissionCommentMention[];
}
