import type { FastifyRequest, FastifyReply, preHandlerAsyncHookHandler } from 'fastify';
import * as boardRepo from '../../repositories/board.js';

export function requireBoard(): preHandlerAsyncHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const boardId = (request.params as { boardId: string }).boardId;
    const board = boardRepo.getBoardById(boardId);
    if (!board) {
      reply.code(404).send({ error: 'Board not found' });
      return;
    }
  };
}
