/**
 * Task-Creation Publication API client (T11 Phase 2 — UI side).
 *
 * Consumes the dormant publication routes registered in
 * `packages/api/src/routes/taskPublication.ts` +
 * `packages/api/src/routes/taskClonePublication.ts`:
 *
 *   POST /missions/:missionId/task-publications       (gated)
 *   POST /tasks/:sourceTaskId/clone-publications      (gated inside the plugin)
 *   GET  /tasks/:sourceTaskId/clone-preparation       (always-on read-only prep)
 *   GET  /task-creation-attempts/:attemptId            (always-on recovery surface)
 *
 * The cutover flag (`ORCY_CREATION_PUBLICATION_ENABLED`) is process-restart-
 * scoped — the UI cannot query it. The flag-detection strategy at the UI
 * boundary is HTTP-404 detection:
 *   - The mutation routes are REGISTERED ONLY when the flag is on (the outer
 *     gate in `packages/api/src/index.ts:246-247`); an off flag means the
 *     route does not exist and the request 404s.
 *   - On a 404 the UI falls back to the legacy endpoints
 *     (`POST /missions/:id/tasks`, `POST /tasks/:id/clone`). The legacy
 *     methods stay byte-unchanged in `packages/ui/src/api/domains/{missions,
 *     tasks}.ts`.
 *
 * The non-404 outcomes (200/201/202/422/409/503) carry a closed-union body
 * dispatched on `outcome`. The view-model types live in
 * `packages/ui/src/types/index.ts` per MEMORY.md "view-model types live in
 * packages/ui/src/types/index.ts".
 *
 * See: T6 ticket § "What this route does" + T7 ticket § "What these routes
 * do" + the shared HTTP mapper at
 * `packages/api/src/routes/helpers/taskPublicationHttp.ts`.
 */
import { request } from "../transport.js";
import type {
  ClonePreparationView,
  TaskCreationAttemptView,
  TaskPublicationOutcomeView,
} from "../../types/index.js";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Work-definition fields shared by create + clone publication bodies.
 *  Mirrors the subset of `taskPublicationSchema` / `clonePublicationSchema`
 *  in `packages/api/src/models/schemas.ts` that the UI needs to send. */
interface PublicationWorkDefinition {
  title: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "critical";
  requiredDomain?: string | null;
  requiredCapabilities?: string[];
  estimatedMinutes?: number | null;
  labels?: string[];
}

/** Assignment intent — mirrors `taskPublicationAssignmentSchema`
 *  (`{kind:"auto"}` | `{kind:"targeted", agentId:string}`). */
export type PublicationAssignmentInput =
  | { kind: "auto" }
  | { kind: "targeted"; agentId: string };

/** Body for `POST /missions/:missionId/task-publications`. */
export interface PublishTaskInput extends PublicationWorkDefinition {
  /** Client-supplied attempt identity — generated on first Publish press,
   *  retained across unchanged Publishes for idempotent retry. */
  attemptKey: string;
  /** Directional dependency edges the new Task depends on (Task ids). */
  dependsOn?: string[];
  /** Assignment intent + targeted-assignment reservation deadline. */
  assignment?: PublicationAssignmentInput;
  targetedAssignmentDeadline?: string;
}

/** Body for `POST /tasks/:sourceTaskId/clone-publications`. The target
 *  Mission is REQUIRED here (unlike the create route, which derives it from
 *  the path). The user may choose another active Mission in the same
 *  Habitat — the source's Mission is the default. */
export interface PublishCloneInput extends PublicationWorkDefinition {
  attemptKey: string;
  targetMissionId: string;
  /** EDITED subtasks (added/removed/reordered/title-edited from the RESET
   *  list returned by `GET .../clone-preparation`). */
  subtasks?: Array<{ title: string; order?: number; assigneeId?: string | null }>;
  /** User-selected dependencies from the UNSELECTED suggestions surfaced by
   *  `GET .../clone-preparation`. The kernel revalidates at publication. */
  selectedDependencies?: string[];
  assignment?: PublicationAssignmentInput;
  targetedAssignmentDeadline?: string;
}

// ---------------------------------------------------------------------------
// Parsed dispatch union (response-shape inspection)
// ---------------------------------------------------------------------------

/** Convenience: parse a raw response body into a typed dispatch union the
 *  Create / Clone dialogs render directly. Same shape as the import dialog's
 *  {@link ParsedImportResponse} — a discriminated union of `v3`-style typed
 *  outcome + generic error envelope (legacy fallback is NOT a branch here
 *  because the legacy endpoints live at DIFFERENT URLs and the UI never
 *  receives a legacy body on these routes; the 404 fallback is dispatched at
 *  the caller, NOT inside this parser). */
export type ParsedTaskPublicationResponse =
  | { kind: "outcome"; outcome: TaskPublicationOutcomeView }
  | { kind: "error"; status: number; body: { error?: string; code?: string; details?: unknown } };

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

/** All known `outcome` values the shared HTTP mapper emits. The list mirrors
 *  the `case` arms in
 *  `packages/api/src/routes/helpers/taskPublicationHttp.ts:publicationResultToHttpResponse`. */
const KNOWN_OUTCOMES = [
  "created",
  "replayed",
  "rejected_validation",
  "vetoed",
  "rejected_fingerprint",
  "guard_mismatch",
  "governance_denied",
] as const;

/** Type guard: response is a v3 publication outcome. The closed union
 *  carries every branch the kernel can emit. */
