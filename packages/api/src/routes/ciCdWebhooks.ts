import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as ciCdService from '../services/ciCdService.js';
import * as pipelineRepo from '../repositories/pipelineEvent.js';
import { humanAuth } from '../middleware/auth.js';
import {
  createCiCdSecretSource,
  handleGitHubWebhook,
  handleGitLabWebhook,
} from '../services/webhooks/webhook-secret-verification.js';

const secretSource = createCiCdSecretSource();

export async function ciCdWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/webhooks/github-ci',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const signature = request.headers['x-hub-signature-256'] as string | undefined;
      const event = request.headers['x-github-event'] as string | undefined;
      const body = request.body as Record<string, unknown>;
      const rawBody = (request.rawBody ?? JSON.stringify(body)) as string;

      const result = handleGitHubWebhook(
        secretSource,
        { body, rawBody, event, signature },
        {
          workflow_run: (b) => ciCdService.handleGitHubWorkflowRunEvent(b as Parameters<typeof ciCdService.handleGitHubWorkflowRunEvent>[0]),
          workflow_job: (b) => ciCdService.handleGitHubWorkflowJobEvent(b as Parameters<typeof ciCdService.handleGitHubWorkflowJobEvent>[0]),
        },
      );

      if (result.statusCode !== 200) {
        reply.code(result.statusCode).send(result.body);
        return;
      }
      return result.body;
    }
  );

  fastify.post(
    '/webhooks/gitlab-ci',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const providedToken = request.headers['x-gitlab-token'] as string | undefined;
      const body = request.body as Record<string, unknown>;
      const objectKind = body.object_kind as string | undefined;

      const result = handleGitLabWebhook(
        secretSource,
        { body, providedToken, objectKind },
        {
          pipeline: (b) => ciCdService.handleGitLabPipelineEvent(b as Parameters<typeof ciCdService.handleGitLabPipelineEvent>[0]),
          build: (b) => ciCdService.handleGitLabJobEvent(b as Parameters<typeof ciCdService.handleGitLabJobEvent>[0]),
        },
      );

      if (result.statusCode !== 200) {
        reply.code(result.statusCode).send(result.body);
        return;
      }
      return result.body;
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
