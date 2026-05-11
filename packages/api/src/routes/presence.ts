import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { joinBoard, leaveBoard, setViewingTask, getBoardPresence } from '../sse/presence.js';
import type { PresenceType } from '../models/index.js';
import { badRequest } from '../errors.js';

interface JoinBody {
  sessionId: string;
  type: PresenceType;
  boardId: string;
  userId?: string;
  userName?: string;
  agentId?: string;
  agentName?: string;
}

interface HeartbeatBody {
  sessionId: string;
  boardId: string;
  viewingTaskId?: string | null;
}

interface LeaveBody {
  sessionId: string;
  boardId: string;
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
    async (request: FastifyRequest<{ Body: JoinBody }>, reply: FastifyReply) => {
      const { sessionId, type, boardId, userId, userName, agentId, agentName } = request.body;
      if (!sessionId || !type || !boardId) {
        throw badRequest('sessionId, type, and boardId are required');
      }
      joinBoard(boardId, { sessionId, type, boardId, userId, userName, agentId, agentName, viewingTaskId: null });
      return { success: true };
    }
  );

  /** POST /presence/heartbeat - Send presence heartbeat. No auth. Returns { success: true } */
  fastify.post<{ Body: HeartbeatBody }>(
    '/presence/heartbeat',
    async (request: FastifyRequest<{ Body: HeartbeatBody }>, reply: FastifyReply) => {
      const { sessionId, boardId, viewingTaskId } = request.body;
      if (!sessionId || !boardId) {
        throw badRequest('sessionId and boardId are required');
      }
      setViewingTask(boardId, sessionId, viewingTaskId ?? null);
      return { success: true };
    }
  );

  /** POST /presence/leave - Leave a board session. No auth. Returns { success: true } */
  fastify.post<{ Body: LeaveBody }>(
    '/presence/leave',
    async (request: FastifyRequest<{ Body: LeaveBody }>, reply: FastifyReply) => {
      const { sessionId, boardId } = request.body;
      if (!sessionId || !boardId) {
        throw badRequest('sessionId and boardId are required');
      }
      leaveBoard(boardId, sessionId);
      return { success: true };
    }
  );

  /** GET /presence/viewers/:boardId - Get active viewers on a board. No auth. Returns { viewers } */
  fastify.get<{ Params: { boardId: string } }>(
    '/presence/viewers/:boardId',
    async (request: FastifyRequest<{ Params: { boardId: string } }>, reply: FastifyReply) => {
      const { boardId } = request.params;
      const viewers = getBoardPresence(boardId);
      return { viewers };
    }
  );
}
