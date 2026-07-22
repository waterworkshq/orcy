/**
 * Scheduled Occurrence Repair-and-Retry Routes.
 *
 * The authorized `POST /scheduled-occurrences/:id/retry` repair endpoint.
 * Composes the {@link repairScheduledOccurrence} adapter (T9B Phase 3) +
 * maps the closed {@link RepairScheduledOccurrenceOutcome} to HTTP.
 *
 * # Why admin-only authorization
 *
 * The retry triggers a fresh Mission publication under the operator's
 * authority — it spends real Task slots, runs governance, and writes
 * audit history. The plan (`technical-plan:344`) requires the retry be
 * "authorized." An admin-only gate (`humanAuth + adminOnly`) is the
 * established elevated-action pattern (mirrors `routes/webhookOutgoing.ts`
 * + `routes/agents.ts` — the route registration + the auth-chain
 * precedent). A non-admin gets 403; an unauthenticated caller gets 401.
 *
 * # Outcome → HTTP mapping
 *
 * The retry's outcome vocabulary mirrors the publisher's (the closed
 * `RepairScheduledOccurrenceOutcome`). HTTP semantics follow the plan's
 * publication-result mapping:
 *
 *   | outcome                         | HTTP | rationale                              |
 *   |---------------------------------|------|----------------------------------------|
 *   | `repaired`                      | 201  | A new Mission was committed.           |
 *   | `vetoed`                        | 403  | Governance refusal (typed response).   |
 *   | `retry_failed_validation`       | 422  | The rendered payload is invalid.       |
 *   | `retry_failed_schedule_missing` | 409  | The schedule is gone (data anomaly).   |
 *   | `retry_schedule_guard_mismatch` | 409  | Resumable — schedule edited mid-tx;    |
 *   |                                 |      | re-try (re-reads the corrected state). |
 *   | `retry_schedule_vanished_mid_tx`| 409  | Resumable — schedule deleted mid-tx.   |
 *   | `retry_guard_mismatch`          | 409  | Resumable — per-Task guard drift; the  |
 *   |                                 |      | retryNumber advanced (re-call).        |
 *   | `retry_governance_denied`       | 409  | Resumable — stale governance at commit.|
 *   | `retry_in_progress`             | 409  | A concurrent retry is mid-flight;      |
 *   |                                 |      | re-call later.                         |
 *   | `retry_already_completed`       | 409  | A prior retry under this retryNumber   |
 *   |                                 |      | already concluded.                     |
 *   | `retry_concurrent_conflict`     | 409  | A concurrent retry fingerprint         |
 *   |                                 |      | mismatch; re-call.                     |
 *   | `illegal_source_state`          | 409  | The occurrence is not `rejected`; no   |
 *   |                                 |      | retry applies.                         |
 *   | `not_found`                     | 404  | No occurrence row for the id.          |
 *
 * See: the {@link repairScheduledOccurrence} adapter (the retry
 * publication function).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { humanAuth } from "../middleware/auth.js";
import { adminOnly } from "../middleware/rbac.js";
import { notFound } from "../errors.js";
import {
  repairScheduledOccurrence,
  type RepairScheduledOccurrenceOutcome,
} from "../services/scheduledOccurrenceRepair.js";

/**
 * Maps a {@link RepairScheduledOccurrenceOutcome} to an HTTP status code +
 * JSON body. Mirrors the publisher's outcome → HTTP mapping discipline
 * (closed outcome → typed HTTP response; never a 500 for an expected
 * domain decision).
 */
