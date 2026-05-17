import type { FastifyRequest, FastifyReply, preHandlerAsyncHookHandler } from 'fastify';
import * as habitatRepo from '../../repositories/board.js';
import { notFound } from '../../errors.js';

export function requireHabitat(): preHandlerAsyncHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const habitatId = (request.params as { habitatId: string }).habitatId;
    const habitat = habitatRepo.getHabitatById(habitatId);
    if (!habitat) {
      throw notFound('Habitat not found');
    }
  };
}
