import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { humanAuth } from "../middleware/auth.js";
import { adminOnly } from "../middleware/rbac.js";
import { getExperienceMetrics } from "../services/experienceMetricsService.js";
import { badRequest } from "../errors.js";

const metricsDaysSchema = (raw: unknown): number => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw badRequest("days must be a non-negative integer");
  }
  return n;
};

/** Admin metrics routes — read-only dashboard aggregations gated by humanAuth + adminOnly. */
export async function metricsRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /habitats/:id/experience-metrics - Per-agent experience signal metrics with outlier flags. Auth: humanAuth + adminOnly. Returns the aggregated metrics or an empty agent list. */
  fastify.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    "/habitats/:id/experience-metrics",
    { preHandler: [humanAuth, adminOnly] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { days?: string };
      }>,
      _reply: FastifyReply,
    ) => {
      const days = request.query.days !== undefined ? metricsDaysSchema(request.query.days) : 30;
      return getExperienceMetrics(request.params.id, days);
    },
  );
}
