import { applyDeclaredAuthPolicies } from "../authPolicy.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as prRepo from "../repositories/pullRequest.js";
import * as githubService from "../services/githubWebhook.js";
import * as gitlabService from "../services/gitlabWebhook.js";
import * as githubReleaseWebhook from "../services/githubReleaseWebhook.js";
import { findHabitatIdByGithubSignature } from "../services/habitatSecretCache.js";
import { humanAuth } from "../middleware/auth.js";
import {
  dispatchGitHubWebhook,
  dispatchGitLabWebhook,
} from "../services/webhooks/webhook-secret-verification.js";

export async function codeReviewWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  // Heterogeneous module: routes declare policy individually; this applier
  // installs their guards (a no-op on seam-constructed instances, where the
  // root installer has already done so).
  applyDeclaredAuthPolicies(fastify);

  // Credential verification runs in the policy-installed verified-ingress
  // guards (preHandler) over the exact raw bytes, with the historical
  // configured-key/missing-key posture matrix; these handlers only dispatch.
  fastify.post(
    "/webhooks/github",
    { config: { authPolicy: { policy: "verified_ingress", verifier: "github_code_review_hmac" } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const signature = request.headers["x-hub-signature-256"] as string | undefined;
      const event = request.headers["x-github-event"] as string | undefined;
      const body = request.body as Record<string, unknown>;
      const rawBody = (request.rawBody ?? JSON.stringify(body)) as string;

      const result = await dispatchGitHubWebhook(
        { body, event },
        {
          pull_request: (b) =>
            githubService.handlePullRequestEvent(
              b as Parameters<typeof githubService.handlePullRequestEvent>[0],
            ),
          pull_request_review: (b) =>
            githubService.handlePullRequestReviewEvent(
              b as Parameters<typeof githubService.handlePullRequestReviewEvent>[0],
            ),
          release: (b) => {
            const habitatId = findHabitatIdByGithubSignature(rawBody, signature ?? "");
            if (!habitatId) return { status: "no_matching_habitat" };
            return githubReleaseWebhook.handleGitHubReleaseEvent(
              b as Parameters<typeof githubReleaseWebhook.handleGitHubReleaseEvent>[0],
              { habitatId },
            );
          },
        },
      );

      if (result.statusCode !== 200) {
        reply.code(result.statusCode).send(result.body);
        return;
      }
      return result.body;
    },
  );

  fastify.post(
    "/webhooks/gitlab",
    { config: { authPolicy: { policy: "verified_ingress", verifier: "gitlab_code_review_token" } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as Record<string, unknown>;
      const objectKind = body.object_kind as string | undefined;

      const result = dispatchGitLabWebhook(
        { body, objectKind },
        {
          merge_request: (b) =>
            gitlabService.handleMergeRequestEvent(
              b as Parameters<typeof gitlabService.handleMergeRequestEvent>[0],
            ),
          note: (b) =>
            gitlabService.handleNoteEvent(b as Parameters<typeof gitlabService.handleNoteEvent>[0]),
        },
      );

      if (result.statusCode !== 200) {
        reply.code(result.statusCode).send(result.body);
        return;
      }
      return result.body;
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/tasks/:id/pull-requests",
    { preHandler: [humanAuth] },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const { id } = request.params;
      const prs = prRepo.getByTaskId(id);
      return { pullRequests: prs };
    },
  );
}
