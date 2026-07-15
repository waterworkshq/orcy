import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentOrHumanAuth } from "../middleware/auth.js";
import { requireHabitatAccess } from "../middleware/team.js";
import * as service from "../services/pluginEnrollmentService.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { badRequest } from "../errors.js";

const createEnrollmentBody = z.object({
  pluginId: z.string().min(1),
  contributionId: z.string().min(1),
  config: z.record(z.unknown()).optional(),
});

const updateEnrollmentBody = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});

const listRunsQuery = z.object({
  pluginId: z.string().optional(),
  status: z.string().optional(),
  since: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const staleRunsQuery = z.object({
  thresholdMinutes: z.coerce.number().int().min(1).optional(),
});

/**
 * Plugin enrollment + run REST surface (ADR-0016). Habitat-scoped routes for
 * enrolling habitat-scoped contributions (signalDetector, lifecycleInterceptor),
 * toggling enabled state, updating config, listing runs, and un-enrolling.
 * All routes require agentOrHumanAuth + a valid habitat id.
 */
export async function pluginRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/plugins/enrollments",
    { preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const parsed = createEnrollmentBody.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      const actor = request.user?.id ?? request.agent?.id ?? "unknown";
      return service.createEnrollment(request.params.habitatId, parsed.data, actor);
    },
  );

  fastify.patch<{ Params: { habitatId: string; id: string } }>(
    "/habitats/:habitatId/plugins/enrollments/:id",
    { preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const parsed = updateEnrollmentBody.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      return service.updateEnrollment(request.params.habitatId, request.params.id, parsed.data);
    },
  );

  fastify.get<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/plugins/enrollments",
    { preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      return service.listEnrollments(request.params.habitatId);
    },
  );

  fastify.delete<{ Params: { habitatId: string; id: string } }>(
    "/habitats/:habitatId/plugins/enrollments/:id",
    { preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const deleted = service.deleteEnrollment(request.params.habitatId, request.params.id);
      return { deleted };
    },
  );

  fastify.get<{ Params: { habitatId: string }; Querystring: Record<string, string | undefined> }>(
    "/habitats/:habitatId/plugins/runs",
    { preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const parsed = listRunsQuery.safeParse(request.query);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      return service.listPluginRuns(request.params.habitatId, parsed.data);
    },
  );

  fastify.get<{ Params: { habitatId: string }; Querystring: Record<string, string | undefined> }>(
    "/habitats/:habitatId/plugins/stale-runs",
    { preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const parsed = staleRunsQuery.safeParse(request.query);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      const thresholdMinutes =
        parsed.data.thresholdMinutes ?? service.getStalePluginRunThresholdMinutes();
      return {
        staleRuns: service.listStalePluginRuns(request.params.habitatId, thresholdMinutes),
      };
    },
  );

  // Plugin catalog: lists loaded plugins (ids, versions, descriptions) and load errors.
  // Authenticated but not habitat-scoped — it's a global catalog available to any authenticated user.
  fastify.get("/plugins", { preHandler: [agentOrHumanAuth] }, async (_request, _reply) => {
    return { plugins: pluginManager.getLoadedPlugins() };
  });

  // Quarantine clear: quarantine is system-global by design (a misbehaving plugin is
  // misbehaving regardless of habitat). The :habitatId param gates access via
  // requireHabitatAccess — the caller must have habitat access to manage quarantines.
  // Per-habitat quarantine would require a schema change (habitat_id on plugin_quarantines)
  // and is deferred to a future release if multi-tenant isolation demands it.
  fastify.delete<{ Params: { habitatId: string; pluginKey: string } }>(
    "/habitats/:habitatId/plugins/:pluginKey/quarantine",
    { preHandler: [agentOrHumanAuth, requireHabitatAccess] },
    async (request, _reply) => {
      const cleared = pluginManager.clearQuarantine(request.params.pluginKey);
      return { cleared };
    },
  );
}
