import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as featureCommentService from '../services/featureCommentService.js';
import { agentAuth, agentOrHumanAuth } from '../middleware/auth.js';
import { badRequest, unauthorized, notFound, forbidden } from '../errors.js';
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

export async function featureCommentRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { id: string }; Body: z.infer<typeof createCommentSchema> }>(
    '/features/:id/comments',
    { preHandler: agentAuth },
    async (request: FastifyRequest<{ Params: { id: string }; Body: z.infer<typeof createCommentSchema> }>, reply: FastifyReply) => {
      if (!request.agent && !request.user) {
        throw unauthorized('Authentication required');
      }

      const parsed = createCommentSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Validation failed', parsed.error.flatten());
      }

      const authorType = request.agent ? 'agent' as const : 'human' as const;
      const authorId = request.agent?.id ?? request.user?.id ?? 'anonymous';

      try {
        const comment = featureCommentService.addComment(
          request.params.id,
          authorType,
          authorId,
          parsed.data.content,
          parsed.data.parentId
        );
        reply.code(201).send({ comment });
      } catch (err) {
        const error = err as Error;
        if (error.message === 'Feature not found') {
          throw notFound('Feature not found');
        } else if (error.message === 'Parent comment not found' || error.message === 'Parent comment belongs to a different feature') {
          throw badRequest(error.message);
        } else {
          throw err;
        }
      }
    }
  );

  fastify.get<{ Params: { id: string }; Querystring: z.infer<typeof commentsQuerySchema> }>(
    '/features/:id/comments',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string }; Querystring: z.infer<typeof commentsQuerySchema> }>, reply: FastifyReply) => {
      const parsed = commentsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw badRequest('Invalid query', parsed.error.flatten());
      }

      const result = featureCommentService.getComments(
        request.params.id,
        parsed.data.limit,
        parsed.data.offset
      );
      return result;
    }
  );

  fastify.patch<{ Params: { id: string; commentId: string }; Body: z.infer<typeof updateCommentSchema> }>(
    '/features/:id/comments/:commentId',
    { preHandler: agentAuth },
    async (request: FastifyRequest<{ Params: { id: string; commentId: string }; Body: z.infer<typeof updateCommentSchema> }>, reply: FastifyReply) => {
      if (!request.agent && !request.user) {
        throw unauthorized('Authentication required');
      }

      const parsed = updateCommentSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Validation failed', parsed.error.flatten());
      }

      const authorType = request.agent ? 'agent' as const : 'human' as const;
      const authorId = request.agent?.id ?? request.user?.id ?? 'anonymous';

      try {
        const comment = featureCommentService.editComment(
          request.params.commentId,
          authorType,
          authorId,
          parsed.data.content
        );
        if (!comment) {
          throw notFound('Comment not found');
        }
        return { comment };
      } catch (err) {
        const error = err as Error;
        if (error.message === 'Comment not found') {
          throw notFound('Comment not found');
        } else if (error.message === 'Not authorized to edit this comment') {
          throw forbidden('Not authorized to edit this comment');
        } else {
          throw err;
        }
      }
    }
  );

  fastify.delete<{ Params: { id: string; commentId: string } }>(
    '/features/:id/comments/:commentId',
    { preHandler: agentAuth },
    async (request: FastifyRequest<{ Params: { id: string; commentId: string } }>, reply: FastifyReply) => {
      if (!request.agent && !request.user) {
        throw unauthorized('Authentication required');
      }

      const authorType = request.agent ? 'agent' as const : 'human' as const;
      const authorId = request.agent?.id ?? request.user?.id ?? 'anonymous';

      try {
        featureCommentService.removeComment(request.params.commentId, authorType, authorId);
        reply.code(204).send();
      } catch (err) {
        const error = err as Error;
        if (error.message === 'Comment not found') {
          throw notFound('Comment not found');
        } else if (error.message === 'Not authorized to delete this comment') {
          throw forbidden('Not authorized to delete this comment');
        } else {
          throw err;
        }
      }
    }
  );
}
