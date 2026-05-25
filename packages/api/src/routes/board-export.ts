import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as habitatService from '../services/boardService.js';
import { exportQuerySchema, importHabitatSchema } from '../models/schemas.js';
import { agentOrHumanAuth, humanAuth } from '../middleware/auth.js';
import { requireHabitatAccess } from '../middleware/team.js';
import * as anomalyService from '../services/anomalyService.js';
import { redactSensitiveHeaders } from '../config/integrationSecurity.js';
import { notFound, badRequest } from '../errors.js';

const habitatIdParamsSchema = z.object({ habitatId: z.string() });

export async function habitatExportRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /habitats/:habitatId/export - Export board data. Auth: humanAuth. Returns filtered board export */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/habitats/:habitatId/export',
    { schema: { params: habitatIdParamsSchema, querystring: exportQuerySchema }, preHandler: humanAuth },
    async (request, _reply) => {
      const result = habitatService.exportHabitat(request.params.habitatId);
      if (!result) {
        throw notFound('Habitat not found');
      }

      const parsed = request.query;
      const include = parsed.include?.split(',') ?? ['columns', 'missions', 'comments', 'templates'];

      const webhooks = include.includes('webhooks')
        ? result.habitat.webhooks.map(w => {
            const { headers, url, ...rest } = w;
            return {
              ...rest,
              url: url.replace(/\/\/[^@]+@/, '//***@'),
              headers: redactSensitiveHeaders(headers),
            };
          })
        : [];

      const filtered = {
        version: result.version,
        exportedAt: result.exportedAt,
        habitat: {
          name: result.habitat.name,
          description: result.habitat.description,
          columns: include.includes('columns') ? result.habitat.columns : [],
          missions: include.includes('missions') ? result.habitat.missions : [],
          comments: include.includes('comments') ? result.habitat.comments : [],
          templates: include.includes('templates') ? result.habitat.templates : [],
          webhooks,
        },
      };

      return filtered;
    }
  );

  /** POST /boards/import - Import a new board. Auth: humanAuth. Returns { board, columns, imported, warnings } */
  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/habitats/import',
    { schema: { body: importHabitatSchema }, preHandler: humanAuth },
    async (request, reply) => {
      try {
        const result = habitatService.importHabitat(request.body as unknown as habitatService.HabitatExportData);
        if (!result) {
          throw badRequest('Import failed');
        }
        reply.code(201).send({ habitat: result.habitat, columns: result.columns, imported: result.imported, warnings: result.warnings });
      } catch (err) {
        throw badRequest((err as Error).message);
      }
    }
  );

  /** POST /habitats/:habitatId/import - Import into existing board. Auth: humanAuth. Returns { board, columns, imported, warnings } */
  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/habitats/:habitatId/import',
    { schema: { params: habitatIdParamsSchema, body: importHabitatSchema }, preHandler: humanAuth },
    async (request, reply) => {
      const habitatResult = habitatService.getHabitat(request.params.habitatId);
      if (!habitatResult) {
        throw notFound('Habitat not found');
      }

      try {
        const result = habitatService.importHabitat(request.body as unknown as habitatService.HabitatExportData, request.params.habitatId);
        if (!result) {
          throw badRequest('Import failed');
        }
        reply.code(201).send({ habitat: result.habitat, columns: result.columns, imported: result.imported, warnings: result.warnings });
      } catch (err) {
        throw badRequest((err as Error).message);
      }
    }
  );

  /** GET /habitats/:habitatId/anomalies - Detect and return current anomalies for a board. Auth: agentOrHumanAuth + board access. Returns { anomalies } */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/habitats/:habitatId/anomalies',
    { schema: { params: habitatIdParamsSchema }, preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const result = habitatService.getHabitat(request.params.habitatId);
      if (!result) {
        throw notFound('Habitat not found');
      }
      const anomalies = anomalyService.detectAnomalies(request.params.habitatId);
      return { anomalies };
    }
  );
}