export function isTaskPublicationOutcomeView(body: unknown): body is TaskPublicationOutcomeView {
  if (typeof body !== "object" || body === null) return false;
  const outcome = (body as { outcome?: unknown }).outcome;
  return typeof outcome === "string" && (KNOWN_OUTCOMES as readonly string[]).includes(outcome);
}

/** Parse a raw response body into a typed dispatch union. Use this at the
 *  caller (after a 2xx response) to narrow into the typed outcome. */
export function parsePublishTaskResponse(
  status: number,
  body: unknown,
): ParsedTaskPublicationResponse {
  if (isTaskPublicationOutcomeView(body)) {
    return { kind: "outcome", outcome: body };
  }
  return {
    kind: "error",
    status,
    body:
      typeof body === "object" && body !== null
        ? (body as { error?: string; code?: string; details?: unknown })
        : {},
  };
}

/** Recover a typed {@link ParsedTaskPublicationResponse} from a thrown error.
 *
 *  The transport's `request()` helper throws `ApiError` on any non-2xx
 *  response — but the publication routes intentionally return 422
 *  (rejected_validation) + 409 (vetoed, rejected_fingerprint) + 503
 *  (guard_mismatch, governance_denied) WITH the closed-union body intact.
 *  Without this recovery, the dialog would render a generic error for every
 *  domain-value branch.
 *
 *  The transport preserves the parsed body as `ApiError.body` (an ADDITIVE
 *  field added in T10C M4 — same contract used by the import dialog's
 *  `parseImportApiError`); this helper extracts it + dispatches through
 *  `parsePublishTaskResponse`.
 *
 *  Returns `null` when the error is not an `ApiError` with a structured body
 *  — callers fall back to the generic error path. */
export function parseTaskPublicationsApiError(
  error: unknown,
): ParsedTaskPublicationResponse | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("status" in error) ||
    typeof (error as { status?: unknown }).status !== "number" ||
    !("body" in error)
  ) {
    return null;
  }
  const status = (error as { status: number }).status;
  const body = (error as { body?: unknown }).body;
  if (body === undefined) return null;
  return parsePublishTaskResponse(status, body);
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

export const taskPublicationsApi = {
  /**
   * Publish a new Task through the kernel:
   *   `POST /missions/:missionId/task-publications`.
   *
   * Returns the RAW response body. The caller inspects the shape (or uses
   * {@link parsePublishTaskResponse} / {@link parseTaskPublicationsApiError}
   * to narrow into the typed {@link TaskPublicationOutcomeView}).
   *
   * The cutover flag is HTTP-404 detected: an off flag means the route is
   * NOT registered (the outer gate in
   * `packages/api/src/index.ts:246-247`) and the request 404s. Callers fall
   * back to the legacy `POST /missions/:id/tasks` on 404.
   */
  publishTask: (missionId: string, input: PublishTaskInput): Promise<unknown> =>
    request<unknown>(
      `/missions/${encodeURIComponent(missionId)}/task-publications`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),

  /**
   * Publish a clone through the kernel:
   *   `POST /tasks/:sourceTaskId/clone-publications`.
   *
   * The POST is gated INSIDE the route plugin
   * (`packages/api/src/routes/taskClonePublication.ts:164`) — when the
   * cutover flag is off the route 404s even though the plugin is registered
   * (the GET preparation is always available). Callers fall back to the
   * legacy `POST /tasks/:id/clone` on 404.
   *
   * The body carries the EDITED work-definition (NOT a re-copy of the
   * source) — the server uses `sourceTaskId` for provenance + same-Habitat
   * enforcement and trusts the body for the final task content.
   */
  publishClone: (sourceTaskId: string, input: PublishCloneInput): Promise<unknown> =>
    request<unknown>(
      `/tasks/${encodeURIComponent(sourceTaskId)}/clone-publications`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),

  /**
   * Read-only clone preparation:
   *   `GET /tasks/:sourceTaskId/clone-preparation`.
   *
   * NOT gated behind the cutover flag — the GET is always available so the
   * prep dialog can open regardless of the flag state. The mutation
   * 404-detection happens at publish time (see {@link publishClone}).
   *
   * The DTO is the allowlisted read-only {@link ClonePreparationView} —
   * ZERO writes (no attempt, no Task, no event — opening the clone form
   * creates nothing).
   */
  getClonePreparation: (sourceTaskId: string, signal?: AbortSignal): Promise<ClonePreparationView> =>
    request<ClonePreparationView>(
      `/tasks/${encodeURIComponent(sourceTaskId)}/clone-preparation`,
      signal ? { signal } : {},
    ),

  /**
   * Poll a task-creation attempt's recovery state:
   *   `GET /task-creation-attempts/:attemptId`.
   *
   * Used after a 202 + `recovering:true` publish response to resolve the
   * committed Task id + terminal outcome. The attempt is non-terminal while
   * `state` is `pending` / `published_pending_observation` /
   * `published_pending_assignment`; the UI should keep polling until
   * `state` enters a terminal (`created` / `created_unassigned` /
   * `rejected_validation` / `vetoed` / `batch_rejected`).
   *
   * Habitat-scoped authorization is enforced at the route — a 404 from this
   * endpoint means the attempt id is unknown OR the caller lacks access
   * (the route refuses cross-habitat leaks as 404).
   */
  getTaskCreationAttempt: (attemptId: string, signal?: AbortSignal): Promise<TaskCreationAttemptView> =>
    request<TaskCreationAttemptView>(
      `/task-creation-attempts/${encodeURIComponent(attemptId)}`,
      signal ? { signal } : {},
    ),
};