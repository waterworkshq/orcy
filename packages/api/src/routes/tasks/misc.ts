import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as taskRepo from '../../repositories/task.js';
import * as taskService from '../../services/tasks/index.js';
import * as eventRepo from '../../repositories/event.js';
import * as decompositionService from '../../services/decompositionService.js';
import * as gitWorktreeService from '../../services/gitWorktreeService.js';
import { eventsQuerySchema } from '../../models/schemas.js';
import type { EventsQueryInput } from '../../models/schemas.js';
import { agentAuth, humanAuth, agentOrHumanAuth } from '../../middleware/auth.js';
import { notFound, badRequest, serviceUnavailable, internalError } from '../../errors.js';

const taskParamsSchema = z.object({ id: z.string() });

export async function taskMiscRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/tasks/:id/events',
    { schema: { params: taskParamsSchema, querystring: eventsQuerySchema }, preHandler: [agentOrHumanAuth] },
    async (request, reply) => {
      const parsed = request.query;
      const result = eventRepo.getEventsByTaskId(
        request.params.id,
        parsed.limit,
        parsed.offset
      );
      return result;
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/tasks/:id/decompose',
    { schema: { params: taskParamsSchema }, preHandler: humanAuth },
    async (request, reply) => {
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) {
        throw notFound('Task not found');
      }

      if (!task.description || task.description.trim().length === 0) {
        throw badRequest('Add a description before decomposing');
      }

      try {
        const result = await decompositionService.decomposeTask(request.params.id);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Decomposition failed';
        if (message.includes('not configured')) {
          throw serviceUnavailable(message);
        } else if (message.includes('not found')) {
          throw notFound(message);
        } else if (message.includes('description')) {
          throw badRequest(message);
        } else {
          throw internalError(message);
        }
      }
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/tasks/:id/worktree',
    { schema: { params: taskParamsSchema }, preHandler: agentAuth },
    async (request, reply) => {
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) {
        throw notFound('Task not found');
      }

      const habitatId = taskRepo.getHabitatIdForTask(task.id);
      const enabled = habitatId ? gitWorktreeService.isWorktreeEnabled(habitatId) : false;
      const worktree = gitWorktreeService.getWorktreeInfo(request.params.id);

      return { worktree, enabled };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/tasks/:id/details',
    { schema: { params: taskParamsSchema }, preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const userId = request.user?.id;
      const result = await taskService.getTaskDetails(request.params.id, userId);
      if (!result) {
        throw notFound('Task not found');
      }
      return result;
    }
  );
}
