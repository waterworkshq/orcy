import { applyDeclaredAuthPolicies } from "../authPolicy.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { dispatchGitHubIssueWebhook } from '../services/integrations/webhookService.js';

export async function githubIssueWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  // Heterogeneous module: routes declare policy individually; this applier
  // installs their guards (a no-op on seam-constructed instances, where the
  // root installer has already done so).
  applyDeclaredAuthPolicies(fastify);

  // Credential resolution runs in the policy-installed github_issues_hmac
  // guard (preHandler), which finds the enabled connection whose secret
  // verifies the request's HMAC over the exact raw bytes and stashes the
  // resolution. This family is fail-soft by design: an unverified request is
  // acknowledged without syncing.
  fastify.post(
    '/webhooks/github/issues',
    { config: { authPolicy: { policy: 'verified_ingress', verifier: 'github_issues_hmac' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as Parameters<typeof dispatchGitHubIssueWebhook>[0];
      const resolution = request.verifiedIngress?.issues ?? { connections: [], matched: null };
      const result = dispatchGitHubIssueWebhook(body, resolution as Parameters<typeof dispatchGitHubIssueWebhook>[1]);
      reply.code(result.statusCode).send(result.body);
    },
  );
}
