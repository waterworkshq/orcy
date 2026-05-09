import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as taskRepo from '../../repositories/task.js';
import * as watcherService from '../../services/watcherService.js';
import { humanAuth } from '../../middleware/auth.js';

export async function taskWatcherRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { id: string } }>(
    '/tasks/:id/watch',
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const userId = request.user!.id;
      try {
        const watcher = watcherService.watchTask(request.params.id, userId);
        reply.code(201).send({ watcher });
      } catch (err) {
        const msg = (err as Error).message;
        if (msg === 'Task not found') {
          reply.code(404).send({ error: msg });
        } else {
          reply.code(500).send({ error: msg });
        }
      }
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/tasks/:id/watch',
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const userId = request.user!.id;
      const removed = watcherService.unwatchTask(request.params.id, userId);
      if (!removed) {
        reply.code(404).send({ error: 'Not watching this task' });
        return;
      }
      reply.code(204).send();
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/tasks/:id/watchers',
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) {
        reply.code(404).send({ error: 'Task not found' });
        return;
      }
      const watchers = watcherService.getWatchers(request.params.id);
      const isCurrentlyWatching = watcherService.isWatching(request.params.id, request.user!.id);
      return { watchers, isWatching: isCurrentlyWatching };
    }
  );
}
