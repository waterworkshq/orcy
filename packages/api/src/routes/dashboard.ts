import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDashboardStats } from '../repositories/event.js';
import { dashboardQuerySchema } from '../models/schemas.js';
import { humanAuth } from '../middleware/auth.js';
import { badRequest } from '../errors.js';

/**
 * Dashboard stats — throughput, cycle time, rejection rate, WIP health, and agent leaderboard.
 */
export async function dashboardRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /dashboard - Get dashboard stats. Auth: humanAuth. Returns stats (tasks, agents, events) */
  fastify.get(
    '/dashboard',
    { preHandler: humanAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = dashboardQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw badRequest('Invalid query params', parsed.error.flatten());
      }

      const { boardId, period } = parsed.data;
      const stats = getDashboardStats(boardId, period);
      return stats;
    }
  );
}
