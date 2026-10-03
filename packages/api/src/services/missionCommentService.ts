import * as missionCommentRepo from "../repositories/featureComment.js";
import * as missionCommentMentionRepo from "../repositories/featureCommentMention.js";
import { resolveMentions } from "./commentHelper.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { getMissionById } from "../repositories/mission.js";
import { notFound, forbidden, badRequest } from "../errors.js";

/** Creates a comment on a mission, resolves `@mentions`, and emits `mission.commented` plus per-mention `mission.mentioned` SSE events to the habitat. */
export function addComment(
  missionId: string,
  authorType: "human" | "agent" | "remote_human" | "remote_orcy",
  authorId: string,
  content: string,
  parentId?: string | null,
) {
  const mission = getMissionById(missionId);
  if (!mission) {
    throw notFound("Mission not found");
  }

  if (parentId) {
    const parent = missionCommentRepo.getCommentById(parentId);
    if (!parent) {
      throw notFound("Parent comment not found");
    }
    if (parent.missionId !== missionId) {
      throw badRequest("Parent comment belongs to a different mission");
    }
  }

  // A reply is inserted under one conditional statement so the parent
  // reference is re-checked against the required Mission AT INSERT time; a
  // final miss maps the existing parent error BEFORE any mention row or event.
  const comment = parentId
    ? missionCommentRepo.createReplyComment({
        missionId,
        parentId,
        authorType,
        authorId,
        content,
      })
    : missionCommentRepo.createComment({
        missionId,
        authorType,
        authorId,
        content,
        parentId: null,
      });
  if (!comment) {
    throw notFound("Parent comment not found");
  }

  const resolvedMentions = resolveMentions(content);
  const createdMentions = missionCommentMentionRepo.createMentions(
    resolvedMentions.map((mention) => ({
      commentId: comment.id,
      mentionedType: mention.mentionedType,
      mentionedId: mention.mentionedId,
      mentionText: mention.mentionText,
    })),
  );
  const mentions = createdMentions.map((created) => ({
    ...created,
    mentionedName: resolvedMentions.find(
      (m) => m.mentionedId === created.mentionedId && m.mentionedType === created.mentionedType,
    )?.mentionedName,
  }));

  const enrichedComment = { ...comment, mentions };

  sseBroadcaster.publish(mission.habitatId, {
    type: "mission.commented",
    data: { missionId, comment: enrichedComment },
  });

  for (const mention of mentions) {
    sseBroadcaster.publish(mission.habitatId, {
      type: "mission.mentioned",
      data: {
        missionId,
        commentId: comment.id,
        mentionedType: mention.mentionedType,
        mentionedId: mention.mentionedId,
        mentionedName: mention.mentionedName ?? mention.mentionText.slice(1),
        habitatId: mission.habitatId,
      },
    });
  }

  return enrichedComment;
}

/** Returns a paginated list of comments for a mission. */
export function getComments(missionId: string, limit?: number, offset?: number) {
  return missionCommentRepo.getCommentsByMissionId(missionId, limit, offset);
}

/**
 * Updates a comment's content. The comment must belong to the required Mission
 * and only the original author may edit it; the final UPDATE re-checks both in
 * its own predicate, so a row that changed after the pre-read is a not-found
 * rather than a mutated foreign row.
 */
export function editComment(
  missionId: string,
  commentId: string,
  authorType: "human" | "agent",
  authorId: string,
  content: string,
) {
  const comment = missionCommentRepo.getCommentById(commentId);
  if (!comment || comment.missionId !== missionId) {
    throw notFound("Comment not found");
  }

  if (comment.authorType !== authorType || comment.authorId !== authorId) {
    throw forbidden("Not authorized to edit this comment");
  }

  const updated = missionCommentRepo.updateComment(missionId, commentId, authorType, authorId, content);
  if (!updated) {
    throw notFound("Comment not found");
  }
  return updated;
}

/**
 * Deletes a comment. Only the original author may remove it, the comment must
 * belong to the required Mission, and the deletion publishes its single root
 * `mission.comment_deleted` event only after the final statement actually
 * matched — the same conditional fence the Task comment family uses.
 */
export function removeComment(
  missionId: string,
  commentId: string,
  authorType: "human" | "agent",
  authorId: string,
) {
  const comment = missionCommentRepo.getCommentById(commentId);
  if (!comment || comment.missionId !== missionId) {
    throw notFound("Comment not found");
  }

  if (comment.authorType !== authorType || comment.authorId !== authorId) {
    throw forbidden("Not authorized to delete this comment");
  }

  const mission = getMissionById(comment.missionId);
  const result = missionCommentRepo.deleteComment(missionId, commentId, authorType, authorId);
  if (!result) {
    throw notFound("Comment not found");
  }

  if (mission) {
    sseBroadcaster.publish(mission.habitatId, {
      type: "mission.comment_deleted",
      data: { missionId: comment.missionId, commentId },
    });
  }

  return result;
}
