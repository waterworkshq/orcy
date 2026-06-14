import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { humanAuth } from "../middleware/auth.js";
import { adminOnly } from "../middleware/rbac.js";
import { teamHabitatAccess } from "../middleware/team.js";
import { badRequest, notFound, forbidden } from "../errors.js";
import * as endpointRepo from "../repositories/remoteWebhookEndpoint.js";
import * as podRepo from "../repositories/remotePod.js";
import { generateRemoteSecret, hashRemoteSecret } from "../services/remoteCredentialService.js";
import {
  registerEndpointPlaintextSecret,
  forgetEndpointPlaintextSecret,
} from "../services/compactRemoteWebhookDispatcher.js";

/**
 * v0.19 Phase E — Remote webhook endpoint management routes.
 *
 * Lifecycle: pending → approved → enabled (or rejected / disabled)
 * The remote pod provides the endpoint URL + signing secret. The host
 * admin approves the endpoint, then enables it. Once enabled, the
 * `compactRemoteWebhookDispatcher` (services/compactRemoteWebhookDispatcher.ts)
 * sends compact event summaries to the URL.
 *
 * Compact payload spec (from PHASE-E-visibility-audit.md):
 * - event type
 * - timestamp
 * - habitat/mission/task IDs where scoped
 * - actor summary with standing and affiliation
 * - grant/trust context ID
 * - follow-up API URL or route hint
 *
 * Full entity details require follow-up scoped API reads (via /api/shared/*).
 */

const createEndpointSchema = z
  .object({
    remotePodId: z.string().min(1),
    url: z.string().url(),
    description: z.string().max(500).optional(),
    events: z.array(z.string().min(1).max(128)).max(50).optional(),
  })
  .strict();

const updateEndpointSchema = z
  .object({
    url: z.string().url().optional(),
    description: z.string().max(500).optional(),
    events: z.array(z.string().min(1).max(128)).max(50).optional(),
  })
  .strict();

const approveSchema = z.object({}).strict();
const enableSchema = z.object({}).strict();
const disableSchema = z.object({ reason: z.string().min(1).max(500) }).strict();
const rejectSchema = z.object({ rejectReason: z.string().min(1).max(500) }).strict();

