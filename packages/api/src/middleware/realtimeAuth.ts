import type { FastifyRequest, FastifyReply } from "fastify";
import * as agentService from "../services/agentService.js";
import { getHabitatById } from "../repositories/habitat.js";
import { getMissionById } from "../repositories/mission.js";
import { getTaskById } from "../repositories/task.js";
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

/** Shared habitat-membership check used by both habitat-param and mission-param authorization. */
export async function checkHabitatAccess(
  request: FastifyRequest,
  habitatId: string,
): Promise<void> {
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

export async function authorizeHabitatAccess(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const habitatId = getHabitatIdFromParams(request);
  if (!habitatId) return;
  return checkHabitatAccess(request, habitatId);
}

/**
 * Mission-id-keyed authorization (closes the RM-11 gap for `/missions/:missionId/*` routes).
 * Derives the habitatId from the mission, then runs the same membership check as
 * {@link authorizeHabitatAccess}. Throws 404 if the mission doesn't exist (no information
 * leak about cross-habitat missions).
 */
export async function authorizeMissionAccess(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const missionId = (request.params as { missionId?: string }).missionId;
  if (!missionId) return;
  const mission = getMissionById(missionId);
  if (!mission) {
    throw notFound("Mission not found");
  }
  return checkHabitatAccess(request, mission.habitatId);
}

/**
 * Task-id-keyed object authorization. Resolves the TARGET task's actual
 * Mission/Habitat (never a caller-supplied substitute) and runs the same
 * membership check as {@link authorizeHabitatAccess}. A missing Task or
 * Mission throws 404 before the membership check; an existing but denied
 * object intentionally throws 403 — local routes distinguish the two and
 * claim no anti-enumeration collapse. Returns the validated habitat id.
 */
export async function authorizeTaskAccess(
  request: FastifyRequest,
  taskId: string,
): Promise<string> {
  const task = getTaskById(taskId);
  if (!task) {
    throw notFound("Task not found");
  }
  const mission = getMissionById(task.missionId);
  if (!mission) {
    throw notFound("Mission not found");
  }
  await checkHabitatAccess(request, mission.habitatId);
  return mission.habitatId;
}
