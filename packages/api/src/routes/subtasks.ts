import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as subtaskService from '../services/subtaskService.js';
import { badRequest, notFound } from '../errors.js';
import { applyDeclaredAuthPolicies } from "../authPolicy.js";
import { authorizeTaskAccess } from "../middleware/realtimeAuth.js";

/**
 * Subtask CRUD — create, list, update, and delete subtasks attached to a
 * task. Agent-only transport: every callback first resolves the URL Task's
 * actual Mission → Habitat and enforces the shared habitat-access predicate
 * (`authorizeTaskAccess`) before any row is read or written; PATCH/DELETE
 * additionally bind the child to the URL parent Task through the service and
 * the final SQL statement (missing Task/Mission/Habitat is 404; an unknown or
 * wrong-parent child is 404 `Subtask not found`).
 */
export async function subtaskRoutes(fastify: FastifyInstance): Promise<void> {
  applyDeclaredAuthPolicies(fastify);

  /** GET /tasks/:taskId/subtasks - List subtasks for a task. Auth: agentAuth. Returns subtask array */
  fastify.get<{ Params: { taskId: string } }>(
    "/tasks/:taskId/subtasks",
    { config: { authPolicy: "agent" } },
    async (request: FastifyRequest<{ Params: { taskId: string } }>, _reply: FastifyReply) => {
      await authorizeTaskAccess(request, request.params.taskId);
      return subtaskService.getSubtasks(request.params.taskId);
    },
  );

  /** POST /tasks/:taskId/subtasks - Create a subtask. Auth: agentAuth. Returns { subtask } or 404 */
  fastify.post<{
    Params: { taskId: string };
    Body: { title: string; order?: number; assigneeId?: string };
  }>(
    "/tasks/:taskId/subtasks",
    { config: { authPolicy: "agent" } },
    async (
      request: FastifyRequest<{
        Params: { taskId: string };
        Body: { title: string; order?: number; assigneeId?: string };
      }>,
      reply: FastifyReply,
    ) => {
      // Title validation stays BEFORE Task admission (documented precedence).
      // Defensive 400 for absent bodies and missing/non-string titles rather
      // than a dereference/trim fault.
      const rawTitle = (request.body as { title?: unknown } | undefined)?.title;
      const title = typeof rawTitle === "string" ? rawTitle : "";
      if (title.trim().length === 0) {
        throw badRequest("Title is required");
      }

      await authorizeTaskAccess(request, request.params.taskId);

      const subtask = subtaskService.createSubtask(request.params.taskId, {
        title: title.trim(),
        order: request.body.order,
        assigneeId: request.body.assigneeId,
      });

      if (!subtask) {
        throw notFound("Task not found");
      }

      reply.code(201).send({ subtask });
    },
  );

  /** PATCH /tasks/:taskId/subtasks/:subtaskId - Update a subtask. Auth: agentAuth. Returns { subtask } or 404 */
  fastify.patch<{
    Params: { taskId: string; subtaskId: string };
    Body: { title?: string; completed?: boolean; order?: number; assigneeId?: string | null };
  }>(
    "/tasks/:taskId/subtasks/:subtaskId",
    { config: { authPolicy: "agent" } },
    async (request, _reply) => {
      await authorizeTaskAccess(request, request.params.taskId);

      const subtask = subtaskService.updateSubtask(
        request.params.taskId,
        request.params.subtaskId,
        request.body,
      );

      if (!subtask) {
        throw notFound("Subtask not found");
      }

      return { subtask };
    },
  );

  /** DELETE /tasks/:taskId/subtasks/:subtaskId - Delete a subtask. Auth: agentAuth. Returns 204 or 404 */
  fastify.delete<{ Params: { taskId: string; subtaskId: string } }>(
    "/tasks/:taskId/subtasks/:subtaskId",
    { config: { authPolicy: "agent" } },
    async (
      request: FastifyRequest<{ Params: { taskId: string; subtaskId: string } }>,
      reply: FastifyReply,
    ) => {
      await authorizeTaskAccess(request, request.params.taskId);

      const success = subtaskService.deleteSubtask(request.params.taskId, request.params.subtaskId);

      if (!success) {
        throw notFound("Subtask not found");
      }

      reply.code(204).send();
    },
  );
}
