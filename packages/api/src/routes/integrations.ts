import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as connectionRepo from "../repositories/integrationConnection.js";
import * as linkRepo from "../repositories/externalIssueLink.js";
import * as candidateRepo from "../repositories/externalIntakeCandidate.js";
import * as syncRunRepo from "../repositories/integrationSyncRun.js";
import * as missionRepo from "../repositories/feature.js";
import { syncConnection, promoteIntakeCandidate } from "../services/integrations/syncService.js";
import {
  startGitHubDeviceFlow,
  pollGitHubDeviceFlow,
  getGitHubViewer,
} from "../services/integrations/githubOAuth.js";
import {
  getJiraCredentials,
  getJiraAuthorizationUrl,
  completeJiraOAuth,
} from "../services/integrations/jiraOAuth.js";
import {
  getLinearClientId,
  generatePKCEPair,
  getLinearAuthorizationUrl,
  completeLinearOAuth,
} from "../services/integrations/linearOAuth.js";
import {
  generateState,
  storeCodeVerifier,
  consumeState,
} from "../services/integrations/oauthState.js";
import { humanAuth, agentOrHumanAuth } from "../middleware/auth.js";
import { requireHabitatAccess } from "../middleware/team.js";
import { badRequest, notFound, forbidden, unauthorized } from "../errors.js";
import { isTeamMemberByHabitatId } from "../repositories/teamMember.js";
import { getHabitatById } from "../repositories/board.js";
import { resolveImportColumn } from "../repositories/column.js";
import { getProviderAdapter } from "../plugins/pluginManager.js";
import { z } from "zod";
import crypto from "crypto";
import type { ExternalIntakeReviewStatus, IntegrationProvider } from "@orcy/shared";

const promotingCandidates = new Set<string>();

const createPatSchema = z.object({
  name: z.string().min(1).max(200),
  token: z.string().min(1),
  repositoryOwner: z.string().min(1),
  repositoryName: z.string().min(1),
  autoImport: z.boolean().optional(),
  pullEnabled: z.boolean().optional(),
});

const updateConnectionSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  pullEnabled: z.boolean().optional(),
  autoImport: z.boolean().optional(),
});

const deviceFlowPollSchema = z.object({
  deviceCode: z.string().min(1),
});

function verifyConnectionAccess(request: FastifyRequest, habitatId: string): void {
  const habitat = getHabitatById(habitatId);
  if (!habitat) throw notFound("Habitat not found");

  if (request.agent) {
    if (!habitat.teamId) return;
    throw forbidden("Agents cannot access team habitats", "BOARD_ACCESS_DENIED");
  }

  if (request.user) {
    if (!habitat.teamId) return;
    if (isTeamMemberByHabitatId(habitatId, request.user.id)) return;
    throw forbidden("You do not have access to this habitat", "BOARD_ACCESS_DENIED");
  }

  throw unauthorized("Authentication required");
}

function getAdapter(provider: string) {
  const pluginAdapter = getProviderAdapter(provider);
  if (pluginAdapter) return pluginAdapter;

  if (provider === "github") {
    try {
      return require("../services/integrations/githubAdapter.js").githubAdapter;
    } catch {
      throw badRequest("GitHub adapter is not available");
    }
  }
  if (provider === "jira") {
    try {
      return require("../services/integrations/jiraAdapter.js").jiraAdapter;
    } catch {
      throw badRequest("Jira adapter is not available");
    }
  }
  if (provider === "linear") {
    try {
      return require("../services/integrations/linearAdapter.js").linearAdapter;
    } catch {
      throw badRequest("Linear adapter is not available");
    }
  }
  throw badRequest(`Provider '${provider}' is not supported yet`);
}

