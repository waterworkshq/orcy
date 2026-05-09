import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as ciCdService from '../services/ciCdService.js';
import * as boardRepo from '../repositories/board.js';
import * as pipelineRepo from '../repositories/pipelineEvent.js';
import { humanAuth } from '../middleware/auth.js';
import { verifyGitHubHmac, verifyGitLabToken } from '../config/integrationSecurity.js';

export async function ciCdWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/webhooks/github-ci',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const signature = request.headers['x-hub-signature-256'] as string | undefined;
      const event = request.headers['x-github-event'] as string | undefined;
      const body = request.body as Record<string, unknown>;
      const rawBody = (request.rawBody ?? JSON.stringify(body)) as string;

      if (!event) {
        reply.code(400).send({ error: 'Missing X-GitHub-Event header' });
        return;
      }

      const boards = boardRepo.listBoards();
      let matched = false;
      let anySecretConfigured = false;

      for (const board of boards) {
        const raw = (board as unknown as Record<string, unknown>).ci_cd_settings;
        if (!raw || typeof raw !== 'string') continue;
        try {
          const settings = JSON.parse(raw) as { githubSecret?: string };
          if (settings.githubSecret) {
            anySecretConfigured = true;
            if (signature && verifyGitHubHmac(rawBody, signature, settings.githubSecret)) {
              matched = true;
              break;
            }
          }
        } catch { continue; }
      }

      if (anySecretConfigured && !matched) {
        reply.code(401).send({ error: 'Invalid or missing signature' });
        return;
      }

      if (event === 'workflow_run') {
        const result = ciCdService.handleGitHubWorkflowRunEvent(body as unknown as Parameters<typeof ciCdService.handleGitHubWorkflowRunEvent>[0]);
        return result;
      }

      if (event === 'workflow_job') {
        const result = ciCdService.handleGitHubWorkflowJobEvent(body as unknown as Parameters<typeof ciCdService.handleGitHubWorkflowJobEvent>[0]);
        return result;
      }

      return { status: 'ignored', event };
    }
  );

  fastify.post(
    '/webhooks/gitlab-ci',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const providedToken = request.headers['x-gitlab-token'] as string | undefined;
      const body = request.body as Record<string, unknown>;
      const objectKind = body.object_kind as string | undefined;

      if (!objectKind) {
        reply.code(400).send({ error: 'Missing object_kind' });
        return;
      }

      const boards = boardRepo.listBoards();
      let matched = false;
      let anySecretConfigured = false;

      for (const board of boards) {
        const raw = (board as unknown as Record<string, unknown>).ci_cd_settings;
        if (!raw || typeof raw !== 'string') continue;
        try {
          const settings = JSON.parse(raw) as { gitlabSecret?: string };
          if (settings.gitlabSecret) {
            anySecretConfigured = true;
            if (providedToken && verifyGitLabToken(providedToken, settings.gitlabSecret)) {
              matched = true;
              break;
            }
          }
        } catch { continue; }
      }

      if (anySecretConfigured && !matched) {
        reply.code(401).send({ error: 'Invalid or missing token' });
        return;
      }

      if (objectKind === 'pipeline') {
        const result = ciCdService.handleGitLabPipelineEvent(body as unknown as Parameters<typeof ciCdService.handleGitLabPipelineEvent>[0]);
        return result;
      }

      if (objectKind === 'build') {
        const result = ciCdService.handleGitLabJobEvent(body as unknown as Parameters<typeof ciCdService.handleGitLabJobEvent>[0]);
        return result;
      }

      return { status: 'ignored', objectKind };
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/tasks/:id/pipeline-events',
    { preHandler: [humanAuth] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const events = pipelineRepo.getByTaskId(id);
      return { pipelineEvents: events };
    }
  );
}
