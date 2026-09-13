/**
 * T2 — effect-receipt operator API (C4).
 *
 * Admin-role + `requireHabitatAccess` BEFORE any query/pagination (uniform
 * cross-habitat denial). Dead-letter-only audited requeue (per-target scope
 * for detector receipts). No substitution primitive exists: requeue resets
 * attempts and re-enters delivery; nothing here substitutes a consumer's
 * output.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireHabitatAccess } from "../middleware/team.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import * as effectReceipts from "../repositories/effectReceipts.js";

const listQuerySchema = z.object({
  state: z.enum(["pending", "delivered", "dead_letter"]).optional(),
  consumer: z
    .enum([
      "workflow_gates",
      "failure_context",
      "retry_ladder",
      "detector_dispatch",
      "skill_ingestion",
      "pulse_workflow_gates",
      "pulse_skill_ingest",
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const requeueSchema = z.object({
  targetId: z.string().uuid().optional(),
});

export async function effectReceiptRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { habitatId: string }; Querystring: z.infer<typeof listQuerySchema> }>(
    "/habitats/:habitatId/effect-receipts",
    { preHandler: [requireHabitatAccess], config: { authPolicy: "human" } },
    async (request) => {
      if (request.user!.role !== "admin") {
        throw forbidden("Only admins can inspect effect receipts");
      }
      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      const { habitatId } = request.params;
      // Authorize-before-query: the admin check above precedes every DB read.
      const page = effectReceipts.listReceiptsForAdmin({
        habitatId,
        state: parsed.data.state,
        consumer: parsed.data.consumer,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      });
      return {
        receipts: page.receipts.map((r) => ({
          id: r.id,
          subjectType: r.subjectType,
          subjectId: r.subjectId,
          consumer: r.consumer,
          state: r.state,
          attempts: r.attempts,
          lastErrorCode: r.lastErrorCode,
          createdAt: r.createdAt,
          deliveredAt: r.deliveredAt,
        })),
        targets: page.targets.map((t) => ({
          id: t.id,
          receiptId: t.receiptId,
          pluginId: t.pluginId,
          contributionId: t.contributionId,
          state: t.state,
          attempts: t.attempts,
          lastErrorCode: t.lastErrorCode,
        })),
        total: page.total,
      };
    },
  );

  fastify.get<{
    Params: { habitatId: string; receiptId: string };
  }>(
    "/habitats/:habitatId/effect-receipts/:receiptId",
    { preHandler: [requireHabitatAccess], config: { authPolicy: "human" } },
    async (request) => {
      if (request.user!.role !== "admin") {
        throw forbidden("Only admins can inspect effect receipts");
      }
      const { habitatId, receiptId } = request.params;
      // Authorize-before-query: the admin check precedes every DB read; the
      // habitat ownership check precedes any receipt data leaving the DB.
      const receipt = effectReceipts.getReceiptById(receiptId);
      if (!receipt || receipt.habitatId !== habitatId) {
        // Uniform cross-habitat denial: indistinguishable from missing.
        throw notFound("Effect receipt not found");
      }
      const targets = effectReceipts.listTargetsForReceipt(receiptId);
      const attempts = effectReceipts.listAttemptsForReceipt(receiptId);
      const adminActions = effectReceipts.listAdminActionsForReceipt(receiptId);
      return {
        receipt: {
          id: receipt.id,
          subjectType: receipt.subjectType,
          subjectId: receipt.subjectId,
          consumer: receipt.consumer,
          state: receipt.state,
          attempts: receipt.attempts,
          lastErrorCode: receipt.lastErrorCode,
          createdAt: receipt.createdAt,
          deliveredAt: receipt.deliveredAt,
        },
        targets: targets.map((t) => ({
          id: t.id,
          pluginId: t.pluginId,
          contributionId: t.contributionId,
          state: t.state,
          attempts: t.attempts,
          lastErrorCode: t.lastErrorCode,
        })),
        attempts: attempts.map((a) => ({
          id: a.id,
          targetId: a.targetId,
          attempt: a.attempt,
          code: a.code,
          actor: a.actor,
          occurredAt: a.occurredAt,
        })),
        adminActions: adminActions.map((a) => ({
          id: a.id,
          targetId: a.targetId,
          action: a.action,
          actorType: a.actorType,
          actorId: a.actorId,
          occurredAt: a.occurredAt,
        })),
      };
    },
  );

  fastify.post<{
    Params: { habitatId: string; receiptId: string };
    Body: z.infer<typeof requeueSchema>;
  }>(
    "/habitats/:habitatId/effect-receipts/:receiptId/requeue",
    { preHandler: [requireHabitatAccess], config: { authPolicy: "human" } },
    async (request) => {
      if (request.user!.role !== "admin") {
        throw forbidden("Only admins can requeue effect receipts");
      }
      const parsed = requeueSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      const { habitatId, receiptId } = request.params;
      const result = effectReceipts.adminRequeue(
        receiptId,
        "human",
        request.user!.id,
        habitatId,
        parsed.data.targetId,
      );
      switch (result.reason) {
        case "not_found":
        case "not_owned_by_habitat":
          // Uniform cross-habitat denial: indistinguishable from missing.
          throw notFound("Effect receipt not found");
        case "not_dead_letter":
          throw conflict("Only dead-lettered receipts can be requeued");
        default:
          return { requeued: true, receiptId: result.receiptId, targetId: result.targetId ?? null };
      }
    },
  );
}
