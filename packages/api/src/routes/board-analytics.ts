import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as habitatService from '../services/boardService.js';
import { habitatEventsQuerySchema } from '../models/schemas.js';
import { agentOrHumanAuth } from '../middleware/auth.js';
import { requireHabitatAccess } from '../middleware/team.js';
import { getEventsByHabitatId } from '../repositories/event.js';
import * as capacityService from '../services/capacityService.js';
import * as predictionService from '../services/predictionService.js';
import * as habitatSummaryService from '../services/boardSummaryService.js';
import { notFound } from '../errors.js';

const habitatIdParamsSchema = z.object({ habitatId: z.string() });

export async function habitatAnalyticsRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /habitats/:habitatId/stats - Get board statistics. Auth: agentOrHumanAuth + board access. Returns stats or 404 */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/habitats/:habitatId/stats',
    { schema: { params: habitatIdParamsSchema }, preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const result = habitatService.getHabitat(request.params.habitatId);
      if (!result) {
        throw notFound('Habitat not found');
      }
      const stats = habitatService.getHabitatStats(request.params.habitatId);
      return stats;
    }
  );

  /** GET /habitats/:habitatId/summary - Get a temporal summary of board activity. Auth: agentOrHumanAuth + board access. Returns { board, snapshot, recentActivity, digest } */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/habitats/:habitatId/summary',
    { schema: { params: habitatIdParamsSchema, querystring: z.object({ since: z.enum(['24h', '7d', '30d', 'all']).optional(), maxTasks: z.coerce.number().int().min(1).max(50).optional(), includeDigest: z.enum(['true', 'false']).optional() }) }, preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const query = request.query;
      const since = query.since ?? '7d';
      const maxMissions = query.maxTasks ?? 20;
      const includeDigest = query.includeDigest !== 'false';

      const result = habitatSummaryService.generateHabitatSummary(request.params.habitatId, {
        since,
        maxMissions,
        includeDigest,
      });

      if (!result) {
        throw notFound('Habitat not found');
      }

      return result;
    }
  );

  /** GET /habitats/:habitatId/events - Get board event history. Auth: agentOrHumanAuth + board access. Returns { events, total } */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/habitats/:habitatId/events',
    { schema: { params: habitatIdParamsSchema, querystring: habitatEventsQuerySchema }, preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const result = habitatService.getHabitat(request.params.habitatId);
      if (!result) {
        throw notFound('Habitat not found');
      }
      const parsed = request.query;
      const { limit, offset, action, actorType, actorId, since } = parsed;
      const { events, total } = getEventsByHabitatId(request.params.habitatId, limit, offset, {
        action,
        actorType,
        actorId,
        since,
      });
      return { events, total };
    }
  );

  /** GET /habitats/:habitatId/capacity - Get agent capacity report for a board. Auth: agentOrHumanAuth + board access. Returns capacity report */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/habitats/:habitatId/capacity',
    { schema: { params: habitatIdParamsSchema }, preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const result = habitatService.getHabitat(request.params.habitatId);
      if (!result) {
        throw notFound('Habitat not found');
      }
      const report = capacityService.getCapacityReport(request.params.habitatId);
      return report;
    }
  );

  /** GET /habitats/:habitatId/predictions - Get completion estimates and at-risk tasks. Auth: agentOrHumanAuth + board access. Returns { velocity, estimates, atRiskTasks } */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/habitats/:habitatId/predictions',
    { schema: { params: habitatIdParamsSchema }, preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const result = habitatService.getHabitat(request.params.habitatId);
      if (!result) {
        throw notFound('Habitat not found');
      }
      return predictionService.getPredictions(request.params.habitatId);
    }
  );

  /** GET /habitats/:habitatId/burndown - Get burndown chart data. Auth: agentOrHumanAuth + board access. Query: ?days=30 */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/habitats/:habitatId/burndown',
    { schema: { params: habitatIdParamsSchema, querystring: z.object({ days: z.coerce.number().int().min(7).max(90).optional() }) }, preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const result = habitatService.getHabitat(request.params.habitatId);
      if (!result) {
        throw notFound('Habitat not found');
      }
      const days = request.query.days ?? 30;
      return predictionService.getBurndown(request.params.habitatId, days);
    }
  );
}
