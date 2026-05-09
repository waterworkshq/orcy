import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as columnRepo from '../repositories/column.js';
import { createColumnSchema, updateColumnSchema } from '../models/schemas.js';
import type { CreateColumnInput, UpdateColumnInput } from '../models/schemas.js';
import * as boardRepo from '../repositories/board.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import { humanAuth } from '../middleware/auth.js';
import { adminOnly } from '../middleware/rbac.js';

export async function columnRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { boardId: string }; Body: CreateColumnInput }>(
    '/boards/:boardId/columns',
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { boardId: string }; Body: CreateColumnInput }>, reply: FastifyReply) => {
      const board = boardRepo.getBoardById(request.params.boardId);
      if (!board) {
        reply.code(404).send({ error: 'Board not found' });
        return;
      }

      const parsed = createColumnSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
        return;
      }

      const column = columnRepo.createColumn({
        ...parsed.data,
        boardId: request.params.boardId,
      });

      sseBroadcaster.publish(request.params.boardId, { type: 'column.created', data: column });
      reply.code(201).send({ column });
    }
  );

  fastify.patch<{ Params: { id: string }; Body: UpdateColumnInput }>(
    '/columns/:id',
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { id: string }; Body: UpdateColumnInput }>, reply: FastifyReply) => {
      const parsed = updateColumnSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
        return;
      }

      const column = columnRepo.updateColumn(request.params.id, parsed.data);
      if (!column) {
        reply.code(404).send({ error: 'Column not found' });
        return;
      }
      sseBroadcaster.publish(column.boardId, { type: 'column.updated', data: column });
      return { column };
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/columns/:id',
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const column = columnRepo.getColumnById(request.params.id);
      if (!column) {
        reply.code(404).send({ error: 'Column not found' });
        return;
      }

      try {
        columnRepo.deleteColumn(request.params.id);
      } catch (err) {
        reply.code(409).send({ error: (err as Error).message });
        return;
      }

      sseBroadcaster.publish(column.boardId, {
        type: 'column.deleted',
        data: { columnId: request.params.id, boardId: column.boardId },
      });
      reply.code(204).send();
    }
  );
}
