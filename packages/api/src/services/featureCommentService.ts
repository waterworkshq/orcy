import * as missionCommentRepo from '../repositories/featureComment.js';
import * as missionCommentMentionRepo from '../repositories/featureCommentMention.js';
import { resolveMentions } from './commentHelper.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import { getMissionById } from '../repositories/feature.js';
import { notFound, forbidden, badRequest } from '../errors.js';

export function addComment(
  missionId: string,
  authorType: 'human' | 'agent',
  authorId: string,
  content: string,
  parentId?: string | null
) {
  const mission = getMissionById(missionId);
  if (!mission) {
    throw notFound('Mission not found');
  }

  if (parentId) {
    const parent = missionCommentRepo.getCommentById(parentId);
    if (!parent) {
      throw notFound('Parent comment not found');
    }
    if (parent.missionId !== missionId) {
      throw badRequest('Parent comment belongs to a different mission');
    }
  }

  const comment = missionCommentRepo.createComment({
    missionId,
    authorType,
    authorId,
    content,
    parentId: parentId || null,
  });

  const resolvedMentions = resolveMentions(content);
  const createdMentions = missionCommentMentionRepo.createMentions(
    resolvedMentions.map((mention) => ({
      commentId: comment.id,
      mentionedType: mention.mentionedType,
      mentionedId: mention.mentionedId,
      mentionText: mention.mentionText,
    }))
  );
  const mentions = createdMentions.map((created) => ({
    ...created,
    mentionedName: resolvedMentions.find((m) => m.mentionedId === created.mentionedId && m.mentionedType === created.mentionedType)?.mentionedName,
  }));

  const enrichedComment = { ...comment, mentions };

  sseBroadcaster.publish(mission.habitatId, {
    type: 'mission.commented',
    data: { missionId, comment: enrichedComment },
  });

  for (const mention of mentions) {
    sseBroadcaster.publish(mission.habitatId, {
      type: 'mission.mentioned',
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

export function getComments(missionId: string, limit?: number, offset?: number) {
  return missionCommentRepo.getCommentsByMissionId(missionId, limit, offset);
}

export function editComment(
  commentId: string,
  authorType: 'human' | 'agent',
  authorId: string,
  content: string
) {
  const comment = missionCommentRepo.getCommentById(commentId);
  if (!comment) {
    throw notFound('Comment not found');
  }

  if (comment.authorType !== authorType || comment.authorId !== authorId) {
    throw forbidden('Not authorized to edit this comment');
  }

  return missionCommentRepo.updateComment(commentId, content);
}

export function removeComment(
  commentId: string,
  authorType: 'human' | 'agent',
  authorId: string
) {
  const comment = missionCommentRepo.getCommentById(commentId);
  if (!comment) {
    throw notFound('Comment not found');
  }

  if (comment.authorType !== authorType || comment.authorId !== authorId) {
    throw forbidden('Not authorized to delete this comment');
  }

  const mission = getMissionById(comment.missionId);
  const result = missionCommentRepo.deleteComment(commentId);

  if (mission) {
    sseBroadcaster.publish(mission.habitatId, {
      type: 'mission.comment_deleted',
      data: { missionId: comment.missionId, commentId },
    });
  }

  return result;
}
