import { applyDeclaredAuthPolicies } from "../authPolicy.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import * as inviteService from "../services/remoteInviteService.js";
import { badRequest } from "../errors.js";

const acceptInviteSchema = z.object({
  podName: z.string().min(1).max(128),
  participantDisplayName: z.string().min(1).max(128),
  participantType: z.enum(["remote_human", "remote_orcy"]).optional(),
  podDescription: z.string().max(512).optional(),
  acceptedBy: z.string().max(128).optional(),
});

function parseBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw badRequest(`Invalid request body: ${issues}`);
  }
  return result.data;
}

/**
 * Phase C — Pre-remote-auth invite acceptance routes.
 *
 * These routes carry the `manual_invite` auth policy: no remote credential
 * exists yet, so the policy-installed guard verifies the manual invite token
 * (format + hash lookup, stashing the resolved invite on the request) before
 * domain handling. The handler then consumes `request.manualInvite`.
 *
 * Provider invite acceptance is intentionally absent: it previously
 * accepted a bare invite UUID plus caller-authored identity without
 * consuming an OAuth auth state, so it was removed. Provider acceptance
 * returns only with a designed, state-consuming callback.
 *
 * Invite tokens are passed via the X-Orcy-Invite-Token header to avoid
 * being logged in URL paths by proxies, CDNs, or browser history.
 */
export async function sharedInviteRoutes(fastify: FastifyInstance): Promise<void> {
  // Heterogeneous module: routes declare policy individually; this applier
  // installs their guards (a no-op on seam-constructed instances, where the
  // root installer has already done so).
  applyDeclaredAuthPolicies(fastify);

  /** POST /shared/invites/preview — validate invite token and return invite details */
  fastify.post(
    "/shared/invites/preview",
    { config: { authPolicy: "manual_invite" } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header("Cache-Control", "no-store");
      return inviteService.previewInvite(request.manualInvite!);
    },
  );

  /** POST /shared/invites/accept — accept manual invite, create pod + participant */
  fastify.post(
    "/shared/invites/accept",
    { config: { authPolicy: "manual_invite" } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header("Cache-Control", "no-store");

      const body = parseBody(acceptInviteSchema, request.body);

      const result = inviteService.acceptInvite(
        request.manualInvite!,
        body.acceptedBy ?? "remote-admin",
        {
          podName: body.podName,
          participantDisplayName: body.participantDisplayName,
          participantType: body.participantType,
          podDescription: body.podDescription,
        },
      );

      reply.code(201).send(result);
    },
  );
}
