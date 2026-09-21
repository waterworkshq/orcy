import { applyDeclaredAuthPolicies } from "../authPolicy.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  getIntegrationsByHabitat,
  getIntegrationById,
  createIntegration,
  updateIntegration,
  deleteIntegration,
} from "../repositories/chatIntegration.js";
import {
  getMappingsByIntegration,
  createMapping,
  deleteMapping,
} from "../repositories/chatSpeakerMapping.js";
import { getHabitatById } from "../repositories/habitat.js";
import { getUserById } from "../repositories/user.js";
import { isTeamMemberByHabitatId } from "../repositories/teamMember.js";
import { adminOnly } from "../middleware/rbac.js";
import { parseSlackCommand } from "../services/slackService.js";
import { formatSlackResponse } from "../services/slackService.js";
import { formatDiscordResponse } from "../services/discordService.js";
import { executeCommand, sendTestMessage } from "../services/chatService.js";
import { executeChatReviewDecision } from "../services/chatReviewDecision.js";
import { validateOutboundUrl } from "../config/integrationSecurity.js";
import {
  badRequest,
  notFound,
  internalError,
  forbidden,
  conflict,
  unauthorized,
} from "../errors.js";
import { RepositoryError } from "../errors/repository.js";
import { isSqliteError } from "../errors/sqlite.js";

interface CreateIntegrationBody {
  provider: "slack" | "discord";
  webhookUrl: string;
  channelId?: string;
  providerWorkspaceId?: string | null;
  botToken?: string;
  events?: string[];
}

interface UpdateIntegrationBody {
  webhookUrl?: string;
  channelId?: string;
  providerWorkspaceId?: string | null;
  botToken?: string;
  enabled?: boolean;
  events?: string[];
}

interface CreateSpeakerMappingBody {
  providerWorkspaceId: string;
  providerSpeakerId: string;
  localUserId: string;
}

const VALID_CHAT_EVENTS = [
  "task_created",
  "task_claimed",
  "task_submitted",
  "task_approved",
  "task_rejected",
  "task_overdue",
];

/**
 * Decodes one `application/x-www-form-urlencoded` body (Slack's actual
 * slash-command wire format) into plain string-valued fields using the
 * platform parser: WHATWG `URLSearchParams` semantics — `+` decodes to a
 * space and `%XX` percent-sequences decode to their bytes; undecodable
 * sequences pass through as-is instead of throwing. Duplicate keys resolve
 * deterministic LAST-WINS (never an array), and the container is
 * null-prototype so adversarial keys (`__proto__`, `constructor`) become
 * own properties instead of mutating the prototype chain.
 */
function parseFormUrlEncoded(body: string): Record<string, string> {
  const fields: Record<string, string> = Object.create(null);
  for (const [key, value] of new URLSearchParams(body)) {
    fields[key] = value;
  }
  return fields;
}

/**
 * Decision-ingress proof gate: review decisions require GENUINE verified
 * ingress — the installed guard's proof must exist, carry the provider's
 * expected core verifier id, and report verified === true. This holds in
 * EVERY posture: the local-dev fail-open allowance (missing secret ⇒
 * guard records verified:false and passes) covers READ commands only — an
 * unsigned request must never reach a mapped human's review authority.
 * Missing/failed/wrong-verifier proof refuses with 401 before any
 * resolution, decision, event, or retry write.
 */
function requireVerifiedDecisionIngress(
  request: FastifyRequest,
  provider: "slack" | "discord",
): void {
  const proof = request.verifiedIngress;
  const expectedVerifier = provider === "slack" ? "slack_signing" : "discord_ed25519";
  if (!proof || proof.verifier !== expectedVerifier || proof.verified !== true) {
    throw unauthorized(
      `Review decisions require a verified ${provider === "slack" ? "Slack" : "Discord"} request signature`,
    );
  }
}

