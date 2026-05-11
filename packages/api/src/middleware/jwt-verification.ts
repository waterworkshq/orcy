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
    if (token && maxQueryTokenAgeSeconds) {
      const decoded = jwt.decode(token) as { iat?: number } | null;
      if (decoded?.iat && Date.now() / 1000 - decoded.iat > maxQueryTokenAgeSeconds) {
        return { error: { message: 'Query token expired', code: 'TOKEN_EXPIRED' } };
      }
    }
  }

  if (!token) return { error: { message: 'Missing authentication token' } };

  try {
    const payload = jwt.verify(token, getJwtSecret(), { issuer: 'orcy' }) as Record<string, unknown>;
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
