import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as habitatHealthService from '../services/boardHealthService.js';
import { agentOrHumanAuth } from '../middleware/auth.js';
import { requireHabitatAccess } from '../middleware/team.js';
import { z } from 'zod';
import { badRequest } from '../errors.js';

const historyQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
});

export async function habitatHealthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/habitats/:habitatId/health',
    { preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const params = request.params as { habitatId: string };
      const health = habitatHealthService.calculateHealth(params.habitatId);
      return health;
    }
  );

  fastify.get(
    '/habitats/:habitatId/health/history',
    { preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const params = request.params as { habitatId: string };
      const parsed = historyQuerySchema.safeParse(request.query);
      const days = parsed.success ? parsed.data.days : 30;

      const history = habitatHealthService.getHealthHistory(params.habitatId, days);
      return { snapshots: history };
    }
  );
}
