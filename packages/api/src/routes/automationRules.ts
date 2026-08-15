import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as deliveryRepo from "../repositories/automationRuleDelivery.js";
import * as inboxService from "../services/automationInboxService.js";
import * as simulationService from "../services/automationSimulationService.js";
import { buildTriggerContext } from "../services/automationContextBuilder.js";
import {
  automationConditionSchema,
  validatePersistedCondition,
} from "../models/automationConditionSchema.js";
import {
  createAutomationRuleSchema,
  updateAutomationRuleSchema,
} from "../models/automationRuleSchema.js";
import { attemptRuleRun } from "../services/automationAttemptLifecycle.js";
import { agentHasHabitatWork, checkHabitatOwnership } from "../services/automationEventService.js";
import { humanAuth } from "../middleware/auth.js";
import { requireHabitatAccess } from "../middleware/team.js";
import { checkHabitatAccess } from "../middleware/realtimeAuth.js";
import { notFound, badRequest, conflict } from "../errors.js";
import type { AutomationTargetType } from "@orcy/shared";

// CS-56 T2 & LL-RM-1: every rule boundary uses strict discriminated schemas
// for trigger, condition, and actions.
const createRuleSchema = createAutomationRuleSchema;
const updateRuleSchema = updateAutomationRuleSchema;

const simulateSchema = z.object({
  overrideCondition: automationConditionSchema.optional(),
  triggerEventId: z.string().optional(),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  payload: z.object({}).passthrough().optional(),
});

/**
 * CS-56 T6 — Manual run request schema. Mirrors the simulation
 * target/payload shape so operators can author conditions with the same
 * canonical `targetType` / `targetId` / `payload` triple.
 *
 *   - `targetType`: defaults to `"none"`; only direct entity targets
 *     (`task`, `mission`, `agent`, `sprint`, `pulse`, `habitat`) are
 *     accepted. `integration` is rejected with a 400 until a real
 *     ownership resolver exists (decision: §6 Manual Execution).
 *   - `targetId`: required unless `targetType` is `"none"`.
 *   - `payload`: arbitrary passthrough; becomes `trigger.payload` for
 *     live `raw.*` condition parity with simulation.
 *
 * The stored rule's condition, trigger identity, dedupe identity, and
 * causal context are intentionally NOT overridable — clients cannot
 * inject chain identity (T4 hardening) or substitute an arbitrary
 * condition tree at runtime.
 */
