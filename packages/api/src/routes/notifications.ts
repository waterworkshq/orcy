import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as attemptRepo from "../repositories/notificationDeliveryAttempt.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import * as retentionRepo from "../repositories/notificationRetentionPolicy.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as simulationService from "../services/automationSimulationService.js";
import {
  migrateLegacyPreferences,
  isLegacyMigrationComplete,
} from "../services/notificationMigrationService.js";
import { adminClearDeliveries } from "../services/notificationClearanceService.js";
import { humanAuth, agentAuth } from "../middleware/auth.js";
import { requireHabitatAccess } from "../middleware/team.js";
import { notFound, badRequest, forbidden } from "../errors.js";
import type { NotificationChannel, NotificationRecipientType } from "@orcy/shared";

const recipientTypeSchema = z.enum(["human", "agent", "remote_human", "remote_orcy"]);

const createSubscriptionSchema = z.object({
  habitatId: z.string().min(1),
  scope: z.enum(["habitat_default", "recipient_override"]),
  recipientType: recipientTypeSchema.optional(),
  recipientId: z.string().optional(),
  eventType: z.string().min(1),
  enabled: z.boolean().optional(),
  required: z.boolean().optional(),
  channels: z.array(z.string()).optional(),
  cadence: z.enum(["immediate", "hourly", "daily", "weekly"]).optional(),
  timezone: z.string().optional(),
  localSendTime: z.string().optional(),
  muteUntil: z.string().optional(),
});

const updateSubscriptionSchema = z.object({
  enabled: z.boolean().optional(),
  required: z.boolean().optional(),
  channels: z.array(z.string()).optional(),
  cadence: z.enum(["immediate", "hourly", "daily", "weekly"]).optional(),
  timezone: z.string().nullable().optional(),
  localSendTime: z.string().nullable().optional(),
  muteUntil: z.string().nullable().optional(),
});

const retentionPolicySchema = z.object({
  acknowledgedClearAfterDays: z.number().int().nonnegative().optional(),
  resolvedClearAfterDays: z.number().int().nonnegative().optional(),
  failedClearAfterDays: z.number().int().nonnegative().optional(),
  historySummaryRetentionDays: z.number().int().nonnegative().nullable().optional(),
  updatedBy: z.string().optional(),
});

const snoozeSchema = z.object({
  snoozedUntil: z.string().min(1),
});

const adminClearSchema = z.object({
  deliveryIds: z.array(z.string()).min(1),
});

