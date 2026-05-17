import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as taskService from '../../services/tasks/index.js';
import {
  createTaskSchema,
  updateTaskSchema,
  cloneTaskSchema,
  batchTaskSchema,
} from '../../models/schemas.js';
import type {
  CreateTaskInput,
  UpdateTaskInput,
  CloneTaskInput,
  BatchTaskInput,
} from '../../models/schemas.js';
import { agentAuth, humanAuth, agentOrHumanAuth } from '../../middleware/auth.js';
import { editorAndAbove } from '../../middleware/rbac.js';
import { notFound, forbidden, conflict, badRequest } from '../../errors.js';

const taskParamsSchema = z.object({ id: z.string() });

export async function taskCrudRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/tasks/:id',
    { schema: { params: taskParamsSchema }, preHandler: [agentOrHumanAuth] },
    async (request, reply) => {
      const task = taskService.getTask(request.params.id);
      if (!task) {
        throw notFound('Task not found');
      }

      return { task };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().patch(
    '/tasks/:id',
    { schema: { params: taskParamsSchema, body: updateTaskSchema }, preHandler: [agentAuth] },
    async (request, reply) => {
      const parsed = request.body;
      const actorId = request.agent?.id ?? request.user?.id ?? 'anonymous';
      const result = taskService.updateTask(request.params.id, parsed, actorId);

      if (!result.success) {
        if (result.archived) {
          throw forbidden('Cannot modify a task in an archived mission');
        } else if (result.notFound) {
          throw notFound('Task not found');
        } else if (result.versionMismatch) {
          throw conflict('Version conflict', { currentVersion: result.currentVersion, yourVersion: parsed.version });
        }
        throw badRequest('Update failed');
      }
      return { task: result.task };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().delete(
    '/tasks/:id',
    { schema: { params: taskParamsSchema }, preHandler: [agentOrHumanAuth] },
    async (request, reply) => {
      const result = taskService.deleteTask(request.params.id);
      if (!result.success) {
        if (result.reason === 'archived') {
          throw forbidden('Cannot delete a task in an archived mission');
        } else if (result.reason === 'not_found') {
          throw notFound('Task not found');
        } else {
          throw badRequest('Cannot delete task', result);
        }
      }
      return { success: true };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/tasks/:id/clone',
    { schema: { params: taskParamsSchema, body: cloneTaskSchema }, preHandler: [humanAuth] },
    async (request, reply) => {
      const parsed = request.body;
      const clonedBy = request.user?.id ?? 'anonymous';
      const result = taskService.cloneTask(
        request.params.id,
        clonedBy,
        {
          includeSubtasks: parsed.includeSubtasks,
          includeComments: parsed.includeComments,
        }
      );

      if (result.success === false) {
        throw notFound('Task not found');
      }

      reply.code(201).send({ task: result.task });
    }
  );
}
