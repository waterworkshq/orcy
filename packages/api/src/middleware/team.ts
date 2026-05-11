export { authorizeBoardAccess as requireBoardAccess } from './realtimeAuth.js';

import type { FastifyRequest, FastifyReply } from 'fastify';
import { isTeamMemberByBoardId, getMember } from '../repositories/teamMember.js';
import { getTeamById } from '../repositories/team.js';
import { unauthorized, forbidden, badRequest, notFound } from '../errors.js';

export async function teamBoardAccess(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!request.user) return;

  const boardId = (request.params as { id: string }).id;
  if (!boardId) return;

  const isMember = isTeamMemberByBoardId(boardId, request.user.id);
  if (isMember) return;

  const { getBoardById } = await import('../repositories/board.js');
  const board = getBoardById(boardId);
  if (!board) return;

  if (!board.teamId) return;

  throw forbidden('You do not have access to this board', 'BOARD_ACCESS_DENIED');
}

export async function teamAdminOrOwner(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!request.user) {
    throw unauthorized('Authentication required');
  }

  const teamId = (request.params as { id: string }).id;
  if (!teamId) {
    throw badRequest('Team ID required');
  }

  if (request.user.role === 'admin') return;

  const member = getMember(teamId, request.user.id);
  if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
    throw forbidden('Team admin or owner role required');
  }
}

export async function teamExists(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const teamId = (request.params as { id: string }).id;
  if (!teamId) return;

  const team = getTeamById(teamId);
  if (!team) {
    throw notFound('Team not found');
  }
}
