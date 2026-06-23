import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SKILL_CATEGORIES } from "@orcy/shared";
import * as skillRepo from "../repositories/habitatSkill.js";
import * as habitatRepo from "../repositories/board.js";
import * as skillService from "../services/habitatSkillService.js";
import { agentOrHumanAuth, humanAuth } from "../middleware/auth.js";
import { notFound, badRequest, forbidden } from "../errors.js";

const contributeBodySchema = z.object({
  insight: z
    .string()
    .min(1, "Insight is required")
    .max(2000, "Insight must be under 2000 characters"),
  skillCategory: z.enum(SKILL_CATEGORIES).optional(),
});

const signalsQuerySchema = z.object({
  minStrength: z.coerce.number().min(0).max(1).optional(),
  skillCategory: z.enum(SKILL_CATEGORIES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function habitatSkillRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    "/habitats/:habitatId/skill",
    { preHandler: agentOrHumanAuth },
    async (request, _reply) => {
      const { habitatId } = request.params as { habitatId: string };

      const habitat = habitatRepo.getHabitatById(habitatId);
      if (!habitat) throw notFound("Habitat not found");

      const skill = skillRepo.getSkillByHabitatId(habitatId);

      return { skill };
    },
  );

  fastify.post(
    "/habitats/:habitatId/skill/refresh",
    { preHandler: agentOrHumanAuth },
    async (request, _reply) => {
      const { habitatId } = request.params as { habitatId: string };

      const habitat = habitatRepo.getHabitatById(habitatId);
      if (!habitat) throw notFound("Habitat not found");

      skillService.regenerateSkill(habitatId);

      const skill = skillRepo.getSkillByHabitatId(habitatId);
      return {
        success: true,
        message: "Skill regenerated",
        signalCount: skill?.signalCount ?? 0,
      };
    },
  );

  fastify.post(
    "/habitats/:habitatId/skill/contribute",
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const { habitatId } = request.params as { habitatId: string };

      const habitat = habitatRepo.getHabitatById(habitatId);
      if (!habitat) throw notFound("Habitat not found");

      const parsed = contributeBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }
      const { insight, skillCategory } = parsed.data;

      const signal = skillService.contributeSignal(habitatId, {
        insight,
        skillCategory,
      });

      if (!signal) {
        throw badRequest("Failed to contribute signal");
      }

      reply.code(201).send({
        success: true,
        signal: {
          id: signal.id,
          strength: signal.strength,
          clusterKey: signal.clusterKey,
        },
      });
    },
  );

  fastify.get(
    "/habitats/:habitatId/skill/signals",
    { preHandler: humanAuth },
    async (request, _reply) => {
      const { habitatId } = request.params as { habitatId: string };

      const habitat = habitatRepo.getHabitatById(habitatId);
      if (!habitat) throw notFound("Habitat not found");

      const parsed = signalsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }
      const { minStrength, skillCategory, limit, offset } = parsed.data;

      const result = skillRepo.getSignalsByHabitat(habitatId, {
        minStrength,
        skillCategory,
        limit,
        offset,
      });

      return { signals: result.signals, total: result.total };
    },
  );

  fastify.delete(
    "/habitats/:habitatId/skill/signals/:signalId",
    { preHandler: humanAuth },
    async (request, reply) => {
      const { habitatId, signalId } = request.params as { habitatId: string; signalId: string };

      const habitat = habitatRepo.getHabitatById(habitatId);
      if (!habitat) throw notFound("Habitat not found");

      const signal = skillRepo.getSignalById(signalId);
      if (!signal) throw notFound("Signal not found");
      if (signal.habitatId !== habitatId) throw forbidden("Signal does not belong to this habitat");

      skillRepo.deleteSignal(signalId);

      reply.code(200).send({ success: true });
    },
  );
}
