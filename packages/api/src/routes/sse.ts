import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sseBroadcaster } from '../sse/broadcaster.js';
import { authenticateRealtime, authorizeBoardAccess } from '../middleware/realtimeAuth.js';
import type { SSEEvent } from '../models/index.js';

export async function sseRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { habitatId: string } }>(
    '/habitats/:habitatId/stream',
    { preHandler: [authenticateRealtime, authorizeBoardAccess] },
    async (request: FastifyRequest<{ Params: { habitatId: string } }>, reply: FastifyReply) => {
      const boardId = request.params.habitatId;

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Accel-Buffering', 'no');

      const encoder = new TextEncoder();

      const unsubscribe = sseBroadcaster.subscribe(boardId, (event: SSEEvent) => {
        const data = `data: ${JSON.stringify(event)}\n\n`;
        reply.raw.write(encoder.encode(data));
      });

      reply.raw.write(encoder.encode(`data: ${JSON.stringify({ type: 'connected', data: { boardId } })}\n\n`));

      request.raw.on('close', () => {
        unsubscribe();
      });

      request.raw.on('error', () => {
        unsubscribe();
      });
    }
  );
}
