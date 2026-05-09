import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as dependencyService from '../services/dependencyService.js';
import * as taskRepo from '../repositories/task.js';
import { agentOrHumanAuth } from '../middleware/auth.js';

export async function dependencyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { id: string }; Body: { dependsOnTaskId: string } }>(
    '/tasks/:id/dependencies',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string }; Body: { dependsOnTaskId: string } }>, reply: FastifyReply) => {
      const { dependsOnTaskId } = request.body;
      if (!dependsOnTaskId) {
        reply.code(400).send({ error: 'dependsOnTaskId is required' });
        return;
      }

      const task = taskRepo.getTaskById(request.params.id);
      if (!task) {
        reply.code(404).send({ error: 'Task not found' });
        return;
      }

      const depTask = taskRepo.getTaskById(dependsOnTaskId);
      if (!depTask) {
        reply.code(404).send({ error: 'Dependency task not found' });
        return;
      }

      const result = dependencyService.addTaskDependency(request.params.id, dependsOnTaskId);
      if (!result.success) {
        reply.code(409).send({ error: result.reason });
        return;
      }

      return { success: true };
    }
  );

  fastify.delete<{ Params: { id: string; depId: string } }>(
    '/tasks/:id/dependencies/:depId',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string; depId: string } }>, reply: FastifyReply) => {
      const removed = dependencyService.removeTaskDependency(request.params.id, request.params.depId);
      if (!removed) {
        reply.code(404).send({ error: 'Dependency not found' });
        return;
      }
      return { success: true };
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/tasks/:id/dependencies',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) {
        reply.code(404).send({ error: 'Task not found' });
        return;
      }
      return dependencyService.getTaskDependencies(request.params.id);
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/tasks/:id/blocked-status',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) {
        reply.code(404).send({ error: 'Task not found' });
        return;
      }

      const deps = dependencyService.getTaskDependencies(request.params.id);
      const validation = dependencyService.validateTaskCompletion(request.params.id);

      return {
        taskId: request.params.id,
        isBlocked: !validation.canComplete,
        ...validation,
        blocking: deps.blocking,
      };
    }
  );

  fastify.post<{ Params: { id: string }; Body: { dependsOnFeatureId: string } }>(
    '/features/:id/dependencies',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string }; Body: { dependsOnFeatureId: string } }>, reply: FastifyReply) => {
      const { dependsOnFeatureId } = request.body;
      if (!dependsOnFeatureId) {
        reply.code(400).send({ error: 'dependsOnFeatureId is required' });
        return;
      }

      const result = dependencyService.addFeatureDependency(request.params.id, dependsOnFeatureId);
      if (!result.success) {
        reply.code(409).send({ error: result.reason });
        return;
      }
      return { success: true };
    }
  );

  fastify.delete<{ Params: { id: string; depId: string } }>(
    '/features/:id/dependencies/:depId',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string; depId: string } }>, reply: FastifyReply) => {
      const removed = dependencyService.removeFeatureDependency(request.params.id, request.params.depId);
      if (!removed) {
        reply.code(404).send({ error: 'Dependency not found' });
        return;
      }
      return { success: true };
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/features/:id/dependencies',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      return dependencyService.getFeatureDependencies(request.params.id);
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/features/:id/blocked-status',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      return dependencyService.validateFeatureCompletion(request.params.id);
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/features/:id/dependency-graph',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      return dependencyService.getDependencyGraph(request.params.id);
    }
  );
}
