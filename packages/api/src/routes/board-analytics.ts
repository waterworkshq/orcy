import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as boardService from '../services/boardService.js';
import { boardEventsQuerySchema } from '../models/schemas.js';
import { agentOrHumanAuth } from '../middleware/auth.js';
import { requireBoardAccess } from '../middleware/team.js';
import { getEventsByBoardId } from '../repositories/event.js';
import * as capacityService from '../services/capacityService.js';
import * as predictionService from '../services/predictionService.js';
import * as boardSummaryService from '../services/boardSummaryService.js';
import { notFound } from '../errors.js';

const habitatIdParamsSchema = z.object({ habitatId: z.string() });

export async function boardAnalyticsRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /habitats/:habitatId/stats - Get board statistics. Auth: agentOrHumanAuth + board access. Returns stats or 404 */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/habitats/:habitatId/stats',
    { schema: { params: habitatIdParamsSchema }, preHandler: [agentOrHumanAuth, requireBoardAccess] },
    async (request, reply) => {
      const result = boardService.getBoard(request.params.habitatId);
      if (!result) {
        throw notFound('Board not found');
      }
      const stats = boardService.getBoardStats(request.params.habitatId);
      return stats;
    }
  );

  /** GET /habitats/:habitatId/summary - Get a temporal summary of board activity. Auth: agentOrHumanAuth + board access. Returns { board, snapshot, recentActivity, digest } */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/habitats/:habitatId/summary',
    { schema: { params: habitatIdParamsSchema, querystring: z.object({ since: z.enum(['24h', '7d', '30d', 'all']).optional(), maxTasks: z.coerce.number().int().min(1).max(50).optional(), includeDigest: z.enum(['true', 'false']).optional() }) }, preHandler: [agentOrHumanAuth, requireBoardAccess] },
    async (request, reply) => {
      const query = request.query;
      const since = query.since ?? '7d';
      const maxFeatures = query.maxTasks ?? 20;
      const includeDigest = query.includeDigest !== 'false';

      const result = boardSummaryService.generateBoardSummary(request.params.habitatId, {
        since,
        maxFeatures,
        includeDigest,
      });

      if (!result) {
        throw notFound('Board not found');
      }

      return result;
    }
  );

  /** GET /habitats/:habitatId/events - Get board event history. Auth: agentOrHumanAuth + board access. Returns { events, total } */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/habitats/:habitatId/events',
    { schema: { params: habitatIdParamsSchema, querystring: boardEventsQuerySchema }, preHandler: [agentOrHumanAuth, requireBoardAccess] },
    async (request, reply) => {
      const result = boardService.getBoard(request.params.habitatId);
      if (!result) {
        throw notFound('Board not found');
      }
      const parsed = request.query;
      const { limit, offset, action, actorType, actorId, since } = parsed;
      const { events, total } = getEventsByBoardId(request.params.habitatId, limit, offset, {
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
    { schema: { params: habitatIdParamsSchema }, preHandler: [agentOrHumanAuth, requireBoardAccess] },
    async (request, reply) => {
      const result = boardService.getBoard(request.params.habitatId);
      if (!result) {
        throw notFound('Board not found');
      }
      const report = capacityService.getCapacityReport(request.params.habitatId);
      return report;
    }
  );

  /** GET /habitats/:habitatId/predictions - Get completion estimates and at-risk tasks. Auth: agentOrHumanAuth + board access. Returns { velocity, estimates, atRiskTasks } */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/habitats/:habitatId/predictions',
    { schema: { params: habitatIdParamsSchema }, preHandler: [agentOrHumanAuth, requireBoardAccess] },
    async (request, reply) => {
      const result = boardService.getBoard(request.params.habitatId);
      if (!result) {
        throw notFound('Board not found');
      }
      return predictionService.getPredictions(request.params.habitatId);
    }
  );

  /** GET /habitats/:habitatId/burndown - Get burndown chart data. Auth: agentOrHumanAuth + board access. Query: ?days=30 */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/habitats/:habitatId/burndown',
    { schema: { params: habitatIdParamsSchema, querystring: z.object({ days: z.coerce.number().int().min(7).max(90).optional() }) }, preHandler: [agentOrHumanAuth, requireBoardAccess] },
    async (request, reply) => {
      const result = boardService.getBoard(request.params.habitatId);
      if (!result) {
        throw notFound('Board not found');
      }
      const days = request.query.days ?? 30;
      return predictionService.getBurndown(request.params.habitatId, days);
    }
  );
}
