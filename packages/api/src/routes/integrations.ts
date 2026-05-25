import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as connectionRepo from '../repositories/integrationConnection.js';
import * as linkRepo from '../repositories/externalIssueLink.js';
import * as syncRunRepo from '../repositories/integrationSyncRun.js';
import { syncConnection } from '../services/integrations/syncService.js';
import { startGitHubDeviceFlow, pollGitHubDeviceFlow, getGitHubViewer } from '../services/integrations/githubOAuth.js';
import { humanAuth, agentOrHumanAuth } from '../middleware/auth.js';
import { requireHabitatAccess } from '../middleware/team.js';
import { badRequest, notFound, forbidden, unauthorized } from '../errors.js';
import { isTeamMemberByHabitatId } from '../repositories/teamMember.js';
import { getHabitatById } from '../repositories/board.js';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import crypto from 'crypto';

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
  if (!habitat) throw notFound('Habitat not found');

  if (request.agent) {
    if (!habitat.teamId) return;
    throw forbidden('Agents cannot access team habitats', 'BOARD_ACCESS_DENIED');
  }

  if (request.user) {
    if (!habitat.teamId) return;
    if (isTeamMemberByHabitatId(habitatId, request.user.id)) return;
    throw forbidden('You do not have access to this habitat', 'BOARD_ACCESS_DENIED');
  }

  throw unauthorized('Authentication required');
}

function getAdapter(provider: string) {
  if (provider === 'github') {
    try {
      return require('../services/integrations/githubAdapter.js').githubAdapter;
    } catch {
      throw badRequest('GitHub adapter is not available');
    }
  }
  throw badRequest(`Provider '${provider}' is not supported yet`);
}

export async function integrationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { habitatId: string } }>(
    '/habitats/:habitatId/integrations',
    { preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request) => {
      const connections = connectionRepo.listByHabitat(request.params.habitatId);
      return { integrations: connections.map(c => connectionRepo.toView(c)) };
    }
  );

  fastify.post<{ Params: { habitatId: string }; Body: z.infer<typeof createPatSchema> }>(
    '/habitats/:habitatId/integrations/github/pat',
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, reply) => {
      const parsed = createPatSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Validation failed', parsed.error.flatten());
      }

      const userId = (request as any).user?.id ?? 'unknown';

      const webhookSecret = crypto.randomBytes(32).toString('hex');

      const connection = connectionRepo.create({
        habitatId: request.params.habitatId,
        provider: 'github',
        name: parsed.data.name,
        authMethod: 'pat',
        accessToken: parsed.data.token,
        repositoryOwner: parsed.data.repositoryOwner,
        repositoryName: parsed.data.repositoryName,
        autoImport: parsed.data.autoImport ?? false,
        pullEnabled: parsed.data.pullEnabled ?? true,
        webhookSecret,
        createdBy: userId,
      });

      reply.code(201).send({ integration: connectionRepo.toView(connection) });
    }
  );

  fastify.post<{ Params: { habitatId: string } }>(
    '/habitats/:habitatId/integrations/github/oauth/device/start',
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
    }
  );

  fastify.post<{ Params: { habitatId: string }; Body: z.infer<typeof deviceFlowPollSchema> }>(
    '/habitats/:habitatId/integrations/github/oauth/device/poll',
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, reply) => {
      const parsed = deviceFlowPollSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('deviceCode is required');
      }

      const { deviceCode } = parsed.data;
      const result = await pollGitHubDeviceFlow(deviceCode);

      if (result.error === 'authorization_pending') {
        return { status: 'pending' };
      }

      if (result.error === 'slow_down') {
        return { status: 'pending' };
      }

      if (result.access_token) {
        const viewer = await getGitHubViewer(result.access_token);

        const userId = (request as any).user?.id ?? 'unknown';

        const connection = connectionRepo.create({
          habitatId: request.params.habitatId,
          provider: 'github',
          name: `${viewer.login}/github`,
          authMethod: 'oauth_device',
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

      if (result.error === 'expired_token') {
        throw badRequest('Device code expired. Please start a new authorization flow.');
      }

      if (result.error === 'access_denied') {
        throw badRequest('Authorization was denied by the user.');
      }

      throw badRequest(result.error_description || result.error || 'Unknown error during authorization');
    }
  );

  fastify.patch<{ Params: { connectionId: string }; Body: z.infer<typeof updateConnectionSchema> }>(
    '/integrations/:connectionId',
    { preHandler: [humanAuth] },
    async (request) => {
      const parsed = updateConnectionSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Validation failed', parsed.error.flatten());
      }

      const existing = connectionRepo.getById(request.params.connectionId);
      if (!existing) throw notFound('Connection not found');

      verifyConnectionAccess(request, existing.habitatId);

      const updated = connectionRepo.update(request.params.connectionId, parsed.data);
      return { integration: connectionRepo.toView(updated!) };
    }
  );

  fastify.delete<{ Params: { connectionId: string } }>(
    '/integrations/:connectionId',
    { preHandler: [humanAuth] },
    async (request: FastifyRequest<{ Params: { connectionId: string } }>, reply: FastifyReply) => {
      const existing = connectionRepo.getById(request.params.connectionId);
      if (!existing) throw notFound('Connection not found');

      verifyConnectionAccess(request, existing.habitatId);

      connectionRepo.disable(request.params.connectionId);
      reply.code(204).send();
    }
  );

  fastify.post<{ Params: { connectionId: string } }>(
    '/integrations/:connectionId/sync',
    { preHandler: [humanAuth] },
    async (request) => {
      const existing = connectionRepo.getById(request.params.connectionId);
      if (!existing) throw notFound('Connection not found');

      verifyConnectionAccess(request, existing.habitatId);

      if (!existing.enabled) throw badRequest('Connection is disabled');
      if (!existing.pullEnabled) throw badRequest('Pull sync is disabled');

      const adapter = getAdapter(existing.provider);
      const result = await syncConnection(request.params.connectionId, 'manual', adapter);
      return result;
    }
  );

  fastify.get<{ Params: { connectionId: string } }>(
    '/integrations/:connectionId/sync-runs',
    { preHandler: [humanAuth] },
    async (request) => {
      const existing = connectionRepo.getById(request.params.connectionId);
      if (!existing) throw notFound('Connection not found');

      verifyConnectionAccess(request, existing.habitatId);

      const runs = syncRunRepo.listByConnectionId(request.params.connectionId);
      return { syncRuns: runs };
    }
  );

  fastify.get<{ Params: { missionId: string } }>(
    '/missions/:missionId/external-links',
    { preHandler: [agentOrHumanAuth] },
    async (request) => {
      const links = linkRepo.listByMissionId(request.params.missionId);
      return { externalLinks: links };
    }
  );
}
