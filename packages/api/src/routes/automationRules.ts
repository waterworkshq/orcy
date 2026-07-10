import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as simulationService from "../services/automationSimulationService.js";
import { buildTriggerContext } from "../services/automationContextBuilder.js";
import { humanAuth } from "../middleware/auth.js";
import { requireHabitatAccess } from "../middleware/team.js";
import { notFound, badRequest, forbidden } from "../errors.js";

const createRuleSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().nonnegative().optional(),
  trigger: z.object({}).passthrough(),
  condition: z.object({}).passthrough().optional(),
  actions: z.array(z.object({}).passthrough()).min(1).max(10),
  cooldownSeconds: z.number().int().nonnegative().optional(),
  maxRunsPerHour: z.number().int().positive().optional(),
});

const updateRuleSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().nonnegative().optional(),
  trigger: z.object({}).passthrough().optional(),
  condition: z.object({}).passthrough().optional(),
  actions: z.array(z.object({}).passthrough()).min(1).max(10).optional(),
  cooldownSeconds: z.number().int().nonnegative().optional(),
  maxRunsPerHour: z.number().int().positive().optional(),
});

const simulateSchema = z.object({
  overrideCondition: z.object({}).passthrough().optional(),
  triggerEventId: z.string().optional(),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  payload: z.object({}).passthrough().optional(),
});

function deriveTriggerType(trigger: unknown, defaultIfEvent: string): string {
  const t = trigger as { type?: string; scanType?: string; eventType?: string };
  return t.type === "scan" ? (t.scanType ?? "unknown") : (t.eventType ?? defaultIfEvent);
}

export async function automationRoutes(fastify: FastifyInstance): Promise<void> {
  // List rules for habitat
  fastify.get<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/automation-rules",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      return ruleRepo.listAutomationRulesByHabitat(request.params.habitatId);
    },
  );

  // Create rule
  fastify.post<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/automation-rules",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const parsed = createRuleSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      return ruleRepo.createAutomationRule({
        habitatId: request.params.habitatId,
        name: parsed.data.name,
        description: parsed.data.description,
        enabled: parsed.data.enabled,
        priority: parsed.data.priority,
        trigger: parsed.data.trigger as any,
        condition: (parsed.data.condition ?? { type: "always" }) as any,
        actions: parsed.data.actions as any,
        cooldownSeconds: parsed.data.cooldownSeconds,
        maxRunsPerHour: parsed.data.maxRunsPerHour,
        createdBy: request.user!.id,
      });
    },
  );

  // Get single rule
  fastify.get<{ Params: { ruleId: string } }>(
    "/automation-rules/:ruleId",
    { preHandler: humanAuth },
    async (request, _reply) => {
      const rule = ruleRepo.getAutomationRuleById(request.params.ruleId);
      if (!rule) throw notFound("Rule not found");
      return rule;
    },
  );

  // Update rule
  fastify.put<{ Params: { ruleId: string } }>(
    "/automation-rules/:ruleId",
    { preHandler: humanAuth },
    async (request, _reply) => {
      const parsed = updateRuleSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      const existing = ruleRepo.getAutomationRuleById(request.params.ruleId);
      if (!existing) throw notFound("Rule not found");
      return ruleRepo.updateAutomationRule(request.params.ruleId, {
        ...parsed.data,
        trigger: parsed.data.trigger as any,
        condition: parsed.data.condition as any,
        actions: parsed.data.actions as any,
      });
    },
  );

  // Delete rule
  fastify.delete<{ Params: { ruleId: string } }>(
    "/automation-rules/:ruleId",
    { preHandler: humanAuth },
    async (request, _reply) => {
      const existing = ruleRepo.getAutomationRuleById(request.params.ruleId);
      if (!existing) throw notFound("Rule not found");
      ruleRepo.deleteAutomationRule(request.params.ruleId);
      return { deleted: true };
    },
  );

  // Enable/Disable
  fastify.post<{ Params: { ruleId: string } }>(
    "/automation-rules/:ruleId/enable",
    { preHandler: humanAuth },
    async (request, _reply) => {
      const existing = ruleRepo.getAutomationRuleById(request.params.ruleId);
      if (!existing) throw notFound("Rule not found");
      return ruleRepo.setRuleEnabled(request.params.ruleId, true);
    },
  );

  fastify.post<{ Params: { ruleId: string } }>(
    "/automation-rules/:ruleId/disable",
    { preHandler: humanAuth },
    async (request, _reply) => {
      const existing = ruleRepo.getAutomationRuleById(request.params.ruleId);
      if (!existing) throw notFound("Rule not found");
      return ruleRepo.setRuleEnabled(request.params.ruleId, false);
    },
  );

  // Simulate
  fastify.post<{ Params: { ruleId: string } }>(
    "/automation-rules/:ruleId/simulate",
    { preHandler: humanAuth },
    async (request, _reply) => {
      const rule = ruleRepo.getAutomationRuleById(request.params.ruleId);
      if (!rule) throw notFound("Rule not found");
      const parsed = simulateSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      const trigger = buildTriggerContext({
        triggerType: deriveTriggerType(rule.trigger, "task.rejected"),
        triggerEventId: parsed.data.triggerEventId ?? null,
        habitatId: rule.habitatId,
        targetType: parsed.data.targetType as any,
        targetId: parsed.data.targetId ?? null,
        payload: parsed.data.payload,
      });
      return simulationService.simulateRule({
        rule,
        trigger,
        overrideCondition: parsed.data.overrideCondition as any,
      });
    },
  );

  // Manual run
  fastify.post<{ Params: { ruleId: string } }>(
    "/automation-rules/:ruleId/run",
    { preHandler: humanAuth },
    async (request, _reply) => {
      const rule = ruleRepo.getAutomationRuleById(request.params.ruleId);
      if (!rule) throw notFound("Rule not found");
      if (!rule.enabled) {
        throw badRequest("Rule is disabled — enable it first or simulate");
      }
      const run = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: rule.habitatId,
        triggerType: deriveTriggerType(rule.trigger, "manual"),
        triggerEventId: "manual",
        targetType: "none",
        targetId: null,
      });
      return { runId: run.id, status: run.status };
    },
  );

  // Rule runs history
  fastify.get<{ Params: { ruleId: string }; Querystring: { limit?: string; offset?: string } }>(
    "/automation-rules/:ruleId/runs",
    { preHandler: humanAuth },
    async (request, _reply) => {
      const { ruleId } = request.params;
      const limit = request.query.limit ? Number(request.query.limit) : 50;
      const offset = request.query.offset ? Number(request.query.offset) : 0;
      const rule = ruleRepo.getAutomationRuleById(ruleId);
      if (!rule) throw notFound("Rule not found");
      return runRepo.listRunsByRule(ruleId, { limit, offset });
    },
  );

  // All runs for habitat
  fastify.get<{ Params: { habitatId: string }; Querystring: { limit?: string; offset?: string } }>(
    "/habitats/:habitatId/automation-runs",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const { habitatId } = request.params;
      const limit = request.query.limit ? Number(request.query.limit) : 50;
      const offset = request.query.offset ? Number(request.query.offset) : 0;
      return runRepo.listRunsByHabitat(habitatId, { limit, offset });
    },
  );
}