export async function integrationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/integrations",
    { preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request) => {
      const connections = connectionRepo.listByHabitat(request.params.habitatId);
      return { integrations: connections.map((c) => connectionRepo.toView(c)) };
    },
  );

  fastify.post<{ Params: { habitatId: string }; Body: z.infer<typeof createPatSchema> }>(
    "/habitats/:habitatId/integrations/github/pat",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, reply) => {
      const parsed = createPatSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      const userId = (request as any).user?.id ?? "unknown";

      const webhookSecret = crypto.randomBytes(32).toString("hex");

      const connection = connectionRepo.create({
        habitatId: request.params.habitatId,
        provider: "github",
        name: parsed.data.name,
        authMethod: "pat",
        accessToken: parsed.data.token,
        repositoryOwner: parsed.data.repositoryOwner,
        repositoryName: parsed.data.repositoryName,
        autoImport: parsed.data.autoImport ?? false,
        pullEnabled: parsed.data.pullEnabled ?? true,
        webhookSecret,
        createdBy: userId,
      });

      reply.code(201).send({ integration: connectionRepo.toView(connection) });
    },
  );

  fastify.post<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/integrations/github/oauth/device/start",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (_request) => {
      const flow = await startGitHubDeviceFlow();
      return {
        deviceCode: flow.device_code,
        userCode: flow.user_code,
        verificationUri: flow.verification_uri,
        expiresIn: flow.expires_in,
        interval: flow.interval,
      };
    },
  );

  fastify.post<{ Params: { habitatId: string }; Body: z.infer<typeof deviceFlowPollSchema> }>(
    "/habitats/:habitatId/integrations/github/oauth/device/poll",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, reply) => {
      const parsed = deviceFlowPollSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("deviceCode is required");
      }

      const { deviceCode } = parsed.data;
      const result = await pollGitHubDeviceFlow(deviceCode);

      if (result.error === "authorization_pending") {
        return { status: "pending" };
      }

      if (result.error === "slow_down") {
        return { status: "pending" };
      }

      if (result.access_token) {
        const viewer = await getGitHubViewer(result.access_token);

        const userId = (request as any).user?.id ?? "unknown";

        const connection = connectionRepo.create({
          habitatId: request.params.habitatId,
          provider: "github",
          name: `${viewer.login}/github`,
          authMethod: "oauth_device",
          accessToken: result.access_token,
          repositoryOwner: viewer.login,
          repositoryName: null,
          externalAccountId: String(viewer.id),
          externalAccountName: viewer.login,
          autoImport: false,
          pullEnabled: true,
          createdBy: userId,
        });

        reply.code(201).send({ integration: connectionRepo.toView(connection) });
        return reply;
      }

      if (result.error === "expired_token") {
        throw badRequest("Device code expired. Please start a new authorization flow.");
      }

      if (result.error === "access_denied") {
        throw badRequest("Authorization was denied by the user.");
      }

      throw badRequest(
        result.error_description || result.error || "Unknown error during authorization",
      );
    },
  );

  fastify.patch<{ Params: { connectionId: string }; Body: z.infer<typeof updateConnectionSchema> }>(
    "/integrations/:connectionId",
    { preHandler: [humanAuth] },
    async (request) => {
      const parsed = updateConnectionSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      const existing = connectionRepo.getById(request.params.connectionId);
      if (!existing) throw notFound("Connection not found");

      verifyConnectionAccess(request, existing.habitatId);

      const updated = connectionRepo.update(request.params.connectionId, parsed.data);
      return { integration: connectionRepo.toView(updated!) };
    },
  );

  fastify.delete<{ Params: { connectionId: string } }>(
    "/integrations/:connectionId",
    { preHandler: [humanAuth] },
    async (request: FastifyRequest<{ Params: { connectionId: string } }>, reply: FastifyReply) => {
      const existing = connectionRepo.getById(request.params.connectionId);
      if (!existing) throw notFound("Connection not found");

      verifyConnectionAccess(request, existing.habitatId);

      connectionRepo.disable(request.params.connectionId);
      reply.code(204).send();
    },
  );

  fastify.post<{ Params: { connectionId: string } }>(
    "/integrations/:connectionId/sync",
    { preHandler: [humanAuth] },
    async (request) => {
      const existing = connectionRepo.getById(request.params.connectionId);
      if (!existing) throw notFound("Connection not found");

      verifyConnectionAccess(request, existing.habitatId);

      if (!existing.enabled) throw badRequest("Connection is disabled");
      if (!existing.pullEnabled) throw badRequest("Pull sync is disabled");

      const adapter = getAdapter(existing.provider);
      const result = await syncConnection(request.params.connectionId, "manual", adapter);
      return result;
    },
  );

  fastify.get<{ Params: { connectionId: string } }>(
    "/integrations/:connectionId/sync-runs",
    { preHandler: [humanAuth] },
    async (request) => {
      const existing = connectionRepo.getById(request.params.connectionId);
      if (!existing) throw notFound("Connection not found");

      verifyConnectionAccess(request, existing.habitatId);

      const runs = syncRunRepo.listByConnectionId(request.params.connectionId);
      return { syncRuns: runs };
    },
  );

  fastify.get<{ Params: { missionId: string } }>(
    "/missions/:missionId/external-links",
    { preHandler: [agentOrHumanAuth] },
    async (request) => {
      const links = linkRepo.listByMissionId(request.params.missionId);
      return { externalLinks: links };
    },
  );

  const jiraOAuthStartSchema = z.object({
    redirectPort: z.number().optional(),
  });

  fastify.post<{ Params: { habitatId: string }; Body?: z.infer<typeof jiraOAuthStartSchema> }>(
    "/habitats/:habitatId/integrations/jira/oauth/start",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request) => {
      const { clientId, clientSecret: _secret } = getJiraCredentials();
      const state = generateState(request.params.habitatId);
      const port = (request.body as any)?.redirectPort;
      if (!port) throw new Error("redirectPort is required");
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const authUrl = getJiraAuthorizationUrl(clientId, redirectUri, state);
      return { authUrl, state, redirectPort: port };
    },
  );

  const jiraOAuthCompleteSchema = z.object({
    code: z.string().min(1),
    state: z.string().min(1),
    redirectPort: z.number(),
  });

  fastify.post<{ Params: { habitatId: string }; Body: z.infer<typeof jiraOAuthCompleteSchema> }>(
    "/habitats/:habitatId/integrations/jira/oauth/complete",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, reply) => {
      const parsed = jiraOAuthCompleteSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest("Validation failed", parsed.error.flatten());

      const stateResult = consumeState(parsed.data.state, request.params.habitatId);
      if (!stateResult) throw badRequest("Invalid or expired OAuth state");

      const result = await completeJiraOAuth({
        code: parsed.data.code,
        redirectPort: parsed.data.redirectPort,
        habitatId: request.params.habitatId,
        userId: (request as any).user?.id ?? "unknown",
      });

      reply.code(201).send(result);
      return reply;
    },
  );

  const jiraApiKeySchema = z.object({
    name: z.string().min(1).max(200),
    email: z.string().email(),
    token: z.string().min(1),
    siteUrl: z.string().url(),
    projectKey: z.string().min(1),
    autoImport: z.boolean().optional(),
    pullEnabled: z.boolean().optional(),
  });

  fastify.post<{ Params: { habitatId: string }; Body: z.infer<typeof jiraApiKeySchema> }>(
    "/habitats/:habitatId/integrations/jira/api-key",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, reply) => {
      const parsed = jiraApiKeySchema.safeParse(request.body);
      if (!parsed.success) throw badRequest("Validation failed", parsed.error.flatten());

      const userId = (request as any).user?.id ?? "unknown";

      const connection = connectionRepo.create({
        habitatId: request.params.habitatId,
        provider: "jira",
        name: parsed.data.name,
        authMethod: "api_key",
        accessToken: parsed.data.token,
        externalAccountName: parsed.data.email,
        externalTenantId: null,
        externalTenantName: new URL(parsed.data.siteUrl).hostname,
        externalBaseUrl: parsed.data.siteUrl.replace(/\/+$/, ""),
        projectKey: parsed.data.projectKey,
        autoImport: parsed.data.autoImport ?? false,
        pullEnabled: parsed.data.pullEnabled ?? true,
        createdBy: userId,
      });

      reply.code(201).send({ integration: connectionRepo.toView(connection) });
      return reply;
    },
  );

  const linearOAuthStartSchema = z.object({
    redirectPort: z.number().optional(),
  });

  fastify.post<{ Params: { habitatId: string }; Body?: z.infer<typeof linearOAuthStartSchema> }>(
    "/habitats/:habitatId/integrations/linear/oauth/start",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request) => {
      const clientId = getLinearClientId();
      const { codeVerifier, codeChallenge } = generatePKCEPair();
      const state = generateState(request.params.habitatId);
      storeCodeVerifier(state, codeVerifier);
      const port = (request.body as any)?.redirectPort;
      if (!port) throw new Error("redirectPort is required");
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const authUrl = getLinearAuthorizationUrl(clientId, redirectUri, codeChallenge, state);
      return { authUrl, state, redirectPort: port };
    },
  );

  const linearOAuthCompleteSchema = z.object({
    code: z.string().min(1),
    state: z.string().min(1),
    redirectPort: z.number(),
  });

  fastify.post<{ Params: { habitatId: string }; Body: z.infer<typeof linearOAuthCompleteSchema> }>(
    "/habitats/:habitatId/integrations/linear/oauth/complete",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, reply) => {
      const parsed = linearOAuthCompleteSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest("Validation failed", parsed.error.flatten());

      const stateResult = consumeState(parsed.data.state, request.params.habitatId);
      if (!stateResult || !stateResult.codeVerifier)
        throw badRequest("Invalid or expired OAuth state");

      const result = await completeLinearOAuth({
        code: parsed.data.code,
        redirectPort: parsed.data.redirectPort,
        habitatId: request.params.habitatId,
        userId: (request as any).user?.id ?? "unknown",
        codeVerifier: stateResult.codeVerifier,
      });

      reply.code(201).send(result);
      return reply;
    },
  );

  const linearApiKeySchema = z.object({
    name: z.string().min(1).max(200),
    token: z.string().min(1),
    teamId: z.string().min(1),
    autoImport: z.boolean().optional(),
    pullEnabled: z.boolean().optional(),
  });

  fastify.post<{ Params: { habitatId: string }; Body: z.infer<typeof linearApiKeySchema> }>(
    "/habitats/:habitatId/integrations/linear/api-key",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, reply) => {
      const parsed = linearApiKeySchema.safeParse(request.body);
      if (!parsed.success) throw badRequest("Validation failed", parsed.error.flatten());

      const userId = (request as any).user?.id ?? "unknown";

      const connection = connectionRepo.create({
        habitatId: request.params.habitatId,
        provider: "linear",
        name: parsed.data.name,
        authMethod: "api_key",
        accessToken: parsed.data.token,
        teamId: parsed.data.teamId,
        autoImport: parsed.data.autoImport ?? false,
        pullEnabled: parsed.data.pullEnabled ?? true,
        createdBy: userId,
      });

      reply.code(201).send({ integration: connectionRepo.toView(connection) });
      return reply;
    },
  );

  fastify.get<{
    Params: { habitatId: string };
    Querystring: { reviewStatus?: string; provider?: string };
  }>(
    "/habitats/:habitatId/intake-candidates",
    { preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request) => {
      const filters: { reviewStatus?: ExternalIntakeReviewStatus; provider?: IntegrationProvider } =
        {};
      if (request.query.reviewStatus)
        filters.reviewStatus = request.query.reviewStatus as ExternalIntakeReviewStatus;
      if (request.query.provider) filters.provider = request.query.provider as IntegrationProvider;

      const candidates = candidateRepo.listByHabitat(request.params.habitatId, filters);
      return { candidates, total: candidates.length };
    },
  );

  fastify.get<{ Params: { candidateId: string } }>(
    "/intake-candidates/:candidateId",
    { preHandler: [agentOrHumanAuth] },
    async (request) => {
      const candidate = candidateRepo.getById(request.params.candidateId);
      if (!candidate) throw notFound("Candidate not found");
      verifyConnectionAccess(request, candidate.habitatId);
      return { candidate };
    },
  );

  fastify.post<{ Params: { candidateId: string } }>(
    "/intake-candidates/:candidateId/promote",
    { preHandler: [humanAuth] },
    async (request, reply) => {
      const candidateId = request.params.candidateId;
      if (promotingCandidates.has(candidateId)) {
        throw badRequest("Candidate is already being promoted");
      }
      promotingCandidates.add(candidateId);
      try {
        const result = promoteIntakeCandidate({
          candidateId,
          createdBy: (request as any).user?.id ?? "unknown",
          verifyAccess: (habitatId: string) => verifyConnectionAccess(request, habitatId),
        });

        reply.code(201).send(result);
        return reply;
      } finally {
        promotingCandidates.delete(candidateId);
      }
    },
  );

  fastify.post<{ Params: { candidateId: string } }>(
    "/intake-candidates/:candidateId/ignore",
    { preHandler: [humanAuth] },
    async (request) => {
      const candidate = candidateRepo.getById(request.params.candidateId);
      if (!candidate) throw notFound("Candidate not found");
      verifyConnectionAccess(request, candidate.habitatId);

      const updated = candidateRepo.update(candidate.id, { reviewStatus: "ignored" });
      return { candidate: updated };
    },
  );

  fastify.post<{ Params: { candidateId: string } }>(
    "/intake-candidates/:candidateId/needs-clarification",
    { preHandler: [humanAuth] },
    async (request) => {
      const candidate = candidateRepo.getById(request.params.candidateId);
      if (!candidate) throw notFound("Candidate not found");
      verifyConnectionAccess(request, candidate.habitatId);

      const updated = candidateRepo.update(candidate.id, { reviewStatus: "needs_clarification" });
      return { candidate: updated };
    },
  );
}
