import * as commentRepo from '../repositories/comment.js';
import * as commentMentionRepo from '../repositories/commentMention.js';
import * as userRepo from '../repositories/user.js';
import * as agentRepo from '../repositories/agent.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import { getTaskById, getBoardIdForTask } from '../repositories/task.js';
import { notFound, forbidden, badRequest } from '../errors.js';

const MENTION_REGEX = /(^|\s)@([a-zA-Z0-9._-]{1,50})\b/g;

function extractMentionTokens(content: string): string[] {
  return [...content.matchAll(MENTION_REGEX)].map((match) => `@${match[2]}`);
}

interface ResolvedMention {
  mentionedType: 'human' | 'agent';
  mentionedId: string;
  mentionText: string;
  mentionedName: string;
}

function resolveMentions(content: string): ResolvedMention[] {
  const tokens = [...new Set(extractMentionTokens(content))];
  if (tokens.length === 0) return [];

  const rawNames = tokens.map((token) => token.slice(1));
  const users = userRepo.findUsersByUsernamesCaseInsensitive(rawNames);
  const agents = agentRepo.listAgents();
  const userMap = new Map(users.map((u) => [u.username.toLowerCase(), u]));
  const agentMap = new Map(agents.map((a) => [a.name.toLowerCase(), a]));

  const results: ResolvedMention[] = [];
  for (const token of tokens) {
    const name = token.slice(1).toLowerCase();
    const human = userMap.get(name);
    if (human) {
      results.push({ mentionedType: 'human', mentionedId: human.id, mentionText: token, mentionedName: human.username });
      continue;
    }
    const agent = agentMap.get(name);
    if (agent) {
      results.push({ mentionedType: 'agent', mentionedId: agent.id, mentionText: token, mentionedName: agent.name });
    }
  }
  return results;
}

/**
 * Add a comment to a task.
 * @param taskId - ID of the task
 * @param authorType - Whether the author is 'human' or 'agent'
 * @param authorId - ID of the comment author
 * @param content - Comment text
 * @param parentId - Optional parent comment ID for replies
 * @returns The created comment
 */
export function addComment(
  taskId: string,
  authorType: 'human' | 'agent',
  authorId: string,
  content: string,
  parentId?: string | null
) {
  const task = getTaskById(taskId);
  if (!task) {
    throw notFound('Task not found');
  }

  if (parentId) {
    const parent = commentRepo.getCommentById(parentId);
    if (!parent) {
      throw notFound('Parent comment not found');
    }
    if (parent.taskId !== taskId) {
      throw badRequest('Parent comment belongs to a different task');
    }
  }

  const comment = commentRepo.createComment({
    taskId,
    authorType,
    authorId,
    content,
    parentId: parentId || null,
  });

  const resolvedMentions = resolveMentions(content);
  const createdMentions = commentMentionRepo.createMentions(
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

  const boardId = getBoardIdForTask(taskId);
  if (boardId) {
    sseBroadcaster.publish(boardId, {
      type: 'task.commented',
      data: { taskId, comment: enrichedComment },
    });

    for (const mention of mentions) {
      sseBroadcaster.publish(boardId, {
        type: 'task.mentioned',
        data: {
          taskId,
          commentId: comment.id,
          mentionedType: mention.mentionedType,
          mentionedId: mention.mentionedId,
          mentionedName: mention.mentionedName ?? mention.mentionText.slice(1),
          boardId,
        },
      });
    }
  }

  return enrichedComment;
}

/**
 * Get comments for a task with pagination.
 * @param taskId - ID of the task
 * @param limit - Maximum number of comments to return
 * @param offset - Number of comments to skip
 * @returns Paginated comment list
 */
export function getComments(taskId: string, limit?: number, offset?: number) {
  return commentRepo.getCommentsByTaskId(taskId, limit, offset);
}

/**
 * Edit the content of an existing comment. Only the original author can edit.
 * @param commentId - ID of the comment to edit
 * @param authorType - Author type of the requester
 * @param authorId - ID of the requester
 * @param content - New comment text
 * @returns The updated comment
 */
export function editComment(
  commentId: string,
  authorType: 'human' | 'agent',
  authorId: string,
  content: string
) {
  const comment = commentRepo.getCommentById(commentId);
  if (!comment) {
    throw notFound('Comment not found');
  }

  if (comment.authorType !== authorType || comment.authorId !== authorId) {
    throw forbidden('Not authorized to edit this comment');
  }

  return commentRepo.updateComment(commentId, content);
}

/**
 * Delete a comment. Only the original author can delete.
 * @param commentId - ID of the comment to delete
 * @param authorType - Author type of the requester
 * @param authorId - ID of the requester
 * @returns The delete result
 */
export function removeComment(
  commentId: string,
  authorType: 'human' | 'agent',
  authorId: string
) {
  const comment = commentRepo.getCommentById(commentId);
  if (!comment) {
    throw notFound('Comment not found');
  }

  if (comment.authorType !== authorType || comment.authorId !== authorId) {
    throw forbidden('Not authorized to delete this comment');
  }

  const task = getTaskById(comment.taskId);
  const result = commentRepo.deleteComment(commentId);

  if (task) {
    const boardId = getBoardIdForTask(comment.taskId);
    if (boardId) {
      sseBroadcaster.publish(boardId, {
        type: 'task.comment_deleted',
        data: { taskId: comment.taskId, commentId },
      });
    }
  }

  return result;
}
