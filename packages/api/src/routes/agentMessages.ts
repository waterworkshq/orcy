import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as agentMessageRepo from '../repositories/agentMessage.js';
import * as agentRepo from '../repositories/agent.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import { agentAuth } from '../middleware/auth.js';

export function requireSelfAgent(request: FastifyRequest, agentId: string): boolean {
  return request.agent?.id === agentId;
}

export async function agentMessageRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { agentId: string }; Body: { boardId: string; toAgentId: string; taskId?: string; subject: string; body: string; messageType?: 'info' | 'request' | 'response' | 'alert'; priority?: 'low' | 'normal' | 'high' | 'urgent' } }>(
    '/agents/:agentId/messages',
    { preHandler: agentAuth },
    async (request: FastifyRequest<{ Params: { agentId: string }; Body: { boardId: string; toAgentId: string; taskId?: string; subject: string; body: string; messageType?: 'info' | 'request' | 'response' | 'alert'; priority?: 'low' | 'normal' | 'high' | 'urgent' } }>, reply: FastifyReply) => {
      const { agentId } = request.params;
      const body = request.body;

      if (!request.agent || !requireSelfAgent(request, agentId)) {
        reply.code(403).send({ error: 'Agent can only send messages as itself' });
        return;
      }

      if (!body.subject || !body.body || !body.toAgentId || !body.boardId) {
        reply.code(400).send({ error: 'Missing required fields: boardId, toAgentId, subject, body' });
        return;
      }

      const toAgent = agentRepo.getAgentById(body.toAgentId);
      if (!toAgent) {
        reply.code(404).send({ error: 'Recipient agent not found' });
        return;
      }

      const authenticatedAgentId = request.agent.id;

      const message = agentMessageRepo.createMessage({
        boardId: body.boardId,
        fromAgentId: authenticatedAgentId,
        toAgentId: body.toAgentId,
        taskId: body.taskId,
        subject: body.subject,
        body: body.body,
        messageType: body.messageType,
        priority: body.priority,
      });

      sseBroadcaster.publish(body.boardId, {
        type: 'agent.message_received',
        data: {
          messageId: message.id,
          fromAgentId: authenticatedAgentId,
          fromAgentName: request.agent.name,
          toAgentId: body.toAgentId,
          subject: message.subject,
          messageType: message.messageType,
          priority: message.priority,
          taskId: message.taskId,
          boardId: body.boardId,
        },
      });

      reply.code(201).send({ message });
    }
  );

  fastify.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/messages',
    { preHandler: agentAuth },
    async (request: FastifyRequest<{ Params: { agentId: string } }>, reply: FastifyReply) => {
      const { agentId } = request.params;

      if (!request.agent || !requireSelfAgent(request, agentId)) {
        reply.code(403).send({ error: 'Agent can only read its own messages' });
        return;
      }

      const query = request.query as { unreadOnly?: string; taskId?: string; limit?: string; offset?: string };

      const result = agentMessageRepo.getMessagesByAgent(agentId, {
        unreadOnly: query.unreadOnly === 'true',
        taskId: query.taskId,
        limit: query.limit ? parseInt(query.limit, 10) : undefined,
        offset: query.offset ? parseInt(query.offset, 10) : undefined,
      });

      const unreadCount = agentMessageRepo.getUnreadCount(agentId);

      return { messages: result.messages, total: result.total, unreadCount };
    }
  );

  fastify.put<{ Params: { id: string } }>(
    '/agents/messages/:id/read',
    { preHandler: agentAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!request.agent) {
        reply.code(401).send({ error: 'Authentication required' });
        return;
      }

      const message = agentMessageRepo.getMessageById(request.params.id);
      if (!message) {
        reply.code(404).send({ error: 'Message not found' });
        return;
      }

      if (message.toAgentId !== request.agent.id && message.fromAgentId !== request.agent.id) {
        reply.code(403).send({ error: 'Not authorized to modify this message' });
        return;
      }

      const updated = agentMessageRepo.markAsRead(request.params.id);
      if (!updated) {
        reply.code(404).send({ error: 'Message not found or already read' });
        return;
      }
      return { message: updated };
    }
  );

  fastify.put<{ Params: { agentId: string } }>(
    '/agents/:agentId/messages/read-all',
    { preHandler: agentAuth },
    async (request: FastifyRequest<{ Params: { agentId: string } }>, reply: FastifyReply) => {
      if (!request.agent || !requireSelfAgent(request, request.params.agentId)) {
        reply.code(403).send({ error: 'Agent can only mark its own messages as read' });
        return;
      }

      const count = agentMessageRepo.markAllAsRead(request.params.agentId);
      return { updated: count };
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/agents/messages/:id',
    { preHandler: agentAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!request.agent) {
        reply.code(401).send({ error: 'Authentication required' });
        return;
      }

      const message = agentMessageRepo.getMessageById(request.params.id);
      if (!message) {
        reply.code(404).send({ error: 'Message not found' });
        return;
      }

      if (message.toAgentId !== request.agent.id && message.fromAgentId !== request.agent.id) {
        reply.code(403).send({ error: 'Not authorized to delete this message' });
        return;
      }

      agentMessageRepo.deleteMessage(request.params.id);
      reply.code(204).send();
    }
  );
}
