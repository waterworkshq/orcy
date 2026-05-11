import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as featureService from '../services/featureService.js';
import * as taskRepo from '../repositories/task.js';
import * as taskService from '../services/tasks/index.js';
import * as featureRepo from '../repositories/feature.js';
import * as featureEventRepo from '../repositories/events/event-feature.js';
import * as decompositionService from '../services/decompositionService.js';
import * as boardRepo from '../repositories/board.js';
import {
  createFeatureSchema,
  updateFeatureSchema,
  featureQuerySchema,
  moveFeatureSchema,
  createTaskInFeatureSchema,
} from '../models/schemas.js';
import { agentOrHumanAuth, agentAuth, humanAuth } from '../middleware/auth.js';
import { requireBoard } from './middleware/preHandlers.js';
import { badRequest, notFound, forbidden, conflict, internalError, AppError } from '../errors.js';

const featureParamsSchema = z.object({ boardId: z.string() });
const idParamsSchema = z.object({ id: z.string() });

export async function featureRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/boards/:boardId/features',
    { schema: { params: featureParamsSchema, body: createFeatureSchema }, preHandler: [agentOrHumanAuth, requireBoard()] },
    async (request, reply) => {
      const parsed = request.body;
      const actorId = request.agent?.id ?? request.user?.id ?? 'anonymous';

      const feature = featureService.createFeature({
        boardId: request.params.boardId,
        columnId: parsed.columnId,
        title: parsed.title,
        description: parsed.description,
        acceptanceCriteria: parsed.acceptanceCriteria,
        priority: parsed.priority,
        labels: parsed.labels,
        dependsOn: parsed.dependsOn,
        blocks: parsed.blocks,
        dueAt: parsed.dueAt,
        slaMinutes: parsed.slaMinutes,
        createdBy: actorId,
      });

      reply.code(201).send({ feature });
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/boards/:boardId/features',
    { schema: { params: featureParamsSchema, querystring: featureQuerySchema }, preHandler: [agentOrHumanAuth] },
    async (request, reply) => {
      const parsed = request.query;
      const board = boardRepo.getBoardById(request.params.boardId);
      if (!board) {
        throw notFound('Board not found');
      }

      const result = featureService.listFeatures(request.params.boardId, {
        status: parsed.status,
        priority: parsed.priority,
        isArchived: parsed.isArchived,
        limit: parsed.limit,
        offset: parsed.offset,
      });

      return { features: result.features, total: result.total };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/features/:id',
    { schema: { params: idParamsSchema }, preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const feature = featureService.getFeatureWithProgress(request.params.id);
      if (!feature) {
        throw notFound('Feature not found');
      }
      return { feature };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/features/:id/details',
    { schema: { params: idParamsSchema }, preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const feature = featureService.getFeatureWithProgress(request.params.id);
      if (!feature) {
        throw notFound('Feature not found');
      }

      const tasks = taskRepo.getTasksByFeatureId(request.params.id);
      const { events } = featureEventRepo.getFeatureEventsByFeatureId(request.params.id, 50);
      const dependencies = {
        dependsOn: feature.dependsOn,
        blocks: feature.blocks,
      };

      const byStatus: Record<string, number> = {};
      for (const t of tasks) {
        byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
      }
      const completed = tasks.filter(t => ['done', 'approved'].includes(t.status)).length;

      return {
        feature,
        tasks,
        events,
        progress: { completed, total: tasks.length, percentage: tasks.length > 0 ? Math.round((completed / tasks.length) * 100) : 0, byStatus },
        dependencies,
      };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().patch(
    '/features/:id',
    { schema: { params: idParamsSchema, body: updateFeatureSchema }, preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const parsed = request.body;
      const actorId = request.agent?.id ?? request.user?.id ?? 'anonymous';

      const feature = featureRepo.getFeatureById(request.params.id);
      if (feature?.isArchived) {
        throw forbidden('Cannot modify an archived feature');
      }

      const result = featureService.updateFeature(request.params.id, parsed, actorId);
      if (!result.success) {
        if (result.notFound) {
          throw notFound('Feature not found');
        } else if (result.versionMismatch) {
          reply.header('Retry-After', '5');
          reply.header('X-Current-Version', String(result.currentVersion));
          throw new AppError(409, 'VERSION_CONFLICT', 'Version conflict', {
            currentVersion: result.currentVersion,
            yourVersion: parsed.version,
          });
        } else if (result.archived) {
          throw forbidden('Cannot modify an archived feature');
        }
        throw internalError('Failed to update feature');
      }
      return { feature: result.feature };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/features/:id/archive',
    { schema: { params: idParamsSchema }, preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const actorId = request.agent?.id ?? request.user?.id ?? 'anonymous';
      const result = featureService.archiveFeature(request.params.id, actorId);
      if (!result.success) {
        if (result.reason === 'not_found') throw notFound('Feature not found');
        if (result.reason === 'not_done') throw badRequest('Only completed features can be archived');
        if (result.reason === 'already_archived') throw badRequest('Feature is already archived');
        throw internalError('Failed to archive feature');
      }
      return { feature: result.feature };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/features/:id/unarchive',
    { schema: { params: idParamsSchema }, preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const actorId = request.agent?.id ?? request.user?.id ?? 'anonymous';
      const result = featureService.unarchiveFeature(request.params.id, actorId);
      if (!result.success) {
        if (result.reason === 'not_found') throw notFound('Feature not found');
        if (result.reason === 'not_archived') throw badRequest('Feature is not archived');
        throw internalError('Failed to unarchive feature');
      }
      return { feature: result.feature };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().delete(
    '/features/:id',
    { schema: { params: idParamsSchema }, preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const result = featureService.deleteFeature(request.params.id);
      if (!result.success) {
        if (result.reason === 'not_found') {
          throw notFound('Feature not found');
        } else if (result.reason === 'has_dependents') {
          throw conflict('Feature has dependent features', { dependents: true });
        }
        throw internalError('Failed to delete feature');
      }
      reply.code(204).send();
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/features/:id/move',
    { schema: { params: idParamsSchema, body: moveFeatureSchema }, preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const parsed = request.body;
      const actorId = request.agent?.id ?? request.user?.id ?? 'anonymous';
      const actorType = request.agent ? 'agent' : 'human';

      const feature = featureService.moveFeatureToColumn(request.params.id, parsed.columnId, actorId, actorType);
      if (!feature) {
        throw notFound('Feature not found');
      }
      return { feature };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/features/:id/tasks',
    { schema: { params: idParamsSchema }, preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const feature = featureRepo.getFeatureById(request.params.id);
      if (!feature) {
        throw notFound('Feature not found');
      }

      const tasks = taskRepo.getTasksByFeatureId(request.params.id);
      return { tasks, total: tasks.length };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/features/:id/tasks',
    { schema: { params: idParamsSchema, body: createTaskInFeatureSchema }, preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const parsed = request.body;
      const feature = featureRepo.getFeatureById(request.params.id);
      if (!feature) {
        throw notFound('Feature not found');
      }
      if (feature.isArchived) {
        throw forbidden('Cannot add tasks to an archived feature');
      }

      const actorId = request.agent?.id ?? request.user?.id ?? 'anonymous';

      const task = taskService.createTask({
        featureId: feature.id,
        title: parsed.title,
        description: parsed.description,
        priority: parsed.priority,
        requiredDomain: parsed.requiredDomain,
        requiredCapabilities: parsed.requiredCapabilities,
        estimatedMinutes: parsed.estimatedMinutes,
        order: parsed.order,
        createdBy: actorId,
      });

      reply.code(201).send({ task });
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/features/:id/progress',
    { schema: { params: idParamsSchema }, preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const feature = featureRepo.getFeatureById(request.params.id);
      if (!feature) {
        throw notFound('Feature not found');
      }

      const tasks = taskRepo.getTasksByFeatureId(request.params.id);
      const byStatus: Record<string, number> = {};
      for (const t of tasks) {
        byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
      }
      const completed = tasks.filter(t => ['done', 'approved'].includes(t.status)).length;

      return {
        completed,
        total: tasks.length,
        percentage: tasks.length > 0 ? Math.round((completed / tasks.length) * 100) : 0,
        byStatus,
      };
    }
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/features/:id/decompose',
    { schema: { params: idParamsSchema }, preHandler: humanAuth },
    async (request, reply) => {
      const feature = featureRepo.getFeatureById(request.params.id);
      if (!feature) {
        throw notFound('Feature not found');
      }

      if (!feature.description || feature.description.trim().length === 0) {
        throw badRequest('Add a description before decomposing');
      }

      const result = await decompositionService.decomposeFeature(request.params.id);
      return result;
    }
  );
}
