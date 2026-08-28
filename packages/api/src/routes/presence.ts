import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  joinHabitat,
  leaveHabitat,
  setViewingTask,
  getHabitatPresence,
  getPresenceEntry,
} from '../sse/presence.js';
import { inheritAuthPolicy } from '../authPolicy.js';
import { checkHabitatAccess, requireHabitatAccess } from '../middleware/team.js';
import { badRequest, forbidden } from '../errors.js';

// Identity is derived from request.user on the server; a join/heartbeat carrying
// identity fields (type, userId, userName, agentId, agentName, ...) is rejected
// outright rather than silently stripped — forged identity must never reach
// presence state or SSE events.
const joinSchema = z
  .object({
    sessionId: z.string().min(1),
    habitatId: z.string().min(1),
  })
  .strict();

const heartbeatSchema = z
  .object({
    sessionId: z.string().min(1),
    habitatId: z.string().min(1),
    viewingTaskId: z.string().min(1).nullable().optional(),
  })
  .strict();

const leaveSchema = z
  .object({
    sessionId: z.string().min(1),
    habitatId: z.string().min(1),
  })
  .strict();

function parseBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw badRequest(`Invalid request body: ${issues}`);
  }
  return result.data;
}

/** Denies when the session in this Habitat belongs to a different human. */
function assertSessionOwnership(habitatId: string, sessionId: string, userId: string): void {
  const entry = getPresenceEntry(habitatId, sessionId);
  if (entry && entry.userId !== userId) {
    throw forbidden('Session belongs to another user', 'PRESENCE_SESSION_OWNERSHIP');
  }
}

/**
 * Presence tracking — join/leave/heartbeat for board viewers and their active task.
 * All routes require human authentication; Habitat access is authorized against
 * the Habitat ID each request carries (body-keyed for POSTs, path param for the
 * viewer list). Presence identity is always derived from the authenticated user.
 */
export async function presenceRoutes(fastify: FastifyInstance): Promise<void> {
  // Homogeneous human scope (containment baseline): every presence route
  // authenticates a local human through the policy-installed guard; identity
  // is always derived from request.user.
  inheritAuthPolicy(fastify, 'human');

  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  /** POST /presence/join - Register presence on a board. Requires human auth. Returns { success: true } */
  fastify.post(
    '/presence/join',
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { sessionId, habitatId } = parseBody(joinSchema, request.body);
      const user = request.user!;
      await checkHabitatAccess(request, habitatId);
      assertSessionOwnership(habitatId, sessionId, user.id);
      joinHabitat(habitatId, {
        sessionId,
        type: 'human',
        habitatId,
        userId: user.id,
        userName: user.username,
        viewingTaskId: null,
      });
      return { success: true };
    }
  );

  /** POST /presence/heartbeat - Send presence heartbeat. Requires human auth. Returns { success: true } */
  fastify.post(
    '/presence/heartbeat',
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { sessionId, habitatId, viewingTaskId } = parseBody(heartbeatSchema, request.body);
      const user = request.user!;
      await checkHabitatAccess(request, habitatId);
      assertSessionOwnership(habitatId, sessionId, user.id);
      // Unknown sessions stay a no-op (preserves the pre-auth behavior).
      if (getPresenceEntry(habitatId, sessionId)) {
        setViewingTask(habitatId, sessionId, viewingTaskId ?? null);
      }
      return { success: true };
    }
  );

  /** POST /presence/leave - Leave a board session. Requires human auth. Returns { success: true } */
  fastify.post(
    '/presence/leave',
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { sessionId, habitatId } = parseBody(leaveSchema, request.body);
      const user = request.user!;
      await checkHabitatAccess(request, habitatId);
      assertSessionOwnership(habitatId, sessionId, user.id);
      // Only publish a leave for a session that exists — a forged leave for an
      // absent session must not emit a presence.left event.
      if (getPresenceEntry(habitatId, sessionId)) {
        leaveHabitat(habitatId, sessionId);
      }
      return { success: true };
    }
  );

  /** GET /presence/viewers/:habitatId - Get active viewers on a board. Requires human auth + habitat access. Returns { viewers } */
  fastify.get<{ Params: { habitatId: string } }>(
    '/presence/viewers/:habitatId',
    { preHandler: [requireHabitatAccess] },
    async (request: FastifyRequest<{ Params: { habitatId: string } }>, _reply: FastifyReply) => {
      const { habitatId } = request.params;
      const viewers = getHabitatPresence(habitatId);
      return { viewers };
    }
  );
}
