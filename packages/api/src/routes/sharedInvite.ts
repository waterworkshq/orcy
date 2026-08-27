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
 * These routes do NOT require remoteParticipantAuth because no remote
 * credential exists yet. They are validated by the manual invite token
 * hash, then create/link remote pod/admin records.
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
  /** POST /shared/invites/preview — validate invite token and return invite details */
  fastify.post("/shared/invites/preview", async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");

    const token = request.headers["x-orcy-invite-token"] as string | undefined;
    if (!token || !token.startsWith("orcy_invite_")) {
      throw badRequest("Invalid invite token format", "INVALID_INVITE_TOKEN");
    }

    const preview = inviteService.previewInviteByToken(token);
    return preview;
  });

  /** POST /shared/invites/accept — accept manual invite, create pod + participant */
  fastify.post("/shared/invites/accept", async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");

    const token = request.headers["x-orcy-invite-token"] as string | undefined;
    if (!token || !token.startsWith("orcy_invite_")) {
      throw badRequest(
        "Invite token required in X-Orcy-Invite-Token header",
        "INVALID_INVITE_TOKEN",
      );
    }

    const body = parseBody(acceptInviteSchema, request.body);

    const result = inviteService.acceptManualInvite(token, body.acceptedBy ?? "remote-admin", {
      podName: body.podName,
      participantDisplayName: body.participantDisplayName,
      participantType: body.participantType,
      podDescription: body.podDescription,
    });

    reply.code(201).send(result);
  });
}
