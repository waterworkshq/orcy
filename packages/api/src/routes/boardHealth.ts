import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as boardHealthService from '../services/boardHealthService.js';
import { agentOrHumanAuth } from '../middleware/auth.js';
import { requireBoardAccess } from '../middleware/team.js';
import { z } from 'zod';
import { badRequest } from '../errors.js';

const historyQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
});

export async function boardHealthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/boards/:id/health',
    { preHandler: [agentOrHumanAuth, requireBoardAccess] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { id: string };
      const health = boardHealthService.calculateHealth(params.id);
      return health;
    }
  );

  fastify.get(
    '/boards/:id/health/history',
    { preHandler: [agentOrHumanAuth, requireBoardAccess] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { id: string };
      const parsed = historyQuerySchema.safeParse(request.query);
      const days = parsed.success ? parsed.data.days : 30;

      const history = boardHealthService.getHealthHistory(params.id, days);
      return { snapshots: history };
    }
  );
}
