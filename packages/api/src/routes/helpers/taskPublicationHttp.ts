/**
 * Shared HTTP mapper for the Task-Creation publication routes (T6 P2 +
 * T7 P2). Extracted from the duplicated `outcomeToHttpResponse` in
 * `routes/taskPublication.ts` + `routes/taskClonePublication.ts` by
 * Fix-P2 (cold-review M4-3) to kill the drift risk of two ~100-line
 * copies diverging.
 *
 * Contract:
 *   - The mapper is a THIN TRANSPORT. The adapter
 *     (`services/taskCreationPublication.ts:publishTaskCreation`) owns the
 *     result envelope; the route forwards the outcome union verbatim. The
 *     mapper ONLY derives an HTTP status + body shape.
 *   - Status code semantics (unchanged from the T6/T7 P2 mapping):
 *       `created` + `recovering:true`  → 202 Accepted (committed but not
 *                                         yet observed — the client polls
 *                                         `GET /task-creation-attempts/:attemptId`).
 *       terminal `created`              → 201 Created.
 *       `replayed`                      → 200 OK (idempotent retry — the
 *                                         stored terminal outcome).
 *       `rejected_validation`           → 422 Unprocessable Entity.
 *       `vetoed`                        → 403 Forbidden (governance refusal).
 *       `rejected_fingerprint`          → 409 Conflict (corrected payload
 *                                         needs a new key).
 *       `guard_mismatch` / `governance_denied` → 503 Service Unavailable
 *                                         (retryable — the client retries
 *                                         with the SAME key; the adapter
 *                                         re-prepares).
 *
 * `envelopeTaskId` is the committed Task id recovered from the
 * `task_creation_envelopes` row by the route (the durable source of truth
 * for "did a Task commit under this attempt?"). It is the BELTS-AND-
 * SUSPENDERS backfill for the `replayed` branch: when the stored terminal
 * result carries no `taskId` (e.g. a terminal written by an older code
 * path before M4-1 stamped it on success), the envelope row recovers it
 * so the response-loss → link-to-Task contract holds (cold-review M4-2).
 *
 * A recovering Task is NEVER mapped to 500. The P1 carry-over requires
 * "HTTP/MCP mappings preserve the shared domain outcome and do not throw
 * committed success as failure" — a 502/500 for a committed-recovering
 * Task would leak the recovery state as a failure.
 */
import type { TaskCreationPublicationResult } from "../../services/taskCreationPublication.js";

/**
 * Maps a {@link TaskCreationPublicationResult} to an HTTP response shape
 * `{ statusCode, body }`. See the module docstring for the status code
 * mapping + the `envelopeTaskId` backfill rationale.
 */
export function publicationResultToHttpResponse(
  result: TaskCreationPublicationResult,
  envelopeTaskId: string | null,
): {
  statusCode: number;
  body: Record<string, unknown>;
} {
  switch (result.outcome) {
    case "created": {
      // The committed task id can be sourced from either the inline
      // `publication.task.id` (fresh publish) or the envelope row (the
      // adapter's `readCommittedPublication` path on a recovering replay).
      const taskId = result.publication.task.id ?? envelopeTaskId ?? undefined;
      if (result.recovering) {
        return {
          statusCode: 202,
          body: {
            outcome: "created",
            attemptId: result.attemptId,
            taskId,
            recovering: true,
            ...(result.recoveringState ? { recoveringState: result.recoveringState } : {}),
          },
        };
      }
      // Terminal `created` should not normally appear here (the dispatcher /
      // coordinator advance the attempt off `published_pending_*` and a same-
      // key retry surfaces via the `replayed` branch). Defensive fallback —
      // treat as 201 to never throw committed success as failure.
      return {
        statusCode: 201,
        body: { outcome: "created", attemptId: result.attemptId, taskId },
      };
    }
    case "replayed": {
      // The client is retrying under the same key with the same payload — the
      // attempt settled; return its stored terminal outcome verbatim. 200 is
      // the right code for an idempotent retrieval (NOT 201 — the side effect
      // already ran on the first call). The `outcome` field is set to
      // `"replayed"` so the caller can distinguish an idempotent retry from
      // a fresh publish; the rest of the terminal fields (taskId, errors,
      // veto, etc.) arrive verbatim so the caller can render the stored
      // outcome without a follow-up GET.
      //
      // M4-2 backfill: when the stored terminal carries a `taskId`, forward
      // it verbatim (the success terminalization stamps it post-Fix-P2 —
      // coordinator `assigned` + adapter terminal `created`). When the
      // terminal does NOT carry it (older terminals, or terminals whose
      // outcome is not task-bearing), fall back to the envelope row's
      // `taskId` so the response-loss → link-to-Task contract still holds.
      const {
        outcome: _terminalOutcome,
        taskId: terminalTaskId,
        ...terminalRest
      } = result.terminal;
      void _terminalOutcome;
      const taskId = terminalTaskId ?? envelopeTaskId ?? undefined;
      return {
        statusCode: 200,
        body: {
          outcome: "replayed",
          attemptId: result.attemptId,
          ...(taskId !== undefined ? { taskId } : {}),
          ...terminalRest,
        },
      };
    }
    case "rejected_validation": {
      return {
        statusCode: 422,
        body: {
          outcome: "rejected_validation",
          attemptId: result.attemptId,
          errors: result.errors,
        },
      };
    }
    case "vetoed": {
      return {
        statusCode: 403,
        body: {
          outcome: "vetoed",
          attemptId: result.attemptId,
          veto: result.veto,
        },
      };
    }
    case "rejected_fingerprint": {
      return {
        statusCode: 409,
        body: {
          outcome: "rejected_fingerprint",
          attemptId: result.attemptId,
          message: "corrected payload requires a new attempt key",
        },
      };
    }
    case "guard_mismatch": {
      return {
        statusCode: 503,
        body: {
          outcome: "guard_mismatch",
          attemptId: result.attemptId,
          reasons: result.reasons,
        },
      };
    }
    case "governance_denied": {
      return {
        statusCode: 503,
        body: {
          outcome: "governance_denied",
          attemptId: result.attemptId,
          kind: result.kind,
          reason: result.reason,
          ...(result.interceptorKey ? { interceptorKey: result.interceptorKey } : {}),
        },
      };
    }
  }
}