export async function notificationRoutes(fastify: FastifyInstance): Promise<void> {
  // ============= Recipient Routes =============

  fastify.get<{
    Params: { habitatId: string };
    Querystring: { limit?: string; offset?: string; recipientType?: string };
  }>(
    "/habitats/:habitatId/notifications/inbox",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const { habitatId } = request.params;
      const userId = request.user!.id;
      const limit = request.query.limit ? Number(request.query.limit) : 50;
      const offset = request.query.offset ? Number(request.query.offset) : 0;
      const result = deliveryRepo.getActiveInbox(habitatId, "human", userId, { limit, offset });
      return result;
    },
  );

  fastify.get<{
    Params: { habitatId: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    "/habitats/:habitatId/notifications/history",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const { habitatId } = request.params;
      const userId = request.user!.id;
      const limit = request.query.limit ? Number(request.query.limit) : 50;
      const offset = request.query.offset ? Number(request.query.offset) : 0;
      const result = deliveryRepo.getDeliveryHistory(habitatId, "human", userId, {
        limit,
        offset,
      });
      return result;
    },
  );

  fastify.get<{ Params: { habitatId: string; deliveryId: string } }>(
    "/habitats/:habitatId/notifications/deliveries/:deliveryId",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const { habitatId, deliveryId } = request.params;
      const userId = request.user!.id;
      const delivery = deliveryRepo.getNotificationDeliveryById(deliveryId);
      if (!delivery || delivery.habitatId !== habitatId) {
        throw notFound("Delivery not found");
      }
      if (delivery.recipientId !== userId) {
        throw forbidden("You can only access your own deliveries");
      }
      const event = eventRepo.getNotificationEventById(delivery.eventId);
      return { delivery, event };
    },
  );

  fastify.post<{ Params: { habitatId: string; deliveryId: string } }>(
    "/habitats/:habitatId/notifications/deliveries/:deliveryId/ack",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const { habitatId, deliveryId } = request.params;
      const userId = request.user!.id;
      const delivery = deliveryRepo.getNotificationDeliveryById(deliveryId);
      if (!delivery || delivery.habitatId !== habitatId) {
        throw notFound("Delivery not found");
      }
      if (delivery.recipientId !== userId) {
        throw forbidden("You can only acknowledge your own deliveries");
      }
      return deliveryRepo.acknowledgeDelivery(deliveryId);
    },
  );

  fastify.post<{ Params: { habitatId: string; deliveryId: string } }>(
    "/habitats/:habitatId/notifications/deliveries/:deliveryId/snooze",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const { habitatId, deliveryId } = request.params;
      const userId = request.user!.id;
      const parsed = snoozeSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      const delivery = deliveryRepo.getNotificationDeliveryById(deliveryId);
      if (!delivery || delivery.habitatId !== habitatId) {
        throw notFound("Delivery not found");
      }
      if (delivery.recipientId !== userId) {
        throw forbidden("You can only snooze your own deliveries");
      }
      return deliveryRepo.snoozeDelivery(deliveryId, parsed.data.snoozedUntil);
    },
  );

  fastify.post<{ Params: { habitatId: string; deliveryId: string } }>(
    "/habitats/:habitatId/notifications/deliveries/:deliveryId/clear",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const { habitatId, deliveryId } = request.params;
      const userId = request.user!.id;
      const delivery = deliveryRepo.getNotificationDeliveryById(deliveryId);
      if (!delivery || delivery.habitatId !== habitatId) {
        throw notFound("Delivery not found");
      }
      if (delivery.recipientId !== userId) {
        throw forbidden("You can only clear your own deliveries");
      }
      return deliveryRepo.clearDelivery(deliveryId);
    },
  );

  // Own subscription state
  fastify.get<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/notifications/subscriptions",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const { habitatId } = request.params;
      const userId = request.user!.id;
      return {
        overrides: subscriptionRepo.getRecipientOverrides(habitatId, "human", userId),
        defaults: subscriptionRepo.getHabitatDefaults(habitatId),
      };
    },
  );

  // ============= Admin Routes =============

  // List all subscriptions for a habitat (admin)
  fastify.get<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/notifications/admin/subscriptions",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const { habitatId } = request.params;
      const all = subscriptionRepo.getAllSubscriptionsByHabitat(habitatId);
      return { subscriptions: all };
    },
  );

  // Create subscription
  fastify.post<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/notifications/admin/subscriptions",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const parsed = createSubscriptionSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      if (parsed.data.habitatId !== request.params.habitatId) {
        throw badRequest("habitatId mismatch");
      }
      // Admin-only: required flag
      if (parsed.data.required && request.user!.role !== "admin") {
        throw forbidden("Only admins can set required flag");
      }
      return subscriptionRepo.createSubscription({
        ...parsed.data,
        createdBy: request.user!.id,
      } as any);
    },
  );

  // Update subscription
  fastify.put<{ Params: { habitatId: string; subscriptionId: string } }>(
    "/habitats/:habitatId/notifications/admin/subscriptions/:subscriptionId",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const { subscriptionId } = request.params;
      const parsed = updateSubscriptionSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      if (parsed.data.required !== undefined && request.user!.role !== "admin") {
        throw forbidden("Only admins can change required flag");
      }
      return subscriptionRepo.updateSubscription(subscriptionId, parsed.data);
    },
  );

  // Delete subscription
  fastify.delete<{ Params: { habitatId: string; subscriptionId: string } }>(
    "/habitats/:habitatId/notifications/admin/subscriptions/:subscriptionId",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const { subscriptionId } = request.params;
      const deleted = subscriptionRepo.deleteSubscription(subscriptionId);
      return { deleted };
    },
  );

  // Retention policy
  fastify.get<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/notifications/admin/retention",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      return retentionRepo.getRetentionPolicyByHabitat(request.params.habitatId);
    },
  );

  fastify.put<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/notifications/admin/retention",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      if (request.user!.role !== "admin") {
        throw forbidden("Only admins can change retention policy");
      }
      const parsed = retentionPolicySchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      return retentionRepo.upsertRetentionPolicy(request.params.habitatId, {
        ...parsed.data,
        updatedBy: request.user!.id,
      });
    },
  );

  // Admin-triggered clearance
  fastify.post<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/notifications/admin/clear",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      if (request.user!.role !== "admin") {
        throw forbidden("Only admins can clear deliveries");
      }
      const parsed = adminClearSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      return adminClearDeliveries(parsed.data.deliveryIds);
    },
  );

  // Migration from legacy preferences
  fastify.post<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/notifications/admin/migrate-legacy",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const userId = request.user!.id;
      const result = migrateLegacyPreferences(userId, request.params.habitatId);
      return result;
    },
  );

  fastify.get<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/notifications/admin/migrate-legacy/status",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const userId = request.user!.id;
      const complete = isLegacyMigrationComplete(userId, request.params.habitatId);
      return { complete };
    },
  );

  // ============= Delivery Monitor =============

  fastify.get<{ Params: { habitatId: string }; Querystring: { channel?: string; limit?: string } }>(
    "/habitats/:habitatId/notifications/admin/delivery-monitor",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      if (request.user!.role !== "admin") {
        throw forbidden("Only admins can view delivery monitor");
      }
      const channel = request.query.channel as NotificationChannel | undefined;
      const limit = request.query.limit ? Number(request.query.limit) : 50;
      // For now, return all attempts across all deliveries in the habitat.
      const { deliveries } = deliveryRepo.getDeliveryHistory(
        request.params.habitatId,
        "human",
        "",
        { limit, offset: 0 },
      );
      void channel;
      const allAttempts = deliveries.flatMap((d) =>
        attemptRepo.getDeliveryAttemptsByDelivery(d.id),
      );
      return { attempts: allAttempts.slice(0, limit) };
    },
  );
}
