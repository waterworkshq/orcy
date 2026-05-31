import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as effortService from "../services/effortService.js";
import * as taskRepo from "../repositories/task.js";
import * as missionRepo from "../repositories/feature.js";
import { agentOrHumanAuth } from "../middleware/auth.js";
import { badRequest, notFound } from "../errors.js";

export async function effortRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { id: string } }>(
    "/tasks/:id/effort-report",
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const report = effortService.getTaskEffortReport(request.params.id);
      if (!report) {
        throw notFound("Task not found");
      }
      return report;
    },
  );

  fastify.get<{ Params: { id: string }; Querystring: { includeCorrections?: string } }>(
    "/tasks/:id/effort-entries",
    { preHandler: agentOrHumanAuth },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { includeCorrections?: string };
      }>,
      _reply: FastifyReply,
    ) => {
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) {
        throw notFound("Task not found");
      }

      const includeCorrections = request.query.includeCorrections !== "false";
      return effortService.listEffortEntries(request.params.id, { includeCorrections });
    },
  );

  fastify.post<{
    Params: { id: string };
    Body: {
      minutes: number;
      note?: string;
      startedAt?: string;
      endedAt?: string;
      source?: "human_manual" | "agent_reported";
    };
  }>(
    "/tasks/:id/effort-entries",
    { preHandler: agentOrHumanAuth },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: {
          minutes: number;
          note?: string;
          startedAt?: string;
          endedAt?: string;
          source?: "human_manual" | "agent_reported";
        };
      }>,
      _reply: FastifyReply,
    ) => {
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) {
        throw notFound("Task not found");
      }

      const { minutes, note, startedAt, endedAt, source } = request.body;
      if (!Number.isInteger(minutes) || minutes <= 0) {
        throw badRequest("minutes must be a positive integer");
      }

      const actorType = (request as any).agent ? "agent" : "human";
      const actorId = (request as any).agent
        ? (request as any).agent.id
        : ((request as any).user?.id ?? null);

      return effortService.logEffort(request.params.id, actorType, actorId, {
        minutes,
        note,
        startedAt,
        endedAt,
        source,
      });
    },
  );

  fastify.post<{
    Params: { id: string; entryId: string };
    Body: { minutesDelta: number; correctionReason: string; note?: string };
  }>(
    "/tasks/:id/effort-entries/:entryId/correct",
    { preHandler: agentOrHumanAuth },
    async (
      request: FastifyRequest<{
        Params: { id: string; entryId: string };
        Body: { minutesDelta: number; correctionReason: string; note?: string };
      }>,
      _reply: FastifyReply,
    ) => {
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) {
        throw notFound("Task not found");
      }

      const { minutesDelta, correctionReason, note } = request.body;
      if (minutesDelta === 0) {
        throw badRequest("minutesDelta cannot be 0");
      }
      if (!correctionReason || correctionReason.trim().length === 0) {
        throw badRequest("correctionReason is required");
      }
      if (correctionReason.length > 500) {
        throw badRequest("correctionReason must be 500 characters or less");
      }

      const actorType = (request as any).agent ? "agent" : "human";
      const actorId = (request as any).agent
        ? (request as any).agent.id
        : ((request as any).user?.id ?? null);

      return effortService.correctEffortEntry(
        request.params.id,
        request.params.entryId,
        actorType,
        actorId,
        {
          minutesDelta,
          correctionReason,
          note,
        },
      );
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/missions/:id/effort-report",
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const mission = missionRepo.getMissionById(request.params.id);
      if (!mission) {
        throw notFound("Mission not found");
      }

      return effortService.getMissionEffortReport(request.params.id);
    },
  );
}
