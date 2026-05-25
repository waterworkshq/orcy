import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as subtaskService from '../services/subtaskService.js';
import { agentAuth } from '../middleware/auth.js';
import { badRequest, notFound } from '../errors.js';

/**
 * Subtask CRUD — create, list, update, and delete subtasks attached to a task.
 */
export async function subtaskRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /tasks/:taskId/subtasks - List subtasks for a task. Auth: agentAuth. Returns subtask array */
  fastify.get<{ Params: { taskId: string } }>(
    '/tasks/:taskId/subtasks',
    { preHandler: agentAuth },
    async (request: FastifyRequest<{ Params: { taskId: string } }>, _reply: FastifyReply) => {
      return subtaskService.getSubtasks(request.params.taskId);
    }
  );

  /** POST /tasks/:taskId/subtasks - Create a subtask. Auth: agentAuth. Returns { subtask } or 404 */
  fastify.post<{ Params: { taskId: string }; Body: { title: string; order?: number; assigneeId?: string } }>(
    '/tasks/:taskId/subtasks',
    { preHandler: agentAuth },
    async (request: FastifyRequest<{ Params: { taskId: string }; Body: { title: string; order?: number; assigneeId?: string } }>, reply: FastifyReply) => {
      const parsed = request.body;
      if (!parsed.title || parsed.title.trim().length === 0) {
        throw badRequest('Title is required');
      }

      const subtask = subtaskService.createSubtask(request.params.taskId, {
        title: parsed.title.trim(),
        order: parsed.order,
        assigneeId: parsed.assigneeId,
      });

      if (!subtask) {
        throw notFound('Task not found');
      }

      reply.code(201).send({ subtask });
    }
  );

  /** PATCH /tasks/:taskId/subtasks/:subtaskId - Update a subtask. Auth: agentAuth. Returns { subtask } or 404 */
  fastify.patch<{ Params: { taskId: string; subtaskId: string }; Body: { title?: string; completed?: boolean; order?: number; assigneeId?: string | null } }>(
    '/tasks/:taskId/subtasks/:subtaskId',
    { preHandler: agentAuth },
    async (request, _reply) => {
      const subtask = subtaskService.updateSubtask(request.params.subtaskId, request.body);

      if (!subtask) {
        throw notFound('Subtask not found');
      }

      return { subtask };
    }
  );

  /** DELETE /tasks/:taskId/subtasks/:subtaskId - Delete a subtask. Auth: agentAuth. Returns 204 or 404 */
  fastify.delete<{ Params: { taskId: string; subtaskId: string } }>(
    '/tasks/:taskId/subtasks/:subtaskId',
    { preHandler: agentAuth },
    async (request: FastifyRequest<{ Params: { taskId: string; subtaskId: string } }>, reply: FastifyReply) => {
      const success = subtaskService.deleteSubtask(request.params.subtaskId);

      if (!success) {
        throw notFound('Subtask not found');
      }

      reply.code(204).send();
    }
  );
}
