import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as missionCommentService from '../services/featureCommentService.js';
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

export async function missionCommentRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { missionId: string }; Body: z.infer<typeof createCommentSchema> }>(
    '/missions/:missionId/comments',
    { preHandler: agentAuth },
    async (request: FastifyRequest<{ Params: { missionId: string }; Body: z.infer<typeof createCommentSchema> }>, reply: FastifyReply) => {
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
        const comment = missionCommentService.addComment(
          request.params.missionId,
          authorType,
          authorId,
          parsed.data.content,
          parsed.data.parentId
        );
        reply.code(201).send({ comment });
      } catch (err) {
        const error = err as Error;
        if (error.message === 'Mission not found') {
          throw notFound('Mission not found');
        } else if (error.message === 'Parent comment not found' || error.message === 'Parent comment belongs to a different mission') {
          throw badRequest(error.message);
        } else {
          throw err;
        }
      }
    }
  );

  fastify.get<{ Params: { missionId: string }; Querystring: z.infer<typeof commentsQuerySchema> }>(
    '/missions/:missionId/comments',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { missionId: string }; Querystring: z.infer<typeof commentsQuerySchema> }>, reply: FastifyReply) => {
      const parsed = commentsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw badRequest('Invalid query', parsed.error.flatten());
      }

      const result = missionCommentService.getComments(
        request.params.missionId,
        parsed.data.limit,
        parsed.data.offset
      );
      return result;
    }
  );

  fastify.patch<{ Params: { missionId: string; commentId: string }; Body: z.infer<typeof updateCommentSchema> }>(
    '/missions/:missionId/comments/:commentId',
    { preHandler: agentAuth },
    async (request: FastifyRequest<{ Params: { missionId: string; commentId: string }; Body: z.infer<typeof updateCommentSchema> }>, reply: FastifyReply) => {
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
        const comment = missionCommentService.editComment(
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

  fastify.delete<{ Params: { missionId: string; commentId: string } }>(
    '/missions/:missionId/comments/:commentId',
    { preHandler: agentAuth },
    async (request: FastifyRequest<{ Params: { missionId: string; commentId: string } }>, reply: FastifyReply) => {
      if (!request.agent && !request.user) {
        throw unauthorized('Authentication required');
      }

      const authorType = request.agent ? 'agent' as const : 'human' as const;
      const authorId = request.agent?.id ?? request.user?.id ?? 'anonymous';

      try {
        missionCommentService.removeComment(request.params.commentId, authorType, authorId);
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
