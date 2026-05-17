import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as timeTrackingService from '../services/timeTrackingService.js';
import * as taskRepo from '../repositories/task.js';
import { agentOrHumanAuth } from '../middleware/auth.js';
import { badRequest, notFound } from '../errors.js';

export async function timeTrackingRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { id: string } }>(
    '/tasks/:id/time-report',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const report = timeTrackingService.getTaskTimeReport(request.params.id);
      if (!report) {
        throw notFound('Task not found');
      }
      return report;
    }
  );

  fastify.get<{ Params: { habitatId: string } }>(
    '/habitats/:habitatId/metrics',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { habitatId: string } }>, reply: FastifyReply) => {
      return timeTrackingService.getHabitatMetrics(request.params.habitatId);
    }
  );

  fastify.put<{ Params: { id: string }; Body: { estimatedMinutes: number } }>(
    '/tasks/:id/estimate',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string }; Body: { estimatedMinutes: number } }>, reply: FastifyReply) => {
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) {
        throw notFound('Task not found');
      }

      const { estimatedMinutes } = request.body;
      if (typeof estimatedMinutes !== 'number' || estimatedMinutes < 0) {
        throw badRequest('estimatedMinutes must be a non-negative number');
      }

      const result = taskRepo.updateTask(request.params.id, { estimatedMinutes });
      if (!result.success) {
        throw notFound('Task not found');
      }
      return { task: result.task };
    }
  );
}
