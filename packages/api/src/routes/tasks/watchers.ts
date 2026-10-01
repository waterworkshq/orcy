import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { authorizeTaskAccess } from "../../middleware/realtimeAuth.js";
import * as watcherRepo from "../../repositories/watcher.js";
import * as watcherService from "../../services/watcherService.js";
import { notFound, internalError } from "../../errors.js";
import { applyDeclaredAuthPolicies } from "../../authPolicy.js";

export async function taskWatcherRoutes(fastify: FastifyInstance): Promise<void> {
  applyDeclaredAuthPolicies(fastify);

  fastify.post<{ Params: { id: string } }>(
    "/tasks/:id/watch",
    { config: { authPolicy: "human" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const userId = request.user!.id;
      await authorizeTaskAccess(request, request.params.id);
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
    { config: { authPolicy: "human" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const userId = request.user!.id;
      await authorizeTaskAccess(request, request.params.id);
      const removed = watcherRepo.removeWatcher(request.params.id, userId);
      if (!removed) {
        throw notFound("Not watching this task");
      }
      reply.code(204).send();
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/tasks/:id/watchers",
    { config: { authPolicy: "human" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      await authorizeTaskAccess(request, request.params.id);
      const watchers = watcherRepo.getWatchersForTask(request.params.id);
      const isCurrentlyWatching = watcherRepo.isWatching(request.params.id, request.user!.id);
      return { watchers, isWatching: isCurrentlyWatching };
    },
  );
}
