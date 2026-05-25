import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as qualityGateService from '../services/qualityGateService.js';
import * as qualityRepo from '../repositories/qualityGate.js';
import * as taskRepo from '../repositories/task.js';
import { agentOrHumanAuth, humanAuth } from '../middleware/auth.js';
import { notFound, badRequest } from '../errors.js';

export async function qualityGateRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { id: string } }>(
    '/tasks/:id/quality-checklist',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) {
        throw notFound('Task not found');
      }
      return qualityGateService.getQualityReport(request.params.id);
    }
  );

  fastify.put<{ Params: { id: string; checklistId: string; itemId: string }; Body: { isCompleted?: boolean; evidenceUrl?: string; notes?: string } }>(
    '/tasks/:id/quality-checklist/:checklistId/items/:itemId',
    { preHandler: agentOrHumanAuth },
    async (request, _reply) => {
      const result = qualityGateService.updateChecklistItem(
        request.params.id,
        request.params.checklistId,
        request.params.itemId,
        request.body
      );
      if (!result) {
        throw notFound('Checklist item not found');
      }
      return result;
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/tasks/:id/quality-checklist/validate',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) {
        throw notFound('Task not found');
      }
      return qualityGateService.validateQualityGates(request.params.id);
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/tasks/:id/approval-status',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) {
        throw notFound('Task not found');
      }
      return qualityGateService.getApprovalStatus(request.params.id);
    }
  );

  fastify.get('/quality/templates', { preHandler: agentOrHumanAuth }, async () => {
    return { templates: qualityRepo.listTemplates() };
  });

  fastify.post<{ Body: { name: string; description?: string; category: string; isRequired?: boolean; items: { title: string; description?: string; required?: boolean }[] } }>(
    '/quality/templates',
    { preHandler: humanAuth },
    async (request, _reply) => {
      const { name, description, category, isRequired, items } = request.body;
      if (!name || !category || !items || items.length === 0) {
        throw badRequest('name, category, and items are required');
      }
      const template = qualityRepo.createTemplate({ name, description, category, isRequired, items });
      return { template };
    }
  );
}
