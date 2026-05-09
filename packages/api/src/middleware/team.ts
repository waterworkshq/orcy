import type { FastifyRequest, FastifyReply } from 'fastify';
import { isTeamMemberByBoardId, getMember } from '../repositories/teamMember.js';
import { getTeamById } from '../repositories/team.js';
import { getBoardById } from '../repositories/board.js';

export async function requireBoardAccess(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const boardId = (request.params as { id: string }).id;
  if (!boardId) return;

  const board = getBoardById(boardId);
  if (!board) {
    reply.code(404).send({ error: 'Board not found' });
    return;
  }

  if (request.agent) return;

  if (request.user) {
    if (!board.teamId) return;
    const isMember = isTeamMemberByBoardId(boardId, request.user.id);
    if (isMember) return;
    reply.code(403).send({ error: 'You do not have access to this board' });
    return;
  }

  reply.code(401).send({ error: 'Authentication required' });
}

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

  reply.code(403).send({ error: 'You do not have access to this board' });
}

export async function teamAdminOrOwner(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!request.user) {
    reply.code(401).send({ error: 'Authentication required' });
    return;
  }

  const teamId = (request.params as { id: string }).id;
  if (!teamId) {
    reply.code(400).send({ error: 'Team ID required' });
    return;
  }

  if (request.user.role === 'admin') return;

  const member = getMember(teamId, request.user.id);
  if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
    reply.code(403).send({ error: 'Team admin or owner role required' });
    return;
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
    reply.code(404).send({ error: 'Team not found' });
    return;
  }
}
