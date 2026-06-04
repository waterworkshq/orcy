import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { agentOrHumanAuth } from "../middleware/auth.js";
import { forbidden, notFound } from "../errors.js";
import { getHabitatById } from "../repositories/board.js";
import { isTeamMemberByHabitatId } from "../repositories/teamMember.js";
import * as auditBundleService from "../services/auditBundleService.js";

const taskIdParamsSchema = z.object({ taskId: z.string() });
const missionIdParamsSchema = z.object({ missionId: z.string() });
const bundleQuerySchema = z.object({ includeHealthSnapshots: z.coerce.boolean().optional() });

function requireEntityHabitatAccess(request: FastifyRequest, habitatId: string): void {
  if (request.agent) return;
  const habitat = getHabitatById(habitatId);
  if (!habitat) throw notFound("Habitat not found");
  if (!habitat.teamId) return;
  if (request.user && isTeamMemberByHabitatId(habitatId, request.user.id)) return;
  throw forbidden("You do not have access to this habitat", "BOARD_ACCESS_DENIED");
}

export async function auditBundleRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/tasks/:taskId/audit/bundle",
    {
      schema: { params: taskIdParamsSchema, querystring: bundleQuerySchema },
      preHandler: [agentOrHumanAuth],
    },
    async (request) => {
      const bundle = auditBundleService.getTaskAuditBundle(request.params.taskId, {
        includeHealthSnapshots: request.query.includeHealthSnapshots,
      });
      requireEntityHabitatAccess(request, bundle.target.habitatId);
      return bundle;
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/missions/:missionId/audit/bundle",
    {
      schema: { params: missionIdParamsSchema, querystring: bundleQuerySchema },
      preHandler: [agentOrHumanAuth],
    },
    async (request) => {
      const bundle = auditBundleService.getMissionAuditBundle(request.params.missionId, {
        includeHealthSnapshots: request.query.includeHealthSnapshots,
      });
      requireEntityHabitatAccess(request, bundle.target.habitatId);
      return bundle;
    },
  );
}
