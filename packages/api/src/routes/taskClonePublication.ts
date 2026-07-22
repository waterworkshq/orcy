/**
 * REST clone publication routes.
 *
 * Exposes {@link prepareClonePublication} (read-only allowlisted DTO) and the
 * extended {@link publishTaskCreation} adapter (accepting `cloneSourceTaskId`).
 *
 * Why new paths:
 *   - The GET (`/tasks/:sourceTaskId/clone-preparation`) is a NEW verb for
 *     clone — the legacy route is write-only and does not surface a
 *     preparation DTO. The new URL carries the noun "preparation" so the
 *     two coexist during the dormancy window.
 *   - The POST (`/tasks/:sourceTaskId/clone-publications`) mirrors T6's
 *     POST (`/missions/:missionId/task-publications`) but the path param
 *     is the SOURCE Task id (not the target Mission) because the clone
 *     journey starts from a source. The target Mission is in the body
 *     (`targetMissionId`) — the user may choose an active Mission in the
 *     same Habitat.
 *
 * What these routes do (per the P1 carry-over in the T7 ticket + the Core
 * Flows § "Editable Clone Preparation and Publication"):
 *
 *   (a) `GET /tasks/:sourceTaskId/clone-preparation`
 *     1. Authenticate via `agentOrHumanAuth`.
 *     2. Call {@link prepareClonePublication} (PURE/READ-ONLY) — resolves
 *        the source's Habitat server-side.
 *     3. Authorize against the source's Habitat (cross-habitat → 403; no
 *        leak of the existence of cross-habitat Tasks).
 *     4. Return the allowlisted DTO verbatim. ZERO writes (no attempt,
 *        no Task, no event — opening the clone form creates nothing).
 *
 *   (b) `POST /tasks/:sourceTaskId/clone-publications`
 *     1. Validate the body via {@link clonePublicationSchema} — the
 *        EDITED work-definition + edited Subtasks + selectedDependencies +
 *        targetMissionId + assignment intent + targeted deadline.
 *        **NO `includeSubtasks`/`includeComments`/`order` in the body** —
 *        the legacy options are retired (T7 P2).
 *     2. Authenticate via `agentOrHumanAuth`. The target mission access
 *        check happens INSIDE the handler because `requireMissionAccess`
 *        reads `request.params.missionId` (the path carries `:sourceTaskId`,
 *        not the target Mission). The source habitat access is also checked
 *        (the kernel enforces same-Habitat via `cross_habitat_mission`).
 *     3. Derive PROVENANCE from the authenticated caller: `auditSource` =
 *        `"rest_api"` (the route's server-constructed value, same as T6 P2
 *        — the UI/API/MCP distinction is conveyed by `actorType` + the
 *        causal-root type, NOT the auditSource enum).
 *     4. Call `publishTaskCreation({ attemptKey, cloneSourceTaskId:
 *        sourceTaskId, targetMissionId, auditSource, actorId, actorType,
 *        ...edited work-definition, subtasks, selectedDependencies,
 *        assignment, targetedAssignmentDeadline })`. The adapter resolves
 *        the source's Habitat authoritatively (overriding `habitatId`) so
 *        the kernel's `cross_habitat_mission` check structurally enforces
 *        same-Habitat on the target Mission.
 *     5. Map the {@link TaskCreationPublicationResult} outcome to HTTP
 *        via {@link outcomeToHttpResponse} (DUPLICATED from T6 P2 — the
 *        function is small, the T6 route is committed, and extracting to a
 *        shared helper would require editing the committed T6 route, which
 *        is forbidden until T11).
 *
 * What these routes do NOT do:
 *   - Accept `includeSubtasks`/`includeComments`/`order` from the body
 *     (the Zod schema does not declare them; Zod strips unknown keys by
 *     default, so the contract is structural, not just documented).
 *
 * Conventions matched (verified against `routes/taskPublication.ts` +
 * `routes/tasks/assignment.ts` + `routes/taskCreationAttempts.ts`):
 *   - `agentOrHumanAuth` preHandler (matches the read attempts route +
 *     the publication route family).
 *   - Zod schema validated via `fastify-type-provider-zod`; `ZodTypeProvider`.
 *   - `throw notFound(...)` / `forbidden(...)` / `unprocessableEntity(...)`
 *     / `serviceUnavailable(...)` from `errors.js` (NOT raw `reply.code`).
 *   - Registered via `index.ts:registerApiRoutes` so both `/api/v1` and
 *     `/api` prefixes mount the route (mirrors T6 P2 + the legacy create-
 *     task + task-creation-attempts routes).
 *
 * See: T7 ticket § "Execution phases" + § "Phase 1 carry-over (for P2)".
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { taskCreationEnvelopes } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { agentOrHumanAuth } from "../middleware/auth.js";
import { checkHabitatAccess } from "../middleware/realtimeAuth.js";
import { forbidden, notFound, unprocessableEntity } from "../errors.js";
import { clonePublicationSchema, type ClonePublicationInput } from "../models/schemas.js";
import { publishTaskCreation } from "../services/taskCreationPublication.js";
import { prepareClonePublication } from "../services/taskClonePreparation.js";
import * as missionRepo from "../repositories/mission.js";
import { publicationResultToHttpResponse } from "./helpers/taskPublicationHttp.js";

const clonePreparationParamsSchema = z.object({ sourceTaskId: z.string() });
const clonePublicationParamsSchema = z.object({ sourceTaskId: z.string() });

// NOTE: The outcome → HTTP mapper previously lived inline here as
// `outcomeToHttpResponse` and was DUPLICATED in `taskPublication.ts`. Fix-P2
// (cold-review M4-3) extracted it to the shared helper
// `routes/helpers/taskPublicationHttp.ts:publicationResultToHttpResponse` so
// the two publication routes cannot drift apart. The shared helper ALSO
// backfills `envelopeTaskId` into the `replayed` branch (M4-2) so the
// response-loss → link-to-Task contract holds even when the stored terminal
// carries no `taskId`.

export async function taskClonePublicationRoutes(fastify: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------------
  // (a) GET /tasks/:sourceTaskId/clone-preparation
  //
  // The read-only allowlisted DTO. Mirrors task-read authorization — the
  // caller must have read access to the source Task's Habitat. ZERO
  // writes (no attempt, no Task, no event — opening the clone form
  // creates nothing).
  // ---------------------------------------------------------------------
  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/tasks/:sourceTaskId/clone-preparation",
    {
      schema: { params: clonePreparationParamsSchema },
      preHandler: agentOrHumanAuth,
    },
    async (request, _reply) => {
      const { sourceTaskId } = request.params;

      // Resolve the source → habitat server-side. The service is PURE
      // READ-ONLY (no writes; no attempt; no reservation).
      const result = prepareClonePublication(sourceTaskId);
      if (result.outcome === "not_found") {
        // Mirror the task-read route's not-found semantics — a missing
        // Task or Mission yields 404 (no cross-habitat leak).
        throw notFound("Source task not found");
      }

      // Authorize against the source's Habitat (the same membership check
      // `requireHabitatAccess` runs). A caller without habitat access
      // gets 403 — the GET refuses to surface a cross-habitat DTO.
      const sourceHabitatId = result.preparation.source.habitatId;
      await checkHabitatAccess(request, sourceHabitatId);

      // Return the allowlisted DTO verbatim — the route is a thin
      // transport for the read-only preparation primitive.
      return result.preparation;
    },
  );

  // ---------------------------------------------------------------------
  // (b) POST /tasks/:sourceTaskId/clone-publications
  //
  // The publication receives the EDITED work-definition + the
  // target Mission + the assignment intent, calls the extended
  // `publishTaskCreation` adapter with `cloneSourceTaskId`, and maps the
  // outcome to HTTP via the shared (duplicated) mapping function.
  //
  // ---------------------------------------------------------------------
  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/tasks/:sourceTaskId/clone-publications",
    {
      schema: { params: clonePublicationParamsSchema, body: clonePublicationSchema },
      preHandler: agentOrHumanAuth,
    },
    async (request, reply) => {
      const parsed: ClonePublicationInput = request.body;
      const { sourceTaskId } = request.params;

      // Resolve the source task → habitat (for cross-habitat enforcement
      // + same-Habitat authority). Without this, a cross-habitat clone
      // could leak via a 202 (the kernel would reject at prepare time
      // but the route would have already returned committed-recovering
      // if the adapter raced past reservation).
      const prep = prepareClonePublication(sourceTaskId);
      if (prep.outcome === "not_found") {
        throw notFound("Source task not found");
      }
      const sourceHabitatId = prep.preparation.source.habitatId;

      // Server-side mission existence + archived-mission guard. The
      // route param is `:sourceTaskId`, not `:missionId`, so
      // `requireMissionAccess`'s path-param lookup does not apply — we
      // resolve + check inline (mirrors T6 P2's `missionRepo.getMissionById`
      // + archived guard pattern).
      const targetMission = missionRepo.getMissionById(parsed.targetMissionId);
      if (!targetMission) {
        // Mirror T6's requireMissionAccess: a missing mission yields
        // not-found (no information leak about cross-habitat Missions).
        throw notFound("Target mission not found");
      }
      if (targetMission.isArchived) {
        // Mirrors the legacy create-task + T6 P2 routes' archived guard —
        // archived Missions are frozen against new Task creation
        // regardless of origin (REST, MCP, clone).
        throw forbidden("Cannot add tasks to an archived mission");
      }

      // Authorize against BOTH the source's Habitat (the source's Habitat
      // is authoritative for a clone — the adapter overrides `habitatId`
      // with it inside `publishTaskCreation`) AND the target Mission's
      // Habitat (a caller scoped to habitat A cannot clone into habitat
      // B's Missions; the kernel's `cross_habitat_mission` check rejects
      // it at prepare time).
      await checkHabitatAccess(request, sourceHabitatId);
      await checkHabitatAccess(request, targetMission.habitatId);

      // Provenance is server-constructed from the authenticated caller.
      // Untrusted body fields cannot assert privileged identities — the
      // adapter type does not expose them.
      //
      // The `auditSource` enum is the ORIGIN CHANNEL (the closed set in
      // @orcy/shared). For a REST route the value is ALWAYS `"rest_api"` —
      // the UI/API distinction is conveyed by `actorType` (human vs agent)
      // and surfaces in the committed envelope's causal-root.type (see
      // `deriveCausalRootType` in services/taskCreationPublication.ts):
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
      // that a targeted intent SUPPLIES a deadline (with `.superRefine`);
      // if a caller slips past the schema, surface as 422 rather than a
      // 500 (defensive fallback — the adapter would otherwise throw).
      const targetedAssignmentDeadline: string | undefined = parsed.targetedAssignmentDeadline;
      if (parsed.assignment.kind === "targeted" && targetedAssignmentDeadline === undefined) {
        throw unprocessableEntity(
          "targetedAssignmentDeadline is required when assignment.kind === 'targeted'",
          "VALIDATION_ERROR",
          { path: "targetedAssignmentDeadline" },
        );
      }

      // Adapter call. It returns the result envelope synchronously; we map
      // it to HTTP. It MAY throw for purely-internal
      // precondition failures (empty attemptKey, missing source Task,
      // empty agentId for targeted) — those surface as unhandled 500s via
      // the global error handler; they are programming-error-shaped, not
      // domain outcomes, so 500 is correct.
      //
      // NOTE: `habitatId` below is the SOURCE's Habitat. The adapter
      // re-resolves the source via `getHabitatIdForTask` inside
      // `publishTaskCreation` and OVERRIDES this value with the source's
      // authoritative Habitat (see `isClone` branch in the adapter). The
      // kernel's `cross_habitat_mission` check then rejects a target
      // Mission outside that Habitat — the route surfaces the rejection
      // as a typed 422 via `rejected_validation`.
      const result = publishTaskCreation({
        attemptKey: parsed.attemptKey,
        actorId,
        actorType,
        auditSource,
        habitatId: sourceHabitatId,
        targetMissionId: parsed.targetMissionId,
        cloneSourceTaskId: sourceTaskId,
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
        ...(parsed.subtasks !== undefined
          ? {
              subtasks: parsed.subtasks.map((s, i) => ({
                title: s.title,
                ...(s.order !== undefined ? { order: s.order } : { order: i }),
                ...(s.assigneeId !== undefined ? { assigneeId: s.assigneeId } : {}),
              })),
            }
          : {}),
        ...(parsed.selectedDependencies !== undefined
          ? {
              selectedDependencies: parsed.selectedDependencies.map((dependsOnId) => ({
                dependsOnId,
              })),
            }
          : {}),
        assignment: parsed.assignment,
        ...(targetedAssignmentDeadline !== undefined ? { targetedAssignmentDeadline } : {}),
      });

      // Recover the committed envelope (if any) so the HTTP layer can
      // include the task id even on a recovering-replay path where the
      // adapter's inline publication is reconstructed rather than fresh.
      const envelopeRow = getDb()
        .select({
          attemptId: taskCreationEnvelopes.attemptId,
          taskId: taskCreationEnvelopes.taskId,
        })
        .from(taskCreationEnvelopes)
        .where(eq(taskCreationEnvelopes.attemptId, result.attemptId))
        .get();
      const envelopeTaskId = envelopeRow?.taskId ?? null;

      const { statusCode, body } = publicationResultToHttpResponse(result, envelopeTaskId);
      reply.code(statusCode).send(body);
    },
  );
}

/**
 * Default export mirrors `routes/taskPublication.ts` / `taskCreationAttempts.ts`
 * — test harnesses that import the file directly register the routes under
 * their chosen prefix.
 */
export default taskClonePublicationRoutes;
