import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as taskRepo from "../../repositories/task.js";
import * as watcherRepo from "../../repositories/watcher.js";
import * as watcherService from "../../services/watcherService.js";
import { humanAuth } from "../../middleware/auth.js";
import { notFound, internalError } from "../../errors.js";

export async function taskWatcherRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { id: string } }>(
    "/tasks/:id/watch",
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const userId = request.user!.id;
      try {
        const watcher = watcherService.watchTask(request.params.id, userId);
        reply.code(201).send({ watcher });
      } catch (err) {
        const msg = (err as Error).message;
        if (msg === "Task not found") {
          throw notFound(msg);
        } else {
          throw internalError(msg);
        }
      }
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/tasks/:id/watch",
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const userId = request.user!.id;
      const removed = watcherRepo.removeWatcher(request.params.id, userId);
      if (!removed) {
        throw notFound("Not watching this task");
      }
      reply.code(204).send();
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/tasks/:id/watchers",
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) {
        throw notFound("Task not found");
      }
      const watchers = watcherRepo.getWatchersForTask(request.params.id);
      const isCurrentlyWatching = watcherRepo.isWatching(request.params.id, request.user!.id);
      return { watchers, isWatching: isCurrentlyWatching };
    },
  );
}
