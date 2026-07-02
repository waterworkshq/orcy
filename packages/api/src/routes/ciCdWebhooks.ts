import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as ciCdService from "../services/ciCdService.js";
import * as releaseTriggerService from "../services/releaseTriggerService.js";
import * as releaseSettingsService from "../services/releaseSettingsService.js";
import * as pipelineRepo from "../repositories/pipelineEvent.js";
import { findHabitatIdByCiCdSignature } from "../services/boardSecretCache.js";
import { humanAuth } from "../middleware/auth.js";
import {
  createCiCdSecretSource,
  handleGitHubWebhook,
  handleGitLabWebhook,
} from "../services/webhooks/webhook-secret-verification.js";

const secretSource = createCiCdSecretSource();

export async function ciCdWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post("/webhooks/github-ci", async (request: FastifyRequest, reply: FastifyReply) => {
    const signature = request.headers["x-hub-signature-256"] as string | undefined;
    const event = request.headers["x-github-event"] as string | undefined;
    const body = request.body as Record<string, unknown>;
    const rawBody = (request.rawBody ?? JSON.stringify(body)) as string;

    const result = handleGitHubWebhook(
      secretSource,
      { body, rawBody, event, signature },
      {
        workflow_run: (b) => {
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
            (!settings.requireVersionTag || /^v?\d+\.\d+\.\d+$/.test(run.head_branch));
          if (isReleaseWorkflow && habitatId) {
            return (async () => {
              try {
                await releaseTriggerService.detectAndActivate(habitatId, run.head_branch, {
                  detectedBy: "cicd_pipeline",
                });
                return { status: "recorded" };
              } catch (err) {
                return {
                  status: "error",
                  error: err instanceof Error ? err.message : "Unknown error",
                };
              }
            })();
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
  });

  fastify.post("/webhooks/gitlab-ci", async (request: FastifyRequest, reply: FastifyReply) => {
    const providedToken = request.headers["x-gitlab-token"] as string | undefined;
    const body = request.body as Record<string, unknown>;
    const objectKind = body.object_kind as string | undefined;

    const result = handleGitLabWebhook(
      secretSource,
      { body, providedToken, objectKind },
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
  });

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
