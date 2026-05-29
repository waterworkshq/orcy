import type { FastifyInstance } from "fastify";
import * as skillRepo from "../repositories/habitatSkill.js";
import * as habitatRepo from "../repositories/board.js";
import * as skillService from "../services/habitatSkillService.js";
import { agentOrHumanAuth, humanAuth } from "../middleware/auth.js";
import { notFound, badRequest, forbidden } from "../errors.js";
import type { SkillCategory } from "../repositories/habitatSkill.js";

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
      const body = request.body as { insight?: string; skillCategory?: string };

      const habitat = habitatRepo.getHabitatById(habitatId);
      if (!habitat) throw notFound("Habitat not found");

      if (!body.insight || typeof body.insight !== "string") {
        throw badRequest("Missing required field: insight");
      }
      if (body.insight.length > 2000) {
        throw badRequest("Insight must be under 2000 characters");
      }

      const validCategories: SkillCategory[] = [
        "convention",
        "pattern",
        "pitfall",
        "domain_knowledge",
        "agent_insight",
      ];
      const skillCategory =
        body.skillCategory && validCategories.includes(body.skillCategory as SkillCategory)
          ? (body.skillCategory as SkillCategory)
          : undefined;

      const signal = skillService.contributeSignal(habitatId, {
        insight: body.insight,
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
      const query = request.query as {
        minStrength?: string;
        skillCategory?: string;
        limit?: string;
        offset?: string;
      };

      const habitat = habitatRepo.getHabitatById(habitatId);
      if (!habitat) throw notFound("Habitat not found");

      const validCategories: SkillCategory[] = [
        "convention",
        "pattern",
        "pitfall",
        "domain_knowledge",
        "agent_insight",
      ];
      const skillCategory =
        query.skillCategory && validCategories.includes(query.skillCategory as SkillCategory)
          ? (query.skillCategory as SkillCategory)
          : undefined;

      const result = skillRepo.getSignalsByHabitat(habitatId, {
        minStrength: query.minStrength ? parseFloat(query.minStrength) : undefined,
        skillCategory,
        limit: query.limit ? parseInt(query.limit, 10) : undefined,
        offset: query.offset ? parseInt(query.offset, 10) : undefined,
      });

      return { items: result.signals, total: result.total };
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
