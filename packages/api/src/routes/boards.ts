import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as boardService from '../services/boardService.js';
import { createBoardSchema, updateBoardSchema, retryPolicySchema, autoAssignSettingsSchema } from '../models/schemas.js';
import type { CreateBoardInput, UpdateBoardInput } from '../models/schemas.js';
import type { RetryPolicy } from '../models/index.js';
import { agentOrHumanAuth, humanAuth, agentAuth } from '../middleware/auth.js';
import { adminOnly } from '../middleware/rbac.js';
import { requireBoardAccess } from '../middleware/team.js';
import { listTeamsByUserId } from '../repositories/team.js';
import { notFound } from '../errors.js';

const boardIdParamsSchema = z.object({ id: z.string() });

export async function boardRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/boards',
    { schema: { querystring: z.object({ name: z.string().optional() }) }, preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const query = request.query;
      let teamIds: string[] | undefined;
      if (request.user) {
        const teams = listTeamsByUserId(request.user.id);
        teamIds = teams.map(t => t.id);
      } else if (request.agent) {
        teamIds = undefined;
      }
      const boards = boardService.listBoards(query.name, teamIds);
      return { boards };
    }
  );

  /** POST /boards - Create a new board. Auth: humanAuth. Returns { board, columns } */
  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/boards',
    { schema: { body: createBoardSchema }, preHandler: humanAuth },
    async (request, reply) => {
      const { board, columns } = boardService.createBoard({
        ...request.body,
        defaultColumns: request.body.defaultColumns ?? true,
        teamId: request.body.teamId,
      });

      reply.code(201).send({ board, columns });
    }
  );

  /** POST /boards/agent - Create a board via agent. Auth: agentAuth. Returns { success, board, columns } */
  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/boards/agent',
    { schema: { body: createBoardSchema }, preHandler: agentAuth },
    async (request, reply) => {
      const { board, columns } = boardService.createBoard({
        ...request.body,
        defaultColumns: request.body.defaultColumns ?? true,
        teamId: request.body.teamId,
      });

      reply.code(201).send({ success: true, board, columns });
    }
  );

  /** GET /boards/:id - Get a board by ID. Auth: agentOrHumanAuth + board access. Returns board or 404 */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/boards/:id',
    { schema: { params: boardIdParamsSchema }, preHandler: [agentOrHumanAuth, requireBoardAccess] },
    async (request, reply) => {
      const result = boardService.getBoard(request.params.id);
      if (!result) {
        throw notFound('Board not found');
      }
      return result;
    }
  );

  /** PATCH /boards/:id - Update a board. Auth: humanAuth. Returns { board } or 404 */
  fastify.withTypeProvider<ZodTypeProvider>().patch(
    '/boards/:id',
    { schema: { params: boardIdParamsSchema, body: updateBoardSchema }, preHandler: humanAuth },
    async (request, reply) => {
      const board = boardService.updateBoard(request.params.id, request.body as Parameters<typeof boardService.updateBoard>[1]);
      if (!board) {
        throw notFound('Board not found');
      }
      return { board };
    }
  );

  /** DELETE /boards/:id - Delete a board. Auth: humanAuth + adminOnly. Returns 204 */
  fastify.withTypeProvider<ZodTypeProvider>().delete(
    '/boards/:id',
    { schema: { params: boardIdParamsSchema }, preHandler: [humanAuth, adminOnly] },
    async (request, reply) => {
      boardService.deleteBoard(request.params.id);
      reply.code(204).send();
    }
  );


}
