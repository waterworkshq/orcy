import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getIntegrationsByBoard, getIntegrationById, createIntegration, updateIntegration, deleteIntegration } from '../repositories/chatIntegration.js';
import { getBoardById } from '../repositories/board.js';
import { humanAuth } from '../middleware/auth.js';
import { adminOnly } from '../middleware/rbac.js';
import { verifySlackRequest, verifySlackRequestWithTimestamp, parseSlackCommand } from '../services/slackService.js';
import { verifyDiscordRequest } from '../services/discordService.js';
import { executeCommand, sendTestMessage } from '../services/chatService.js';
import { isRemotePosture, validateOutboundUrl } from '../config/integrationSecurity.js';

interface CreateIntegrationBody {
  provider: 'slack' | 'discord';
  webhookUrl: string;
  channelId?: string;
  botToken?: string;
  events?: string[];
}

interface UpdateIntegrationBody {
  webhookUrl?: string;
  channelId?: string;
  botToken?: string;
  enabled?: boolean;
  events?: string[];
}

const VALID_CHAT_EVENTS = [
  'task_created', 'task_claimed', 'task_submitted',
  'task_approved', 'task_rejected', 'task_overdue',
];

export async function chatIntegrationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { boardId: string } }>(
    '/boards/:boardId/chat-integrations',
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { boardId: string } }>, reply: FastifyReply) => {
      const { boardId } = request.params;
      const board = getBoardById(boardId);
      if (!board) {
        reply.code(404).send({ error: 'Board not found' });
        return;
      }
      const integrations = getIntegrationsByBoard(boardId);
      return integrations.map(i => ({
        ...i,
        botToken: i.botToken ? '********' : null,
      }));
    }
  );

  fastify.post<{ Params: { boardId: string }; Body: CreateIntegrationBody }>(
    '/boards/:boardId/chat-integrations',
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { boardId: string }; Body: CreateIntegrationBody }>, reply: FastifyReply) => {
      const { boardId } = request.params;
      const { provider, webhookUrl, channelId, botToken, events } = request.body;

      if (!provider || !webhookUrl) {
        reply.code(400).send({ error: 'provider and webhookUrl are required' });
        return;
      }

      if (provider !== 'slack' && provider !== 'discord') {
        reply.code(400).send({ error: 'provider must be slack or discord' });
        return;
      }

      const urlValidation = await validateOutboundUrl(webhookUrl);
      if (!urlValidation.valid) {
        reply.code(400).send({ error: `Unsafe webhook URL: ${urlValidation.reason}` });
        return;
      }

      const board = getBoardById(boardId);
      if (!board) {
        reply.code(404).send({ error: 'Board not found' });
        return;
      }

      if (events) {
        for (const event of events) {
          if (!VALID_CHAT_EVENTS.includes(event)) {
            reply.code(400).send({ error: `Invalid event type: ${event}` });
            return;
          }
        }
      }

      const integration = createIntegration({
        boardId,
        provider,
        webhookUrl,
        channelId,
        botToken,
        events,
      });

      return integration;
    }
  );

  fastify.put<{ Params: { id: string }; Body: UpdateIntegrationBody }>(
    '/chat-integrations/:id',
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { id: string }; Body: UpdateIntegrationBody }>, reply: FastifyReply) => {
      const { id } = request.params;
      const updates = request.body;

      const existing = getIntegrationById(id);
      if (!existing) {
        reply.code(404).send({ error: 'Integration not found' });
        return;
      }

      if (updates.events) {
        for (const event of updates.events) {
          if (!VALID_CHAT_EVENTS.includes(event)) {
            reply.code(400).send({ error: `Invalid event type: ${event}` });
            return;
          }
        }
      }

      if (updates.webhookUrl) {
        const urlValidation = await validateOutboundUrl(updates.webhookUrl);
        if (!urlValidation.valid) {
          reply.code(400).send({ error: `Unsafe webhook URL: ${urlValidation.reason}` });
          return;
        }
      }

      const success = updateIntegration(id, updates);
      if (!success) {
        reply.code(500).send({ error: 'Failed to update integration' });
        return;
      }

      const updated = getIntegrationById(id)!;
      return {
        ...updated,
        botToken: updated.botToken ? '********' : null,
      };
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/chat-integrations/:id',
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const existing = getIntegrationById(id);
      if (!existing) {
        reply.code(404).send({ error: 'Integration not found' });
        return;
      }
      const success = deleteIntegration(id);
      if (!success) {
        reply.code(500).send({ error: 'Failed to delete integration' });
        return;
      }
      return { success: true };
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/chat-integrations/:id/test',
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const integration = getIntegrationById(id);
      if (!integration) {
        reply.code(404).send({ error: 'Integration not found' });
        return;
      }

      const result = await sendTestMessage(integration.webhookUrl, integration.provider);
      return result;
    }
  );

  fastify.post(
    '/chat/slack/command',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const signingSecret = process.env.SLACK_SIGNING_SECRET ?? '';
      const signature = request.headers['x-slack-signature'] as string | undefined;
      const timestamp = request.headers['x-slack-request-timestamp'] as string | undefined;
      const rawBody = typeof request.rawBody === 'string' ? request.rawBody : JSON.stringify(request.body);

      if (signingSecret) {
        const result = verifySlackRequestWithTimestamp(signature, timestamp, rawBody, signingSecret);
        if (!result.valid) {
          reply.code(401).send({ error: result.reason ?? 'Invalid signature' });
          return;
        }
      } else if (isRemotePosture()) {
        reply.code(401).send({ error: 'Slack signing secret not configured' });
        return;
      }

      const payload = request.body as {
        text?: string;
        team_id?: string;
        channel_id?: string;
        user_id?: string;
        response_url?: string;
      };

      const text = payload.text ?? '';
      const { action, args } = parseSlackCommand(text);

      if (action === 'help' || !text.trim()) {
        const { response } = await executeCommand('help', 'help', []);
        reply.send((response as { slack: object }).slack);
        return;
      }

      const boardId = process.env.ORCY_DEFAULT_HABITAT_ID;
      if (!boardId) {
        reply.send({ text: 'No default board configured. Set ORCY_DEFAULT_HABITAT_ID.' });
        return;
      }

      const { response } = await executeCommand(boardId, action, args, payload.user_id);
      reply.send((response as { slack: object }).slack);
    }
  );

  fastify.post(
    '/chat/discord/interaction',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const publicKey = process.env.DISCORD_PUBLIC_KEY ?? '';
      const signature = request.headers['x-signature-ed25519'] as string | undefined;
      const timestamp = request.headers['x-signature-timestamp'] as string | undefined;

      const rawBody = typeof request.rawBody === 'string' ? request.rawBody : JSON.stringify(request.body);

      if (publicKey) {
        if (!verifyDiscordRequest(signature, timestamp, rawBody, publicKey)) {
          reply.code(401).send({ error: 'Invalid signature' });
          return;
        }
      } else if (isRemotePosture()) {
        reply.code(401).send({ error: 'Discord public key not configured' });
        return;
      }

      const payload = request.body as {
        type?: number;
        data?: { name?: string; options?: Array<{ name: string; value: string; options?: Array<{ name: string; value: string }> }> };
        guild_id?: string;
        channel_id?: string;
        member?: { user?: { id: string } };
      };

      if (payload.type === 1) {
        reply.send({ type: 1 });
        return;
      }

      if (payload.type === 2 && payload.data) {
        const { parseDiscordCommand } = await import('../services/discordService.js');
        const { action, args } = parseDiscordCommand(payload.data);

        const boardId = process.env.ORCY_DEFAULT_HABITAT_ID;
        if (!boardId) {
          reply.send({
            type: 4,
            data: { content: 'No default board configured. Set ORCY_DEFAULT_HABITAT_ID.' },
          });
          return;
        }

        const { response } = await executeCommand(boardId, action, args, payload.member?.user?.id);
        const discordResponse = (response as { discord: object }).discord;
        reply.send({ type: 4, data: discordResponse });
        return;
      }

      reply.code(400).send({ error: 'Unknown interaction type' });
    }
  );
}
