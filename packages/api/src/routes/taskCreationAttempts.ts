/**
 * T3A Phase 4 — authorized read endpoint for task-creation attempts.
 *
 * DORMANT additive production route: no production origin creates attempts
 * yet, but the GET surface lets authorized operators (agents + humans with
 * access) inspect attempt recovery state without going through the
 * reservation layer. Phase 1 ships {@link getAttemptStatus} in
 * `repositories/taskCreationAttempts.ts`; this route is its only HTTP
 * consumer.
 *
 * Conventions matched (verified against `routes/pulse.ts`, `routes/scheduledTasks.ts`,
 * `routes/triage.ts`):
 *   - `agentOrHumanAuth` preHandler (matches the pulse / triage family — the
 *     plan calls out "authorized callers", i.e. agents + humans with access).
 *   - 404 via `notFound(...)` from `errors.js`, NOT a raw `reply.code`.
 *   - Typed not-found from the repository (`{ found: false }`) is mapped to
 *     the route 404 — the primitive stays domain-pure, the route owns HTTP.
 *   - Prefixed under `/api/v1` and `/api` via the existing `registerApiRoutes`
 *     indirection in `index.ts`.
 */
import type { FastifyInstance } from "fastify";
import { agentOrHumanAuth } from "../middleware/auth.js";
import { notFound } from "../errors.js";
import { getAttemptStatus } from "../repositories/taskCreationAttempts.js";

export async function taskCreationAttemptRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { attemptId: string } }>(
    "/task-creation-attempts/:attemptId",
    { preHandler: agentOrHumanAuth },
    async (request, _reply) => {
      const { attemptId } = request.params;

      const result = getAttemptStatus(attemptId);
      if (!result.found) {
        throw notFound("Task creation attempt not found");
      }

      // The recovery surface (state, committed identifiers, terminal result,
      // lease + checkpoint timestamps) is returned verbatim — the route is a
      // thin transport for the Phase-1 read primitive.
      return result.status;
    },
  );
}