import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as agentMessageRepo from '../repositories/agentMessage.js';
import * as agentRepo from '../repositories/agent.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import { agentAuth } from '../middleware/auth.js';
import { unauthorized, forbidden, notFound, badRequest } from '../errors.js';

export function requireSelfAgent(request: FastifyRequest, agentId: string): boolean {
  return request.agent?.id === agentId;
}

export async function agentMessageRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { agentId: string }; Body: { habitatId: string; toAgentId: string; taskId?: string; subject: string; body: string; messageType?: 'info' | 'request' | 'response' | 'alert'; priority?: 'low' | 'normal' | 'high' | 'urgent' } }>(
    '/agents/:agentId/messages',
    { preHandler: agentAuth },
    async (request: FastifyRequest<{ Params: { agentId: string }; Body: { habitatId: string; toAgentId: string; taskId?: string; subject: string; body: string; messageType?: 'info' | 'request' | 'response' | 'alert'; priority?: 'low' | 'normal' | 'high' | 'urgent' } }>, reply: FastifyReply) => {
      const { agentId } = request.params;
      const body = request.body;

      if (!request.agent || !requireSelfAgent(request, agentId)) {
        throw forbidden('Agent can only send messages as itself');
      }

      if (!body.subject || !body.body || !body.toAgentId || !body.habitatId) {
        throw badRequest('Missing required fields: habitatId, toAgentId, subject, body');
      }

      const toAgent = agentRepo.getAgentById(body.toAgentId);
      if (!toAgent) {
        throw notFound('Recipient agent not found');
      }

      const authenticatedAgentId = request.agent.id;

      const message = agentMessageRepo.createMessage({
        habitatId: body.habitatId,
        fromAgentId: authenticatedAgentId,
        toAgentId: body.toAgentId,
        taskId: body.taskId,
        subject: body.subject,
        body: body.body,
        messageType: body.messageType,
        priority: body.priority,
      });

      sseBroadcaster.publish(body.habitatId, {
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
          habitatId: body.habitatId,
        },
      });

      reply.code(201).send({ message });
    }
  );

  fastify.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/messages',
    { preHandler: agentAuth },
    async (request: FastifyRequest<{ Params: { agentId: string } }>, _reply: FastifyReply) => {
      const { agentId } = request.params;

      if (!request.agent || !requireSelfAgent(request, agentId)) {
        throw forbidden('Agent can only read its own messages');
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
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      if (!request.agent) {
        throw unauthorized('Authentication required');
      }

      const message = agentMessageRepo.getMessageById(request.params.id);
      if (!message) {
        throw notFound('Message not found');
      }

      if (message.toAgentId !== request.agent.id && message.fromAgentId !== request.agent.id) {
        throw forbidden('Not authorized to modify this message');
      }

      const updated = agentMessageRepo.markAsRead(request.params.id);
      if (!updated) {
        throw notFound('Message not found or already read');
      }
      return { message: updated };
    }
  );

  fastify.put<{ Params: { agentId: string } }>(
    '/agents/:agentId/messages/read-all',
    { preHandler: agentAuth },
    async (request: FastifyRequest<{ Params: { agentId: string } }>, _reply: FastifyReply) => {
      if (!request.agent || !requireSelfAgent(request, request.params.agentId)) {
        throw forbidden('Agent can only mark its own messages as read');
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
        throw unauthorized('Authentication required');
      }

      const message = agentMessageRepo.getMessageById(request.params.id);
      if (!message) {
        throw notFound('Message not found');
      }

      if (message.toAgentId !== request.agent.id && message.fromAgentId !== request.agent.id) {
        throw forbidden('Not authorized to delete this message');
      }

      agentMessageRepo.deleteMessage(request.params.id);
      reply.code(204).send();
    }
  );
}
