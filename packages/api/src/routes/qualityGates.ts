import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as qualityGateService from '../services/qualityGateService.js';
import * as qualityRepo from '../repositories/qualityGate.js';
import { notFound, badRequest } from '../errors.js';
import { z } from 'zod';
import { applyDeclaredAuthPolicies } from "../authPolicy.js";
import { authorizeTaskAccess } from "../middleware/realtimeAuth.js";

/**
 * Route-local PUT body contract. Unknown fields are stripped (zod default).
 * `completedBy` is caller-supplied metadata, never an author/reviewer
 * authority. At least one effective mapper field must be present — tested
 * with `!== undefined`, so `isCompleted: false` and `evidenceUrl: null` are
 * legitimate effective inputs.
 */
const updateChecklistItemSchema = z
  .object({
    isCompleted: z.boolean().optional(),
    completedBy: z.string().nullable().optional(),
    evidenceUrl: z.string().nullable().optional(),
    notes: z.string().optional(),
  })
  .refine(
    (data) =>
      data.isCompleted !== undefined ||
      data.evidenceUrl !== undefined ||
      data.notes !== undefined,
    { message: "At least one of isCompleted, evidenceUrl, or notes is required" },
  );

export async function qualityGateRoutes(fastify: FastifyInstance): Promise<void> {
  applyDeclaredAuthPolicies(fastify);

  fastify.get<{ Params: { id: string } }>(
    '/tasks/:id/quality-checklist',
    { config: { authPolicy: 'local_actor' } },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      await authorizeTaskAccess(request, request.params.id);
      return qualityGateService.getQualityReport(request.params.id);
    }
  );

  fastify.put<{ Params: { id: string; checklistId: string; itemId: string }; Body: z.infer<typeof updateChecklistItemSchema> }>(
    '/tasks/:id/quality-checklist/:checklistId/items/:itemId',
    { config: { authPolicy: 'local_actor' } },
    async (request, _reply) => {
      const parsed = updateChecklistItemSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      await authorizeTaskAccess(request, request.params.id);

      const result = qualityGateService.updateChecklistItem(
        request.params.id,
        request.params.checklistId,
        request.params.itemId,
        parsed.data
      );
      if (!result) {
        throw notFound('Checklist item not found');
      }
      return result;
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/tasks/:id/quality-checklist/validate',
    { config: { authPolicy: 'local_actor' } },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      await authorizeTaskAccess(request, request.params.id);
      return qualityGateService.validateQualityGates(request.params.id);
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/tasks/:id/approval-status',
    { config: { authPolicy: 'local_actor' } },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      await authorizeTaskAccess(request, request.params.id);
      return qualityGateService.getApprovalStatus(request.params.id);
    }
  );

  fastify.get('/quality/templates', { config: { authPolicy: 'local_actor' } }, async () => {
    return { templates: qualityRepo.listTemplates() };
  });

  fastify.post<{ Body: { name: string; description?: string; category: string; isRequired?: boolean; items: { title: string; description?: string; required?: boolean }[] } }>(
    '/quality/templates',
    { config: { authPolicy: 'human' } },
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
