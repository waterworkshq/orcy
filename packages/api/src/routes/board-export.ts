import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as boardService from '../services/boardService.js';
import { exportQuerySchema, importBoardSchema } from '../models/schemas.js';
import { agentOrHumanAuth, humanAuth } from '../middleware/auth.js';
import { requireBoardAccess } from '../middleware/team.js';
import * as anomalyService from '../services/anomalyService.js';
import { redactSensitiveHeaders } from '../config/integrationSecurity.js';
import { notFound, badRequest } from '../errors.js';

const habitatIdParamsSchema = z.object({ habitatId: z.string() });

export async function boardExportRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /habitats/:habitatId/export - Export board data. Auth: humanAuth. Returns filtered board export */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/habitats/:habitatId/export',
    { schema: { params: habitatIdParamsSchema, querystring: exportQuerySchema }, preHandler: humanAuth },
    async (request, reply) => {
      const result = boardService.exportBoard(request.params.habitatId);
      if (!result) {
        throw notFound('Board not found');
      }

      const parsed = request.query;
      const include = parsed.include?.split(',') ?? ['columns', 'features', 'comments', 'templates'];

      const webhooks = include.includes('webhooks')
        ? result.board.webhooks.map(w => {
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
        board: {
          name: result.board.name,
          description: result.board.description,
          columns: include.includes('columns') ? result.board.columns : [],
          features: include.includes('features') ? result.board.features : [],
          comments: include.includes('comments') ? result.board.comments : [],
          templates: include.includes('templates') ? result.board.templates : [],
          webhooks,
        },
      };

      return filtered;
    }
  );

  /** POST /boards/import - Import a new board. Auth: humanAuth. Returns { board, columns, imported, warnings } */
  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/boards/import',
    { schema: { body: importBoardSchema }, preHandler: humanAuth },
    async (request, reply) => {
      try {
        const result = boardService.importBoard(request.body as unknown as boardService.BoardExportData);
        if (!result) {
          throw badRequest('Import failed');
        }
        reply.code(201).send({ board: result.board, columns: result.columns, imported: result.imported, warnings: result.warnings });
      } catch (err) {
        throw badRequest((err as Error).message);
      }
    }
  );

  /** POST /habitats/:habitatId/import - Import into existing board. Auth: humanAuth. Returns { board, columns, imported, warnings } */
  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/habitats/:habitatId/import',
    { schema: { params: habitatIdParamsSchema, body: importBoardSchema }, preHandler: humanAuth },
    async (request, reply) => {
      const boardResult = boardService.getBoard(request.params.habitatId);
      if (!boardResult) {
        throw notFound('Board not found');
      }

      try {
        const result = boardService.importBoard(request.body as unknown as boardService.BoardExportData, request.params.habitatId);
        if (!result) {
          throw badRequest('Import failed');
        }
        reply.code(201).send({ board: result.board, columns: result.columns, imported: result.imported, warnings: result.warnings });
      } catch (err) {
        throw badRequest((err as Error).message);
      }
    }
  );

  /** GET /habitats/:habitatId/anomalies - Detect and return current anomalies for a board. Auth: agentOrHumanAuth + board access. Returns { anomalies } */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/habitats/:habitatId/anomalies',
    { schema: { params: habitatIdParamsSchema }, preHandler: [agentOrHumanAuth, requireBoardAccess] },
    async (request, reply) => {
      const result = boardService.getBoard(request.params.habitatId);
      if (!result) {
        throw notFound('Board not found');
      }
      const anomalies = anomalyService.detectAnomalies(request.params.habitatId);
      return { anomalies };
    }
  );
}
