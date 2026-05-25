import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { joinHabitat, leaveHabitat, setViewingTask, getHabitatPresence } from '../sse/presence.js';
import type { PresenceType } from '../models/index.js';
import { badRequest } from '../errors.js';

interface JoinBody {
  sessionId: string;
  type: PresenceType;
  habitatId: string;
  userId?: string;
  userName?: string;
  agentId?: string;
  agentName?: string;
}

interface HeartbeatBody {
  sessionId: string;
  habitatId: string;
  viewingTaskId?: string | null;
}

interface LeaveBody {
  sessionId: string;
  habitatId: string;
}

/**
 * Presence tracking — join/leave/heartbeat for board viewers and their active task.
 */
export async function presenceRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  /** POST /presence/join - Register presence on a board. No auth. Returns { success: true } */
  fastify.post<{ Body: JoinBody }>(
    '/presence/join',
    async (request: FastifyRequest<{ Body: JoinBody }>, _reply: FastifyReply) => {
      const { sessionId, type, habitatId, userId, userName, agentId, agentName } = request.body;
      if (!sessionId || !type || !habitatId) {
        throw badRequest('sessionId, type, and habitatId are required');
      }
      joinHabitat(habitatId, { sessionId, type, habitatId: habitatId, userId, userName, agentId, agentName, viewingTaskId: null });
      return { success: true };
    }
  );

  /** POST /presence/heartbeat - Send presence heartbeat. No auth. Returns { success: true } */
  fastify.post<{ Body: HeartbeatBody }>(
    '/presence/heartbeat',
    async (request: FastifyRequest<{ Body: HeartbeatBody }>, _reply: FastifyReply) => {
      const { sessionId, habitatId, viewingTaskId } = request.body;
      if (!sessionId || !habitatId) {
        throw badRequest('sessionId and habitatId are required');
      }
      setViewingTask(habitatId, sessionId, viewingTaskId ?? null);
      return { success: true };
    }
  );

  /** POST /presence/leave - Leave a board session. No auth. Returns { success: true } */
  fastify.post<{ Body: LeaveBody }>(
    '/presence/leave',
    async (request: FastifyRequest<{ Body: LeaveBody }>, _reply: FastifyReply) => {
      const { sessionId, habitatId } = request.body;
      if (!sessionId || !habitatId) {
        throw badRequest('sessionId and habitatId are required');
      }
      leaveHabitat(habitatId, sessionId);
      return { success: true };
    }
  );

  /** GET /presence/viewers/:habitatId - Get active viewers on a board. No auth. Returns { viewers } */
  fastify.get<{ Params: { habitatId: string } }>(
    '/presence/viewers/:habitatId',
    async (request: FastifyRequest<{ Params: { habitatId: string } }>, _reply: FastifyReply) => {
      const { habitatId } = request.params;
      const viewers = getHabitatPresence(habitatId);
      return { viewers };
    }
  );
}
