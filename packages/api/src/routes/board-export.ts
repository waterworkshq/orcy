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

const boardIdParamsSchema = z.object({ id: z.string() });

export async function boardExportRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /boards/:id/export - Export board data. Auth: humanAuth. Returns filtered board export */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/boards/:id/export',
    { schema: { params: boardIdParamsSchema, querystring: exportQuerySchema }, preHandler: humanAuth },
    async (request, reply) => {
      const result = boardService.exportBoard(request.params.id);
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

  /** POST /boards/:id/import - Import into existing board. Auth: humanAuth. Returns { board, columns, imported, warnings } */
  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/boards/:id/import',
    { schema: { params: boardIdParamsSchema, body: importBoardSchema }, preHandler: humanAuth },
    async (request, reply) => {
      const boardResult = boardService.getBoard(request.params.id);
      if (!boardResult) {
        throw notFound('Board not found');
      }

      try {
        const result = boardService.importBoard(request.body as unknown as boardService.BoardExportData, request.params.id);
        if (!result) {
          throw badRequest('Import failed');
        }
        reply.code(201).send({ board: result.board, columns: result.columns, imported: result.imported, warnings: result.warnings });
      } catch (err) {
        throw badRequest((err as Error).message);
      }
    }
  );

  /** GET /boards/:id/anomalies - Detect and return current anomalies for a board. Auth: agentOrHumanAuth + board access. Returns { anomalies } */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/boards/:id/anomalies',
    { schema: { params: boardIdParamsSchema }, preHandler: [agentOrHumanAuth, requireBoardAccess] },
    async (request, reply) => {
      const result = boardService.getBoard(request.params.id);
      if (!result) {
        throw notFound('Board not found');
      }
      const anomalies = anomalyService.detectAnomalies(request.params.id);
      return { anomalies };
    }
  );
}
