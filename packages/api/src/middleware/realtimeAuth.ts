import type { FastifyRequest, FastifyReply } from 'fastify';
import * as agentService from '../services/agentService.js';
import { getBoardById } from '../repositories/board.js';
import { isTeamMemberByBoardId } from '../repositories/teamMember.js';
import type { HumanRole } from './auth.js';
import { extractAndVerifyJwt } from './jwt-verification.js';
import { unauthorized, forbidden, notFound } from '../errors.js';

const MAX_QUERY_TOKEN_AGE_SECONDS = 30;

export function getBoardIdFromParams(request: FastifyRequest): string | undefined {
  const params = request.params as Record<string, string>;
  return params.id ?? params.boardId;
}

export async function authenticateRealtime(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const apiKey = request.headers['x-agent-api-key'] as string | undefined;
  if (apiKey) {
    const agent = agentService.getAgentByApiKey(apiKey);
    if (agent) {
      request.agent = agent;
      return;
    }
    throw unauthorized('Invalid agent API key', 'INVALID_API_KEY');
  }

  const { user, error } = extractAndVerifyJwt(request, {
    allowBearer: true,
    allowQueryToken: true,
    maxQueryTokenAgeSeconds: MAX_QUERY_TOKEN_AGE_SECONDS,
  });

  if (error) {
    throw unauthorized(error.message, error.code ?? 'UNAUTHORIZED');
  }

  request.user = { ...user!, role: user!.role as HumanRole };
}

export async function authorizeBoardAccess(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const boardId = getBoardIdFromParams(request);
  if (!boardId) return;

  const board = getBoardById(boardId);
  if (!board) {
    throw notFound('Board not found');
  }

  if (request.agent) return;

  if (request.user) {
    if (!board.teamId) return;
    const isMember = isTeamMemberByBoardId(boardId, request.user.id);
    if (isMember) return;
    throw forbidden('You do not have access to this board', 'BOARD_ACCESS_DENIED');
  }

  throw unauthorized('Authentication required');
}
