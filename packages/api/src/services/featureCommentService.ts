import * as featureCommentRepo from '../repositories/featureComment.js';
import * as featureCommentMentionRepo from '../repositories/featureCommentMention.js';
import { resolveMentions } from './commentHelper.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import { getFeatureById } from '../repositories/feature.js';
import { notFound, forbidden, badRequest } from '../errors.js';

export function addComment(
  featureId: string,
  authorType: 'human' | 'agent',
  authorId: string,
  content: string,
  parentId?: string | null
) {
  const feature = getFeatureById(featureId);
  if (!feature) {
    throw notFound('Feature not found');
  }

  if (parentId) {
    const parent = featureCommentRepo.getCommentById(parentId);
    if (!parent) {
      throw notFound('Parent comment not found');
    }
    if (parent.featureId !== featureId) {
      throw badRequest('Parent comment belongs to a different feature');
    }
  }

  const comment = featureCommentRepo.createComment({
    featureId,
    authorType,
    authorId,
    content,
    parentId: parentId || null,
  });

  const resolvedMentions = resolveMentions(content);
  const createdMentions = featureCommentMentionRepo.createMentions(
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

  sseBroadcaster.publish(feature.boardId, {
    type: 'feature.commented',
    data: { featureId, comment: enrichedComment },
  });

  for (const mention of mentions) {
    sseBroadcaster.publish(feature.boardId, {
      type: 'feature.mentioned',
      data: {
        featureId,
        commentId: comment.id,
        mentionedType: mention.mentionedType,
        mentionedId: mention.mentionedId,
        mentionedName: mention.mentionedName ?? mention.mentionText.slice(1),
        boardId: feature.boardId,
      },
    });
  }

  return enrichedComment;
}

export function getComments(featureId: string, limit?: number, offset?: number) {
  return featureCommentRepo.getCommentsByFeatureId(featureId, limit, offset);
}

export function editComment(
  commentId: string,
  authorType: 'human' | 'agent',
  authorId: string,
  content: string
) {
  const comment = featureCommentRepo.getCommentById(commentId);
  if (!comment) {
    throw notFound('Comment not found');
  }

  if (comment.authorType !== authorType || comment.authorId !== authorId) {
    throw forbidden('Not authorized to edit this comment');
  }

  return featureCommentRepo.updateComment(commentId, content);
}

export function removeComment(
  commentId: string,
  authorType: 'human' | 'agent',
  authorId: string
) {
  const comment = featureCommentRepo.getCommentById(commentId);
  if (!comment) {
    throw notFound('Comment not found');
  }

  if (comment.authorType !== authorType || comment.authorId !== authorId) {
    throw forbidden('Not authorized to delete this comment');
  }

  const feature = getFeatureById(comment.featureId);
  const result = featureCommentRepo.deleteComment(commentId);

  if (feature) {
    sseBroadcaster.publish(feature.boardId, {
      type: 'feature.comment_deleted',
      data: { featureId: comment.featureId, commentId },
    });
  }

  return result;
}