function repairOutcomeToHttpResponse(
  result: RepairScheduledOccurrenceOutcome,
  actorId: string,
): { statusCode: number; body: unknown } {
  switch (result.outcome) {
    case "repaired":
      return {
        statusCode: 201,
        body: {
          outcome: "repaired",
          retryNumber: result.retryNumber,
          occurrence: result.occurrence,
          mission: result.mission,
          tasks: result.tasks,
          workflow: result.workflow,
        },
      };
    case "retry_failed_vetoed":
      return {
        statusCode: 403,
        body: {
          outcome: "vetoed",
          retryNumber: result.retryNumber,
          occurrence: result.occurrence,
          vetoes: result.vetoes,
        },
      };
    case "retry_failed_validation":
      return {
        statusCode: 422,
        body: {
          outcome: "retry_failed_validation",
          retryNumber: result.retryNumber,
          occurrence: result.occurrence,
          errors: result.errors,
        },
      };
    case "retry_failed_schedule_missing":
      return {
        statusCode: 409,
        body: {
          outcome: "retry_failed_schedule_missing",
          retryNumber: result.retryNumber,
          occurrence: result.occurrence,
        },
      };
    case "retry_guard_mismatch":
      return {
        statusCode: 409,
        body: {
          outcome: "retry_guard_mismatch",
          retryNumber: result.retryNumber,
          occurrence: result.occurrence,
          taskIndex: result.taskIndex,
          reasons: result.reasons,
        },
      };
    case "retry_governance_denied":
      return {
        statusCode: 409,
        body: {
          outcome: "retry_governance_denied",
          retryNumber: result.retryNumber,
          occurrence: result.occurrence,
          taskIndex: result.taskIndex,
          kind: result.kind,
          reason: result.reason,
          ...(result.interceptorKey !== undefined ? { interceptorKey: result.interceptorKey } : {}),
        },
      };
    case "retry_schedule_guard_mismatch":
      return {
        statusCode: 409,
        body: {
          outcome: "retry_schedule_guard_mismatch",
          retryNumber: result.retryNumber,
          occurrence: result.occurrence,
          fields: result.fields,
        },
      };
    case "retry_schedule_vanished_mid_tx":
      return {
        statusCode: 409,
        body: {
          outcome: "retry_schedule_vanished_mid_tx",
          retryNumber: result.retryNumber,
          occurrence: result.occurrence,
        },
      };
    case "retry_in_progress":
      return {
        statusCode: 409,
        body: {
          outcome: "retry_in_progress",
          retryNumber: result.retryNumber,
          occurrence: result.occurrence,
        },
      };
    case "retry_already_completed":
      return {
        statusCode: 409,
        body: {
          outcome: "retry_already_completed",
          retryNumber: result.retryNumber,
          occurrence: result.occurrence,
          priorEntry: result.priorEntry,
        },
      };
    case "retry_concurrent_conflict":
      return {
        statusCode: 409,
        body: {
          outcome: "retry_concurrent_conflict",
          retryNumber: result.retryNumber,
          occurrence: result.occurrence,
        },
      };
    case "illegal_source_state":
      return {
        statusCode: 409,
        body: {
          outcome: "illegal_source_state",
          occurrence: result.occurrence,
          fromState: result.fromState,
        },
      };
    case "not_found":
      // The route handler throws `notFound` for the not-found branch (the
      // 404 mapping is the global error handler's responsibility). This
      // switch arm is unreachable when called via the route handler.
      return { statusCode: 404, body: { outcome: "not_found" } };
  }
}

/** The retry route registration. */
export async function scheduledOccurrenceRepairRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    "/scheduled-occurrences/:id/retry",
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { id: string };

      // Provenance: the operator's identity (the authenticated admin) is
      // recorded in the retryHistory entry's `actorId` field. The Mission's
      // `createdBy` stays "scheduler" (matches the publisher's attribution
      // — the retry is structurally a scheduled-occurrence publication;
      // the operator trigger is recorded in the stamp, not the Mission row).
      const actorId = request.user?.id;
      if (!actorId) {
        // humanAuth + adminOnly guarantee `request.user` is set; defensive
        // fallback (mirrors the clone-publication route's check).
        throw notFound("Authentication required");
      }

      const result = repairScheduledOccurrence({
        occurrenceId: params.id,
        actorId,
      });

      // The not-found branch maps to a thrown `notFound` so the global
      // error handler applies its standard 404 formatting (consistent
      // with the scheduled-task routes' not-found pattern).
      if (result.outcome === "not_found") {
        throw notFound("Scheduled occurrence not found", "SCHEDULED_OCCURRENCE_NOT_FOUND");
      }

      const { statusCode, body } = repairOutcomeToHttpResponse(result, actorId);
      reply.code(statusCode).send(body);
    },
  );
}

/**
 * Default export mirrors `routes/taskClonePublication.ts` /
 * `taskCreationAttempts.ts` — test harnesses that import the file directly
 * register the routes under their chosen prefix.
 */
export default scheduledOccurrenceRepairRoutes;
