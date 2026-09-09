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
import { getHabitatById } from '../repositories/habitat.js';
import { adminOnly } from '../middleware/rbac.js';
import { validateOutboundUrl, filterUnsafeHeaders } from '../config/integrationSecurity.js';
import { badRequest, notFound, internalError } from '../errors.js';
import { applyDeclaredAuthPolicies } from "../authPolicy.js";
import {
  isNotificationWebhookEventEntry,
  NOTIFICATION_EVENT_CATALOG,
} from "../services/notificationSubscriptionResolver.js";

interface CreateWebhookBody {
  habitatId: string | null;
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
 * One validator for board events AND the namespaced notification opt-in.
 * A `notification:<type>` entry authorizes the subscription as a
 * notification destination for that catalog type — closed against the owning
 * V18 catalog (unknown namespaced names are rejected, never
 * open-string-accepted). Notification payloads are the signed standard
 * envelope only: a namespaced entry requires `format: 'standard'` — the
 * combination is rejected HERE, at configuration, rather than silently
 * sending a wrong payload shape at delivery time.
 */
function isValidWebhookEventEntry(event: string): boolean {
  return VALID_EVENTS.includes(event) || isNotificationWebhookEventEntry(event);
}

function assertEventsCompatibleWithFormat(
  events: string[],
  format: 'standard' | 'slack' | 'discord',
): void {
  if (format === 'standard') return;
  const namespaced = events.filter((event) => event.startsWith('notification:'));
  if (namespaced.length > 0) {
    throw badRequest(
      `notification event entries (${namespaced.join(', ')}) require format 'standard' — ` +
        `the notification payload is a signed standard envelope. Remove the entries or use a standard-format subscription.`,
    );
  }
}

/**
 * Webhook subscription management — create, update, delete, rotate secrets,
 * send test pings, and inspect delivery history.
 */
export async function webhookRoutes(fastify: FastifyInstance): Promise<void> {
  applyDeclaredAuthPolicies(fastify);

  /** GET /webhooks - List webhook subscriptions. Auth: humanAuth + adminOnly. Returns subscriptions */
  fastify.get<{ Querystring: { habitatId?: string } }>(
    '/webhooks',
    { preHandler: [adminOnly], config: { authPolicy: "human" } },
    async (request: FastifyRequest<{ Querystring: { habitatId?: string } }>, _reply: FastifyReply) => {
      const habitatId = request.query.habitatId || undefined;
      const subscriptions = getWebhookSubscriptions(habitatId);
      return subscriptions.map(sub => ({
        ...sub,
        secret: sub.secret ? '********' : null,
      }));
    }
  );

  /** POST /webhooks - Create a webhook subscription. Auth: humanAuth + adminOnly. Returns subscription */
  fastify.post<{ Body: CreateWebhookBody }>(
    '/webhooks',
    { preHandler: [adminOnly], config: { authPolicy: "human" } },
    async (request: FastifyRequest<{ Body: CreateWebhookBody }>, _reply: FastifyReply) => {
      const { habitatId, name, url, format = 'standard', events = [], headers = {} } = request.body;

      if (!name || !url) {
        throw badRequest('name and url are required');
      }

      const urlValidation = await validateOutboundUrl(url);
      if (!urlValidation.valid) {
        throw badRequest(`Unsafe webhook URL: ${urlValidation.reason}`);
      }

      const headerFilter = filterUnsafeHeaders(headers);
      if (headerFilter.blocked.length > 0) {
        throw badRequest(`Blocked custom headers: ${headerFilter.blocked.join(', ')}. Remove sensitive headers or request explicit allowlisting.`);
      }

      if (habitatId) {
        const habitat = getHabitatById(habitatId);
        if (!habitat) {
          throw notFound('Habitat not found');
        }
      }

      for (const event of events) {
        if (!isValidWebhookEventEntry(event)) {
          throw badRequest(`Invalid event type: ${event}`);
        }
      }
      assertEventsCompatibleWithFormat(events, format);

      const subscription = createWebhookSubscription(
        habitatId || null,
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
    { preHandler: [adminOnly], config: { authPolicy: "human" } },
    async (request: FastifyRequest<{ Params: { id: string }; Body: UpdateWebhookBody }>, _reply: FastifyReply) => {
      const { id } = request.params;
      const updates = request.body;

      const existing = getWebhookSubscriptionById(id);
      if (!existing) {
        throw notFound('Webhook subscription not found');
      }

      if (updates.events) {
        for (const event of updates.events) {
          if (!isValidWebhookEventEntry(event)) {
            throw badRequest(`Invalid event type: ${event}`);
          }
        }
      }

      // The format constraint binds the RESULTING subscription: an update may
      // add namespaced entries, change format, or both — the combination
      // carried after the update is what must be lawful.
      const resultingFormat = updates.format ?? (existing.format as 'standard' | 'slack' | 'discord');
      const resultingEvents = updates.events ?? existing.events;
      assertEventsCompatibleWithFormat(resultingEvents, resultingFormat);

      if (updates.url) {
        const urlValidation = await validateOutboundUrl(updates.url);
        if (!urlValidation.valid) {
          throw badRequest(`Unsafe webhook URL: ${urlValidation.reason}`);
        }
      }

      if (updates.headers) {
        const headerFilter = filterUnsafeHeaders(updates.headers);
        if (headerFilter.blocked.length > 0) {
          throw badRequest(`Blocked custom headers: ${headerFilter.blocked.join(', ')}. Remove sensitive headers or request explicit allowlisting.`);
        }
        updates.headers = headerFilter.headers;
      }

      const success = updateWebhookSubscription(id, updates);
      if (!success) {
        throw internalError('Failed to update subscription');
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
    { preHandler: [adminOnly], config: { authPolicy: "human" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const { id } = request.params;

      const existing = getWebhookSubscriptionById(id);
      if (!existing) {
        throw notFound('Webhook subscription not found');
      }

      const success = deleteWebhookSubscription(id);
      if (!success) {
        throw internalError('Failed to delete subscription');
      }

      return { success: true };
    }
  );

  /** POST /webhooks/:id/test - Send a test webhook. Auth: humanAuth + adminOnly. Returns { success, statusCode, latencyMs } */
  fastify.post<{ Params: { id: string } }>(
    '/webhooks/:id/test',
    { preHandler: [adminOnly], config: { authPolicy: "human" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const { id } = request.params;

      const subscription = getWebhookSubscriptionById(id);
      if (!subscription) {
        throw notFound('Webhook subscription not found');
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
    { preHandler: [adminOnly], config: { authPolicy: "human" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const { id } = request.params;

      const existing = getWebhookSubscriptionById(id);
      if (!existing) {
        throw notFound('Webhook subscription not found');
      }

      const newSecret = rotateWebhookSecret(id);
      if (!newSecret) {
        throw internalError('Failed to rotate secret');
      }

      return { secret: newSecret };
    }
  );

  /** GET /webhooks/:id/deliveries - Get webhook delivery history. Auth: humanAuth + adminOnly. Returns deliveries */
  fastify.get<{ Params: { id: string }; Querystring: { limit?: number } }>(
    '/webhooks/:id/deliveries',
    { preHandler: [adminOnly], config: { authPolicy: "human" } },
    async (request: FastifyRequest<{ Params: { id: string }; Querystring: { limit?: number } }>, _reply: FastifyReply) => {
      const { id } = request.params;
      const limit = request.query.limit || 25;

      const subscription = getWebhookSubscriptionById(id);
      if (!subscription) {
        throw notFound('Webhook subscription not found');
      }

      const deliveries = getDeliveriesForSubscription(id, limit);
      return deliveries;
    }
  );
}