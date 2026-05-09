import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  createWebhookSubscription,
  getWebhookSubscriptions,
  getWebhookSubscriptionById,
  updateWebhookSubscription,
  deleteWebhookSubscription,
  rotateWebhookSecret,
  getDeliveriesForSubscription,
  sendTestWebhook,
} from '../services/webhookDispatcher.js';
import { getBoardById } from '../repositories/board.js';
import { humanAuth } from '../middleware/auth.js';
import { adminOnly } from '../middleware/rbac.js';
import { validateOutboundUrl, filterUnsafeHeaders } from '../config/integrationSecurity.js';

interface CreateWebhookBody {
  boardId: string | null;
  name: string;
  url: string;
  format?: 'standard' | 'slack' | 'discord';
  events?: string[];
  headers?: Record<string, string>;
}

interface UpdateWebhookBody {
  name?: string;
  url?: string;
  format?: 'standard' | 'slack' | 'discord';
  events?: string[];
  headers?: Record<string, string>;
  enabled?: boolean;
}

const VALID_EVENTS = [
  'task.created', 'task.updated', 'task.moved',
  'task.claimed', 'task.submitted', 'task.approved',
  'task.rejected', 'task.completed', 'task.failed',
  'task.released', 'agent.status_changed', 'agent.heartbeat',
  'column.wip_limit_reached',
];

/**
 * Webhook subscription management — create, update, delete, rotate secrets,
 * send test pings, and inspect delivery history.
 */
export async function webhookRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /webhooks - List webhook subscriptions. Auth: humanAuth + adminOnly. Returns subscriptions */
  fastify.get<{ Querystring: { boardId?: string } }>(
    '/webhooks',
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Querystring: { boardId?: string } }>, reply: FastifyReply) => {
      const boardId = request.query.boardId || undefined;
      const subscriptions = getWebhookSubscriptions(boardId);
      return subscriptions.map(sub => ({
        ...sub,
        secret: sub.secret ? '********' : null,
      }));
    }
  );

  /** POST /webhooks - Create a webhook subscription. Auth: humanAuth + adminOnly. Returns subscription */
  fastify.post<{ Body: CreateWebhookBody }>(
    '/webhooks',
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Body: CreateWebhookBody }>, reply: FastifyReply) => {
      const { boardId, name, url, format = 'standard', events = [], headers = {} } = request.body;

      if (!name || !url) {
        reply.code(400).send({ error: 'name and url are required' });
        return;
      }

      const urlValidation = await validateOutboundUrl(url);
      if (!urlValidation.valid) {
        reply.code(400).send({ error: `Unsafe webhook URL: ${urlValidation.reason}` });
        return;
      }

      const headerFilter = filterUnsafeHeaders(headers);
      if (headerFilter.blocked.length > 0) {
        reply.code(400).send({ error: `Blocked custom headers: ${headerFilter.blocked.join(', ')}. Remove sensitive headers or request explicit allowlisting.` });
        return;
      }

      if (boardId) {
        const board = getBoardById(boardId);
        if (!board) {
          reply.code(404).send({ error: 'Board not found' });
          return;
        }
      }

      for (const event of events) {
        if (!VALID_EVENTS.includes(event)) {
          reply.code(400).send({ error: `Invalid event type: ${event}` });
          return;
        }
      }

      const subscription = createWebhookSubscription(
        boardId || null,
        name,
        url,
        format,
        events,
        headerFilter.headers
      );

      return {
        ...subscription,
        secret: subscription.secret,
      };
    }
  );

  /** PUT /webhooks/:id - Update a webhook subscription. Auth: humanAuth + adminOnly. Returns updated */
  fastify.put<{ Params: { id: string }; Body: UpdateWebhookBody }>(
    '/webhooks/:id',
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { id: string }; Body: UpdateWebhookBody }>, reply: FastifyReply) => {
      const { id } = request.params;
      const updates = request.body;

      const existing = getWebhookSubscriptionById(id);
      if (!existing) {
        reply.code(404).send({ error: 'Webhook subscription not found' });
        return;
      }

      if (updates.events) {
        for (const event of updates.events) {
          if (!VALID_EVENTS.includes(event)) {
            reply.code(400).send({ error: `Invalid event type: ${event}` });
            return;
          }
        }
      }

      if (updates.url) {
        const urlValidation = await validateOutboundUrl(updates.url);
        if (!urlValidation.valid) {
          reply.code(400).send({ error: `Unsafe webhook URL: ${urlValidation.reason}` });
          return;
        }
      }

      if (updates.headers) {
        const headerFilter = filterUnsafeHeaders(updates.headers);
        if (headerFilter.blocked.length > 0) {
          reply.code(400).send({ error: `Blocked custom headers: ${headerFilter.blocked.join(', ')}. Remove sensitive headers or request explicit allowlisting.` });
          return;
        }
        updates.headers = headerFilter.headers;
      }

      const success = updateWebhookSubscription(id, updates);
      if (!success) {
        reply.code(500).send({ error: 'Failed to update subscription' });
        return;
      }

      const updated = getWebhookSubscriptionById(id)!;
      return {
        ...updated,
        secret: updated.secret ? '********' : null,
      };
    }
  );

  /** DELETE /webhooks/:id - Delete a webhook subscription. Auth: humanAuth + adminOnly. Returns { success } */
  fastify.delete<{ Params: { id: string } }>(
    '/webhooks/:id',
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;

      const existing = getWebhookSubscriptionById(id);
      if (!existing) {
        reply.code(404).send({ error: 'Webhook subscription not found' });
        return;
      }

      const success = deleteWebhookSubscription(id);
      if (!success) {
        reply.code(500).send({ error: 'Failed to delete subscription' });
        return;
      }

      return { success: true };
    }
  );

  /** POST /webhooks/:id/test - Send a test webhook. Auth: humanAuth + adminOnly. Returns { success, statusCode, latencyMs } */
  fastify.post<{ Params: { id: string } }>(
    '/webhooks/:id/test',
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;

      const subscription = getWebhookSubscriptionById(id);
      if (!subscription) {
        reply.code(404).send({ error: 'Webhook subscription not found' });
        return;
      }

      const result = await sendTestWebhook(subscription);

      return {
        success: result.success,
        statusCode: result.statusCode,
        latencyMs: result.latencyMs,
      };
    }
  );

  /** POST /webhooks/:id/rotate-secret - Rotate webhook secret. Auth: humanAuth + adminOnly. Returns { secret } */
  fastify.post<{ Params: { id: string } }>(
    '/webhooks/:id/rotate-secret',
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;

      const existing = getWebhookSubscriptionById(id);
      if (!existing) {
        reply.code(404).send({ error: 'Webhook subscription not found' });
        return;
      }

      const newSecret = rotateWebhookSecret(id);
      if (!newSecret) {
        reply.code(500).send({ error: 'Failed to rotate secret' });
        return;
      }

      return { secret: newSecret };
    }
  );

  /** GET /webhooks/:id/deliveries - Get webhook delivery history. Auth: humanAuth + adminOnly. Returns deliveries */
  fastify.get<{ Params: { id: string }; Querystring: { limit?: number } }>(
    '/webhooks/:id/deliveries',
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { id: string }; Querystring: { limit?: number } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const limit = request.query.limit || 25;

      const subscription = getWebhookSubscriptionById(id);
      if (!subscription) {
        reply.code(404).send({ error: 'Webhook subscription not found' });
        return;
      }

      const deliveries = getDeliveriesForSubscription(id, limit);
      return deliveries;
    }
  );
}