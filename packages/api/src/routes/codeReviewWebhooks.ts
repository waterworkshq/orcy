import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as prRepo from '../repositories/pullRequest.js';
import * as githubService from '../services/githubWebhook.js';
import * as gitlabService from '../services/gitlabWebhook.js';
import { humanAuth } from '../middleware/auth.js';
import { isRemotePosture } from '../config/integrationSecurity.js';
import {
  lookupBoardIdBySecret,
  hasAnySecretsConfigured,
  findBoardIdByGithubSignature,
  hasGithubSecretsConfigured,
} from '../services/boardSecretCache.js';

export async function codeReviewWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/webhooks/github',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const signature = request.headers['x-hub-signature-256'] as string | undefined;
      const event = request.headers['x-github-event'] as string | undefined;
      const body = request.body as Record<string, unknown>;
      const rawBody = (request.rawBody ?? JSON.stringify(body)) as string;

      if (!event) {
        reply.code(400).send({ error: 'Missing X-GitHub-Event header' });
        return;
      }

      const repo = (body as { repository?: { full_name?: string } })?.repository?.full_name;

      let matched = false;

      if (signature) {
        matched = findBoardIdByGithubSignature(rawBody, signature) !== null;
      }

      if (!matched && (hasGithubSecretsConfigured() || isRemotePosture())) {
        reply.code(401).send({ error: 'Invalid or missing signature' });
        return;
      }

      if (event === 'pull_request') {
        const result = githubService.handlePullRequestEvent(body as unknown as Parameters<typeof githubService.handlePullRequestEvent>[0]);
        return result;
      }

      if (event === 'pull_request_review') {
        const result = githubService.handlePullRequestReviewEvent(body as unknown as Parameters<typeof githubService.handlePullRequestReviewEvent>[0]);
        return result;
      }

      return { status: 'ignored', event };
    }
  );

  fastify.post(
    '/webhooks/gitlab',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const providedToken = request.headers['x-gitlab-token'] as string | undefined;
      const body = request.body as Record<string, unknown>;
      const objectKind = body.object_kind as string | undefined;

      if (!objectKind) {
        reply.code(400).send({ error: 'Missing object_kind' });
        return;
      }

      let matched = false;

      if (providedToken) {
        const boardId = lookupBoardIdBySecret(providedToken);
        if (boardId) {
          matched = true;
        }
      }

      if (!matched && (hasAnySecretsConfigured() || isRemotePosture())) {
        reply.code(401).send({ error: 'Invalid or missing token' });
        return;
      }

      if (objectKind === 'merge_request') {
        const result = gitlabService.handleMergeRequestEvent(body as unknown as Parameters<typeof gitlabService.handleMergeRequestEvent>[0]);
        return result;
      }

      if (objectKind === 'note') {
        const result = gitlabService.handleNoteEvent(body as unknown as Parameters<typeof gitlabService.handleNoteEvent>[0]);
        return result;
      }

      return { status: 'ignored', objectKind };
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/tasks/:id/pull-requests',
    { preHandler: [humanAuth] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const prs = prRepo.getByTaskId(id);
      return { pullRequests: prs };
    }
  );
}
