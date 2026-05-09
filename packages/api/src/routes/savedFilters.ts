import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as savedFilterRepo from '../repositories/savedFilter.js';
import { agentOrHumanAuth } from '../middleware/auth.js';
import { z } from 'zod';

const createSavedFilterSchema = z.object({
  name: z.string().min(1).max(100),
  filterConfig: z.record(z.unknown()),
});

const updateSavedFilterSchema = z.object({
  name: z.string().min(1).max(100),
  filterConfig: z.record(z.unknown()),
});

export async function savedFilterRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { boardId: string } }>(
    '/boards/:boardId/saved-filters',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { boardId: string } }>, reply: FastifyReply) => {
      const userId = request.user?.id ?? request.agent?.id ?? 'anonymous';
      const filters = savedFilterRepo.getSavedFilters(request.params.boardId, userId);
      return { savedFilters: filters };
    }
  );

  fastify.post<{ Params: { boardId: string }; Body: { name: string; filterConfig: Record<string, unknown> } }>(
    '/boards/:boardId/saved-filters',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { boardId: string }; Body: { name: string; filterConfig: Record<string, unknown> } }>, reply: FastifyReply) => {
      const parsed = createSavedFilterSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
        return;
      }

      const userId = request.user?.id ?? request.agent?.id ?? 'anonymous';
      const savedFilter = savedFilterRepo.createSavedFilter(
        request.params.boardId,
        userId,
        parsed.data.name,
        parsed.data.filterConfig
      );

      reply.code(201).send({ savedFilter });
    }
  );

  fastify.put<{ Params: { id: string }; Body: { name: string; filterConfig: Record<string, unknown> } }>(
    '/saved-filters/:id',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string }; Body: { name: string; filterConfig: Record<string, unknown> } }>, reply: FastifyReply) => {
      const parsed = updateSavedFilterSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
        return;
      }

      const existing = savedFilterRepo.getSavedFilterById(request.params.id);
      if (!existing) {
        reply.code(404).send({ error: 'Saved filter not found' });
        return;
      }

      if (existing.isBuiltin) {
        reply.code(403).send({ error: 'Cannot modify built-in views' });
        return;
      }

      const savedFilter = savedFilterRepo.updateSavedFilter(request.params.id, parsed.data.name, parsed.data.filterConfig);
      return { savedFilter };
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/saved-filters/:id',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const existing = savedFilterRepo.getSavedFilterById(request.params.id);
      if (!existing) {
        reply.code(404).send({ error: 'Saved filter not found' });
        return;
      }

      if (existing.isBuiltin) {
        reply.code(403).send({ error: 'Cannot delete built-in views' });
        return;
      }

      savedFilterRepo.deleteSavedFilter(request.params.id);
      reply.code(204).send();
    }
  );
}
