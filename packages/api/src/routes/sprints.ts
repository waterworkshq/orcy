import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as sprintService from "../services/sprintService.js";
import * as sprintAnalyticsService from "../services/sprintAnalyticsService.js";
import * as sprintRepo from "../repositories/sprint.js";
import { agentOrHumanAuth, humanAuth } from "../middleware/auth.js";
import { requireHabitatAccess } from "../middleware/team.js";
import { badRequest, notFound, forbidden, unauthorized } from "../errors.js";
import { isTeamMemberByHabitatId } from "../repositories/teamMember.js";
import { getHabitatById } from "../repositories/board.js";
import { z } from "zod";

const createSprintSchema = z.object({
  name: z.string().min(1).max(200),
  goal: z.string().max(2000).optional(),
  startDate: z
    .string()
    .min(1)
    .refine((v) => !isNaN(Date.parse(v)), "Invalid start date"),
  endDate: z
    .string()
    .min(1)
    .refine((v) => !isNaN(Date.parse(v)), "Invalid end date"),
  capacityMinutes: z.number().int().nullable().optional(),
  notes: z.string().max(5000).optional(),
});

const updateSprintSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  goal: z.string().max(2000).optional(),
  startDate: z
    .string()
    .min(1)
    .refine((v) => !isNaN(Date.parse(v)), "Invalid start date")
    .optional(),
  endDate: z
    .string()
    .min(1)
    .refine((v) => !isNaN(Date.parse(v)), "Invalid end date")
    .optional(),
  capacityMinutes: z.number().int().nullable().optional(),
  notes: z.string().max(5000).optional(),
});

const addMissionSchema = z.object({
  missionId: z.string().min(1),
});

function verifySprintHabitatAccess(request: FastifyRequest, habitatId: string): void {
  const habitat = getHabitatById(habitatId);
  if (!habitat) throw notFound("Habitat not found");

  if (request.agent) {
    if (!habitat.teamId) return;
    throw forbidden("Agents cannot access team habitats", "BOARD_ACCESS_DENIED");
  }

  if (request.user) {
    if (!habitat.teamId) return;
    if (isTeamMemberByHabitatId(habitatId, request.user.id)) return;
    throw forbidden("You do not have access to this habitat", "BOARD_ACCESS_DENIED");
  }

  throw unauthorized("Authentication required");
}

function requireSprintAccess(request: FastifyRequest): void {
  const sprintId = (request.params as { id: string }).id;
  const sprint = sprintRepo.getById(sprintId);
  if (!sprint) throw notFound("Sprint not found");
  verifySprintHabitatAccess(request, sprint.habitatId);
}

export async function sprintRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/sprints",
    { preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request) => {
      const sprints = sprintService.getSprintsForHabitat(request.params.habitatId);
      return { sprints };
    },
  );

  fastify.get<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/sprints/active",
    { preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request) => {
      const sprint = sprintService.getActiveSprint(request.params.habitatId);
      if (!sprint) return { sprint: null };
      return { sprint };
    },
  );

  fastify.post<{ Params: { habitatId: string }; Body: z.infer<typeof createSprintSchema> }>(
    "/habitats/:habitatId/sprints",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, reply) => {
      const parsed = createSprintSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      const userId = request.user?.id ?? "unknown";
      const sprint = sprintService.createSprint(request.params.habitatId, parsed.data, userId);
      reply.code(201).send({ sprint });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/sprints/:id",
    { preHandler: [agentOrHumanAuth] },
    async (request) => {
      requireSprintAccess(request);
      const sprint = sprintService.getSprint(request.params.id);
      if (!sprint) throw notFound("Sprint not found");
      return { sprint };
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/sprints/:id/metrics",
    { preHandler: [agentOrHumanAuth] },
    async (request) => {
      requireSprintAccess(request);
      const metrics = sprintAnalyticsService.getSprintMetrics(request.params.id);
      if (!metrics) throw notFound("Sprint not found");
      return metrics;
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/sprints/:id/burndown",
    { preHandler: [agentOrHumanAuth] },
    async (request) => {
      requireSprintAccess(request);
      const burndown = sprintAnalyticsService.getSprintBurndown(request.params.id);
      if (!burndown) throw notFound("Sprint not found");
      return burndown;
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/sprints/:id/carry-over",
    { preHandler: [agentOrHumanAuth] },
    async (request) => {
      requireSprintAccess(request);
      const report = sprintAnalyticsService.getSprintCarryOver(request.params.id);
      if (!report) throw notFound("Sprint not found");
      return report;
    },
  );

  fastify.patch<{ Params: { id: string }; Body: z.infer<typeof updateSprintSchema> }>(
    "/sprints/:id",
    { preHandler: [humanAuth] },
    async (request) => {
      requireSprintAccess(request);
      const parsed = updateSprintSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      const sprint = sprintService.updateSprint(request.params.id, parsed.data);
      return { sprint };
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/sprints/:id",
    { preHandler: [humanAuth] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      requireSprintAccess(request);
      sprintService.deleteSprint(request.params.id);
      reply.code(204).send();
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/sprints/:id/start",
    { preHandler: [humanAuth] },
    async (request) => {
      requireSprintAccess(request);
      const sprint = sprintService.startSprint(request.params.id);
      return { sprint };
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/sprints/:id/complete",
    { preHandler: [humanAuth] },
    async (request) => {
      requireSprintAccess(request);
      const sprint = sprintService.completeSprint(request.params.id);
      return { sprint };
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/sprints/:id/cancel",
    { preHandler: [humanAuth] },
    async (request) => {
      requireSprintAccess(request);
      const sprint = sprintService.cancelSprint(request.params.id);
      return { sprint };
    },
  );

  fastify.post<{ Params: { id: string }; Body: z.infer<typeof addMissionSchema> }>(
    "/sprints/:id/missions",
    { preHandler: [humanAuth] },
    async (request) => {
      requireSprintAccess(request);
      const parsed = addMissionSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      const sprint = sprintService.addMissionToSprint(request.params.id, parsed.data.missionId);
      return { sprint };
    },
  );

  fastify.delete<{ Params: { id: string; missionId: string } }>(
    "/sprints/:id/missions/:missionId",
    { preHandler: [humanAuth] },
    async (request) => {
      requireSprintAccess(request);
      const sprint = sprintService.removeMissionFromSprint(
        request.params.id,
        request.params.missionId,
      );
      return { sprint };
    },
  );
}
