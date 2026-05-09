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

const taskParamsSchema = z.object({ id: z.string() });

export async function taskCrudRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/tasks/:id',
    { schema: { params: taskParamsSchema }, preHandler: [agentOrHumanAuth] },
    async (request, reply) => {
      const task = taskService.getTask(request.params.id);
      if (!task) {
        reply.code(404).send({ error: 'Task not found' });
        return;
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
          reply.code(403).send({ error: 'Cannot modify a task in an archived feature' });
        } else if (result.notFound) {
          reply.code(404).send({ error: 'Task not found' });
        } else if (result.versionMismatch) {
          reply.code(409)
            .header('Retry-After', '5')
            .header('X-Current-Version', String(result.currentVersion))
            .send({
              error: 'Version conflict',
              currentVersion: result.currentVersion,
              yourVersion: parsed.version,
            });
        }
        return;
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
          reply.code(403).send({ error: 'Cannot delete a task in an archived feature' });
        } else if (result.reason === 'not_found') {
          reply.code(404).send({ error: 'Task not found' });
        } else {
          reply.code(400).send({ error: 'Cannot delete task', details: result });
        }
        return;
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
        reply.code(404).send({ error: 'Task not found' });
        return;
      }

      reply.code(201).send({ task: result.task });
    }
  );
}
