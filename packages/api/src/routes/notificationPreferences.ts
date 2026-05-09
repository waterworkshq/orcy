import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as prefRepo from '../repositories/notificationPreferences.js';
import * as userRepo from '../repositories/user.js';
import { humanAuth } from '../middleware/auth.js';
import { z } from 'zod';

const preferencesSchema = z.object({
  taskAssigned: z.boolean().optional(),
  taskSubmitted: z.boolean().optional(),
  taskApproved: z.boolean().optional(),
  taskRejected: z.boolean().optional(),
  taskOverdue: z.boolean().optional(),
  taskMentioned: z.boolean().optional(),
  taskWatching: z.boolean().optional(),
});

const updateEmailSchema = z.object({
  email: z.string().email().nullable().optional(),
});

export async function notificationPrefRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/users/me/notification-preferences',
    { preHandler: humanAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user!.id;
      const prefs = prefRepo.getPreferences(userId, null);
      const user = userRepo.getUserById(userId);
      return { preferences: prefs, email: user?.email ?? null };
    }
  );

  fastify.put(
    '/users/me/notification-preferences',
    { preHandler: humanAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = preferencesSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
        return;
      }

      const userId = request.user!.id;
      const prefs = prefRepo.upsertPreferences(userId, null, parsed.data);
      return { preferences: prefs };
    }
  );

  fastify.put(
    '/users/me/email',
    { preHandler: humanAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = updateEmailSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
        return;
      }

      const userId = request.user!.id;
      userRepo.updateUserEmail(userId, parsed.data.email ?? '');
      return { success: true, email: parsed.data.email };
    }
  );

  fastify.get<{ Params: { boardId: string } }>(
    '/boards/:boardId/notification-preferences',
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { boardId: string } }>, reply: FastifyReply) => {
      const userId = request.user!.id;
      const prefs = prefRepo.getPreferences(userId, request.params.boardId);
      return { preferences: prefs };
    }
  );

  fastify.put<{ Params: { boardId: string } }>(
    '/boards/:boardId/notification-preferences',
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { boardId: string } }>, reply: FastifyReply) => {
      const parsed = preferencesSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
        return;
      }

      const userId = request.user!.id;
      const prefs = prefRepo.upsertPreferences(userId, request.params.boardId, parsed.data);
      return { preferences: prefs };
    }
  );
}
