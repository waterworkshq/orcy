import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as taskService from "../../services/tasks/index.js";
import { updateTaskSchema, cloneTaskSchema } from "../../models/schemas.js";
import { agentAuth, humanAuth, agentOrHumanAuth } from "../../middleware/auth.js";
import { notFound, forbidden, conflict, badRequest } from "../../errors.js";
import { isCreationPublicationEnabled } from "../../config/creationPublicationCutover.js";

const taskParamsSchema = z.object({ id: z.string() });

export async function taskCrudRoutes(fastify: FastifyInstance): Promise<void> {
  fastify
    .withTypeProvider<ZodTypeProvider>()
    .get(
      "/tasks/:id",
      { schema: { params: taskParamsSchema }, preHandler: [agentOrHumanAuth] },
      async (request, _reply) => {
        const task = taskService.getTask(request.params.id);
        if (!task) {
          throw notFound("Task not found");
        }

        return { task };
      },
    );

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .patch(
      "/tasks/:id",
      { schema: { params: taskParamsSchema, body: updateTaskSchema }, preHandler: [agentAuth] },
      async (request, _reply) => {
        const parsed = request.body;
        const actorId = request.agent?.id ?? request.user?.id ?? "anonymous";
        const result = taskService.updateTask(request.params.id, parsed, actorId);

        if (!result.success) {
          if (result.archived) {
            throw forbidden("Cannot modify a task in an archived mission");
          } else if (result.notFound) {
            throw notFound("Task not found");
          } else if (result.versionMismatch) {
            throw conflict("Version conflict", {
              currentVersion: result.currentVersion,
              yourVersion: parsed.version,
            });
          }
          throw badRequest("Update failed");
        }
        return { task: result.task };
      },
    );

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .delete(
      "/tasks/:id",
      { schema: { params: taskParamsSchema }, preHandler: [agentOrHumanAuth] },
      async (request, _reply) => {
        const result = taskService.deleteTask(request.params.id);
        if (!result.success) {
          if (result.reason === "archived") {
            throw forbidden("Cannot delete a task in an archived mission");
          } else if (result.reason === "not_found") {
            throw notFound("Task not found");
          } else {
            throw badRequest("Cannot delete task", result);
          }
        }
        return { success: true };
      },
    );

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .post(
      "/tasks/:id/clone",
      { schema: { params: taskParamsSchema, body: cloneTaskSchema }, preHandler: [humanAuth] },
      async (request, reply) => {
        // T11 Phase 4 — when the publication kernel is active, the legacy
        // immediate-clone endpoint is retired. Callers must use the new
        // clone-publication route (POST /tasks/:sourceTaskId/clone-publications)
        // which routes through the kernel (prepare/edit/publish with
        // governance, observation gate, clone-source linkage).
        if (isCreationPublicationEnabled()) {
          throw notFound(
            "POST /tasks/:id/clone is retired when the publication kernel is active. Use POST /tasks/:sourceTaskId/clone-publications instead.",
          );
        }
        const parsed = request.body;
        const clonedBy = request.user?.id ?? "anonymous";
        const result = taskService.cloneTask(request.params.id, clonedBy, {
          includeSubtasks: parsed.includeSubtasks,
          includeComments: parsed.includeComments,
        });

        if (result.success === false) {
          throw notFound("Task not found");
        }

        reply.code(201).send({ task: result.task });
      },
    );
}
