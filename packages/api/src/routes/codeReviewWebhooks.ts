import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as prRepo from '../repositories/pullRequest.js';
import * as githubService from '../services/githubWebhook.js';
import * as gitlabService from '../services/gitlabWebhook.js';
import { humanAuth } from '../middleware/auth.js';
import {
  createCodeReviewSecretSource,
  handleGitHubWebhook,
  handleGitLabWebhook,
} from '../services/webhooks/webhook-secret-verification.js';

const secretSource = createCodeReviewSecretSource();

export async function codeReviewWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/webhooks/github',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const signature = request.headers['x-hub-signature-256'] as string | undefined;
      const event = request.headers['x-github-event'] as string | undefined;
      const body = request.body as Record<string, unknown>;
      const rawBody = (request.rawBody ?? JSON.stringify(body)) as string;

      const result = handleGitHubWebhook(
        secretSource,
        { body, rawBody, event, signature },
        {
          pull_request: (b) => githubService.handlePullRequestEvent(b as Parameters<typeof githubService.handlePullRequestEvent>[0]),
          pull_request_review: (b) => githubService.handlePullRequestReviewEvent(b as Parameters<typeof githubService.handlePullRequestReviewEvent>[0]),
        },
        { failClosed: true },
      );

      if (result.statusCode !== 200) {
        reply.code(result.statusCode).send(result.body);
        return;
      }
      return result.body;
    }
  );

  fastify.post(
    '/webhooks/gitlab',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const providedToken = request.headers['x-gitlab-token'] as string | undefined;
      const body = request.body as Record<string, unknown>;
      const objectKind = body.object_kind as string | undefined;

      const result = handleGitLabWebhook(
        secretSource,
        { body, providedToken, objectKind },
        {
          merge_request: (b) => gitlabService.handleMergeRequestEvent(b as Parameters<typeof gitlabService.handleMergeRequestEvent>[0]),
          note: (b) => gitlabService.handleNoteEvent(b as Parameters<typeof gitlabService.handleNoteEvent>[0]),
        },
        { failClosed: true },
      );

      if (result.statusCode !== 200) {
        reply.code(result.statusCode).send(result.body);
        return;
      }
      return result.body;
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/tasks/:id/pull-requests',
    { preHandler: [humanAuth] },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const { id } = request.params;
      const prs = prRepo.getByTaskId(id);
      return { pullRequests: prs };
    }
  );
}
