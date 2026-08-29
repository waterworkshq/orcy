import { applyDeclaredAuthPolicies } from "../authPolicy.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  getIntegrationsByHabitat,
  getIntegrationById,
  createIntegration,
  updateIntegration,
  deleteIntegration,
} from "../repositories/chatIntegration.js";
import { getHabitatById } from "../repositories/habitat.js";
import { adminOnly } from "../middleware/rbac.js";
import { parseSlackCommand } from "../services/slackService.js";
import { executeCommand, sendTestMessage } from "../services/chatService.js";
import { validateOutboundUrl } from "../config/integrationSecurity.js";
import { badRequest, notFound, internalError } from "../errors.js";

interface CreateIntegrationBody {
  provider: "slack" | "discord";
  webhookUrl: string;
  channelId?: string;
  botToken?: string;
  events?: string[];
}

interface UpdateIntegrationBody {
  webhookUrl?: string;
  channelId?: string;
  botToken?: string;
  enabled?: boolean;
  events?: string[];
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
      const { provider, webhookUrl, channelId, botToken, events } = request.body;

      if (!provider || !webhookUrl) {
        throw badRequest("provider and webhookUrl are required");
      }

      if (provider !== "slack" && provider !== "discord") {
        throw badRequest("provider must be slack or discord");
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

        const habitatId = process.env.ORCY_DEFAULT_HABITAT_ID;
        if (!habitatId) {
          reply.send({ text: "No default board configured. Set ORCY_DEFAULT_HABITAT_ID." });
          return;
        }

        const { response } = await executeCommand(habitatId, action, args, payload.user_id);
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

        const habitatId = process.env.ORCY_DEFAULT_HABITAT_ID;
        if (!habitatId) {
          reply.send({
            type: 4,
            data: { content: "No default board configured. Set ORCY_DEFAULT_HABITAT_ID." },
          });
          return;
        }

        const { response } = await executeCommand(
          habitatId,
          action,
          args,
          payload.member?.user?.id,
        );
        const discordResponse = (response as { discord: object }).discord;
        reply.send({ type: 4, data: discordResponse });
        return;
      }

      throw badRequest("Unknown interaction type");
    },
  );
}