export async function chatIntegrationRoutes(fastify: FastifyInstance): Promise<void> {
  // Heterogeneous module: routes declare policy individually; this applier
  // installs their guards (a no-op on seam-constructed instances, where the
  // root installer has already done so).
  applyDeclaredAuthPolicies(fastify);

  fastify.get<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/chat-integrations",
    { preHandler: [adminOnly], config: { authPolicy: "human" } },
    async (request: FastifyRequest<{ Params: { habitatId: string } }>, _reply: FastifyReply) => {
      const { habitatId } = request.params;
      const habitat = getHabitatById(habitatId);
      if (!habitat) {
        throw notFound("Habitat not found");
      }
      const integrations = getIntegrationsByHabitat(habitatId);
      return integrations.map((i) => ({
        ...i,
        botToken: i.botToken ? "********" : null,
      }));
    },
  );

  fastify.post<{ Params: { habitatId: string }; Body: CreateIntegrationBody }>(
    "/habitats/:habitatId/chat-integrations",
    { preHandler: [adminOnly], config: { authPolicy: "human" } },
    async (
      request: FastifyRequest<{ Params: { habitatId: string }; Body: CreateIntegrationBody }>,
      _reply: FastifyReply,
    ) => {
      const { habitatId } = request.params;
      const { provider, webhookUrl, channelId, providerWorkspaceId, botToken, events } =
        request.body;

      if (!provider || !webhookUrl) {
        throw badRequest("provider and webhookUrl are required");
      }

      if (provider !== "slack" && provider !== "discord") {
        throw badRequest("provider must be slack or discord");
      }

      if (
        providerWorkspaceId !== undefined &&
        providerWorkspaceId !== null &&
        !String(providerWorkspaceId).trim()
      ) {
        throw badRequest("providerWorkspaceId must be a non-empty string when provided");
      }

      const urlValidation = await validateOutboundUrl(webhookUrl);
      if (!urlValidation.valid) {
        throw badRequest(`Unsafe webhook URL: ${urlValidation.reason}`);
      }

      const habitat = getHabitatById(habitatId);
      if (!habitat) {
        throw notFound("Habitat not found");
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
        providerWorkspaceId: providerWorkspaceId ?? null,
        botToken,
        events,
      });

      return integration;
    },
  );

  fastify.put<{ Params: { id: string }; Body: UpdateIntegrationBody }>(
    "/chat-integrations/:id",
    { preHandler: [adminOnly], config: { authPolicy: "human" } },
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: UpdateIntegrationBody }>,
      _reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const updates = request.body;

      const existing = getIntegrationById(id);
      if (!existing) {
        throw notFound("Integration not found");
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

      if (
        updates.providerWorkspaceId !== undefined &&
        updates.providerWorkspaceId !== null &&
        !String(updates.providerWorkspaceId).trim()
      ) {
        throw badRequest("providerWorkspaceId must be a non-empty string when provided");
      }

      const success = updateIntegration(id, updates);
      if (!success) {
        throw internalError("Failed to update integration");
      }

      const updated = getIntegrationById(id)!;
      return {
        ...updated,
        botToken: updated.botToken ? "********" : null,
      };
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/chat-integrations/:id",
    { preHandler: [adminOnly], config: { authPolicy: "human" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const { id } = request.params;
      const existing = getIntegrationById(id);
      if (!existing) {
        throw notFound("Integration not found");
      }
      const success = deleteIntegration(id);
      if (!success) {
        throw internalError("Failed to delete integration");
      }
      return { success: true };
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/chat-integrations/:id/test",
    { preHandler: [adminOnly], config: { authPolicy: "human" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const { id } = request.params;
      const integration = getIntegrationById(id);
      if (!integration) {
        throw notFound("Integration not found");
      }

      const result = await sendTestMessage(integration.webhookUrl, integration.provider);
      return result;
    },
  );

  // Speaker mappings: explicit attribution of a provider speaker
  // (workspace-scoped) to a REAL local human for review decisions made
  // through the signed chat ingress. Admin-only, same route family and
  // auth posture as the integration CRUD above. No external provider
  // lookup — v1 trusts operator-entered speaker ids; unmatched speakers
  // simply never resolve at decision time.
  fastify.get<{ Params: { habitatId: string; integrationId: string } }>(
    "/habitats/:habitatId/chat-integrations/:integrationId/speaker-mappings",
    { preHandler: [adminOnly], config: { authPolicy: "human" } },
    async (
      request: FastifyRequest<{ Params: { habitatId: string; integrationId: string } }>,
      _reply: FastifyReply,
    ) => {
      const { habitatId, integrationId } = request.params;
      const integration = getIntegrationById(integrationId);
      if (!integration) {
        throw notFound("Integration not found");
      }
      if (integration.habitatId !== habitatId) {
        throw forbidden("Integration does not belong to this habitat", "HABITAT_MISMATCH");
      }
      return { speakerMappings: getMappingsByIntegration(integrationId) };
    },
  );

  fastify.post<{
    Params: { habitatId: string; integrationId: string };
    Body: CreateSpeakerMappingBody;
  }>(
    "/habitats/:habitatId/chat-integrations/:integrationId/speaker-mappings",
    { preHandler: [adminOnly], config: { authPolicy: "human" } },
    async (
      request: FastifyRequest<{
        Params: { habitatId: string; integrationId: string };
        Body: CreateSpeakerMappingBody;
      }>,
      _reply: FastifyReply,
    ) => {
      const { habitatId, integrationId } = request.params;
      const { providerWorkspaceId, providerSpeakerId, localUserId } =
        request.body ?? ({} as CreateSpeakerMappingBody);

      const integration = getIntegrationById(integrationId);
      if (!integration) {
        throw notFound("Integration not found");
      }
      if (integration.habitatId !== habitatId) {
        throw forbidden("Integration does not belong to this habitat", "HABITAT_MISMATCH");
      }
      if (!integration.providerWorkspaceId) {
        throw badRequest(
          "Integration has no providerWorkspaceId configured; set it before mapping speakers (NULL-workspace integrations are push-only)",
        );
      }

      if (!providerWorkspaceId || !String(providerWorkspaceId).trim()) {
        throw badRequest("providerWorkspaceId is required");
      }
      if (providerWorkspaceId !== integration.providerWorkspaceId) {
        throw badRequest("providerWorkspaceId must match the integration's configured workspace");
      }
      if (!providerSpeakerId || !String(providerSpeakerId).trim()) {
        throw badRequest("providerSpeakerId is required");
      }

      // The mapped user must be a CURRENT, habitat-eligible human reviewer
      // (existence + role + team membership — the same policy re-checked at
      // decision time; never a snapshot).
      const user = getUserById(localUserId);
      if (!user) {
        throw badRequest("localUserId does not reference an existing user");
      }
      if (user.role !== "admin" && user.role !== "editor") {
        throw badRequest("Mapped user must hold the admin or editor role (viewer cannot review)");
      }
      const habitat = getHabitatById(habitatId);
      if (!habitat) {
        throw notFound("Habitat not found");
      }
      if (habitat.teamId && !isTeamMemberByHabitatId(habitatId, localUserId)) {
        throw badRequest("Mapped user is not a member of this habitat's team");
      }

      try {
        const mapping = createMapping({
          integrationId,
          providerWorkspaceId,
          providerSpeakerId,
          localUserId,
          createdBy: request.user!.id,
        });
        return mapping;
      } catch (err) {
        if (
          err instanceof RepositoryError &&
          ((isSqliteError(err.cause) && err.cause.code === "SQLITE_CONSTRAINT_UNIQUE") ||
            /UNIQUE constraint failed: chat_speaker_mappings/i.test(
              String(err.cause?.message ?? ""),
            ))
        ) {
          throw conflict("A mapping already exists for this speaker on the integration");
        }
        throw err;
      }
    },
  );

  fastify.delete<{ Params: { habitatId: string; integrationId: string; mappingId: string } }>(
    "/habitats/:habitatId/chat-integrations/:integrationId/speaker-mappings/:mappingId",
    { preHandler: [adminOnly], config: { authPolicy: "human" } },
    async (
      request: FastifyRequest<{
        Params: { habitatId: string; integrationId: string; mappingId: string };
      }>,
      _reply: FastifyReply,
    ) => {
      const { habitatId, integrationId, mappingId } = request.params;
      const integration = getIntegrationById(integrationId);
      if (!integration) {
        throw notFound("Integration not found");
      }
      if (integration.habitatId !== habitatId) {
        throw forbidden("Integration does not belong to this habitat", "HABITAT_MISMATCH");
      }
      const mappings = getMappingsByIntegration(integrationId);
      const mapping = mappings.find((m) => m.id === mappingId);
      if (!mapping || mapping.habitatId !== habitatId) {
        throw notFound("Speaker mapping not found");
      }
      const success = deleteMapping(mappingId);
      if (!success) {
        throw internalError("Failed to delete speaker mapping");
      }
      return { success: true };
    },
  );

  // Slack's slash commands arrive as application/x-www-form-urlencoded —
  // the wire format Slack itself sends. The urlencoded parser is confined
  // to this nested scope: Fastify encapsulation makes a content-type
  // parser visible only to routes registered inside the scope that
  // declares it, so no other route's content-type handling changes.
  // fastify-raw-body already captured the exact wire bytes at preParsing
  // (runFirst) before any parser runs, so the policy-installed
  // slack_signing guard still verifies the untouched bytes.
  await fastify.register(async (slackCommandScope: FastifyInstance) => {
    slackCommandScope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_request, body, done) => {
        // parseAs "string" always delivers a string; the Buffer arm of the
        // declared parameter type is unreachable and kept total without a cast.
        done(null, parseFormUrlEncoded(typeof body === "string" ? body : body.toString("utf8")));
      },
    );

    slackCommandScope.post(
      "/chat/slack/command",
      { config: { authPolicy: { policy: "verified_ingress", verifier: "slack_signing" } } },
      async (request: FastifyRequest, reply: FastifyReply) => {
        // Credential verification runs in the policy-installed
        // slack_verified_ingress guard (preHandler): a configured signing
        // secret must verify over the exact raw bytes; a missing secret fails
        // closed only under remote posture.

        const payload = request.body as {
          text?: string;
          team_id?: string;
          channel_id?: string;
          user_id?: string;
          response_url?: string;
        };

        const text = payload.text ?? "";
        const { action, args } = parseSlackCommand(text);

        if (action === "help" || !text.trim()) {
          const { response } = await executeCommand("help", "help", []);
          reply.send((response as { slack: object }).slack);
          return;
        }

        // Review decisions never use the default-habitat env: the signed
        // team_id/channel_id/user_id resolve an exact integration +
        // speaker mapping → a real local human principal (zero writes on
        // any refusal). Reads below keep the env-habitat semantics.
        if (action === "approve" || action === "reject") {
          requireVerifiedDecisionIngress(request, "slack");
          const result = await executeChatReviewDecision(
            {
              provider: "slack",
              providerWorkspaceId: payload.team_id,
              channelId: payload.channel_id,
              providerSpeakerId: payload.user_id,
            },
            action,
            args,
          );
          reply.send(formatSlackResponse(result.message, result.status !== "refused"));
          return;
        }

        const habitatId = process.env.ORCY_DEFAULT_HABITAT_ID;
        if (!habitatId) {
          reply.send({ text: "No default board configured. Set ORCY_DEFAULT_HABITAT_ID." });
          return;
        }

        const { response } = await executeCommand(habitatId, action, args);
        reply.send((response as { slack: object }).slack);
      },
    );
  });

  fastify.post(
    "/chat/discord/interaction",
    { config: { authPolicy: { policy: "verified_ingress", verifier: "discord_ed25519" } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Credential verification runs in the policy-installed
      // discord_verified_ingress guard (preHandler): a configured public key
      // must verify the Ed25519 signature over the exact raw bytes; a missing
      // key fails closed only under remote posture.

      const payload = request.body as {
        type?: number;
        data?: {
          name?: string;
          options?: Array<{
            name: string;
            value: string;
            options?: Array<{ name: string; value: string }>;
          }>;
        };
        guild_id?: string;
        channel_id?: string;
        member?: { user?: { id: string } };
      };

      if (payload.type === 1) {
        reply.send({ type: 1 });
        return;
      }

      if (payload.type === 2 && payload.data) {
        const { parseDiscordCommand } = await import("../services/discordService.js");
        const { action, args } = parseDiscordCommand(payload.data);

        // Review decisions never use the default-habitat env: the signed
        // guild_id/channel_id/member.user.id resolve an exact integration +
        // speaker mapping → a real local human principal. Guildless DMs
        // (no guild_id) refuse inside the resolver — no workspace, no
        // resolution, zero writes.
        if (action === "approve" || action === "reject") {
          requireVerifiedDecisionIngress(request, "discord");
          const result = await executeChatReviewDecision(
            {
              provider: "discord",
              providerWorkspaceId: payload.guild_id,
              channelId: payload.channel_id,
              providerSpeakerId: payload.member?.user?.id,
            },
            action,
            args,
          );
          reply.send({
            type: 4,
            data: formatDiscordResponse(result.message, result.status !== "refused"),
          });
          return;
        }

        const habitatId = process.env.ORCY_DEFAULT_HABITAT_ID;
        if (!habitatId) {
          reply.send({
            type: 4,
            data: { content: "No default board configured. Set ORCY_DEFAULT_HABITAT_ID." },
          });
          return;
        }

        const { response } = await executeCommand(habitatId, action, args);
        const discordResponse = (response as { discord: object }).discord;
        reply.send({ type: 4, data: discordResponse });
        return;
      }

      throw badRequest("Unknown interaction type");
    },
  );
}
