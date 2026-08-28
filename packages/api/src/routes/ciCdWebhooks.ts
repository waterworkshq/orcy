import { applyDeclaredAuthPolicies } from "../authPolicy.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as ciCdService from "../services/ciCdService.js";
import * as releaseTriggerService from "../services/releaseTriggerService.js";
import * as releaseSettingsService from "../services/releaseSettingsService.js";
import * as pipelineRepo from "../repositories/pipelineEvent.js";
import { findHabitatIdByCiCdSignature } from "../services/habitatSecretCache.js";
import { humanAuth } from "../middleware/auth.js";
import {
  dispatchGitHubWebhook,
  dispatchGitLabWebhook,
} from "../services/webhooks/webhook-secret-verification.js";
import { parseVersion, isPreRelease } from "@orcy/shared";

export async function ciCdWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  // Heterogeneous module: routes declare policy individually; this applier
  // installs their guards (a no-op on seam-constructed instances, where the
  // root installer has already done so).
  applyDeclaredAuthPolicies(fastify);

  // Credential verification runs in the policy-installed verified-ingress
  // guards (preHandler) over the exact raw bytes, with the historical
  // configured-key/missing-key posture matrix; these handlers only dispatch.
  fastify.post(
    "/webhooks/github-ci",
    { config: { authPolicy: { policy: "verified_ingress", verifier: "github_ci_hmac" } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const signature = request.headers["x-hub-signature-256"] as string | undefined;
      const event = request.headers["x-github-event"] as string | undefined;
      const body = request.body as Record<string, unknown>;
      const rawBody = (request.rawBody ?? JSON.stringify(body)) as string;

      const result = await dispatchGitHubWebhook(
        { body, event },
        {
        workflow_run: async (b) => {
          const event = b as Parameters<typeof ciCdService.handleGitHubWorkflowRunEvent>[0];
          const run = event.workflow_run;
          // Release-workflow convention. Habitat is resolved first via the CI/CD
          // secret store (distinct from the code-review secret store), then the
          // per-habitat release settings drive the workflow-name + version-tag
          // convention. A matching run triggers release detection; a non-matching
          // run falls through to pipeline-status handling unchanged.
          const habitatId = findHabitatIdByCiCdSignature(rawBody, signature ?? "");
          const settings = habitatId
            ? releaseSettingsService.resolveReleaseSettings(habitatId)
            : null;
          const isReleaseWorkflow =
            settings !== null &&
            run.conclusion === "success" &&
            typeof run.name === "string" &&
            run.name.includes(settings.releaseWorkflowName) &&
            (!settings.requireVersionTag ||
              /^v?\d+\.\d+\.\d+(-[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*)?$/.test(run.head_branch));
          if (isReleaseWorkflow && habitatId) {
            // Semver pre-release tags are skipped — not a real release event.
            try {
              if (isPreRelease(parseVersion(run.head_branch))) {
                return { status: "ignored" };
              }
            } catch {
              return {
                status: "error",
                statusCode: 400,
                error: `Invalid version tag: ${run.head_branch}`,
              };
            }
            try {
              await releaseTriggerService.detectAndActivate(habitatId, run.head_branch, {
                detectedBy: "cicd_pipeline",
              });
              return { status: "recorded" };
            } catch (err) {
              const message = err instanceof Error ? err.message : "Unknown error";
              const isValidation = /invalid version|explicit type/i.test(message);
              return {
                status: "error",
                statusCode: isValidation ? 400 : 500,
                error: message,
              };
            }
          }
          return ciCdService.handleGitHubWorkflowRunEvent(event);
        },
        workflow_job: (b) =>
          ciCdService.handleGitHubWorkflowJobEvent(
            b as Parameters<typeof ciCdService.handleGitHubWorkflowJobEvent>[0],
          ),
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
    "/webhooks/gitlab-ci",
    { config: { authPolicy: { policy: "verified_ingress", verifier: "gitlab_ci_token" } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as Record<string, unknown>;
      const objectKind = body.object_kind as string | undefined;

      const result = dispatchGitLabWebhook(
        { body, objectKind },
        {
          pipeline: (b) =>
            ciCdService.handleGitLabPipelineEvent(
              b as Parameters<typeof ciCdService.handleGitLabPipelineEvent>[0],
            ),
          build: (b) =>
            ciCdService.handleGitLabJobEvent(
              b as Parameters<typeof ciCdService.handleGitLabJobEvent>[0],
            ),
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
    "/tasks/:id/pipeline-events",
    { preHandler: [humanAuth] },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const { id } = request.params;
      const events = pipelineRepo.getByTaskId(id);
      return { pipelineEvents: events };
    },
  );
}
