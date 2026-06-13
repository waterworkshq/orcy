import type { FastifyRequest, FastifyReply } from "fastify";
import * as agentService from "../services/agentService.js";
import { getHabitatById } from "../repositories/board.js";
import { isTeamMemberByHabitatId } from "../repositories/teamMember.js";
import type { HumanRole } from "./auth.js";
import { extractAndVerifyJwt } from "./jwt-verification.js";
import { unauthorized, forbidden, notFound } from "../errors.js";
import { remoteParticipantAuth, isRemoteConnectionValid } from "./remoteAuth.js";

const MAX_QUERY_TOKEN_AGE_SECONDS = 30;

export function getHabitatIdFromParams(request: FastifyRequest): string | undefined {
  const params = request.params as Record<string, string>;
  return params.id ?? params.habitatId;
}

export async function authenticateRealtime(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const remoteKey = request.headers["x-orcy-remote-key"] as string | undefined;
  if (remoteKey) {
    await remoteParticipantAuth(request, _reply);
    return;
  }

  const apiKey = request.headers["x-agent-api-key"] as string | undefined;
  if (apiKey) {
    const agent = agentService.getAgentByApiKey(apiKey);
    if (agent) {
      request.agent = agent;
      return;
    }
    throw unauthorized("Invalid agent API key", "INVALID_API_KEY");
  }

  const { user, error } = extractAndVerifyJwt(request, {
    allowBearer: true,
    allowQueryToken: true,
    maxQueryTokenAgeSeconds: MAX_QUERY_TOKEN_AGE_SECONDS,
  });

  if (error) {
    throw unauthorized(error.message, error.code ?? "UNAUTHORIZED");
  }

  request.user = { ...user!, role: user!.role as HumanRole };
}

export async function authorizeHabitatAccess(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const habitatId = getHabitatIdFromParams(request);
  if (!habitatId) return;

  const habitat = getHabitatById(habitatId);
  if (!habitat) {
    throw notFound("Habitat not found");
  }

  if (request.agent) return;

  if (request.remoteParticipant) {
    const ctx = request.remoteParticipant;
    if (ctx.habitatId !== habitatId) {
      throw forbidden(
        "Remote participant does not have access to this habitat",
        "REMOTE_HABITAT_MISMATCH",
      );
    }
    const validation = isRemoteConnectionValid(ctx);
    if (!validation.valid) {
      throw forbidden(
        `Remote connection invalidated: ${validation.reason}`,
        "REMOTE_CONNECTION_INVALID",
      );
    }
    return;
  }

  if (request.user) {
    if (!habitat.teamId) return;
    const isMember = isTeamMemberByHabitatId(habitatId, request.user.id);
    if (isMember) return;
    throw forbidden("You do not have access to this habitat", "BOARD_ACCESS_DENIED");
  }

  throw unauthorized("Authentication required");
}
