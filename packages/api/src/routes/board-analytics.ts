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

const boardIdParamsSchema = z.object({ id: z.string() });

export async function boardAnalyticsRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /boards/:id/stats - Get board statistics. Auth: agentOrHumanAuth + board access. Returns stats or 404 */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/boards/:id/stats',
    { schema: { params: boardIdParamsSchema }, preHandler: [agentOrHumanAuth, requireBoardAccess] },
    async (request, reply) => {
      const result = boardService.getBoard(request.params.id);
      if (!result) {
        throw notFound('Board not found');
      }
      const stats = boardService.getBoardStats(request.params.id);
      return stats;
    }
  );

  /** GET /boards/:id/summary - Get a temporal summary of board activity. Auth: agentOrHumanAuth + board access. Returns { board, snapshot, recentActivity, digest } */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/boards/:id/summary',
    { schema: { params: boardIdParamsSchema, querystring: z.object({ since: z.enum(['24h', '7d', '30d', 'all']).optional(), maxTasks: z.coerce.number().int().min(1).max(50).optional(), includeDigest: z.enum(['true', 'false']).optional() }) }, preHandler: [agentOrHumanAuth, requireBoardAccess] },
    async (request, reply) => {
      const query = request.query;
      const since = query.since ?? '7d';
      const maxFeatures = query.maxTasks ?? 20;
      const includeDigest = query.includeDigest !== 'false';

      const result = boardSummaryService.generateBoardSummary(request.params.id, {
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

  /** GET /boards/:id/events - Get board event history. Auth: agentOrHumanAuth + board access. Returns { events, total } */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/boards/:id/events',
    { schema: { params: boardIdParamsSchema, querystring: boardEventsQuerySchema }, preHandler: [agentOrHumanAuth, requireBoardAccess] },
    async (request, reply) => {
      const result = boardService.getBoard(request.params.id);
      if (!result) {
        throw notFound('Board not found');
      }
      const parsed = request.query;
      const { limit, offset, action, actorType, actorId, since } = parsed;
      const { events, total } = getEventsByBoardId(request.params.id, limit, offset, {
        action,
        actorType,
        actorId,
        since,
      });
      return { events, total };
    }
  );

  /** GET /boards/:id/capacity - Get agent capacity report for a board. Auth: agentOrHumanAuth + board access. Returns capacity report */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/boards/:id/capacity',
    { schema: { params: boardIdParamsSchema }, preHandler: [agentOrHumanAuth, requireBoardAccess] },
    async (request, reply) => {
      const result = boardService.getBoard(request.params.id);
      if (!result) {
        throw notFound('Board not found');
      }
      const report = capacityService.getCapacityReport(request.params.id);
      return report;
    }
  );

  /** GET /boards/:id/predictions - Get completion estimates and at-risk tasks. Auth: agentOrHumanAuth + board access. Returns { velocity, estimates, atRiskTasks } */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/boards/:id/predictions',
    { schema: { params: boardIdParamsSchema }, preHandler: [agentOrHumanAuth, requireBoardAccess] },
    async (request, reply) => {
      const result = boardService.getBoard(request.params.id);
      if (!result) {
        throw notFound('Board not found');
      }
      return predictionService.getPredictions(request.params.id);
    }
  );

  /** GET /boards/:id/burndown - Get burndown chart data. Auth: agentOrHumanAuth + board access. Query: ?days=30 */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/boards/:id/burndown',
    { schema: { params: boardIdParamsSchema, querystring: z.object({ days: z.coerce.number().int().min(7).max(90).optional() }) }, preHandler: [agentOrHumanAuth, requireBoardAccess] },
    async (request, reply) => {
      const result = boardService.getBoard(request.params.id);
      if (!result) {
        throw notFound('Board not found');
      }
      const days = request.query.days ?? 30;
      return predictionService.getBurndown(request.params.id, days);
    }
  );
}