const manualRunSchema = z
  .object({
    targetType: z
      .enum(["task", "mission", "agent", "sprint", "pulse", "habitat", "none"])
      .optional(),
    targetId: z.string().optional(),
    payload: z.record(z.unknown()).optional(),
  })
  .strict();

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
      return ruleRepo.updateAutomationRule(
        request.params.ruleId,
        {
          ...parsed.data,
          trigger: parsed.data.trigger as any,
          condition: parsed.data.condition as any,
          actions: parsed.data.actions as any,
        },
        { author: { type: "human", id: request.user!.id } },
      );
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

  // Enable/Disable — CS-56 T2: an enable request also re-validates the
  // rule's persisted condition tree. Rules whose condition JSON predates
  // the schema (or was authored outside the route surface) and is now
  // structurally invalid are surfaced for repair rather than silently
  // activated. CS-56 decision §4 / technical plan #condition-validation.
  fastify.post<{ Params: { ruleId: string } }>(
    "/automation-rules/:ruleId/enable",
    { preHandler: humanAuth },
    async (request, _reply) => {
      const existing = ruleRepo.getAutomationRuleById(request.params.ruleId);
      if (!existing) throw notFound("Rule not found");
      const outcome = validatePersistedCondition(existing.condition);
      if (!outcome.valid) {
        throw badRequest(
          "Stored condition is invalid and must be repaired before the rule can be enabled",
          { issues: outcome.issues, diagnostic: outcome.diagnostic },
        );
      }
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
  // CS-56 T6 — Routes manual execution through the canonical
  // `attemptRuleRun` lifecycle. The handler:
  //   - loads + enables the rule,
  //   - enforces Habitat access against `rule.habitatId` so this rule-id
  //     route cannot become a cross-Habitat execution seam (MEMORY:
  //     `request.actor` does not exist on Fastify — auth is via
  //     `request.user` / `request.agent`; `checkHabitatAccess` honors both),
  //   - validates the request body (target/payload shape — no caller
  //     overrides of condition / trigger identity / dedupe / causal),
  //   - validates target ownership for Task / Mission / Sprint / Pulse /
  //     Habitat (must resolve to the rule Habitat) and Agent (must have
  //     active Habitat work via `agentHasHabitatWork`), and rejects
  //     `integration` until an ownership resolver exists,
  //   - calls `attemptRuleRun` with internal `triggerEventId="manual"`,
  //     null `eventDedupeKey`, `source="manual"`, and the rule's
  //     configured trigger type,
  //   - returns the terminal run + disposition. Never returns a newly
  //     stranded `running` row under normal execution.
  fastify.post<{ Params: { ruleId: string } }>(
    "/automation-rules/:ruleId/run",
    { preHandler: humanAuth },
    async (request, _reply) => {
      const rule = ruleRepo.getAutomationRuleById(request.params.ruleId);
      if (!rule) throw notFound("Rule not found");
      if (!rule.enabled) {
        throw badRequest("Rule is disabled — enable it first or simulate");
      }
      // Enforce Habitat access (route param is ruleId, not habitatId, so
      // the standard `requireHabitatAccess` middleware cannot read it).
      await checkHabitatAccess(request, rule.habitatId);

      const parsed = manualRunSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      const targetType: AutomationTargetType = (parsed.data.targetType ??
        "none") as AutomationTargetType;
      const targetId = parsed.data.targetId ?? null;

      // targetId required unless targetType === "none".
      if (targetType !== "none" && !targetId) {
        throw badRequest("targetId is required when targetType is not 'none'");
      }
      // `integration` has no ownership resolver yet (decision §6).
      if (targetType === "integration") {
        throw badRequest("integration target is not yet supported for manual runs");
      }

      // Validate target ownership against the rule's Habitat.
      // Task / Mission / Sprint / Pulse / Habitat: the entity must resolve
      // to `rule.habitatId` (mirror of `checkHabitatOwnership` semantics).
      // Agent: must have active Task work in the rule Habitat
      // (`agentHasHabitatWork`, the same signal the event path uses).
      if (targetType !== "none" && targetId) {
        if (targetType === "agent") {
          if (!agentHasHabitatWork(targetId, rule.habitatId)) {
            throw badRequest("Agent has no active Habitat work in the rule's Habitat");
          }
        } else {
          const ownership = checkHabitatOwnership(rule.habitatId, targetType, targetId);
          if (ownership !== "valid") {
            throw badRequest(
              ownership === "missing"
                ? `Target ${targetType} not found`
                : `Target ${targetType} belongs to a different Habitat`,
            );
          }
        }
      }

      // Synthesize a stable trigger identity. `manual` is reserved — it
      // is the cooldown fingerprint for manual attempts (T6 settles: per
      // rule + target), and `eventDedupeKey` stays null so the manual
      // path never engages trusted-event reservation.
      const triggerEventId = "manual";
      const triggerType = deriveTriggerType(rule.trigger, "manual");
      const payload = parsed.data.payload ?? {};

      const disposition = await attemptRuleRun({
        rule,
        source: "manual",
        trigger: {
          triggerType,
          triggerEventId,
          habitatId: rule.habitatId,
          targetType,
          targetId,
          payload,
        },
        eventDedupeKey: null,
      });

      // The response shape carries the terminal run and a slim disposition
      // envelope (kind + reason / outcome / actionResults). UI consumers
      // that previously polled for `runId`+`status` continue to find both
      // here (see `run.id` + `run.status`).
      return {
        runId: disposition.run.id,
        status: disposition.run.status,
        disposition,
        run: disposition.run,
      };
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

  // ---------------------------------------------------------------------------
  // Automation inbox — operator visibility + audited dispositions
  // ---------------------------------------------------------------------------

  const dispositionSchema = z.object({
    reason: z.string().min(1),
    ackDuplicateRisk: z.boolean().optional(),
    ackLegacyProvedNoReceipt: z.boolean().optional(),
  });

  // Inbox + delivery visibility for a habitat (attention_required must be
  // visible — it is NOT success). Pagination is explicit: older
  // attention-required work beyond the newest page stays reachable instead
  // of silently disappearing.
  fastify.get<{ Params: { habitatId: string }; Querystring: { limit?: string; offset?: string } }>(
    "/habitats/:habitatId/automation-inbox",
    { preHandler: [humanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const paging = z
        .object({
          limit: z.coerce.number().int().min(1).max(500).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        })
        .safeParse(request.query ?? {});
      if (!paging.success) {
        throw badRequest("Validation failed", paging.error.flatten());
      }
      return inboxService.listHabitatInbox(request.params.habitatId, {
        limit: paging.data.limit,
        offset: paging.data.offset,
      });
    },
  );

  // Operator waive AFTER external reconciliation (audited).
  fastify.post<{ Params: { deliveryId: string } }>(
    "/automation-deliveries/:deliveryId/waive",
    { preHandler: humanAuth },
    async (request, reply) => {
      const parsed = dispositionSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      const delivery = deliveryRepo.getDeliveryById(request.params.deliveryId);
      if (!delivery) throw notFound("Delivery not found");
      await checkHabitatAccess(request, delivery.habitatId);
      const result = inboxService.waiveAutomationDelivery({
        deliveryId: request.params.deliveryId,
        actorType: "human",
        actorId: request.user!.id,
        reason: parsed.data.reason,
      });
      if (result.outcome === "not_found") throw notFound("Delivery not found");
      if (result.outcome === "conflict") {
        throw conflict(
          `Delivery is not attention_required (current state: ${result.state}) — waive applies only after external reconciliation of an attention delivery`,
        );
      }
      reply.code(200);
      return result;
    },
  );

  // Explicit risk-acknowledged successor attempt generation (audited).
  fastify.post<{ Params: { deliveryId: string } }>(
    "/automation-deliveries/:deliveryId/retry",
    { preHandler: humanAuth },
    async (request, reply) => {
      const parsed = dispositionSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      const delivery = deliveryRepo.getDeliveryById(request.params.deliveryId);
      if (!delivery) throw notFound("Delivery not found");
      await checkHabitatAccess(request, delivery.habitatId);
      const result = inboxService.createAutomationDeliverySuccessorGeneration({
        deliveryId: request.params.deliveryId,
        actorType: "human",
        actorId: request.user!.id,
        reason: parsed.data.reason,
        ackDuplicateRisk: parsed.data.ackDuplicateRisk === true,
        ackLegacyProvedNoReceipt: parsed.data.ackLegacyProvedNoReceipt === true,
      });
      if (result.outcome === "not_found") throw notFound("Delivery not found");
      if (result.outcome === "risk_ack_required") {
        throw badRequest(
          "ackDuplicateRisk must be true — a successor generation re-executes unproved actions and may duplicate external effects",
        );
      }
      if (result.outcome === "legacy_no_receipt_ack_required") {
        throw badRequest(
          "ackLegacyProvedNoReceipt must be true — this delivery carries a historically-proved checkpoint without a durable receipt (the action already fired); re-running it re-fires a confirmed side effect",
        );
      }
      if (result.outcome === "conflict") {
        throw conflict(
          `Delivery cannot branch a successor from its current state (${result.state}) — only the latest attention_required generation may`,
        );
      }
      reply.code(201);
      return result;
    },
  );
}
