import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as columnRepo from '../repositories/column.js';
import { createColumnSchema, updateColumnSchema } from '../models/schemas.js';
import type { CreateColumnInput, UpdateColumnInput } from '../models/schemas.js';
import * as habitatRepo from '../repositories/board.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import { humanAuth } from '../middleware/auth.js';
import { adminOnly } from '../middleware/rbac.js';
import { notFound, badRequest, conflict } from '../errors.js';

export async function columnRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { habitatId: string }; Body: CreateColumnInput }>(
    '/habitats/:habitatId/columns',
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { habitatId: string }; Body: CreateColumnInput }>, reply: FastifyReply) => {
      const habitat = habitatRepo.getHabitatById(request.params.habitatId);
      if (!habitat) {
        throw notFound('Habitat not found');
      }

      const parsed = createColumnSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Validation failed', parsed.error.flatten());
      }

      const column = columnRepo.createColumn({
        ...parsed.data,
        habitatId: request.params.habitatId,
      });

      sseBroadcaster.publish(request.params.habitatId, { type: 'column.created', data: column });
      reply.code(201).send({ column });
    }
  );

  fastify.patch<{ Params: { id: string }; Body: UpdateColumnInput }>(
    '/columns/:id',
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { id: string }; Body: UpdateColumnInput }>, _reply: FastifyReply) => {
      const parsed = updateColumnSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Validation failed', parsed.error.flatten());
      }

      const column = columnRepo.updateColumn(request.params.id, parsed.data);
      if (!column) {
        throw notFound('Column not found');
      }
      sseBroadcaster.publish(column.habitatId, { type: 'column.updated', data: column });
      return { column };
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/columns/:id',
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const column = columnRepo.getColumnById(request.params.id);
      if (!column) {
        throw notFound('Column not found');
      }

      try {
        columnRepo.deleteColumn(request.params.id);
      } catch (err) {
        throw conflict((err as Error).message);
      }

      sseBroadcaster.publish(column.habitatId, {
        type: 'column.deleted',
        data: { columnId: request.params.id, habitatId: column.habitatId },
      });
      reply.code(204).send();
    }
  );
}
