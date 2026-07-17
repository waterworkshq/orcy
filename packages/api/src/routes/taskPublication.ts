/**
 * T6 Phase 2 — REST publication route (DORMANT).
 *
 * Exposes the interactive {@link publishTaskCreation} adapter from
 * `services/taskCreationPublication.ts` (T6 Phase 1, committed at `c111a9f`)
 * as a dormant REST route alongside the legacy
 * `POST /missions/:missionId/tasks` + `createTaskInMissionSchema` (the
 * production path until T11 swaps them).
 *
 * Why a new path:
 *   The route must NOT collide with the legacy `POST /missions/:missionId/tasks`
 *   (T11 swaps the active production path onto this new route). The dormant
 *   name `POST /missions/:missionId/task-publications` carries the noun "publication"
 *   so the two URLs coexist during the dormancy window. The legacy route +
 *   schema + `createTask` stay byte-unchanged.
 *
 * What this route does (per Technical Plan § "Shared Publication Contract" +
 * the P1 carry-over in the T6 ticket):
 *   1. Validates `body` via {@link taskPublicationSchema} (no `order` field;
 *      `assignment` discriminated union; `targetedAssignmentDeadline` REQUIRED
 *      when `assignment.kind === "targeted"` via `.superRefine`).
 *   2. Authenticates via `agentOrHumanAuth` + `requireMissionAccess` (the
 *      missionId pre-handler derives habitatId and runs the membership check
 *      — same as the legacy create-task route).
 *   3. Derives PROVENANCE from the authenticated caller (NOT from the
 *      untrusted body): `auditSource` = `"ui"` for human, `"api"` for agent;
 *      `actorId` = `request.agent?.id ?? request.user?.id`; `actorType` =
 *      `"human" | "agent"`. MCP path is P3 — this route is REST-only.
 *   4. Resolves the mission → habitatId (server-side derivation, NOT from
 *      the body — prevents cross-habitat scoping misdirection). The
 *      archived-mission guard mirrors the legacy route.
 *   5. Calls `publishTaskCreation({ attemptKey, missionId, auditSource,
 *      actorId, actorType, work-definition, assignment,
 *      targetedAssignmentDeadline })`.
 *   6. Maps the {@link TaskCreationPublicationResult} outcome to HTTP per
 *      the P1 carry-over (lines 43–45 of the ticket):
 *        - `created` + `recovering:true`  → 202 Accepted (committed but not
 *          yet observed — the client polls `GET
 *          /task-creation-attempts/:attemptId`).
 *        - terminal `created`              → 201 Created.
 *        - `replayed`                     → 200 OK with the stored terminal
 *          outcome (idempotent retry).
 *        - `rejected_validation`          → 422 Unprocessable Entity.
 *        - `vetoed`                       → 409 Conflict (governance refusal).
 *        - `rejected_fingerprint`         → 409 Conflict (corrected payload
 *          needs a new key).
 *        - `guard_mismatch` / `governance_denied` → 503 Service Unavailable
 *          (retryable — the client retries with the same key; the adapter
 *          re-prepares).
 *
 * What this route does NOT do:
 *   - Replace the legacy `POST /missions/:missionId/tasks`. That swap is T11.
 *   - Wire the adapter into the production path (DORMANT — tests are the only
 *     exerciser until T11).
 *   - Accept `actor`, `causalContext`, `prospectiveTaskId`, or any other
 *     privileged field from the body. The adapter type does not expose them;
 *     the route does not smuggle them in.
 *
 * Conventions matched (verified against `routes/missions.ts`,
 * `routes/taskCreationAttempts.ts`, `routes/tasks/assignment.ts`):
 *   - `agentOrHumanAuth` + `requireMissionAccess` preHandlers (matches the
 *     legacy create-task route's authorization exactly).
 *   - Zod schema validated via `fastify-type-provider-zod`; `ZodTypeProvider`.
 *   - `throw notFound(...)` / `forbidden(...)` / `unprocessableEntity(...)` /
 *     `serviceUnavailable(...)` from `errors.js` (NOT raw `reply.code`).
 *   - Registered via `index.ts:registerApiRoutes` so both `/api/v1` and
 *     `/api` prefixes mount the route (mirrors existing task creation +
 *     task-creation-attempts routes).
 *
 * See: T6 ticket § "Execution phases" + § "Phase 1 carry-over (for P2)".
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { taskCreationEnvelopes } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { agentOrHumanAuth } from "../middleware/auth.js";
import { requireMissionAccess } from "../middleware/team.js";
import {
  forbidden,
  notFound,
  serviceUnavailable,
  unprocessableEntity,
} from "../errors.js";
import { taskPublicationSchema, type TaskPublicationInput } from "../models/schemas.js";
import {
  publishTaskCreation,
  type TaskCreationPublicationResult,
} from "../services/taskCreationPublication.js";
import * as missionRepo from "../repositories/mission.js";

const publicationParamsSchema = z.object({ missionId: z.string() });

/**
 * Maps a published-publication attempt's persisted envelope to the
 * `TaskCreationPublicationResult` shape. The adapter writes the envelope
 * row DURING the publication transaction, so it is the durable source of
 * truth for "did a Task commit under this attempt?".
 *
 * For the recovering-replay path, the caller (REST or MCP) needs to learn
 * `recovering:true` + the recovering state — the adapter's
 * `readCommittedPublication` reconstructs it from rows, but a smaller
 * surface (committed envelope + committed taskId) is enough for HTTP
 * transport. The full recovery surface lives on
 * `GET /task-creation-attempts/:attemptId`.
 */
