import type { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import * as agentService from '../services/agentService.js';

let _jwtSecret: string | undefined;

export function setJwtSecret(secret: string): void {
  _jwtSecret = secret;
}

export function getJwtSecret(): string {
  if (_jwtSecret) return _jwtSecret;
  const env = process.env.JWT_SECRET;
  if (env) return env;
  return 'dev-secret-change-in-production';
}

/** Role assigned to a human user in the system. */
export type HumanRole = 'admin' | 'editor' | 'viewer';

declare module 'fastify' {
  interface FastifyRequest {
    agent?: Awaited<ReturnType<typeof agentService.getAgentByApiKey>>;
    user?: { id: string; username: string; role: HumanRole; type: 'human' };
  }
}

/**
 * Fastify middleware that authenticates an agent request using the X-Agent-API-Key header.
 * Sets request.agent on success, or returns 401.
 */
export async function agentAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const apiKey = request.headers['x-agent-api-key'] as string | undefined;

  if (!apiKey) {
    reply.code(401).send({ error: 'Missing X-Agent-API-Key header' });
    return;
  }

  const agent = agentService.getAgentByApiKey(apiKey);
  if (!agent) {
    reply.code(401).send({ error: 'Invalid API key' });
    return;
  }

  request.agent = agent;
}

/**
 * Fastify middleware that authenticates a human user via a Bearer JWT.
 * Sets request.user on success, or returns 401.
 */
export async function humanAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, getJwtSecret(), {
      issuer: 'orcy',
    }) as { sub: string; username: string; role: string };

    request.user = {
      id: payload.sub,
      username: payload.username,
      role: payload.role as HumanRole,
      type: 'human',
    };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return reply.code(401).send({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    } else {
      return reply.code(401).send({ error: 'Invalid token' });
    }
  }
}

/**
 * Fastify middleware that validates the X-Registration-Token header.
 * Returns 403 if a token is configured but does not match.
 */
export async function registrationAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const secret = process.env.ORCY_REGISTRATION_TOKEN;
  if (!secret) return;

  const token = request.headers['x-registration-token'] as string | undefined;
  if (!token || token !== secret) {
    return reply.code(403).send({ error: 'Invalid registration token' });
  }
}

export async function sseAuth(
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

  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }

  if (!token) {
    const query = request.query as { token?: string };
    if (query?.token) {
      token = query.token;
    }
  }

  if (!token) {
    reply.code(401).send({ error: 'Authentication required' });
    return;
  }

  try {
    const payload = jwt.verify(token, getJwtSecret(), {
      issuer: 'orcy',
    }) as { sub: string; username: string; role: string };

    request.user = {
      id: payload.sub,
      username: payload.username,
      role: payload.role as HumanRole,
      type: 'human',
    };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return reply.code(401).send({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    } else {
      return reply.code(401).send({ error: 'Invalid token' });
    }
  }
}

export async function agentOrHumanAuth(
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
    reply.code(401).send({ error: 'Invalid API key' });
    return;
  }

  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, getJwtSecret(), {
        issuer: 'orcy',
      }) as { sub: string; username: string; role: string };
      request.user = {
        id: payload.sub,
        username: payload.username,
        role: payload.role as HumanRole,
        type: 'human',
      };
      return;
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        reply.code(401).send({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
        return;
      }
      reply.code(401).send({ error: 'Invalid token' });
      return;
    }
  }

  reply.code(401).send({ error: 'Missing X-Agent-API-Key header or Authorization Bearer token' });
}
