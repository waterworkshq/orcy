import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as reviewRuleRepo from '../repositories/reviewRule.js';
import * as taskReviewerRepo from '../repositories/taskReviewer.js';
import { agentOrHumanAuth, humanAuth } from '../middleware/auth.js';
import { requireHabitatAccess } from '../middleware/team.js';
import { badRequest, notFound, forbidden, unauthorized } from '../errors.js';
import { isTeamMemberByHabitatId } from '../repositories/teamMember.js';
import { getHabitatById } from '../repositories/habitat.js';
import { getTaskById } from '../repositories/task.js';
import { getMissionById } from '../repositories/feature.js';
import { z } from 'zod';

const STRATEGIES = ['domain_expert', 'round_robin', 'least_loaded', 'random', 'fixed'] as const;

const createRuleSchema = z.object({
  name: z.string().min(1).max(200),
  enabled: z.number().min(0).max(1).optional(),
  priority: z.number().int().min(0).optional(),
  matchDomain: z.string().nullable().optional(),
  matchLabels: z.array(z.string()).optional(),
  matchPriority: z.string().nullable().optional(),
  assignmentStrategy: z.enum(STRATEGIES).optional(),
  requiredReviews: z.number().int().min(1).max(10).optional(),
  antiSelfReview: z.number().min(0).max(1).optional(),
  fixedReviewerIds: z.array(z.string()).optional(),
});

const updateRuleSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  enabled: z.number().min(0).max(1).optional(),
  priority: z.number().int().min(0).optional(),
  matchDomain: z.string().nullable().optional(),
  matchLabels: z.array(z.string()).optional(),
  matchPriority: z.string().nullable().optional(),
  assignmentStrategy: z.enum(STRATEGIES).optional(),
  requiredReviews: z.number().int().min(1).max(10).optional(),
  antiSelfReview: z.number().min(0).max(1).optional(),
  fixedReviewerIds: z.array(z.string()).optional(),
});

const addReviewerSchema = z.object({
  reviewerId: z.string().min(1),
  reviewerType: z.enum(['human', 'agent']).optional(),
});

function verifyRuleHabitatAccess(request: FastifyRequest, habitatId: string): void {
  const habitat = getHabitatById(habitatId);
  if (!habitat) throw notFound('Habitat not found');

  if (request.agent) {
    if (!habitat.teamId) return;
    throw forbidden('Agents cannot access team habitats', 'BOARD_ACCESS_DENIED');
  }

  if (request.user) {
    if (!habitat.teamId) return;
    if (isTeamMemberByHabitatId(habitatId, request.user.id)) return;
    throw forbidden('You do not have access to this habitat', 'BOARD_ACCESS_DENIED');
  }

  throw unauthorized('Authentication required');
}

function getHabitatIdFromTask(taskId: string): string {
  const task = getTaskById(taskId);
  if (!task) throw notFound('Task not found');
  const mission = getMissionById(task.missionId);
  if (!mission) throw notFound('Mission not found');
  return mission.habitatId;
}

export async function reviewRuleRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { habitatId: string } }>(
    '/habitats/:habitatId/review-rules',
    { preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request) => {
      const rules = reviewRuleRepo.getByHabitatId(request.params.habitatId);
      return { reviewRules: rules };
    }
  );

  fastify.post<{ Params: { habitatId: string }; Body: z.infer<typeof createRuleSchema> }>(
    '/habitats/:habitatId/review-rules',
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, reply) => {
      const parsed = createRuleSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Validation failed', parsed.error.flatten());
      }

      const rule = reviewRuleRepo.create(request.params.habitatId, parsed.data);
      reply.code(201).send({ reviewRule: rule });
    }
  );

  fastify.patch<{ Params: { id: string }; Body: z.infer<typeof updateRuleSchema> }>(
    '/review-rules/:id',
    { preHandler: [humanAuth] },
    async (request) => {
      const parsed = updateRuleSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Validation failed', parsed.error.flatten());
      }

      const existing = reviewRuleRepo.getById(request.params.id);
      if (!existing) throw notFound('Review rule not found');

      verifyRuleHabitatAccess(request, existing.habitatId);

      const updated = reviewRuleRepo.update(request.params.id, parsed.data);
      return { reviewRule: updated };
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/review-rules/:id',
    { preHandler: [humanAuth] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const existing = reviewRuleRepo.getById(request.params.id);
      if (!existing) throw notFound('Review rule not found');

      verifyRuleHabitatAccess(request, existing.habitatId);

      reviewRuleRepo.remove(request.params.id);
      reply.code(204).send();
    }
  );

  fastify.get<{ Params: { taskId: string } }>(
    '/tasks/:taskId/reviewers',
    { preHandler: [agentOrHumanAuth] },
    async (request) => {
      const reviewers = taskReviewerRepo.getByTaskId(request.params.taskId);
      return { reviewers };
    }
  );

  fastify.post<{ Params: { taskId: string }; Body: z.infer<typeof addReviewerSchema> }>(
    '/tasks/:taskId/reviewers',
    { preHandler: [humanAuth] },
    async (request, reply) => {
      const habitatId = getHabitatIdFromTask(request.params.taskId);
      verifyRuleHabitatAccess(request, habitatId);

      const parsed = addReviewerSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Validation failed', parsed.error.flatten());
      }

      const reviewer = taskReviewerRepo.create(
        request.params.taskId,
        parsed.data.reviewerType ?? 'human',
        parsed.data.reviewerId
      );
      reply.code(201).send({ reviewer });
    }
  );

  fastify.delete<{ Params: { taskId: string; reviewerId: string } }>(
    '/tasks/:taskId/reviewers/:reviewerId',
    { preHandler: [humanAuth] },
    async (request: FastifyRequest<{ Params: { taskId: string; reviewerId: string } }>, reply: FastifyReply) => {
      const habitatId = getHabitatIdFromTask(request.params.taskId);
      verifyRuleHabitatAccess(request, habitatId);

      const reviewer = taskReviewerRepo.findByTaskAndReviewer(request.params.taskId, request.params.reviewerId);
      if (!reviewer) throw notFound('Reviewer assignment not found');

      taskReviewerRepo.remove(reviewer.id);
      reply.code(204).send();
    }
  );
}