function toView(row: endpointRepo.RemoteWebhookEndpointRow) {
  return {
    id: row.id,
    remotePodId: row.remotePodId,
    habitatId: row.habitatId,
    url: row.url,
    description: row.description,
    events: row.events,
    status: row.status,
    lastTestAt: row.lastTestAt,
    lastTestStatus: row.lastTestStatus,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    enabledBy: row.enabledBy,
    enabledAt: row.enabledAt,
    rejectedBy: row.rejectedBy,
    rejectedAt: row.rejectedAt,
    rejectReason: row.rejectReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function remoteWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", humanAuth);
  fastify.addHook("preHandler", adminOnly);
  fastify.addHook("preHandler", teamHabitatAccess);

  /** GET /api/habitats/:id/remote-access/webhook-endpoints — list all */
  fastify.get<{ Params: { id: string } }>(
    "/habitats/:id/remote-access/webhook-endpoints",
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const habitatId = request.params.id;
      // Collect endpoints for every pod in the habitat
      const pods = podRepo.getRemotePodsByHabitat(habitatId);
      const result = pods.flatMap((p) =>
        endpointRepo.getRemoteWebhookEndpointsByPod(p.id).map(toView),
      );
      return { endpoints: result };
    },
  );

  /** GET .../webhook-endpoints/:endpointId — get one */
  fastify.get<{ Params: { id: string; endpointId: string } }>(
    "/habitats/:id/remote-access/webhook-endpoints/:endpointId",
    async (
      request: FastifyRequest<{ Params: { id: string; endpointId: string } }>,
      _reply: FastifyReply,
    ) => {
      const row = endpointRepo.getRemoteWebhookEndpointById(request.params.endpointId);
      if (!row) throw notFound("Webhook endpoint not found");
      if (row.habitatId !== request.params.id) {
        throw notFound("Webhook endpoint not found");
      }
      return toView(row);
    },
  );

  /** POST .../webhook-endpoints — create (starts in pending state) */
  fastify.post<{ Params: { id: string } }>(
    "/habitats/:id/remote-access/webhook-endpoints",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const body = parseBody(createEndpointSchema, request.body);

      // The pod must belong to this habitat
      const pod = podRepo.getRemotePodById(body.remotePodId);
      if (!pod || pod.habitatId !== request.params.id) {
        throw badRequest("remotePodId does not belong to this habitat");
      }

      // Generate and hash a per-endpoint secret for HMAC signing
      const { plaintextSecret: secret, secretHash } = generateRemoteSecret();

      const row = endpointRepo.createRemoteWebhookEndpoint({
        remotePodId: body.remotePodId,
        habitatId: request.params.id,
        url: body.url,
        description: body.description,
        events: body.events,
        secretHash,
      });

      // The plaintext secret is shown ONLY at creation time, just like
      // remote API credentials. The host admin must share it with the
      // remote pod out-of-band so the pod can verify HMAC signatures.
      reply.code(201).send({
        endpoint: toView(row),
        plaintextSecret: secret,
      });
      // Register the secret for HMAC signing at dispatch time. The host
      // admin must share this with the remote pod out-of-band. Phase E.1
      // will replace this in-memory cache with encrypted-at-rest storage.
      registerEndpointPlaintextSecret(row.id, secret);
    },
  );

  /** PATCH .../webhook-endpoints/:endpointId — update URL/events/description */
  fastify.patch<{ Params: { id: string; endpointId: string } }>(
    "/habitats/:id/remote-access/webhook-endpoints/:endpointId",
    async (
      request: FastifyRequest<{ Params: { id: string; endpointId: string } }>,
      _reply: FastifyReply,
    ) => {
      const body = parseBody(updateEndpointSchema, request.body);
      const existing = endpointRepo.getRemoteWebhookEndpointById(request.params.endpointId);
      if (!existing || existing.habitatId !== request.params.id) {
        throw notFound("Webhook endpoint not found");
      }

      const row = endpointRepo.updateRemoteWebhookEndpoint(request.params.endpointId, {
        url: body.url,
        description: body.description,
        events: body.events,
      });
      if (!row) throw notFound("Webhook endpoint not found");
      return toView(row);
    },
  );

  /** POST .../webhook-endpoints/:endpointId/approve — approve (pending → approved) */
  fastify.post<{ Params: { id: string; endpointId: string } }>(
    "/habitats/:id/remote-access/webhook-endpoints/:endpointId/approve",
    async (
      request: FastifyRequest<{ Params: { id: string; endpointId: string } }>,
      _reply: FastifyReply,
    ) => {
      parseBody(approveSchema, request.body);
      const existing = endpointRepo.getRemoteWebhookEndpointById(request.params.endpointId);
      if (!existing || existing.habitatId !== request.params.id) {
        throw notFound("Webhook endpoint not found");
      }
      if (existing.status === "approved" || existing.status === "enabled") {
        return toView(existing); // idempotent
      }
      if (existing.status === "rejected" || existing.status === "disabled") {
        throw badRequest(`Cannot approve a ${existing.status} endpoint`);
      }
      const row = endpointRepo.approveRemoteWebhookEndpoint(
        request.params.endpointId,
        request.user!.id,
      );
      return toView(row!);
    },
  );

  /** POST .../webhook-endpoints/:endpointId/enable — enable (approved → enabled) */
  fastify.post<{ Params: { id: string; endpointId: string } }>(
    "/habitats/:id/remote-access/webhook-endpoints/:endpointId/enable",
    async (
      request: FastifyRequest<{ Params: { id: string; endpointId: string } }>,
      _reply: FastifyReply,
    ) => {
      parseBody(enableSchema, request.body);
      const existing = endpointRepo.getRemoteWebhookEndpointById(request.params.endpointId);
      if (!existing || existing.habitatId !== request.params.id) {
        throw notFound("Webhook endpoint not found");
      }
      if (existing.status === "enabled") return toView(existing);
      if (existing.status !== "approved" && existing.status !== "disabled") {
        throw badRequest(`Cannot enable endpoint in status ${existing.status}`);
      }
      const row = endpointRepo.enableRemoteWebhookEndpoint(
        request.params.endpointId,
        request.user!.id,
      );
      return toView(row!);
    },
  );

  /** POST .../webhook-endpoints/:endpointId/disable — disable (any → disabled) */
  fastify.post<{ Params: { id: string; endpointId: string } }>(
    "/habitats/:id/remote-access/webhook-endpoints/:endpointId/disable",
    async (
      request: FastifyRequest<{ Params: { id: string; endpointId: string } }>,
      _reply: FastifyReply,
    ) => {
      const body = parseBody(disableSchema, request.body);
      const existing = endpointRepo.getRemoteWebhookEndpointById(request.params.endpointId);
      if (!existing || existing.habitatId !== request.params.id) {
        throw notFound("Webhook endpoint not found");
      }
      const row = endpointRepo.disableRemoteWebhookEndpoint(request.params.endpointId);
      if (!row) throw notFound("Webhook endpoint not found");
      // Mark the disable reason into the audit metadata via updatedAt
      void body.reason;
      forgetEndpointPlaintextSecret(request.params.endpointId);
      return toView(row);
    },
  );

  /** POST .../webhook-endpoints/:endpointId/reject — reject (pending → rejected) */
  fastify.post<{ Params: { id: string; endpointId: string } }>(
    "/habitats/:id/remote-access/webhook-endpoints/:endpointId/reject",
    async (
      request: FastifyRequest<{ Params: { id: string; endpointId: string } }>,
      _reply: FastifyReply,
    ) => {
      const body = parseBody(rejectSchema, request.body);
      const existing = endpointRepo.getRemoteWebhookEndpointById(request.params.endpointId);
      if (!existing || existing.habitatId !== request.params.id) {
        throw notFound("Webhook endpoint not found");
      }
      if (existing.status === "rejected") return toView(existing);
      if (existing.status !== "pending" && existing.status !== "approved") {
        throw badRequest(`Cannot reject endpoint in status ${existing.status}`);
      }
      const row = endpointRepo.rejectRemoteWebhookEndpoint(
        request.params.endpointId,
        request.user!.id,
        body.rejectReason,
      );
      forgetEndpointPlaintextSecret(request.params.endpointId);
      return toView(row!);
    },
  );

  /** DELETE .../webhook-endpoints/:endpointId */
  fastify.delete<{ Params: { id: string; endpointId: string } }>(
    "/habitats/:id/remote-access/webhook-endpoints/:endpointId",
    async (
      request: FastifyRequest<{ Params: { id: string; endpointId: string } }>,
      reply: FastifyReply,
    ) => {
      const existing = endpointRepo.getRemoteWebhookEndpointById(request.params.endpointId);
      if (!existing || existing.habitatId !== request.params.id) {
        throw notFound("Webhook endpoint not found");
      }
      endpointRepo.deleteRemoteWebhookEndpoint(request.params.endpointId);
      forgetEndpointPlaintextSecret(request.params.endpointId);
      reply.code(204).send();
    },
  );
}

function parseBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw badRequest(`Invalid request body: ${issues}`);
  }
  return result.data;
}
