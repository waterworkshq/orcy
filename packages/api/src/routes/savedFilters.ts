import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as savedFilterRepo from '../repositories/savedFilter.js';
import { agentOrHumanAuth } from '../middleware/auth.js';
import { badRequest, notFound, forbidden } from '../errors.js';
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
  fastify.get<{ Params: { habitatId: string } }>(
    '/habitats/:habitatId/saved-filters',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { habitatId: string } }>, _reply: FastifyReply) => {
      const userId = request.user?.id ?? request.agent?.id ?? 'anonymous';
      const filters = savedFilterRepo.getSavedFilters(request.params.habitatId, userId);
      return { savedFilters: filters };
    }
  );

  fastify.post<{ Params: { habitatId: string }; Body: { name: string; filterConfig: Record<string, unknown> } }>(
    '/habitats/:habitatId/saved-filters',
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const parsed = createSavedFilterSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Validation failed', parsed.error.flatten());
      }

      const userId = request.user?.id ?? request.agent?.id ?? 'anonymous';
      const savedFilter = savedFilterRepo.createSavedFilter(
        request.params.habitatId,
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
    async (request, _reply) => {
      const parsed = updateSavedFilterSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Validation failed', parsed.error.flatten());
      }

      const existing = savedFilterRepo.getSavedFilterById(request.params.id);
      if (!existing) {
        throw notFound('Saved filter not found');
      }

      if (existing.isBuiltin) {
        throw forbidden('Cannot modify built-in views');
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
        throw notFound('Saved filter not found');
      }

      if (existing.isBuiltin) {
        throw forbidden('Cannot delete built-in views');
      }

      savedFilterRepo.deleteSavedFilter(request.params.id);
      reply.code(204).send();
    }
  );
}
