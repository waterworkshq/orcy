import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as auditExportService from "../services/auditExportService.js";
import { humanAuth } from "../middleware/auth.js";
import { requireHabitatAccess } from "../middleware/team.js";
import { getHabitatById } from "../repositories/board.js";
import { isTeamMemberByHabitatId } from "../repositories/teamMember.js";
import { badRequest, forbidden, notFound, unauthorized } from "../errors.js";
import { z } from "zod";

const exportQuerySchema = z.object({
  format: z.enum(["csv", "json", "jsonl"]),
  since: z.string().optional(),
  until: z.string().optional(),
  actions: z.string().optional(),
  actorType: z.string().optional(),
  actorId: z.string().optional(),
  entityTypes: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  taskId: z.string().optional(),
  missionId: z.string().optional(),
  source: z.string().optional(),
  provider: z.string().optional(),
  preset: z.string().optional(),
  includeMetadata: z.string().optional(),
  includeProvenance: z.string().optional(),
  includeIntegrity: z.string().optional(),
  includeHealthSnapshots: z.string().optional(),
});

const eventsQuerySchema = exportQuerySchema.omit({ format: true });

const summaryQuerySchema = z.object({
  since: z.string().optional(),
  until: z.string().optional(),
});

const scheduleBodySchema = z.object({
  name: z.string().min(1),
  format: z.enum(["csv", "json", "jsonl"]),
  filters: z.record(z.unknown()).optional(),
  schedule: z.string().min(1),
});

async function requireAuditScheduleAccess(
  request: FastifyRequest<{ Params: { id: string } }>,
  _reply: FastifyReply,
): Promise<void> {
  const schedule = auditExportService.getScheduleById(request.params.id);
  if (!schedule) throw notFound("Audit schedule not found");

  const habitat = getHabitatById(schedule.habitatId);
  if (!habitat) throw notFound("Habitat not found");

  if (!request.user) throw unauthorized("Authentication required");
  if (!habitat.teamId) return;
  if (isTeamMemberByHabitatId(schedule.habitatId, request.user.id)) return;

  throw forbidden("You do not have access to this habitat", "BOARD_ACCESS_DENIED");
}

export async function auditExportRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { habitatId: string }; Querystring: z.infer<typeof eventsQuerySchema> }>(
    "/habitats/:habitatId/audit/events",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (
      request: FastifyRequest<{
        Params: { habitatId: string };
        Querystring: z.infer<typeof eventsQuerySchema>;
      }>,
      _reply: FastifyReply,
    ) => {
      const parsed = eventsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw badRequest("Invalid query", parsed.error.flatten());
      }

      return auditExportService.getCanonicalAuditEvents(request.params.habitatId, parsed.data);
    },
  );

  fastify.get<{ Params: { habitatId: string }; Querystring: z.infer<typeof exportQuerySchema> }>(
    "/habitats/:habitatId/audit/export",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (
      request: FastifyRequest<{
        Params: { habitatId: string };
        Querystring: z.infer<typeof exportQuerySchema>;
      }>,
      reply: FastifyReply,
    ) => {
      const parsed = exportQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw badRequest("Invalid query", parsed.error.flatten());
      }

      await auditExportService.streamAuditExport(request.params.habitatId, parsed.data, reply);
    },
  );

  fastify.get<{ Params: { habitatId: string }; Querystring: z.infer<typeof summaryQuerySchema> }>(
    "/habitats/:habitatId/audit/summary",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (
      request: FastifyRequest<{
        Params: { habitatId: string };
        Querystring: z.infer<typeof summaryQuerySchema>;
      }>,
      _reply: FastifyReply,
    ) => {
      const parsed = summaryQuerySchema.safeParse(request.query);
      const { since, until } = parsed.success ? parsed.data : {};

      const summary = auditExportService.getAuditSummary(request.params.habitatId, since, until);
      return summary;
    },
  );

  fastify.post<{ Params: { habitatId: string }; Body: z.infer<typeof scheduleBodySchema> }>(
    "/habitats/:habitatId/audit/schedule",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (
      request: FastifyRequest<{
        Params: { habitatId: string };
        Body: z.infer<typeof scheduleBodySchema>;
      }>,
      reply: FastifyReply,
    ) => {
      const parsed = scheduleBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Invalid body", parsed.error.flatten());
      }

      const schedule = auditExportService.createSchedule(request.params.habitatId, parsed.data);
      reply.code(201).send({ schedule });
    },
  );

  fastify.get<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/audit/schedules",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request: FastifyRequest<{ Params: { habitatId: string } }>, _reply: FastifyReply) => {
      const schedules = auditExportService.listSchedules(request.params.habitatId);
      return { schedules };
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/audit/schedules/:id",
    { preHandler: [humanAuth, requireAuditScheduleAccess] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      auditExportService.deleteSchedule(request.params.id);
      reply.code(204).send();
    },
  );
}
