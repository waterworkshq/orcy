import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as templateRepo from "../repositories/template.js";
import * as missionRepo from "../repositories/feature.js";
import { humanAuth, agentOrHumanAuth } from "../middleware/auth.js";
import { adminOnly } from "../middleware/rbac.js";
import { z } from "zod";
import { badRequest, notFound, forbidden } from "../errors.js";

const createTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  titlePattern: z.string().min(1).max(200),
  descriptionPattern: z.string().max(5000).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  labels: z.array(z.string()).optional(),
  requiredDomain: z.string().nullable().optional(),
  requiredCapabilities: z.array(z.string()).optional(),
});

const updateTemplateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  titlePattern: z.string().min(1).max(200).optional(),
  descriptionPattern: z.string().max(5000).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  labels: z.array(z.string()).optional(),
  requiredDomain: z.string().nullable().optional(),
  requiredCapabilities: z.array(z.string()).optional(),
});

const applyTemplateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  labels: z.array(z.string()).optional(),
  variables: z.record(z.string()).optional(),
});

/**
 * Task template management — create, list, update, delete, and track usage.
 */
export async function templateRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /habitats/:habitatId/templates - List templates for a board. Auth: agentOrHumanAuth. Returns { templates } */
  fastify.get<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/templates",
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { habitatId: string } }>, _reply: FastifyReply) => {
      const templates = templateRepo.getTemplatesByHabitatId(request.params.habitatId);
      return { templates };
    },
  );

  /** POST /habitats/:habitatId/templates - Create a template. Auth: humanAuth. Returns { template } */
  fastify.post<{ Params: { habitatId: string }; Body: z.infer<typeof createTemplateSchema> }>(
    "/habitats/:habitatId/templates",
    { preHandler: humanAuth },
    async (
      request: FastifyRequest<{
        Params: { habitatId: string };
        Body: z.infer<typeof createTemplateSchema>;
      }>,
      reply: FastifyReply,
    ) => {
      const parsed = createTemplateSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      const userId = request.user?.id ?? "anonymous";

      const template = templateRepo.createTemplate({
        habitatId: request.params.habitatId,
        name: parsed.data.name,
        titlePattern: parsed.data.titlePattern,
        descriptionPattern: parsed.data.descriptionPattern,
        priority: parsed.data.priority,
        labels: parsed.data.labels,
        requiredDomain: parsed.data.requiredDomain,
        requiredCapabilities: parsed.data.requiredCapabilities,
        createdBy: userId,
      });

      reply.code(201).send({ template });
    },
  );

  /** PATCH /templates/:id - Update a template. Auth: humanAuth. Returns { template } or 404 */
  fastify.patch<{ Params: { id: string }; Body: z.infer<typeof updateTemplateSchema> }>(
    "/templates/:id",
    { preHandler: humanAuth },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: z.infer<typeof updateTemplateSchema>;
      }>,
      _reply: FastifyReply,
    ) => {
      const parsed = updateTemplateSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      const template = templateRepo.updateTemplate(request.params.id, {
        name: parsed.data.name,
        titlePattern: parsed.data.titlePattern,
        descriptionPattern: parsed.data.descriptionPattern,
        priority: parsed.data.priority,
        labels: parsed.data.labels,
        requiredDomain: parsed.data.requiredDomain,
        requiredCapabilities: parsed.data.requiredCapabilities,
      });

      if (!template) {
        throw notFound("Template not found");
      }

      return { template };
    },
  );

  /** DELETE /templates/:id - Delete a template. Auth: humanAuth + adminOnly. Returns 204 or 404/403 */
  fastify.delete<{ Params: { id: string } }>(
    "/templates/:id",
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const template = templateRepo.getTemplateById(request.params.id);
      if (!template) {
        throw notFound("Template not found");
      }

      if (template.isDefault) {
        throw forbidden("Cannot delete default template");
      }

      const deleted = templateRepo.deleteTemplate(request.params.id);
      if (!deleted) {
        throw notFound("Template not found");
      }

      reply.code(204).send();
    },
  );

  /** POST /templates/:id/usage - Increment template usage count. Auth: agentOrHumanAuth. Returns { success: true } */
  fastify.post<{ Params: { id: string } }>(
    "/templates/:id/usage",
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const template = templateRepo.getTemplateById(request.params.id);
      if (!template) {
        throw notFound("Template not found");
      }

      templateRepo.incrementUsageCount(request.params.id);
      return { success: true };
    },
  );

  /** POST /missions/:missionId/apply-template/:templateId - Apply template to create feature+tasks. Auth: humanAuth. Returns { feature, tasks } */
  fastify.post<{
    Params: { missionId: string; templateId: string };
    Body: z.infer<typeof applyTemplateSchema>;
  }>(
    "/missions/:missionId/apply-template/:templateId",
    { preHandler: humanAuth },
    async (
      request: FastifyRequest<{
        Params: { missionId: string; templateId: string };
        Body: z.infer<typeof applyTemplateSchema>;
      }>,
      reply: FastifyReply,
    ) => {
      const parsed = applyTemplateSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      const existingMission = missionRepo.getMissionById(request.params.missionId);
      if (!existingMission) {
        throw notFound("Mission not found");
      }

      const template = templateRepo.getTemplateById(request.params.templateId);
      if (!template) {
        throw notFound("Template not found");
      }

      if (template.habitatId !== null && template.habitatId !== existingMission.habitatId) {
        throw forbidden("Template does not belong to this habitat");
      }

      const userId = request.user?.id ?? "anonymous";
      const result = templateRepo.applyTemplate(
        request.params.templateId,
        existingMission.habitatId,
        parsed.data,
        userId,
      );

      if (!result) {
        throw notFound("Template not found");
      }

      reply
        .code(201)
        .send({ mission: result.mission, tasks: result.tasks, workflow: result.workflow });
    },
  );
}
