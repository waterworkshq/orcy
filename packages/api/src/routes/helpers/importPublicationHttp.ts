/**
 * Shared HTTP mapper for the v3 Habitat-Import publication routes (T10C M3).
 *
 * Mirrors `routes/helpers/taskPublicationHttp.ts` (the T6/T7 publication
 * mapper): a THIN TRANSPORT that derives an HTTP status + body shape from
 * the closed outcome unions produced by the import-manifest kernel
 * ({@link PrepareImportOutcome} + {@link PublishImportOutcome}). The route
 * remains the orchestrator — it builds {@link PrepareImportInput}, calls
 * {@link prepareImport} → {@link publishImportAggregateWithClient}, then
 * forwards the result here.
 *
 * # Contract
 *
 * - The mapper ONLY derives HTTP shape. It never re-interprets a kernel
 *   decision; the body carries the outcome union's verbatim payload.
 * - Body shape follows the established codebase convention
 *   (`taskPublicationHttp.ts` + `scheduledOccurrenceRepair.ts`):
 *   `{ outcome: "<branch>", ...branch-specific fields }`.
 * - A committed-recovering import is NEVER mapped to 500 (mirrors the T6/T7
 *   contract — never throw committed success as failure). Resumable
 *   outcomes (`already_publishing`, `guard_mismatch`) surface their typed
 *   status so the M4 UI can poll / retry intelligently.
 *
 * # Status code semantics (T10C M3 contract — the M4 UI consumes this table)
 *
 *   prepareImport:
 *     `prepared`                       → caller proceeds to publish (NOT mapped here).
 *     `rejected_preflight`             → 422 (complete validation/governance/
 *                                          reference failure surface — EVERY
 *                                          accumulated error in `errors`).
 *     `already_exists`                 → 200 (caller decides: replay, poll,
 *                                          or surface conflict — the existing
 *                                          attempt is terminal or in flight).
 *     `feature_disabled`               → 501 (defensive — flag-off requests
 *                                          never reach this branch; the route
 *                                          routes them to the legacy path).
 *
 *   publishImportAggregateWithClient:
 *     `published`                      → 201 (the full aggregate committed).
 *     `already_publishing`             → 202 (committed but a concurrent worker
 *                                          holds the lease; the UI polls the
 *                                          attempt).
 *     `guard_mismatch`                 → 409 (resumable — the habitat's
 *                                          `updatedAt` drifted mid-publish;
 *                                          the tx rolled back, the attempt
 *                                          stays `publishing`).
 *     `vetoed`                         → 422 (terminal governance refusal —
 *                                          NOTHING committed; ALL decisive
 *                                          vetoes carried).
 *     `illegal_source_state`           → 409 (terminal-state refusal — the
 *                                          import attempt is `published` or
 *                                          `rejected`).
 *     `not_found`                      → 404 (the import-attempt row vanished —
 *                                          a data anomaly).
 *     `replayed`                       → 200 (idempotent retry under the same
 *                                          key — the stored terminal outcome
 *                                          surfaces verbatim).
 *
 * @see packages/api/src/services/importManifest/preflightImport.ts for the
 *      {@link PrepareImportOutcome} closed union.
 * @see packages/api/src/services/importManifest/importPublication.ts for the
 *      {@link PublishImportOutcome} closed union.
 * @see packages/api/src/routes/helpers/taskPublicationHttp.ts for the
 *      transport-only mapper discipline this mirrors.
 */
import type { PrepareImportOutcome } from "../../services/importManifest/preflightImport.js";
import type { PublishImportOutcome } from "../../services/importManifest/importPublication.js";

/**
 * Maps a non-`prepared` {@link PrepareImportOutcome} branch to an HTTP
 * response shape. The `prepared` branch is NOT mapped here — the caller
 * proceeds to {@link publishImportAggregateWithClient} and maps THAT result
 * via {@link publishImportOutcomeToHttpResponse}.
 *
 * Returns `{ statusCode, body }`. The caller does `reply.code(statusCode).send(body)`.
 */
