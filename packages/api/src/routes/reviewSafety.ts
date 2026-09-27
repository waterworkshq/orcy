import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest, notFound, forbidden, unauthorized, conflict } from "../errors.js";
import { getTaskById } from "../repositories/task.js";
import { checkHabitatAccess } from "../middleware/team.js";
import { getHabitatIdFromTask } from "./reviewRules.js";
import {
  resolveTaskReviewRequirement,
  getTaskReviewRequirement,
} from "../services/reviewRecoveryService.js";
import { applyDeclaredAuthPolicies } from "../authPolicy.js";

const resolveSchema = z.object({
  expectedTaskVersion: z.number().int().min(1),
  expectedRequirementVersion: z.number().int().min(1),
  effectiveCount: z.number().int().min(0),
  reason: z.string().min(1).max(2000),
});

function requireHumanUser(request: { user?: { id: string } | null }): { id: string } {
  if (!request.user) throw unauthorized("Human authentication required");
  return request.user;
}

/**
 * Review-safety recovery surface: read a Task's durable review requirement,
 * and the single independent human resolution/relaxation command. Human-auth
 * only — agents, remote participants and system callers have no override
 * authority in this slice; persisted roles are re-checked under the command's
 * own transaction (JWT claims are identity, not authority).
 */
export async function reviewSafetyRoutes(fastify: FastifyInstance): Promise<void> {
  applyDeclaredAuthPolicies(fastify);

  fastify.get<{ Params: { taskId: string } }>(
    "/tasks/:taskId/review-requirement",
    { config: { authPolicy: "human" } },
    async (request) => {
      requireHumanUser(request);
      // B6: derived Task→Mission→Habitat membership check — the requirement
      // (claimant, floors, override, rule ids) is Task state and must not
      // cross habitats (same predicate as the reviewer GET).
      const habitatId = getHabitatIdFromTask(request.params.taskId);
      await checkHabitatAccess(request, habitatId);
      const requirement = getTaskReviewRequirement(request.params.taskId);
      return { requirement };
    },
  );

  fastify.post<{ Params: { taskId: string }; Body: z.infer<typeof resolveSchema> }>(
    "/tasks/:taskId/review-requirement/resolve",
    { config: { authPolicy: "human" } },
    async (request, reply) => {
      const user = requireHumanUser(request);
      const task = getTaskById(request.params.taskId);
      if (!task) throw notFound("Task not found");

      const parsed = resolveSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      const result = resolveTaskReviewRequirement({
        taskId: request.params.taskId,
        actorUserId: user.id,
        expectedTaskVersion: parsed.data.expectedTaskVersion,
        expectedRequirementVersion: parsed.data.expectedRequirementVersion,
        effectiveCount: parsed.data.effectiveCount,
        reason: parsed.data.reason,
      });

      if (!result.ok) {
        switch (result.reason) {
          case "not_authorized":
            throw forbidden(
              "Only a non-viewer global admin, or a non-viewer team owner/admin of this task's habitat, may resolve review requirements",
              "REVIEW_RESOLUTION_DENIED",
            );
          case "actor_is_executor":
            throw forbidden(
              "The current executor cannot resolve this task's review requirement",
              "REVIEW_RESOLUTION_INDEPENDENCE",
            );
          case "actor_decided_in_generation":
            throw forbidden(
              "A human who made a review decision in the current generation cannot resolve its requirement",
              "REVIEW_RESOLUTION_INDEPENDENCE",
            );
          case "task_version_mismatch":
          case "requirement_version_mismatch":
            throw conflict(
              "Stale version — re-read the task and requirement and retry",
              "REVIEW_RESOLUTION_VERSION_CONFLICT",
            );
          case "state_not_resolvable":
            throw badRequest(
              "Only legacy_unknown resolution or a reduction of a positive required baseline is supported",
            );
          case "not_a_reduction":
            throw badRequest(
              "For a required baseline, effectiveCount must be lower than the current baseline (a relaxation, never an increase)",
            );
          default:
            throw badRequest(`Resolution refused: ${result.reason}`);
        }
      }

      reply.code(200).send({ requirement: result.requirement, overrideId: result.overrideId });
    },
  );
}
