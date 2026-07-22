import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as missionService from "../services/featureService.js";
import * as taskRepo from "../repositories/task.js";
import * as taskService from "../services/tasks/index.js";
import * as missionRepo from "../repositories/mission.js";
import * as missionEventRepo from "../repositories/events/event-feature.js";
import * as decompositionService from "../services/decompositionService.js";
import {
  createMissionSchema,
  updateMissionSchema,
  missionQuerySchema,
  moveMissionSchema,
  createTaskInMissionSchema,
} from "../models/schemas.js";
import { agentOrHumanAuth, humanAuth } from "../middleware/auth.js";
import { requireHabitatAccess, requireMissionAccess } from "../middleware/team.js";
import { isCreationPublicationEnabled } from "../config/creationPublicationCutover.js";
import {
  badRequest,
  notFound,
  forbidden,
  conflict,
  internalError,
  AppError,
  InterceptorVetoError,
} from "../errors.js";

const habitatIdParamsSchema = z.object({ habitatId: z.string() });
const missionIdParamsSchema = z.object({ missionId: z.string() });

export async function missionRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/habitats/:habitatId/missions",
    {
      schema: { params: habitatIdParamsSchema, body: createMissionSchema },
      preHandler: [agentOrHumanAuth, requireHabitatAccess],
    },
    async (request, reply) => {
      const parsed = request.body;
      const actorId = request.agent?.id ?? request.user?.id ?? "anonymous";

      const mission = missionService.createMission({
        habitatId: request.params.habitatId,
        columnId: parsed.columnId,
        title: parsed.title,
        description: parsed.description,
        acceptanceCriteria: parsed.acceptanceCriteria,
        priority: parsed.priority,
        labels: parsed.labels,
        dependsOn: parsed.dependsOn,
        blocks: parsed.blocks,
        dueAt: parsed.dueAt,
        slaMinutes: parsed.slaMinutes,
        createdBy: actorId,
        releaseGateType: parsed.releaseGateType,
        releaseGateVersion: parsed.releaseGateVersion,
        releaseDeadlineType: parsed.releaseDeadlineType,
        releaseDeadlineVersion: parsed.releaseDeadlineVersion,
      });

      reply.code(201).send({ mission });
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/habitats/:habitatId/missions",
    {
      schema: { params: habitatIdParamsSchema, querystring: missionQuerySchema },
      preHandler: [agentOrHumanAuth, requireHabitatAccess],
    },
    async (request, _reply) => {
      const parsed = request.query;

      const result = missionService.listMissions(request.params.habitatId, {
        status: parsed.status,
        priority: parsed.priority,
        isArchived: parsed.isArchived,
        limit: parsed.limit,
        offset: parsed.offset,
      });

      return { missions: result.missions, total: result.total };
    },
  );

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .get(
      "/missions/:missionId",
      { schema: { params: missionIdParamsSchema }, preHandler: agentOrHumanAuth },
      async (request, _reply) => {
        const mission = missionService.getMissionWithProgress(request.params.missionId);
        if (!mission) {
          throw notFound("Mission not found");
        }
        return { mission };
      },
    );

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .get(
      "/missions/:missionId/details",
      { schema: { params: missionIdParamsSchema }, preHandler: agentOrHumanAuth },
      async (request, _reply) => {
        const mission = missionService.getMissionWithProgress(request.params.missionId);
        if (!mission) {
          throw notFound("Mission not found");
        }

        const tasks = taskRepo.getTasksByMissionId(request.params.missionId);
        const { events } = missionEventRepo.getMissionEventsByMissionId(
          request.params.missionId,
          50,
        );
        const dependencies = {
          dependsOn: mission.dependsOn,
          blocks: mission.blocks,
        };

        const progress = missionService.getMissionProgress(request.params.missionId)!;

        return {
          mission,
          tasks,
          events,
          progress,
          dependencies,
        };
      },
    );

  fastify.withTypeProvider<ZodTypeProvider>().patch(
    "/missions/:missionId",
    {
      schema: { params: missionIdParamsSchema, body: updateMissionSchema },
      preHandler: [agentOrHumanAuth, requireMissionAccess],
    },
    async (request, reply) => {
      const parsed = request.body;
      const actorId = request.agent?.id ?? request.user?.id ?? "anonymous";

      const mission = missionRepo.getMissionById(request.params.missionId);
      if (mission?.isArchived) {
        throw forbidden("Cannot modify an archived mission");
      }

      const result = missionService.updateMission(request.params.missionId, parsed, actorId);
      if (!result.success) {
        if (result.notFound) {
          throw notFound("Mission not found");
        } else if (result.versionMismatch) {
          reply.header("Retry-After", "5");
          reply.header("X-Current-Version", String(result.currentVersion));
          throw new AppError(409, "VERSION_CONFLICT", "Version conflict", {
            currentVersion: result.currentVersion,
            yourVersion: parsed.version,
          });
        } else if (result.archived) {
          throw forbidden("Cannot modify an archived mission");
        }
        throw internalError("Failed to update mission");
      }
      return { mission: result.mission };
    },
  );

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .post(
      "/missions/:missionId/archive",
      { schema: { params: missionIdParamsSchema }, preHandler: agentOrHumanAuth },
      async (request, _reply) => {
        const actorId = request.agent?.id ?? request.user?.id ?? "anonymous";
        const result = missionService.archiveMission(request.params.missionId, actorId);
        if (!result.success) {
          if (result.reason === "not_found") throw notFound("Mission not found");
          if (result.reason === "not_done")
            throw badRequest("Only completed missions can be archived");
          if (result.reason === "already_archived") throw badRequest("Mission is already archived");
          throw internalError("Failed to archive mission");
        }
        return { mission: result.mission };
      },
    );

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .post(
      "/missions/:missionId/unarchive",
      { schema: { params: missionIdParamsSchema }, preHandler: agentOrHumanAuth },
      async (request, _reply) => {
        const actorId = request.agent?.id ?? request.user?.id ?? "anonymous";
        const result = missionService.unarchiveMission(request.params.missionId, actorId);
        if (!result.success) {
          if (result.reason === "not_found") throw notFound("Mission not found");
          if (result.reason === "not_archived") throw badRequest("Mission is not archived");
          throw internalError("Failed to unarchive mission");
        }
        return { mission: result.mission };
      },
    );

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .delete(
      "/missions/:missionId",
      { schema: { params: missionIdParamsSchema }, preHandler: agentOrHumanAuth },
      async (request, reply) => {
        const actorId = request.agent?.id ?? request.user?.id ?? "anonymous";
        const actorType = request.agent ? "agent" : "human";
        const result = missionService.deleteMission(request.params.missionId, actorId, actorType);
        if (!result.success) {
          if (result.reason === "not_found") {
            throw notFound("Mission not found");
          } else if (result.reason === "has_dependents") {
            throw conflict("Mission has dependent missions", { dependents: true });
          }
          throw internalError("Failed to delete mission");
        }
        reply.code(204).send();
      },
    );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/missions/:missionId/move",
    {
      schema: { params: missionIdParamsSchema, body: moveMissionSchema },
      preHandler: [agentOrHumanAuth, requireMissionAccess],
    },
    async (request, reply) => {
      const parsed = request.body;
      const actorId = request.agent?.id ?? request.user?.id ?? "anonymous";
      const actorType = request.agent ? "agent" : "human";

      const result = missionService.moveMissionToColumn(
        request.params.missionId,
        parsed.columnId,
        actorId,
        actorType,
        parsed.expectedVersion,
      );
      if ("notFound" in result) {
        throw notFound("Mission not found");
      }
      if ("invalidTarget" in result) {
        throw notFound("Mission or column not found");
      }
      if ("staleVersion" in result) {
        reply.header("Retry-After", "5");
        reply.header("X-Current-Version", String(result.currentVersion));
        throw new AppError(409, "VERSION_CONFLICT", "Mission version conflict", {
          currentVersion: result.currentVersion,
          yourVersion: parsed.expectedVersion,
        });
      }
      return { mission: result.mission };
    },
  );

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .get(
      "/missions/:missionId/tasks",
      { schema: { params: missionIdParamsSchema }, preHandler: agentOrHumanAuth },
      async (request, _reply) => {
        const mission = missionRepo.getMissionById(request.params.missionId);
        if (!mission) {
          throw notFound("Mission not found");
        }

        const tasks = taskRepo.getTasksByMissionId(request.params.missionId);
        return { tasks, total: tasks.length };
      },
    );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/missions/:missionId/tasks",
    {
      schema: { params: missionIdParamsSchema, body: createTaskInMissionSchema },
      preHandler: [agentOrHumanAuth, requireMissionAccess],
    },
    async (request, reply) => {
      // T11 Phase 4 — when the publication kernel is active, the legacy
      // direct-insertion endpoint is retired. Callers must use the new
      // publication route (POST /missions/:missionId/task-publications)
      // which routes through the kernel (governance, observation gate,
      // dispatch fan-out, creation-integrity marker).
      if (isCreationPublicationEnabled()) {
        throw notFound(
          "POST /missions/:missionId/tasks is retired when the publication kernel is active. Use POST /missions/:missionId/task-publications instead.",
        );
      }
      const parsed = request.body;
      const mission = missionRepo.getMissionById(request.params.missionId);
      if (!mission) {
        throw notFound("Mission not found");
      }
      if (mission.isArchived) {
        throw forbidden("Cannot add tasks to an archived mission");
      }

      const actorId = request.agent?.id ?? request.user?.id ?? "anonymous";

      try {
        const task = taskService.createTask({
          missionId: mission.id,
          title: parsed.title,
          description: parsed.description,
          priority: parsed.priority,
          requiredDomain: parsed.requiredDomain,
          requiredCapabilities: parsed.requiredCapabilities,
          estimatedMinutes: parsed.estimatedMinutes,
          order: parsed.order,
          createdBy: actorId,
        });

        reply.code(201).send({ task });
      } catch (err) {
        if (err instanceof InterceptorVetoError) {
          throw forbidden("Transition blocked by lifecycle interceptor", "INTERCEPTOR_VETO", {
            blockedBy: { reason: err.veto.reason, details: err.veto.details },
          });
        }
        throw err;
      }
    },
  );

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .get(
      "/missions/:missionId/progress",
      { schema: { params: missionIdParamsSchema }, preHandler: agentOrHumanAuth },
      async (request, _reply) => {
        const mission = missionRepo.getMissionById(request.params.missionId);
        if (!mission) {
          throw notFound("Mission not found");
        }

        const progress = missionService.getMissionProgress(request.params.missionId);
        if (!progress) {
          throw notFound("Mission not found");
        }
        return progress;
      },
    );

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .post(
      "/missions/:missionId/decompose",
      { schema: { params: missionIdParamsSchema }, preHandler: [humanAuth, requireMissionAccess] },
      async (request, _reply) => {
        const mission = missionRepo.getMissionById(request.params.missionId);
        if (!mission) {
          throw notFound("Mission not found");
        }

        if (!mission.description || mission.description.trim().length === 0) {
          throw badRequest("Add a description before decomposing");
        }

        const result = await decompositionService.decomposeMission(request.params.missionId);
        return result;
      },
    );
}
