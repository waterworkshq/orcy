import type { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import * as agentService from '../services/agentService.js';
import { getBoardById } from '../repositories/board.js';
import { isTeamMemberByBoardId } from '../repositories/teamMember.js';
import type { HumanRole } from './auth.js';
import { getJwtSecret } from './auth.js';

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
    reply.code(401).send({ error: 'Invalid agent API key' });
    return;
  }

  const authHeader = request.headers.authorization;
  let token: string | undefined;
  let fromQuery = false;

  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }

  if (!token) {
    const query = request.query as { token?: string };
    if (query?.token) {
      token = query.token;
      fromQuery = true;
    }
  }

  if (!token) {
    reply.code(401).send({ error: 'Authentication required' });
    return;
  }

  try {
    const payload = jwt.verify(token, getJwtSecret(), {
      issuer: 'orcy',
    }) as { sub: string; username: string; role: string; iat?: number };

    if (fromQuery && payload.iat) {
      const tokenAge = Math.floor(Date.now() / 1000) - payload.iat;
      if (tokenAge > MAX_QUERY_TOKEN_AGE_SECONDS) {
        reply.code(401).send({ error: 'Query token expired', code: 'TOKEN_EXPIRED' });
        return;
      }
    }

    request.user = {
      id: payload.sub,
      username: payload.username,
      role: payload.role as HumanRole,
      type: 'human',
    };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      reply.code(401).send({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    } else {
      reply.code(401).send({ error: 'Invalid token' });
    }
  }
}

export async function authorizeBoardAccess(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const boardId = getBoardIdFromParams(request);
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
