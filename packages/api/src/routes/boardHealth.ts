import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as habitatHealthService from '../services/boardHealthService.js';
import { requireHabitatAccess } from '../middleware/team.js';
import { z } from 'zod';
import { applyDeclaredAuthPolicies } from "../authPolicy.js";


const historyQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
});

export async function habitatHealthRoutes(fastify: FastifyInstance): Promise<void> {
  applyDeclaredAuthPolicies(fastify);

  fastify.get(
    '/habitats/:habitatId/health',
    { preHandler: [requireHabitatAccess], config: { authPolicy: "local_actor" } },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const params = request.params as { habitatId: string };
      const health = habitatHealthService.calculateHealth(params.habitatId);
      return health;
    }
  );

  fastify.get(
    '/habitats/:habitatId/health/history',
    { preHandler: [requireHabitatAccess], config: { authPolicy: "local_actor" } },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const params = request.params as { habitatId: string };
      const parsed = historyQuerySchema.safeParse(request.query);
      const days = parsed.success ? parsed.data.days : 30;

      const history = habitatHealthService.getHealthHistory(params.habitatId, days);
      return { snapshots: history };
    }
  );
}
