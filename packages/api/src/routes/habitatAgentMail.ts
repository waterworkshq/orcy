import type { FastifyInstance, FastifyRequest } from "fastify";
import { humanAuth } from "../middleware/auth.js";
import { requireHabitatAccess } from "../middleware/team.js";
import { forbidden } from "../errors.js";
import * as agentMessageRepo from "../repositories/agentMessage.js";

function rejectNonLocalHuman(request: FastifyRequest): void {
  if (request.agent) {
    throw forbidden("Agent mail projection is local-human only", "AGENT_MAIL_HUMAN_ONLY");
  }
  if (request.remoteParticipant) {
    throw forbidden("Remote participants cannot read agent mail bodies", "AGENT_MAIL_LOCAL_ONLY");
  }
}

export async function habitatAgentMailRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{
    Params: { habitatId: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    "/habitats/:habitatId/agent-messages",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request: FastifyRequest<{
      Params: { habitatId: string };
      Querystring: { limit?: string; offset?: string };
    }>) => {
      rejectNonLocalHuman(request);
      const { habitatId } = request.params;
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : undefined;
      const offset = request.query.offset ? parseInt(request.query.offset, 10) : undefined;
      return agentMessageRepo.getMessagesByHabitat(habitatId, { limit, offset });
    },
  );
}
