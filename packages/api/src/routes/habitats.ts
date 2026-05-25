import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import * as habitatService from '../services/boardService.js';
import { createHabitatSchema, updateHabitatSchema } from '../models/schemas.js';
import { agentOrHumanAuth, humanAuth, agentAuth } from '../middleware/auth.js';
import { adminOnly } from '../middleware/rbac.js';
import { requireHabitatAccess } from '../middleware/team.js';
import { listTeamsByUserId } from '../repositories/team.js';
import { notFound } from '../errors.js';

const habitatIdParamsSchema = z.object({ habitatId: z.string() });

export async function habitatRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/habitats',
    { schema: { querystring: z.object({ name: z.string().optional() }) }, preHandler: agentOrHumanAuth },
    async (request, _reply) => {
      const query = request.query;
      let teamIds: string[] | undefined;
      if (request.user) {
        const teams = listTeamsByUserId(request.user.id);
        teamIds = teams.map(t => t.id);
      } else if (request.agent) {
        teamIds = undefined;
      }
      const habitats = habitatService.listHabitats(query.name, teamIds);
      return { habitats };
    }
  );

  /** POST /habitats - Create a new board. Auth: humanAuth. Returns { board, columns } */
  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/habitats',
    { schema: { body: createHabitatSchema }, preHandler: humanAuth },
    async (request, reply) => {
      const { habitat, columns } = habitatService.createHabitat({
        ...request.body,
        defaultColumns: request.body.defaultColumns ?? true,
        teamId: request.body.teamId,
      });

      reply.code(201).send({ habitat, columns });
    }
  );

  /** POST /habitats/agent - Create a board via agent. Auth: agentAuth. Returns { success, board, columns } */
  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/habitats/agent',
    { schema: { body: createHabitatSchema }, preHandler: agentAuth },
    async (request, reply) => {
      const { habitat, columns } = habitatService.createHabitat({
        ...request.body,
        defaultColumns: request.body.defaultColumns ?? true,
        teamId: request.body.teamId,
      });

      reply.code(201).send({ success: true, habitat, columns });
    }
  );

  /** GET /habitats/:habitatId - Get a board by ID. Auth: agentOrHumanAuth + board access. Returns board or 404 */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/habitats/:habitatId',
    { schema: { params: habitatIdParamsSchema }, preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const result = habitatService.getHabitat(request.params.habitatId);
      if (!result) {
        throw notFound('Habitat not found');
      }
      return result;
    }
  );

  /** PATCH /habitats/:habitatId - Update a board. Auth: humanAuth. Returns { board } or 404 */
  fastify.withTypeProvider<ZodTypeProvider>().patch(
    '/habitats/:habitatId',
    { schema: { params: habitatIdParamsSchema, body: updateHabitatSchema }, preHandler: humanAuth },
    async (request, _reply) => {
      const habitat = habitatService.updateHabitat(request.params.habitatId, request.body as Parameters<typeof habitatService.updateHabitat>[1]);
      if (!habitat) {
        throw notFound('Habitat not found');
      }
      return { habitat };
    }
  );

  /** DELETE /habitats/:habitatId - Delete a board. Auth: humanAuth + adminOnly. Returns 204 */
  fastify.withTypeProvider<ZodTypeProvider>().delete(
    '/habitats/:habitatId',
    { schema: { params: habitatIdParamsSchema }, preHandler: [humanAuth, adminOnly] },
    async (request, reply) => {
      habitatService.deleteHabitat(request.params.habitatId);
      reply.code(204).send();
    }
  );


}
