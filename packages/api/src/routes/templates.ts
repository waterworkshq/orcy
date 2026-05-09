import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as templateRepo from '../repositories/template.js';
import { humanAuth, agentOrHumanAuth } from '../middleware/auth.js';
import { adminOnly } from '../middleware/rbac.js';
import { z } from 'zod';

const createTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  titlePattern: z.string().min(1).max(200),
  descriptionPattern: z.string().max(5000).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  labels: z.array(z.string()).optional(),
  requiredDomain: z.string().nullable().optional(),
  requiredCapabilities: z.array(z.string()).optional(),
});

const updateTemplateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  titlePattern: z.string().min(1).max(200).optional(),
  descriptionPattern: z.string().max(5000).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  labels: z.array(z.string()).optional(),
  requiredDomain: z.string().nullable().optional(),
  requiredCapabilities: z.array(z.string()).optional(),
});

/**
 * Task template management — create, list, update, delete, and track usage.
 */
export async function templateRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /boards/:boardId/templates - List templates for a board. Auth: agentOrHumanAuth. Returns { templates } */
  fastify.get<{ Params: { boardId: string } }>(
    '/boards/:boardId/templates',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { boardId: string } }>, reply: FastifyReply) => {
      const templates = templateRepo.getTemplatesByBoardId(request.params.boardId);
      return { templates };
    }
  );

  /** POST /boards/:boardId/templates - Create a template. Auth: humanAuth. Returns { template } */
  fastify.post<{ Params: { boardId: string }; Body: z.infer<typeof createTemplateSchema> }>(
    '/boards/:boardId/templates',
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { boardId: string }; Body: z.infer<typeof createTemplateSchema> }>, reply: FastifyReply) => {
      const parsed = createTemplateSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
        return;
      }

      const userId = request.user?.id ?? 'anonymous';

      const template = templateRepo.createTemplate({
        boardId: request.params.boardId,
        name: parsed.data.name,
        titlePattern: parsed.data.titlePattern,
        descriptionPattern: parsed.data.descriptionPattern,
        priority: parsed.data.priority,
        labels: parsed.data.labels,
        requiredDomain: parsed.data.requiredDomain,
        requiredCapabilities: parsed.data.requiredCapabilities,
        createdBy: userId,
      });

      reply.code(201).send({ template });
    }
  );

  /** PATCH /templates/:id - Update a template. Auth: humanAuth. Returns { template } or 404 */
  fastify.patch<{ Params: { id: string }; Body: z.infer<typeof updateTemplateSchema> }>(
    '/templates/:id',
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { id: string }; Body: z.infer<typeof updateTemplateSchema> }>, reply: FastifyReply) => {
      const parsed = updateTemplateSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
        return;
      }

      const template = templateRepo.updateTemplate(request.params.id, {
        name: parsed.data.name,
        titlePattern: parsed.data.titlePattern,
        descriptionPattern: parsed.data.descriptionPattern,
        priority: parsed.data.priority,
        labels: parsed.data.labels,
        requiredDomain: parsed.data.requiredDomain,
        requiredCapabilities: parsed.data.requiredCapabilities,
      });

      if (!template) {
        reply.code(404).send({ error: 'Template not found' });
        return;
      }

      return { template };
    }
  );

  /** DELETE /templates/:id - Delete a template. Auth: humanAuth + adminOnly. Returns 204 or 404/403 */
  fastify.delete<{ Params: { id: string } }>(
    '/templates/:id',
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const template = templateRepo.getTemplateById(request.params.id);
      if (!template) {
        reply.code(404).send({ error: 'Template not found' });
        return;
      }

      if (template.isDefault) {
        reply.code(403).send({ error: 'Cannot delete default template' });
        return;
      }

      const deleted = templateRepo.deleteTemplate(request.params.id);
      if (!deleted) {
        reply.code(404).send({ error: 'Template not found' });
        return;
      }

      reply.code(204).send();
    }
  );

  /** POST /templates/:id/usage - Increment template usage count. Auth: agentOrHumanAuth. Returns { success: true } */
  fastify.post<{ Params: { id: string } }>(
    '/templates/:id/usage',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const template = templateRepo.getTemplateById(request.params.id);
      if (!template) {
        reply.code(404).send({ error: 'Template not found' });
        return;
      }

      templateRepo.incrementUsageCount(request.params.id);
      return { success: true };
    }
  );
}
