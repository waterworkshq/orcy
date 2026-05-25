import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { handleGitHubIssueWebhook } from '../services/integrations/webhookService.js';

export async function githubIssueWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/webhooks/github/issues',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const signature = request.headers['x-hub-signature-256'] as string | undefined;
      const body = request.body as Record<string, unknown>;
      const rawBody = (request.rawBody ?? JSON.stringify(body)) as string;

      const result = handleGitHubIssueWebhook(rawBody, signature, body as any);
      reply.code(result.statusCode).send(result.body);
    }
  );
}
