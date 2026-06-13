import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as inviteService from "../services/remoteInviteService.js";
import { badRequest } from "../errors.js";

/**
 * Phase C — Pre-remote-auth invite acceptance routes.
 *
 * These routes do NOT require remoteParticipantAuth because no remote
 * credential exists yet. They are validated by manual invite token hash
 * or provider callback state, then create/link remote pod/admin records.
 */
export async function sharedInviteRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /shared/invites/:token — validate invite token and return invite details */
  fastify.get<{ Params: { token: string } }>(
    "/shared/invites/:token",
    async (request: FastifyRequest<{ Params: { token: string } }>, _reply: FastifyReply) => {
      // This is a read-only preview — just validate the token and return the invite
      const { token } = request.params;
      if (!token || !token.startsWith("orcy_invite_")) {
        throw badRequest("Invalid invite token format", "INVALID_INVITE_TOKEN");
      }

      // We verify by hash without consuming the invite
      const { createHash } = await import("crypto");
      const { getRemoteInviteByTokenHash } = await import("../repositories/remoteInvite.js");
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const invite = getRemoteInviteByTokenHash(tokenHash);

      if (!invite) {
        throw badRequest("Invite token not recognized", "INVITE_NOT_FOUND");
      }
      if (invite.status !== "pending") {
        throw badRequest(`Invite is ${invite.status}`, `INVITE_${invite.status.toUpperCase()}`);
      }
      if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
        throw badRequest("Invite has expired", "INVITE_EXPIRED");
      }

      return {
        inviteType: invite.inviteType,
        baselineStanding: invite.baselineStanding,
        baselineScopes: invite.baselineScopes,
        expiresAt: invite.expiresAt,
        status: invite.status,
      };
    },
  );

  /** POST /shared/invites/:token/accept — accept manual invite, create pod + participant */
  fastify.post<{ Params: { token: string } }>(
    "/shared/invites/:token/accept",
    async (request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
      const body = request.body as {
        podName?: string;
        participantDisplayName?: string;
        participantType?: "remote_human" | "remote_orcy";
        podDescription?: string;
        acceptedBy?: string;
      };

      if (!body?.podName || !body?.participantDisplayName) {
        throw badRequest("podName and participantDisplayName are required");
      }

      const result = inviteService.acceptManualInvite(
        request.params.token,
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

  /** POST /shared/invites/:inviteId/accept-provider — accept provider invite after OAuth callback */
  fastify.post<{ Params: { inviteId: string } }>(
    "/shared/invites/:inviteId/accept-provider",
    async (request: FastifyRequest<{ Params: { inviteId: string } }>, reply: FastifyReply) => {
      const body = request.body as {
        podName?: string;
        participantDisplayName?: string;
        participantType?: "remote_human" | "remote_orcy";
        podDescription?: string;
        providerPodIdentity?: string;
        providerIdentityId?: string;
        acceptedBy?: string;
      };

      if (!body?.podName || !body?.participantDisplayName) {
        throw badRequest("podName and participantDisplayName are required");
      }

      const result = inviteService.acceptProviderInvite(
        request.params.inviteId,
        body.acceptedBy ?? "remote-admin",
        {
          podName: body.podName,
          participantDisplayName: body.participantDisplayName,
          participantType: body.participantType,
          podDescription: body.podDescription,
          providerPodIdentity: body.providerPodIdentity,
          providerIdentityId: body.providerIdentityId,
        },
      );

      reply.code(201).send(result);
    },
  );
}
