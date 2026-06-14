export { authorizeHabitatAccess as requireHabitatAccess } from "./realtimeAuth.js";

import type { FastifyRequest, FastifyReply } from "fastify";
import { isTeamMemberByHabitatId, getMember } from "../repositories/teamMember.js";
import { getTeamById } from "../repositories/team.js";
import { unauthorized, forbidden, badRequest, notFound } from "../errors.js";

export async function teamHabitatAccess(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!request.user) return;

  const habitatId = (request.params as { id: string }).id;
  if (!habitatId) return;

  const isMember = isTeamMemberByHabitatId(habitatId, request.user.id);
  if (isMember) return;

  const { getHabitatById } = await import("../repositories/board.js");
  const habitat = getHabitatById(habitatId);
  if (!habitat) throw notFound("Habitat not found");

  if (!habitat.teamId) return;

  throw forbidden("You do not have access to this habitat", "BOARD_ACCESS_DENIED");
}

export async function teamAdminOrOwner(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!request.user) {
    throw unauthorized("Authentication required");
  }

  const teamId = (request.params as { id: string }).id;
  if (!teamId) {
    throw badRequest("Team ID required");
  }

  if (request.user.role === "admin") return;

  const member = getMember(teamId, request.user.id);
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    throw forbidden("Team admin or owner role required");
  }
}

export async function teamExists(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const teamId = (request.params as { id: string }).id;
  if (!teamId) return;

  const team = getTeamById(teamId);
  if (!team) {
    throw notFound("Team not found");
  }
}
