import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { batchOperateTasks } from "../../services/tasks/index.js";
import { batchTaskSchema } from "../../models/schemas.js";
import { agentOrHumanAuth } from "../../middleware/auth.js";
import { forbidden } from "../../errors.js";

const habitatIdParamSchema = z.object({ habitatId: z.string() });

export async function taskBatchRoutes(fastify: FastifyInstance): Promise<void> {
  fastify
    .withTypeProvider<ZodTypeProvider>()
    .post(
      "/habitats/:habitatId/tasks/batch",
      {
        schema: { params: habitatIdParamSchema, body: batchTaskSchema },
        preHandler: [agentOrHumanAuth],
      },
      async (request, _reply) => {
        const { habitatId } = request.params;
        const parsed = request.body;
        const actorId = request.agent?.id ?? request.user?.id ?? "anonymous";
        const actorType = request.agent ? "agent" : "human";

        if (parsed.operation === "assign" && actorType === "agent") {
          throw forbidden(
            "Batch assignment is admin-only. Use POST /tasks/:id/claim to claim a task.",
          );
        }

        const result = batchOperateTasks(habitatId, parsed, actorId, actorType);
        return result;
      },
    );
}