export function prepareImportOutcomeToHttpResponse(
  result: Exclude<PrepareImportOutcome, { outcome: "prepared" }>,
): { statusCode: number; body: Record<string, unknown> } {
  switch (result.outcome) {
    case "rejected_preflight": {
      // The complete validation/governance/reference failure surface. The
      // kernel accumulates EVERY independently-discoverable failure into
      // `errors` (no first-error short-circuit — the plan's directive).
      // Forward verbatim so the M4 UI can render per-domain error detail.
      //
      // NOTE: the kernel's `PublicationError` shape is `{field, code,
      // message}` (see `preflightImport.ts:domainErrorToPublicationError`).
      // The `domain` is folded into `field` (via `fieldPath.join(".")` when
      // the handler produced a path, else the domain name itself). The M4 UI
      // parses `field` for the leading domain segment.
      return {
        statusCode: 422,
        body: {
          outcome: "rejected_preflight",
          importAttemptId: result.importAttemptId,
          errors: result.errors,
        },
      };
    }
    case "already_exists": {
      // The caller decides: replay (re-submit), poll the existing attempt,
      // or surface the conflict. 200 is the right code for an idempotent
      // retrieval (the prior reservation is the same key the caller just
      // supplied — NOT a new side effect).
      return {
        statusCode: 200,
        body: {
          outcome: "already_exists",
          attempt: result.attempt,
        },
      };
    }
    case "feature_disabled": {
      // Defensive — the route's flag gate routes flag-off requests to the
      // legacy path, so this branch is unreachable from the REST surface
      // under normal operation. 501 surfaces it as "the new pipeline is not
      // active here" rather than a 500.
      return {
        statusCode: 501,
        body: { outcome: "feature_disabled" },
      };
    }
  }
}

/**
 * Maps a {@link PublishImportOutcome} to an HTTP response shape. Returns
 * `{ statusCode, body }`. The caller does `reply.code(statusCode).send(body)`.
 */
export function publishImportOutcomeToHttpResponse(result: PublishImportOutcome): {
  statusCode: number;
  body: Record<string, unknown>;
} {
  switch (result.outcome) {
    case "published": {
      // The full Habitat aggregate committed atomically. The body carries
      // the import-attempt row + the new (or persisted) habitat id + the
      // per-domain committed counts.
      return {
        statusCode: 201,
        body: {
          outcome: "published",
          importAttempt: result.importAttempt,
          habitatId: result.habitatId,
          importedCounts: result.importedCounts,
        },
      };
    }
    case "already_publishing": {
      // Committed but a concurrent worker holds the lease. The UI polls
      // the import-attempt state (a future M4 endpoint; the polling surface
      // itself is out-of-scope for M3).
      return {
        statusCode: 202,
        body: {
          outcome: "already_publishing",
          importAttempt: result.importAttempt,
          status: "publishing",
        },
      };
    }
    case "guard_mismatch": {
      // RESUMABLE — the habitat's `updatedAt` drifted between preflight +
      // tx. The aggregate rolled back; the import attempt stays
      // `publishing` for a future recovery worker (or the caller's retry).
      // `fields` is currently `["targetHabitatUpdatedAt"]`.
      return {
        statusCode: 409,
        body: {
          outcome: "guard_mismatch",
          importAttempt: result.importAttempt,
          fields: result.fields,
        },
      };
    }
    case "vetoed": {
      // Terminal governance refusal — NOTHING committed. The import
      // attempt terminalized as `rejected`. EVERY decisive Task-level
      // veto is carried (T9A-04 all-decisive-vetoes discipline).
      return {
        statusCode: 422,
        body: {
          outcome: "vetoed",
          importAttempt: result.importAttempt,
          vetoes: result.vetoes,
        },
      };
    }
    case "illegal_source_state": {
      // The import attempt is in a terminal state (`published` or
      // `rejected`); the CAS refused the `publishing` transition.
      return {
        statusCode: 409,
        body: {
          outcome: "illegal_source_state",
          importAttempt: result.importAttempt,
          fromState: result.fromState,
        },
      };
    }
    case "not_found": {
      // The import-attempt row vanished — a data anomaly (preflight
      // always reserves one before returning `prepared`). Empty body per
      // the grounding contract.
      return {
        statusCode: 404,
        body: { outcome: "not_found" },
      };
    }
    case "replayed": {
      // Idempotent retry under the same key. The stored terminal outcome
      // surfaces verbatim (the prior publication's resolution). 200 — the
      // side effect already ran on the first call.
      return {
        statusCode: 200,
        body: {
          outcome: "replayed",
          importAttempt: result.importAttempt,
          terminal: result.terminal,
        },
      };
    }
  }
}
