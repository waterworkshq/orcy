import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { humanAuth } from "../middleware/auth.js";
import { adminOnly } from "../middleware/rbac.js";
import { badRequest } from "../errors.js";
import * as readinessService from "../services/shareHabitatReadinessService.js";
import * as providerService from "../services/identityProviderService.js";
import * as inviteService from "../services/remoteInviteService.js";
import * as adminService from "../services/remoteAccessAdminService.js";
import * as mcpConfigService from "../services/mcpConfigService.js";
import type {
  IdentityProviderKind,
  ParticipantStanding,
  RemoteActionScope,
  RemoteGrantType,
  RemoteGrantEligibilityMode,
  RemoteGrantTargetType,
  RemoteRevocationMode,
  RemoteCredentialType,
} from "@orcy/shared/types";

/**
 * Phase C — Share Habitat admin surface routes.
 *
 * All routes require local human admin auth. Invite acceptance is handled
 * separately under /api/shared/invites/* (pre-remote-auth).
 */
export async function remoteAccessRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", humanAuth);
  fastify.addHook("preHandler", adminOnly);

  // -----------------------------------------------------------------------
  // Readiness
  // -----------------------------------------------------------------------

  /** GET /habitats/:id/remote-access/readiness — reachability/profile checks */
  fastify.get<{ Params: { id: string } }>(
    "/habitats/:id/remote-access/readiness",
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const query = request.query as { manualInviteSelected?: string };
      return readinessService.checkReadiness(request.params.id, {
        manualInviteSelected: query.manualInviteSelected === "true",
      });
    },
  );

  // -----------------------------------------------------------------------
  // Identity Providers
  // -----------------------------------------------------------------------

  /** GET /habitats/:id/remote-access/providers — list configured providers */
  fastify.get<{ Params: { id: string } }>(
    "/habitats/:id/remote-access/providers",
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      return { providers: providerService.listProviders(request.params.id) };
    },
  );

  /** POST /habitats/:id/remote-access/providers — configure a new provider */
  fastify.post<{ Params: { id: string } }>(
    "/habitats/:id/remote-access/providers",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const body = request.body as {
        kind?: IdentityProviderKind;
        name?: string;
        issuer?: string;
        clientId?: string;
        clientSecret?: string;
        callbackUrl?: string;
        scopes?: string[];
        enabled?: boolean;
      };
      if (!body.kind || !body.name || !body.clientId || !body.clientSecret) {
        throw badRequest("kind, name, clientId, and clientSecret are required");
      }
      const provider = providerService.configureProvider({
        habitatId: request.params.id,
        kind: body.kind,
        name: body.name,
        issuer: body.issuer,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        callbackUrl: body.callbackUrl,
        scopes: body.scopes,
        enabled: body.enabled,
        createdBy: request.user!.id,
      });
      reply.code(201).send({ provider });
    },
  );

  /** PATCH /habitats/:id/remote-access/providers/:providerId — update provider */
  fastify.patch<{ Params: { id: string; providerId: string } }>(
    "/habitats/:id/remote-access/providers/:providerId",
    async (
      request: FastifyRequest<{ Params: { id: string; providerId: string } }>,
      _reply: FastifyReply,
    ) => {
      const body = request.body as Partial<{
        name: string;
        issuer: string;
        clientId: string;
        clientSecret: string;
        callbackUrl: string;
        scopes: string[];
        enabled: boolean;
      }>;
      return {
        provider: providerService.updateProvider(
          request.params.id,
          request.params.providerId,
          body,
        ),
      };
    },
  );

  /** DELETE /habitats/:id/remote-access/providers/:providerId — remove provider */
  fastify.delete<{ Params: { id: string; providerId: string } }>(
    "/habitats/:id/remote-access/providers/:providerId",
    async (
      request: FastifyRequest<{ Params: { id: string; providerId: string } }>,
      reply: FastifyReply,
    ) => {
      providerService.deleteProvider(request.params.id, request.params.providerId);
      reply.code(204).send();
    },
  );

  /** POST /habitats/:id/remote-access/providers/:providerId/initiate — start OAuth flow */
  fastify.post<{ Params: { id: string; providerId: string } }>(
    "/habitats/:id/remote-access/providers/:providerId/initiate",
    async (
      request: FastifyRequest<{ Params: { id: string; providerId: string } }>,
      _reply: FastifyReply,
    ) => {
      const body = request.body as { inviteId?: string } | null;
      return providerService.initiateAuthState(
        request.params.id,
        request.params.providerId,
        body?.inviteId,
      );
    },
  );

  // -----------------------------------------------------------------------
  // Invites
  // -----------------------------------------------------------------------

  /** GET /habitats/:id/remote-access/invites — list invites */
  fastify.get<{ Params: { id: string } }>(
    "/habitats/:id/remote-access/invites",
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      return { invites: inviteService.listInvites(request.params.id) };
    },
  );

  /** POST /habitats/:id/remote-access/invites — create provider or manual invite */
  fastify.post<{ Params: { id: string } }>(
    "/habitats/:id/remote-access/invites",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const body = request.body as {
        inviteType?: "provider" | "manual";
        baselineStanding?: ParticipantStanding;
        baselineScopes?: RemoteActionScope[];
        providerId?: string;
        expiresAt?: string | null;
      };
      if (!body.inviteType || !body.baselineStanding) {
        throw badRequest("inviteType and baselineStanding are required");
      }

      if (body.inviteType === "manual") {
        const result = inviteService.createManualInvite({
          habitatId: request.params.id,
          baselineStanding: body.baselineStanding,
          baselineScopes: body.baselineScopes,
          invitedBy: request.user!.id,
          expiresAt: body.expiresAt,
        });
        reply.code(201).send(result);
      } else {
        if (!body.providerId) {
          throw badRequest("providerId is required for provider invites");
        }
        const invite = inviteService.createProviderInvite({
          habitatId: request.params.id,
          providerId: body.providerId,
          baselineStanding: body.baselineStanding,
          baselineScopes: body.baselineScopes,
          invitedBy: request.user!.id,
          expiresAt: body.expiresAt,
        });
        reply.code(201).send({ invite });
      }
    },
  );

  /** POST /habitats/:id/remote-access/invites/:inviteId/revoke — revoke invite */
  fastify.post<{ Params: { id: string; inviteId: string } }>(
    "/habitats/:id/remote-access/invites/:inviteId/revoke",
    async (
      request: FastifyRequest<{ Params: { id: string; inviteId: string } }>,
      _reply: FastifyReply,
    ) => {
      const body = request.body as { revokeReason?: string } | null;
      return {
        invite: inviteService.revokeInvite(
          request.params.id,
          request.params.inviteId,
          request.user!.id,
          body?.revokeReason,
        ),
      };
    },
  );

  // -----------------------------------------------------------------------
  // Remote Pods
  // -----------------------------------------------------------------------

  /** GET /habitats/:id/remote-access/remote-pods — list pods */
  fastify.get<{ Params: { id: string } }>(
    "/habitats/:id/remote-access/remote-pods",
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const query = request.query as { status?: string };
      return {
        pods: adminService.listPods(
          request.params.id,
          query.status as "pending" | "active" | "suspended" | "revoked" | undefined,
        ),
      };
    },
  );

  /** GET /habitats/:id/remote-access/remote-pods/:podId — pod details */
  fastify.get<{ Params: { id: string; podId: string } }>(
    "/habitats/:id/remote-access/remote-pods/:podId",
    async (
      request: FastifyRequest<{ Params: { id: string; podId: string } }>,
      _reply: FastifyReply,
    ) => {
      return { pod: adminService.getPod(request.params.id, request.params.podId) };
    },
  );

  /** PATCH /habitats/:id/remote-access/remote-pods/:podId — update pod metadata or status */
  fastify.patch<{ Params: { id: string; podId: string } }>(
    "/habitats/:id/remote-access/remote-pods/:podId",
    async (
      request: FastifyRequest<{ Params: { id: string; podId: string } }>,
      _reply: FastifyReply,
    ) => {
      const body = request.body as Partial<{
        name: string;
        description: string;
        defaultStanding: ParticipantStanding;
        action: "activate" | "suspend" | "revoke";
        revokeReason: string;
      }>;

      if (body.action) {
        switch (body.action) {
          case "suspend":
            return { pod: adminService.suspendPod(request.params.id, request.params.podId) };
          case "activate":
            return { pod: adminService.activatePod(request.params.id, request.params.podId) };
          case "revoke":
            return {
              pod: adminService.revokePod(
                request.params.id,
                request.params.podId,
                request.user!.id,
                body.revokeReason,
              ),
            };
        }
      }

      return {
        pod: adminService.updatePod(request.params.id, request.params.podId, {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.defaultStanding !== undefined ? { defaultStanding: body.defaultStanding } : {}),
        }),
      };
    },
  );

  /** GET /habitats/:id/remote-access/remote-pods/:podId/participants — participants in pod */
  fastify.get<{ Params: { id: string; podId: string } }>(
    "/habitats/:id/remote-access/remote-pods/:podId/participants",
    async (
      request: FastifyRequest<{ Params: { id: string; podId: string } }>,
      _reply: FastifyReply,
    ) => {
      return {
        participants: adminService.listParticipants(request.params.id, {
          podId: request.params.podId,
        }),
      };
    },
  );

  // -----------------------------------------------------------------------
  // Remote Participants
  // -----------------------------------------------------------------------

  /** GET /habitats/:id/remote-access/participants/:participantId — participant details */
  fastify.get<{ Params: { id: string; participantId: string } }>(
    "/habitats/:id/remote-access/participants/:participantId",
    async (
      request: FastifyRequest<{ Params: { id: string; participantId: string } }>,
      _reply: FastifyReply,
    ) => {
      return {
        participant: adminService.getParticipant(request.params.id, request.params.participantId),
      };
    },
  );

  /** PATCH /habitats/:id/remote-access/participants/:participantId — approve/update participant */
  fastify.patch<{ Params: { id: string; participantId: string } }>(
    "/habitats/:id/remote-access/participants/:participantId",
    async (
      request: FastifyRequest<{ Params: { id: string; participantId: string } }>,
      _reply: FastifyReply,
    ) => {
      const body = request.body as Partial<{
        approvedCapabilities: string[];
        approvedDomains: string[];
        standing: ParticipantStanding;
        action: "activate" | "suspend" | "revoke";
      }>;

      if (body.action) {
        switch (body.action) {
          case "suspend":
            return {
              participant: adminService.suspendParticipant(
                request.params.id,
                request.params.participantId,
              ),
            };
          case "activate":
            return {
              participant: adminService.activateParticipant(
                request.params.id,
                request.params.participantId,
              ),
            };
          case "revoke":
            return {
              participant: adminService.revokeParticipant(
                request.params.id,
                request.params.participantId,
              ),
            };
        }
      }

      return {
        participant: adminService.approveParticipant(
          request.params.id,
          request.params.participantId,
          {
            ...(body.approvedCapabilities !== undefined
              ? { approvedCapabilities: body.approvedCapabilities }
              : {}),
            ...(body.approvedDomains !== undefined
              ? { approvedDomains: body.approvedDomains }
              : {}),
            ...(body.standing !== undefined ? { standing: body.standing } : {}),
          },
        ),
      };
    },
  );

  // -----------------------------------------------------------------------
  // Grants
  // -----------------------------------------------------------------------

  /** GET /habitats/:id/remote-access/grants — list grants */
  fastify.get<{ Params: { id: string } }>(
    "/habitats/:id/remote-access/grants",
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      return { grants: adminService.listGrants(request.params.id) };
    },
  );

  /** GET /habitats/:id/remote-access/grants/:grantId — grant details */
  fastify.get<{ Params: { id: string; grantId: string } }>(
    "/habitats/:id/remote-access/grants/:grantId",
    async (
      request: FastifyRequest<{ Params: { id: string; grantId: string } }>,
      _reply: FastifyReply,
    ) => {
      return { grant: adminService.getGrant(request.params.id, request.params.grantId) };
    },
  );

  /** POST /habitats/:id/remote-access/grants — create grant */
  fastify.post<{ Params: { id: string } }>(
    "/habitats/:id/remote-access/grants",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const body = request.body as {
        remotePodId?: string;
        remoteParticipantId?: string | null;
        grantType?: RemoteGrantType;
        standing?: ParticipantStanding;
        actionScopes?: RemoteActionScope[];
        eligibilityMode?: RemoteGrantEligibilityMode;
        includeFutureMatches?: boolean;
        graceWindowHours?: number;
        expiresAt?: string | null;
        targets?: { targetType: RemoteGrantTargetType; targetId: string }[];
        rule?: {
          domains?: string[];
          labels?: string[];
          capabilities?: string[];
        };
      };

      if (!body.remotePodId || !body.grantType || !body.standing) {
        throw badRequest("remotePodId, grantType, and standing are required");
      }

      const grant = adminService.createGrant({
        habitatId: request.params.id,
        remotePodId: body.remotePodId,
        remoteParticipantId: body.remoteParticipantId,
        grantType: body.grantType,
        standing: body.standing,
        actionScopes: body.actionScopes ?? ["read"],
        eligibilityMode: body.eligibilityMode,
        includeFutureMatches: body.includeFutureMatches,
        graceWindowHours: body.graceWindowHours,
        expiresAt: body.expiresAt,
        targets: body.targets,
        rule: body.rule,
        createdBy: request.user!.id,
      });

      reply.code(201).send({ grant });
    },
  );

  /** POST /habitats/:id/remote-access/grants/:grantId/revoke — revoke/freeze grant */
  fastify.post<{ Params: { id: string; grantId: string } }>(
    "/habitats/:id/remote-access/grants/:grantId/revoke",
    async (
      request: FastifyRequest<{ Params: { id: string; grantId: string } }>,
      _reply: FastifyReply,
    ) => {
      const body = request.body as { mode?: RemoteRevocationMode; reason?: string };
      if (!body.mode) {
        throw badRequest("mode (soft|hard|freeze) is required");
      }
      return {
        grant: adminService.revokeGrant(
          request.params.id,
          request.params.grantId,
          body.mode,
          request.user!.id,
          body.reason,
        ),
      };
    },
  );

  /** POST /habitats/:id/remote-access/grants/preview — preview rule-based grant match */
  fastify.post<{ Params: { id: string } }>(
    "/habitats/:id/remote-access/grants/preview",
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const body = request.body as {
        targets?: { targetType: RemoteGrantTargetType; targetId: string }[];
        rule?: {
          domains?: string[];
          labels?: string[];
          capabilities?: string[];
        };
      };
      return adminService.previewGrant({
        habitatId: request.params.id,
        targets: body.targets,
        rule: body.rule ?? {},
      });
    },
  );

  // -----------------------------------------------------------------------
  // Credentials & MCP Config
  // -----------------------------------------------------------------------

  /** POST /habitats/:id/remote-access/participants/:participantId/credentials — create credential + MCP config */
  fastify.post<{ Params: { id: string; participantId: string } }>(
    "/habitats/:id/remote-access/participants/:participantId/credentials",
    async (
      request: FastifyRequest<{ Params: { id: string; participantId: string } }>,
      reply: FastifyReply,
    ) => {
      const body = request.body as {
        credentialType?: RemoteCredentialType;
        label?: string;
        expiresAt?: string | null;
        clients?: mcpConfigService.McpClientId[];
      };
      const result = mcpConfigService.createCredentialWithConfig({
        habitatId: request.params.id,
        participantId: request.params.participantId,
        credentialType: body.credentialType ?? "mcp",
        label: body.label,
        expiresAt: body.expiresAt,
        createdBy: request.user!.id,
        clients: body.clients,
      });
      reply.code(201).send(result);
    },
  );

  /** GET /habitats/:id/remote-access/credentials/:credentialId — credential metadata (NO secret) */
  fastify.get<{ Params: { id: string; credentialId: string } }>(
    "/habitats/:id/remote-access/credentials/:credentialId",
    async (
      request: FastifyRequest<{ Params: { id: string; credentialId: string } }>,
      _reply: FastifyReply,
    ) => {
      return mcpConfigService.getCredentialMetadata(request.params.id, request.params.credentialId);
    },
  );

  /** POST /habitats/:id/remote-access/credentials/:credentialId/rotate — rotate credential (returns new one-time secret) */
  fastify.post<{ Params: { id: string; credentialId: string } }>(
    "/habitats/:id/remote-access/credentials/:credentialId/rotate",
    async (
      request: FastifyRequest<{ Params: { id: string; credentialId: string } }>,
      _reply: FastifyReply,
    ) => {
      const body = request.body as { clients?: mcpConfigService.McpClientId[] } | null;
      return mcpConfigService.rotateCredentialWithConfig(
        request.params.id,
        request.params.credentialId,
        request.user!.id,
        body?.clients,
      );
    },
  );

  /** POST /habitats/:id/remote-access/credentials/:credentialId/revoke — revoke credential */
  fastify.post<{ Params: { id: string; credentialId: string } }>(
    "/habitats/:id/remote-access/credentials/:credentialId/revoke",
    async (
      request: FastifyRequest<{ Params: { id: string; credentialId: string } }>,
      reply: FastifyReply,
    ) => {
      const body = request.body as { reason?: string } | null;
      const credential = mcpConfigService.revokeCredential(
        request.params.id,
        request.params.credentialId,
        request.user!.id,
        body?.reason,
      );
      reply.code(200).send({ credential });
    },
  );

  /** GET /habitats/:id/remote-access/participants/:participantId/credentials — list credentials for participant */
  fastify.get<{ Params: { id: string; participantId: string } }>(
    "/habitats/:id/remote-access/participants/:participantId/credentials",
    async (
      request: FastifyRequest<{ Params: { id: string; participantId: string } }>,
      _reply: FastifyReply,
    ) => {
      return {
        credentials: mcpConfigService.listCredentialsByParticipant(
          request.params.id,
          request.params.participantId,
        ),
      };
    },
  );

  /** POST /habitats/:id/remote-access/credentials/:credentialId/mcp-config — regenerate MCP config snippets (metadata only) */
  fastify.post<{ Params: { id: string; credentialId: string } }>(
    "/habitats/:id/remote-access/credentials/:credentialId/mcp-config",
    async (
      request: FastifyRequest<{ Params: { id: string; credentialId: string } }>,
      _reply: FastifyReply,
    ) => {
      const body = request.body as { clients?: mcpConfigService.McpClientId[] } | null;
      return mcpConfigService.regenerateConfigSnippets(
        request.params.id,
        request.params.credentialId,
        body?.clients ?? ["claude_code", "codex", "opencode"],
      );
    },
  );

  // -----------------------------------------------------------------------
  // Management View
  // -----------------------------------------------------------------------

  /** GET /habitats/:id/remote-access/management — unified pod/participant/grant management view */
  fastify.get<{ Params: { id: string } }>(
    "/habitats/:id/remote-access/management",
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      return adminService.getManagementView(request.params.id);
    },
  );
}
