import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as commentService from '../services/commentService.js';
import { agentAuth, agentOrHumanAuth } from '../middleware/auth.js';
import { z } from 'zod';

const createCommentSchema = z.object({
  content: z.string().min(1).max(5000),
  parentId: z.string().uuid().optional(),
});

const updateCommentSchema = z.object({
  content: z.string().min(1).max(5000),
});

const commentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

/**
 * Task comment CRUD — create, list, update, and delete comments on tasks.
 */
export async function commentRoutes(fastify: FastifyInstance): Promise<void> {
  /** POST /tasks/:id/comments - Add a comment to a task. Auth: agentAuth. Returns { comment } with mention metadata or 404 */
  fastify.post<{ Params: { id: string }; Body: z.infer<typeof createCommentSchema> }>(
    '/tasks/:id/comments',
    { preHandler: agentAuth },
    async (request: FastifyRequest<{ Params: { id: string }; Body: z.infer<typeof createCommentSchema> }>, reply: FastifyReply) => {
      if (!request.agent && !request.user) {
        reply.code(401).send({ error: 'Authentication required' });
        return;
      }

      const parsed = createCommentSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
        return;
      }

      const authorType = request.agent ? 'agent' as const : 'human' as const;
      const authorId = request.agent?.id ?? request.user?.id ?? 'anonymous';

      try {
        const comment = commentService.addComment(
          request.params.id,
          authorType,
          authorId,
          parsed.data.content,
          parsed.data.parentId
        );
        reply.code(201).send({ comment });
      } catch (err) {
        const error = err as Error;
        if (error.message === 'Task not found') {
          reply.code(404).send({ error: 'Task not found' });
        } else if (error.message === 'Parent comment not found' || error.message === 'Parent comment belongs to a different task') {
          reply.code(400).send({ error: error.message });
        } else {
          throw err;
        }
      }
    }
  );

  /** GET /tasks/:id/comments - List comments for a task. Auth: agentOrHumanAuth. Returns { comments, total } with mention metadata */
  fastify.get<{ Params: { id: string }; Querystring: z.infer<typeof commentsQuerySchema> }>(
    '/tasks/:id/comments',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string }; Querystring: z.infer<typeof commentsQuerySchema> }>, reply: FastifyReply) => {
      const parsed = commentsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Invalid query', details: parsed.error.flatten() });
        return;
      }

      const result = commentService.getComments(
        request.params.id,
        parsed.data.limit,
        parsed.data.offset
      );
      return result;
    }
  );

  /** PATCH /tasks/:id/comments/:commentId - Edit a comment. Auth: agentAuth. Returns { comment } or 404/403 */
  fastify.patch<{ Params: { id: string; commentId: string }; Body: z.infer<typeof updateCommentSchema> }>(
    '/tasks/:id/comments/:commentId',
    { preHandler: agentAuth },
    async (request: FastifyRequest<{ Params: { id: string; commentId: string }; Body: z.infer<typeof updateCommentSchema> }>, reply: FastifyReply) => {
      if (!request.agent && !request.user) {
        reply.code(401).send({ error: 'Authentication required' });
        return;
      }

      const parsed = updateCommentSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
        return;
      }

      const authorType = request.agent ? 'agent' as const : 'human' as const;
      const authorId = request.agent?.id ?? request.user?.id ?? 'anonymous';

      try {
        const comment = commentService.editComment(
          request.params.commentId,
          authorType,
          authorId,
          parsed.data.content
        );
        if (!comment) {
          reply.code(404).send({ error: 'Comment not found' });
          return;
        }
        return { comment };
      } catch (err) {
        const error = err as Error;
        if (error.message === 'Comment not found') {
          reply.code(404).send({ error: 'Comment not found' });
        } else if (error.message === 'Not authorized to edit this comment') {
          reply.code(403).send({ error: 'Not authorized to edit this comment' });
        } else {
          throw err;
        }
      }
    }
  );

  /** DELETE /tasks/:id/comments/:commentId - Delete a comment. Auth: agentAuth. Returns 204 or 404/403 */
  fastify.delete<{ Params: { id: string; commentId: string } }>(
    '/tasks/:id/comments/:commentId',
    { preHandler: agentAuth },
    async (request: FastifyRequest<{ Params: { id: string; commentId: string } }>, reply: FastifyReply) => {
      if (!request.agent && !request.user) {
        reply.code(401).send({ error: 'Authentication required' });
        return;
      }

      const authorType = request.agent ? 'agent' as const : 'human' as const;
      const authorId = request.agent?.id ?? request.user?.id ?? 'anonymous';

      try {
        commentService.removeComment(request.params.commentId, authorType, authorId);
        reply.code(204).send();
      } catch (err) {
        const error = err as Error;
        if (error.message === 'Comment not found') {
          reply.code(404).send({ error: 'Comment not found' });
        } else if (error.message === 'Not authorized to delete this comment') {
          reply.code(403).send({ error: 'Not authorized to delete this comment' });
        } else {
          throw err;
        }
      }
    }
  );
}
