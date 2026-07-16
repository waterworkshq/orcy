import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getIntegrationsByHabitat, getIntegrationById, createIntegration, updateIntegration, deleteIntegration } from '../repositories/chatIntegration.js';
import { getHabitatById } from '../repositories/board.js';
import { humanAuth } from '../middleware/auth.js';
import { adminOnly } from '../middleware/rbac.js';
import { verifySlackRequestWithTimestamp, parseSlackCommand } from '../services/slackService.js';
import { verifyDiscordRequest } from '../services/discordService.js';
import { executeCommand, sendTestMessage } from '../services/chatService.js';
import { isRemotePosture, validateOutboundUrl } from '../config/integrationSecurity.js';
import { badRequest, notFound, unauthorized, internalError } from '../errors.js';

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
  fastify.get<{ Params: { habitatId: string } }>(
    '/habitats/:habitatId/chat-integrations',
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { habitatId: string } }>, _reply: FastifyReply) => {
      const { habitatId } = request.params;
      const habitat = getHabitatById(habitatId);
      if (!habitat) {
        throw notFound('Habitat not found');
      }
      const integrations = getIntegrationsByHabitat(habitatId);
      return integrations.map(i => ({
        ...i,
        botToken: i.botToken ? '********' : null,
      }));
    }
  );

  fastify.post<{ Params: { habitatId: string }; Body: CreateIntegrationBody }>(
    '/habitats/:habitatId/chat-integrations',
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { habitatId: string }; Body: CreateIntegrationBody }>, _reply: FastifyReply) => {
      const { habitatId } = request.params;
      const { provider, webhookUrl, channelId, botToken, events } = request.body;

      if (!provider || !webhookUrl) {
        throw badRequest('provider and webhookUrl are required');
      }

      if (provider !== 'slack' && provider !== 'discord') {
        throw badRequest('provider must be slack or discord');
      }

      const urlValidation = await validateOutboundUrl(webhookUrl);
      if (!urlValidation.valid) {
        throw badRequest(`Unsafe webhook URL: ${urlValidation.reason}`);
      }

      const habitat = getHabitatById(habitatId);
      if (!habitat) {
        throw notFound('Habitat not found');
      }

      if (events) {
        for (const event of events) {
          if (!VALID_CHAT_EVENTS.includes(event)) {
            throw badRequest(`Invalid event type: ${event}`);
          }
        }
      }

      const integration = createIntegration({
        habitatId: habitatId,
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
    async (request: FastifyRequest<{ Params: { id: string }; Body: UpdateIntegrationBody }>, _reply: FastifyReply) => {
      const { id } = request.params;
      const updates = request.body;

      const existing = getIntegrationById(id);
      if (!existing) {
        throw notFound('Integration not found');
      }

      if (updates.events) {
        for (const event of updates.events) {
          if (!VALID_CHAT_EVENTS.includes(event)) {
            throw badRequest(`Invalid event type: ${event}`);
          }
        }
      }

      if (updates.webhookUrl) {
        const urlValidation = await validateOutboundUrl(updates.webhookUrl);
        if (!urlValidation.valid) {
          throw badRequest(`Unsafe webhook URL: ${urlValidation.reason}`);
        }
      }

      const success = updateIntegration(id, updates);
      if (!success) {
        throw internalError('Failed to update integration');
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
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const { id } = request.params;
      const existing = getIntegrationById(id);
      if (!existing) {
        throw notFound('Integration not found');
      }
      const success = deleteIntegration(id);
      if (!success) {
        throw internalError('Failed to delete integration');
      }
      return { success: true };
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/chat-integrations/:id/test',
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const { id } = request.params;
      const integration = getIntegrationById(id);
      if (!integration) {
        throw notFound('Integration not found');
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
          throw unauthorized(result.reason ?? 'Invalid signature');
        }
      } else if (isRemotePosture()) {
        throw unauthorized('Slack signing secret not configured');
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

      const habitatId = process.env.ORCY_DEFAULT_HABITAT_ID;
      if (!habitatId) {
        reply.send({ text: 'No default board configured. Set ORCY_DEFAULT_HABITAT_ID.' });
        return;
      }

      const { response } = await executeCommand(habitatId, action, args, payload.user_id);
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
          throw unauthorized('Invalid signature');
        }
      } else if (isRemotePosture()) {
        throw unauthorized('Discord public key not configured');
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

        const habitatId = process.env.ORCY_DEFAULT_HABITAT_ID;
        if (!habitatId) {
          reply.send({
            type: 4,
            data: { content: 'No default board configured. Set ORCY_DEFAULT_HABITAT_ID.' },
          });
          return;
        }

        const { response } = await executeCommand(habitatId, action, args, payload.member?.user?.id);
        const discordResponse = (response as { discord: object }).discord;
        reply.send({ type: 4, data: discordResponse });
        return;
      }

      throw badRequest('Unknown interaction type');
    }
  );
}
