import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as auditExportService from '../services/auditExportService.js';
import { humanAuth } from '../middleware/auth.js';
import { notFound, badRequest } from '../errors.js';
import { z } from 'zod';

const exportQuerySchema = z.object({
  format: z.enum(['csv', 'json', 'jsonl']),
  since: z.string().optional(),
  until: z.string().optional(),
  actions: z.string().optional(),
  actorType: z.string().optional(),
  actorId: z.string().optional(),
  entityTypes: z.string().optional(),
  includeMetadata: z.string().optional(),
});

const summaryQuerySchema = z.object({
  since: z.string().optional(),
  until: z.string().optional(),
});

const scheduleBodySchema = z.object({
  name: z.string().min(1),
  format: z.enum(['csv', 'json', 'jsonl']),
  filters: z.record(z.unknown()).optional(),
  schedule: z.string().min(1),
});

export async function auditExportRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { id: string }; Querystring: z.infer<typeof exportQuerySchema> }>(
    '/boards/:id/audit/export',
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { id: string }; Querystring: z.infer<typeof exportQuerySchema> }>, reply: FastifyReply) => {
      const parsed = exportQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw badRequest('Invalid query', parsed.error.flatten());
      }

      await auditExportService.streamAuditExport(request.params.id, parsed.data, reply);
    }
  );

  fastify.get<{ Params: { id: string }; Querystring: z.infer<typeof summaryQuerySchema> }>(
    '/boards/:id/audit/summary',
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { id: string }; Querystring: z.infer<typeof summaryQuerySchema> }>, reply: FastifyReply) => {
      const parsed = summaryQuerySchema.safeParse(request.query);
      const { since, until } = parsed.success ? parsed.data : {};

      const summary = auditExportService.getAuditSummary(request.params.id, since, until);
      return summary;
    }
  );

  fastify.post<{ Params: { id: string }; Body: z.infer<typeof scheduleBodySchema> }>(
    '/boards/:id/audit/schedule',
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { id: string }; Body: z.infer<typeof scheduleBodySchema> }>, reply: FastifyReply) => {
      const parsed = scheduleBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Invalid body', parsed.error.flatten());
      }

      const schedule = auditExportService.createSchedule(request.params.id, parsed.data);
      reply.code(201).send({ schedule });
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/boards/:id/audit/schedules',
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const schedules = auditExportService.listSchedules(request.params.id);
      return { schedules };
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/audit/schedules/:id',
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      auditExportService.deleteSchedule(request.params.id);
      reply.code(204).send();
    }
  );
}
