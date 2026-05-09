import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as timeTrackingService from '../services/timeTrackingService.js';
import * as taskRepo from '../repositories/task.js';
import { agentOrHumanAuth } from '../middleware/auth.js';

export async function timeTrackingRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { id: string } }>(
    '/tasks/:id/time-report',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const report = timeTrackingService.getTaskTimeReport(request.params.id);
      if (!report) {
        reply.code(404).send({ error: 'Task not found' });
        return;
      }
      return report;
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/boards/:id/metrics',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      return timeTrackingService.getBoardMetrics(request.params.id);
    }
  );

  fastify.put<{ Params: { id: string }; Body: { estimatedMinutes: number } }>(
    '/tasks/:id/estimate',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string }; Body: { estimatedMinutes: number } }>, reply: FastifyReply) => {
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) {
        reply.code(404).send({ error: 'Task not found' });
        return;
      }

      const { estimatedMinutes } = request.body;
      if (typeof estimatedMinutes !== 'number' || estimatedMinutes < 0) {
        reply.code(400).send({ error: 'estimatedMinutes must be a non-negative number' });
        return;
      }

      const result = taskRepo.updateTask(request.params.id, { estimatedMinutes });
      if (!result.success) {
        reply.code(404).send({ error: 'Task not found' });
        return;
      }
      return { task: result.task };
    }
  );
}
