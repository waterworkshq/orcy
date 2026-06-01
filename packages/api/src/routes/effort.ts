import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as effortService from "../services/effortService.js";
import * as taskRepo from "../repositories/task.js";
import * as missionRepo from "../repositories/feature.js";
import { agentOrHumanAuth } from "../middleware/auth.js";
import { notFound } from "../errors.js";
import type { CodeEvidenceActorType } from "@orcy/shared";

const taskIdParamsSchema = z.object({ id: z.string() });
const entryIdParamsSchema = z.object({ id: z.string(), entryId: z.string() });
const missionIdParamsSchema = z.object({ id: z.string() });

const includeCorrectionsQuerySchema = z.object({
  includeCorrections: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v !== "false" && v !== false),
});

const logEffortBodySchema = z.object({
  minutes: z.number().int().positive().max(1440),
  source: z.enum(["human_manual", "agent_reported"]).optional(),
  note: z.string().max(500).optional(),
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
});

const correctEffortBodySchema = z.object({
  minutesDelta: z
    .number()
    .int()
    .min(-1440)
    .max(1440)
    .refine((v) => v !== 0, {
      message: "minutesDelta cannot be 0",
    }),
  correctionReason: z.string().min(1).max(500),
  note: z.string().max(500).optional(),
});

function getActor(request: {
  agent?: { id: string } | null;
  user?: { id: string; role: string } | null;
}): { type: CodeEvidenceActorType; id: string } {
  if (request.agent) {
    return { type: "agent", id: request.agent.id };
  }
  if (request.user) {
    return { type: "human", id: request.user.id };
  }
  return { type: "system", id: "system" };
}

export async function effortRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/tasks/:id/effort-report",
    {
      schema: { params: taskIdParamsSchema },
      preHandler: agentOrHumanAuth,
    },
    async (request) => {
      const report = effortService.getTaskEffortReport(request.params.id);
      if (!report) {
        throw notFound("Task not found");
      }
      return report;
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/tasks/:id/effort-entries",
    {
      schema: {
        params: taskIdParamsSchema,
        querystring: includeCorrectionsQuerySchema,
      },
      preHandler: agentOrHumanAuth,
    },
    async (request) => {
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) {
        throw notFound("Task not found");
      }
      return effortService.listEffortEntries(request.params.id, {
        includeCorrections: request.query.includeCorrections,
      });
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/tasks/:id/effort-entries",
    {
      schema: {
        params: taskIdParamsSchema,
        body: logEffortBodySchema,
      },
      preHandler: agentOrHumanAuth,
    },
    async (request) => {
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) {
        throw notFound("Task not found");
      }

      const actor = getActor(request);

      return effortService.logEffort(
        request.params.id,
        actor.type === "system" ? "human" : actor.type,
        actor.id,
        request.body,
      );
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/tasks/:id/effort-entries/:entryId/correct",
    {
      schema: {
        params: entryIdParamsSchema,
        body: correctEffortBodySchema,
      },
      preHandler: agentOrHumanAuth,
    },
    async (request) => {
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) {
        throw notFound("Task not found");
      }

      const actor = getActor(request);

      return effortService.correctEffortEntry(
        request.params.id,
        request.params.entryId,
        actor.type === "system" ? "human" : actor.type,
        actor.id,
        request.body,
      );
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/missions/:id/effort-report",
    {
      schema: { params: missionIdParamsSchema },
      preHandler: agentOrHumanAuth,
    },
    async (request) => {
      const mission = missionRepo.getMissionById(request.params.id);
      if (!mission) {
        throw notFound("Mission not found");
      }

      return effortService.getMissionEffortReport(request.params.id);
    },
  );
}
