import type { FastifyRequest, FastifyReply } from 'fastify';
import { unauthorized, forbidden } from '../errors.js';

/**
 * Role constants for human users: admin > editor > viewer.
 * Mirrors auth.HumanRole — kept here for middleware consumers.
 */
export type HumanRole = 'admin' | 'editor' | 'viewer';

/**
 * Returns a Fastify request handler that checks request.user.role against allowedRoles.
 * Replies with 401 if no user is present, or 403 if the role is insufficient.
 */
export function requireRole(...allowedRoles: HumanRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw unauthorized('Authentication required');
    }
    if (!allowedRoles.includes(request.user.role as HumanRole)) {
      throw forbidden('Insufficient permissions', 'INSUFFICIENT_PERMISSIONS', {
        required: allowedRoles,
        current: request.user.role,
      });
    }
  };
}

/** Shorthand for requireRole('admin'). Blocks non-admin requests. */
export const adminOnly = requireRole('admin');
/** Shorthand for requireRole('admin', 'editor'). Allows admin and editor roles. */
export const editorAndAbove = requireRole('admin', 'editor');
/** Shorthand for requireRole('admin', 'editor', 'viewer'). Allows all roles. */
export const viewerAndAbove = requireRole('admin', 'editor', 'viewer');
