import type { FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';

let _jwtSecret: string | undefined;

export function setJwtSecret(secret: string): void {
  _jwtSecret = secret;
}

export function getJwtSecret(): string {
  if (_jwtSecret) return _jwtSecret;
  const env = process.env.JWT_SECRET;
  if (env) return env;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production');
  }
  console.warn('WARNING: Using default JWT secret. Set JWT_SECRET for production.');
  return 'dev-secret-change-in-production';
}

export interface JwtUser {
  id: string;
  username: string;
  role: string;
  type: 'human';
}

export interface ExtractJwtOptions {
  allowBearer?: boolean;
  allowQueryToken?: boolean;
  maxQueryTokenAgeSeconds?: number;
}

export function extractAndVerifyJwt(
  request: FastifyRequest,
  options?: ExtractJwtOptions,
): { user?: JwtUser; error?: { message: string; code?: string } } {
  const {
    allowBearer = true,
    allowQueryToken = false,
    maxQueryTokenAgeSeconds,
  } = options ?? {};

  let token: string | undefined;

  if (allowBearer) {
    const auth = request.headers['authorization'];
    if (auth?.startsWith('Bearer ')) token = auth.slice(7);
  }

  if (!token && allowQueryToken) {
    token = (request.query as Record<string, string>)['token'];
  }

  if (!token) return { error: { message: 'Missing authentication token' } };

  try {
    const payload = jwt.verify(token, getJwtSecret(), {
      issuer: 'orcy',
      clockTolerance: 30,
    }) as Record<string, unknown>;

    if (maxQueryTokenAgeSeconds && typeof payload.iat === 'number') {
      if (Date.now() / 1000 - payload.iat > maxQueryTokenAgeSeconds) {
        return { error: { message: 'Query token expired', code: 'TOKEN_EXPIRED' } };
      }
    }

    return {
      user: {
        id: payload.sub as string,
        username: payload.username as string,
        role: payload.role as string,
        type: 'human',
      },
    };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return { error: { message: 'Token expired', code: 'TOKEN_EXPIRED' } };
    }
    return { error: { message: 'Invalid token' } };
  }
}