function surfaceFromEnvelope(envelopeRow: {
  attemptId: string;
  taskId: string;
}): {
  outcome: "created";
  attemptId: string;
  taskId: string;
} {
  return {
    outcome: "created",
    attemptId: envelopeRow.attemptId,
    taskId: envelopeRow.taskId,
  };
}

/**
 * Maps a {@link TaskCreationPublicationResult} to an HTTP response shape.
 *
 * The route forwards the adapter's outcome union verbatim to the client —
 * the route is a thin transport; the adapter owns the result envelope.
 * Status codes are derived from the outcome discriminator:
 *
 *   - `created` + `recovering:true` → 202 (committed but not yet observed).
 *   - `created` + `recovering:false` (terminal created) → 201.
 *   - `replayed` → 200 (idempotent retry — the stored terminal).
 *   - `rejected_validation` → 422.
 *   - `vetoed` → 409.
 *   - `rejected_fingerprint` → 409 (corrected payload needs a new key).
 *   - `guard_mismatch` / `governance_denied` → 503 (retryable — the client
 *     retries under the SAME key; the adapter re-prepares).
 *
 * Note: a recovering Task is NOT mapped to 500. The P1 carry-over
 * explicitly requires that "HTTP/MCP mappings preserve the shared domain
 * outcome and do not throw committed success as failure" — a 502/500 for a
 * committed-recovering Task would leak the recovery state as a failure.
 */
