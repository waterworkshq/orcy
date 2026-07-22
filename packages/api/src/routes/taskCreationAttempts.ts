/**
 * T3A Phase 4 — authorized read endpoint for task-creation attempts.
 *
 * DORMANT additive production route: no production origin creates attempts
 * yet, but the GET surface lets authorized operators (agents + humans WITH
 * ACCESS) inspect attempt recovery state without going through the
 * reservation layer. Phase 1 ships {@link getAttemptStatus} in
 * `repositories/taskCreationAttempts.ts`; this route is its only HTTP
 * consumer.
 *
 * Authorization (T3B Phase R / R4): `agentOrHumanAuth` establishes identity;
 * the handler then resolves the caller's habitat membership against the
 * attempt's persisted `habitatId` authorization scope via the shared
 * {@link checkHabitatAccess} core (the same membership check
 * `requireHabitatAccess`/`requireMissionAccess` run). The scope is plain text
 * and NON-cascading so it survives habitat replacement; a since-deleted
 * habitat is treated as not-found (access refused, no cross-habitat leak).
 * An attempt with no `habitatId` (unreachable now that reservation always
 * populates one) is refused as not-found.
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
import { checkHabitatAccess } from "../middleware/realtimeAuth.js";
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

      // Habitat-scope authorization (R4): resolve the caller's membership
      // against the attempt's persisted habitatId BEFORE projecting. A missing
      // scope is refused as not-found (no leak). checkHabitatAccess throws
      // notFound/forbidden on denial — the global error handler maps them.
      const scopeHabitatId = result.status.habitatId;
      if (!scopeHabitatId) {
        throw notFound("Task creation attempt not found");
      }
      await checkHabitatAccess(request, scopeHabitatId);

      // The recovery surface (state, committed identifiers, terminal result,
      // lease + checkpoint timestamps) is returned verbatim — the route is a
      // thin transport for the Phase-1 read primitive.
      return result.status;
    },
  );
}
