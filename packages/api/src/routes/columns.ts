import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as columnRepo from "../repositories/column.js";
import { createColumnSchema, updateColumnSchema, reorderColumnsSchema } from "../models/schemas.js";
import type { CreateColumnInput, UpdateColumnInput } from "../models/schemas.js";
import * as habitatRepo from "../repositories/habitat.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { humanAuth } from "../middleware/auth.js";
import { adminOnly } from "../middleware/rbac.js";
import { notFound, badRequest, conflict, AppError } from "../errors.js";

export async function columnRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { habitatId: string }; Body: CreateColumnInput }>(
    "/habitats/:habitatId/columns",
    { preHandler: humanAuth },
    async (
      request: FastifyRequest<{ Params: { habitatId: string }; Body: CreateColumnInput }>,
      reply: FastifyReply,
    ) => {
      const habitat = habitatRepo.getHabitatById(request.params.habitatId);
      if (!habitat) {
        throw notFound("Habitat not found");
      }

      const parsed = createColumnSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      const column = columnRepo.createColumn({
        ...parsed.data,
        habitatId: request.params.habitatId,
      });

      sseBroadcaster.publish(request.params.habitatId, { type: "column.created", data: column });
      reply.code(201).send({ column });
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/habitats/:habitatId/columns/reorder",
    {
      schema: {
        params: z.object({ habitatId: z.string() }),
        body: reorderColumnsSchema,
      },
      preHandler: [humanAuth, adminOnly],
    },
    async (request, reply) => {
      const { expectedOrder, desiredOrder } = request.body;
      const result = columnRepo.reorderColumns(
        request.params.habitatId,
        expectedOrder,
        desiredOrder,
      );
      if (!result.success) {
        if ("notFound" in result) throw notFound("Habitat not found");
        if ("invalid" in result) throw badRequest(result.reason);
        if ("versionConflict" in result) {
          reply.header("Retry-After", "5");
          throw new AppError(409, "VERSION_CONFLICT", "Column order changed", {
            currentOrder: result.currentOrder,
            yourOrder: expectedOrder,
          });
        }
        throw conflict("Reorder failed");
      }

      // Publish complete column.updated events only after the transaction
      // has committed. The response carries the canonical ordered set.
      for (const column of result.columns) {
        sseBroadcaster.publish(request.params.habitatId, {
          type: "column.updated",
          data: column,
        });
      }
      return { columns: result.columns };
    },
  );

  fastify.patch<{ Params: { id: string }; Body: UpdateColumnInput }>(
    "/columns/:id",
    { preHandler: humanAuth },
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: UpdateColumnInput }>,
      _reply: FastifyReply,
    ) => {
      const parsed = updateColumnSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      const column = columnRepo.updateColumn(request.params.id, parsed.data);
      if (!column) {
        throw notFound("Column not found");
      }
      sseBroadcaster.publish(column.habitatId, { type: "column.updated", data: column });
      return { column };
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/columns/:id",
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const column = columnRepo.getColumnById(request.params.id);
      if (!column) {
        throw notFound("Column not found");
      }

      try {
        columnRepo.deleteColumn(request.params.id);
      } catch (err) {
        throw conflict((err as Error).message);
      }

      sseBroadcaster.publish(column.habitatId, {
        type: "column.deleted",
        data: { columnId: request.params.id, habitatId: column.habitatId },
      });
      reply.code(204).send();
    },
  );
}
