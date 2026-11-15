import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as taskService from "../../services/tasks/index.js";
import { updateTaskSchema, updateTaskMetadataSchema } from "../../models/schemas.js";
import { notFound, forbidden, conflict, badRequest, conflictWithCode, AppError, ErrorCodes } from "../../errors.js";
import { saveTaskMetadata } from "../../services/tasks/humanTaskMetadata.js";
import { applyDeclaredAuthPolicies } from "../../authPolicy.js";
import { authorizeTaskAccess } from "../../middleware/realtimeAuth.js";

const taskParamsSchema = z.object({ id: z.string() });

export async function taskCrudRoutes(fastify: FastifyInstance): Promise<void> {
  applyDeclaredAuthPolicies(fastify);

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .get(
      "/tasks/:id",
      { schema: { params: taskParamsSchema }, config: { authPolicy: "local_actor" } },
      async (request, _reply) => {
        await authorizeTaskAccess(request, request.params.id);
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
      { schema: { params: taskParamsSchema, body: updateTaskSchema }, config: { authPolicy: "agent" } },
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
    .patch(
      "/tasks/:id/metadata",
      { schema: { params: taskParamsSchema, body: updateTaskMetadataSchema }, config: { authPolicy: "human" } },
      async (request, _reply) => {
        const body = request.body;
        const outcome = saveTaskMetadata({
          taskId: request.params.id,
          userId: request.user!.id,
          expectedVersion: body.expectedVersion,
          expectedTaskIdentity: body.expectedTaskIdentity,
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
          ...(body.expectedPriority !== undefined ? { expectedPriority: body.expectedPriority } : {}),
        });
        if (!outcome.ok) {
          if (outcome.code === "NOT_FOUND") throw notFound("Task not found");
          if (outcome.code === "FORBIDDEN") throw forbidden("Cannot edit this task's metadata", "TASK_METADATA_EDIT_FORBIDDEN");
          if (outcome.code === "NOT_EDITABLE") throw conflictWithCode("TASK_METADATA_NOT_EDITABLE", outcome.message);
          if (outcome.code === "CONTENTION") {
            // Same Retry-After hint as the pulse contention precedent: the
            // message asks clients to retry, so give them the backoff header.
            const busy = new AppError(503, ErrorCodes.SERVICE_UNAVAILABLE, "Task metadata writer is busy; retry shortly");
            busy.retryAfterMs = 500;
            throw busy;
          }
          throw conflictWithCode("VERSION_CONFLICT", outcome.message, { currentVersion: outcome.currentVersion, expectedVersion: body.expectedVersion });
        }
        return { task: outcome.task, habitatId: outcome.habitatId };
      },
    );

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .delete(
      "/tasks/:id",
      { schema: { params: taskParamsSchema }, config: { authPolicy: "local_actor" } },
      async (request, _reply) => {
        await authorizeTaskAccess(request, request.params.id);
        // Real authenticated actor reaches the custody-retirement audit.
        const result = taskService.deleteTask(request.params.id, {
          actorType: request.agent ? "agent" : "human",
          actorId: request.agent?.id ?? request.user?.id ?? "unknown",
        });
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
}