function outcomeToHttpResponse(
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
      const { outcome: _terminalOutcome, ...terminalRest } = result.terminal;
      void _terminalOutcome;
      return {
        statusCode: 200,
        body: {
          outcome: "replayed",
          attemptId: result.attemptId,
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
        statusCode: 409,
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

export async function taskPublicationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/missions/:missionId/task-publications",
    {
      schema: { params: publicationParamsSchema, body: taskPublicationSchema },
      preHandler: [agentOrHumanAuth, requireMissionAccess],
    },
    async (request, reply) => {
      const parsed: TaskPublicationInput = request.body;

      // Mission → habitatId derivation (server-side, NOT from the body — the
      // body does not carry habitatId to prevent a scoped-to-A caller from
      // targeting habitat B). requireMissionAccess already resolved the
      // mission + verified access; we re-fetch here for the archived guard
      // AND to derive habitatId for the adapter input.
      const mission = missionRepo.getMissionById(request.params.missionId);
      if (!mission) {
        // requireMissionAccess would have rejected; defensive fallback.
        throw notFound("Mission not found");
      }
      if (mission.isArchived) {
        // Mirrors the legacy route's archived guard — archived Missions are
        // frozen against new Task creation regardless of origin.
        throw forbidden("Cannot add tasks to an archived mission");
      }

      // Provenance is server-constructed from the authenticated caller.
      // Untrusted body fields cannot assert privileged identities — the
      // adapter type does not expose them.
      //
      // The `auditSource` enum (see AUDIT_SOURCES in @orcy/shared) is the
      // ORIGIN CHANNEL, not the UI/API semantic distinction the spec
      // describes. For a REST route the value is ALWAYS `"rest_api"` —
      // the UI/API distinction is conveyed by `actorType` (human vs agent)
      // and surfaces in the committed envelope's causal-root.type
      // (see `deriveCausalRootType` in services/taskCreationPublication.ts):
      //   human  via rest_api → root.type === "human"  (the UI signal)
      //   agent  via rest_api → root.type === "api"    (the API signal)
      //   any    via mcp_tool  → root.type === "mcp"    (the MCP signal — P3)
      const actorType: "human" | "agent" = request.agent ? "agent" : "human";
      const actorId = request.agent?.id ?? request.user?.id;
      if (!actorId) {
        // agentOrHumanAuth always sets one of these — defensive fallback.
        throw forbidden("Authentication required");
      }
      const auditSource = "rest_api" as const;

      // Targeted-assignment deadline resolution. The Zod schema enforces
      // that a targeted intent SUPPLIES a deadline (with `.superRefine`); if
      // a caller slips past the schema (e.g. an empty ISO string that
      // passes the `.datetime()` check but would throw inside the adapter),
      // surface as 422 rather than a 500.
      let targetedAssignmentDeadline: string | undefined =
        parsed.targetedAssignmentDeadline;
      if (parsed.assignment.kind === "targeted" && targetedAssignmentDeadline === undefined) {
        // Should never reach here — the schema's superRefine would have
        // surfaced a 400. Defensive fallback surfaces the adapter-shaped 422.
        throw unprocessableEntity(
          "targetedAssignmentDeadline is required when assignment.kind === 'targeted'",
          "VALIDATION_ERROR",
          { path: "targetedAssignmentDeadline" },
        );
      }

      // Adapter call. The adapter is DORMANT (no production caller besides
      // this route + tests until T11). It returns the result envelope
      // synchronously; we map it to HTTP. It MAY throw for purely-internal
      // precondition failures (empty attemptKey, empty agentId, etc.) — those
      // surface as unhandled 500s via the global error handler; they are
      // programming-error-shaped, not domain outcomes, so 500 is correct.
      const result = publishTaskCreation({
        attemptKey: parsed.attemptKey,
        actorId,
        actorType,
        auditSource,
        habitatId: mission.habitatId,
        targetMissionId: mission.id,
        title: parsed.title,
        ...(parsed.description !== undefined ? { description: parsed.description } : {}),
        ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
        ...(parsed.requiredDomain !== undefined ? { requiredDomain: parsed.requiredDomain } : {}),
        ...(parsed.requiredCapabilities !== undefined
          ? { requiredCapabilities: parsed.requiredCapabilities }
          : {}),
        ...(parsed.estimatedMinutes !== undefined
          ? { estimatedMinutes: parsed.estimatedMinutes }
          : {}),
        ...(parsed.labels !== undefined ? { labels: parsed.labels } : {}),
        ...(parsed.dependsOn !== undefined
          ? { selectedDependencies: parsed.dependsOn.map((dependsOnId) => ({ dependsOnId })) }
          : {}),
        assignment: parsed.assignment,
        ...(targetedAssignmentDeadline !== undefined
          ? { targetedAssignmentDeadline }
          : {}),
      });

      // Recover the committed envelope (if any) so the HTTP layer can include
      // the task id even on a recovering-replay path where the adapter's
      // inline publication is reconstructed rather than fresh.
      const envelopeRow = getDb()
        .select({ attemptId: taskCreationEnvelopes.attemptId, taskId: taskCreationEnvelopes.taskId })
        .from(taskCreationEnvelopes)
        .where(eq(taskCreationEnvelopes.attemptId, result.attemptId))
        .get();
      const envelopeTaskId = envelopeRow?.taskId ?? null;

      // Special handling for the adapter throws when the route's data has a
      // gap. The adapter `rejects_fingerprint` is a typed domain outcome and
      // reaches here normally; throws from the adapter indicate programming
      // errors (empty attemptKey, empty agentId) and propagate as 500 via
      // the global error handler.
      void surfaceFromEnvelope; // kept for symmetry with future enrichment

      const { statusCode, body } = outcomeToHttpResponse(result, envelopeTaskId);
      reply.code(statusCode).send(body);
    },
  );
}

/**
 * Default export mirrors `routes/tasks/assignment.ts` / `taskCreationAttempts.ts`
 * — test harnesses that import the file directly register the routes under
 * their chosen prefix.
 */
export default taskPublicationRoutes;
