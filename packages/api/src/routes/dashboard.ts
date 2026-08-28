import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDashboardStats } from '../repositories/event.js';
import { dashboardQuerySchema } from '../models/schemas.js';
import { badRequest } from '../errors.js';
import { applyDeclaredAuthPolicies } from "../authPolicy.js";

/**
 * Dashboard stats — throughput, cycle time, rejection rate, WIP health, and agent leaderboard.
 */
export async function dashboardRoutes(fastify: FastifyInstance): Promise<void> {
  applyDeclaredAuthPolicies(fastify);

  /** GET /dashboard - Get dashboard stats. Auth: humanAuth. Returns stats (tasks, agents, events) */
  fastify.get(
    '/dashboard',
    { config: { authPolicy: "human" } },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const parsed = dashboardQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw badRequest('Invalid query params', parsed.error.flatten());
      }

      const { habitatId, period } = parsed.data;
      const stats = getDashboardStats(habitatId, period);
      return stats;
    }
  );
}
