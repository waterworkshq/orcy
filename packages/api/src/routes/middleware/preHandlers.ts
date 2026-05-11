import type { FastifyRequest, FastifyReply, preHandlerAsyncHookHandler } from 'fastify';
import * as boardRepo from '../../repositories/board.js';
import { notFound } from '../../errors.js';

export function requireBoard(): preHandlerAsyncHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const boardId = (request.params as { boardId: string }).boardId;
    const board = boardRepo.getBoardById(boardId);
    if (!board) {
      throw notFound('Board not found');
    }
  };
}
