/**
 * T5 Phase 3 — targeted-assignment RETRY surface.
 *
 * `POST /tasks/:taskId/assignment-attempts` re-attempts assignment against an
 * EXISTING Task (i.e. one whose creation attempt already terminalized as
 * `created_unassigned`). This route does NOT re-enter Task creation, does NOT
 * retry the reservation (the reservation was released/expired by the
 * coordinator when it terminalized the attempt), and does NOT re-call the
 * coordinator (`resolveTargetedAssignment`) — the retry is a fresh claim
 * against a pending Task via {@link claimWithAuthority} directly.
 *
 * It is idempotent by design: a retry after a successful assignment surfaces
 * the current assignee (`already_claimed` / `not_pending` → `lost` with the
 * current assignee). A retry after a refusal re-attempts cleanly — no side
 * effects on the creation-attempt ledger (no new attempt row, no reservation,
 * no coordinator call). The Phase-1/Phase-2 coordinator owns the
 * `published_pending_assignment` → terminal state machine; this route ONLY
 * runs after the coordinator already released the gate.
 *
 * Auth: `agentOrHumanAuth` + caller-must-have-habitat-access to the task's
 * habitat (resolved inside the handler, mirrors the GET
 * `/task-creation-attempts/:attemptId` route's R4 surface — the task's
 * habitatId is fetched from the row, the caller's membership is checked
 * against it; a non-member gets 403, a missing task gets 404).
 *
 * Conventions matched (verified against `routes/taskCreationAttempts.ts` and
 * `routes/tasks/lifecycle.ts`):
 *   - `agentOrHumanAuth` preHandler; habitat membership checked inside the
 *     handler via {@link checkHabitatAccess}.
 *   - Typed `ClaimResult` from the authority is mapped to HTTP: typed refusal
 *     categories → typed 403/409 (category+reason preserved); not_found → 404;
 *     infrastructure failures → 503; idempotent success → 200 with the
 *     current state.
 *   - `throw notFound(...)` / `forbidden(...)` / `conflict(...)` from
 *     `errors.js` — NOT raw `reply.code(N).send(...)`.
 *   - Registered via `routes/tasks/index.ts` so the existing `/api/v1` +
 *     `/api` prefix indirection applies (no per-route prefix).
 *
 * Out of scope: the coordinator (`resolveTargetedAssignment`), the sweeper,
 * the scheduler/cron. This route is a NEW CALLER of `claimWithAuthority`, not
 * a hub edit.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  tasks,
  missions,
  taskCreationEnvelopes,
  taskCreationAttempts,
} from "../../db/schema/index.js";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { agentOrHumanAuth } from "../../middleware/auth.js";
import { checkHabitatAccess } from "../../middleware/realtimeAuth.js";
import { assignmentAttemptSchema } from "../../models/schemas.js";
import { notFound, forbidden, conflict, serviceUnavailable } from "../../errors.js";
import { claimWithAuthority } from "../../repositories/claimAuthority.js";
import type { ClaimFailure } from "../../repositories/claimAuthority.js";
import { getTaskById } from "../../repositories/taskCrud.js";

const taskParamsSchema = z.object({ taskId: z.string() });

/**
 * Maps a typed {@link ClaimFailure} category to an `{outcome, …}` shape that
 * P3 surfaces. The route returns this shape verbatim — UI consumers project
 * the `category` / `currentAssignee` directly. Idempotent success returns
 * `{outcome:"lost", currentAssignee:{kind:"local", id:A}}` for a re-claim by
 * the same identity (the task IS claimed by A; the retry is a no-op).
 *
 * `not_found` and the cross-habitat check are owned by the handler (so the
 * caller never sees a typo'd id leaking habitat membership). Typed refusal
 * categories are surfaced WITHOUT a status-code escalation — the HTTP layer
 * in the route maps refusal → 403, occupancy loss → 200 with `{lost}`, infra
 * → 503.
 */
function failureToOutcome(
  claim: ClaimFailure,
  taskId: string,
):
  | {
      outcome: "lost";
      taskId: string;
      currentAssignee: { kind: "local" | "remote"; id: string } | null;
    }
  | { outcome: "refused"; taskId: string; category: string; reason: string }
  | { outcome: "infra"; taskId: string; category: string; reason: string; causeCode?: string } {
  if (claim.category === "already_claimed" || claim.category === "not_pending") {
    // Read-through to surface the current assignee (per the P3 handoff:
    // "report current assignee when retry loses after reservation release").
    // The authority's `reserved_for_other` branch already carries a
    // `reservedFor` diagnostic; already_claimed / not_pending do not.
    const task = getTaskById(taskId);
    let currentAssignee: { kind: "local" | "remote"; id: string } | null = null;
    if (task) {
      if (task.assignedAgentId !== null) {
        currentAssignee = { kind: "local", id: task.assignedAgentId };
      } else if (task.remoteAssignedParticipantId != null) {
        // `remoteAssignedParticipantId` is optional on `Task` (`string | null |
        // undefined`); the authority's plain-claim branch only writes non-null
        // values, so the only valid non-assigned state is null/undefined.
        currentAssignee = { kind: "remote", id: task.remoteAssignedParticipantId! };
      } else {
        currentAssignee = null;
      }
    }
    // Phase 3 idempotency: a second call where the same agent already holds
    // the claim (currentAssignee.id === requestedAgentId) is the
    // success→lost idempotent shape — the route returns it as 200 (lost) so
    // the UI can show "still assigned to X" without a new side effect.
    return {
      outcome: "lost",
      taskId,
      currentAssignee,
    };
  }
  if (
    claim.category === "ineligible" ||
    claim.category === "governance_veto" ||
    claim.category === "reserved_for_other"
  ) {
    return {
      outcome: "refused",
      taskId,
      category: claim.category,
      reason: claim.reason,
    };
  }
  // observation_pending / version_conflict / infrastructure_failure /
  // not_found (not_found means the task vanished between authority reads —
  // rare; treat as retryable infra for the caller).
  if (claim.category === "version_conflict" || claim.category === "infrastructure_failure") {
    // Narrowed: only these two variants carry `causeCode`.
    return {
      outcome: "infra",
      taskId,
      category: claim.category,
      reason: claim.reason,
      causeCode: claim.causeCode,
    };
  }
  return {
    outcome: "infra",
    taskId,
    category: claim.category,
    reason: claim.reason,
  };
}

export async function taskAssignmentRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/tasks/:taskId/assignment-attempts",
    {
      schema: { params: taskParamsSchema, body: assignmentAttemptSchema },
      preHandler: agentOrHumanAuth,
    },
    async (request, _reply) => {
      const { taskId } = request.params;
      const { requestedAgentId } = request.body;

      // 1. Resolve the task + enforce habitat-scope authorization (R4).
      // Join tasks→missions to extract the task's habitatId (the tasks
      // table itself does not carry habitatId; the join is canonical —
      // mirrors `taskQueries.getTasksByHabitatId`'s mission-then-tasks
      // pattern). Defense-in-depth read on `tasks` directly ensures a
      // missing task 404s BEFORE any habitat resolution.
      const row = getDb()
        .select({ habitatId: missions.habitatId })
        .from(tasks)
        .innerJoin(missions, eq(missions.id, tasks.missionId))
        .where(eq(tasks.id, taskId))
        .get();
      if (!row) {
        throw notFound("Task not found");
      }
      // Habitat-scope membership check (mirrors GET
      // `/task-creation-attempts/:attemptId`): the caller's identity
      // (agent or human) must have access to the task's habitat. A
      // non-member gets 403 (no leak); a missing habitat gets 404.
      await checkHabitatAccess(request, row.habitatId);

      // Guard 1 — Admin-only explicit-assignment authority (Fix-P1 / C1).
      // Mirrors `routes/tasks/batch.ts:26-29`: an AGENT caller cannot
      // explicitly assign to an arbitrary `requestedAgentId` — agents must
      // claim for themselves via `POST /tasks/:id/claim`. Humans (admins)
      // may retry-assign. This runs AFTER the habitat check so R4
      // cross-habitat isolation still gates first (both return 403 — no
      // information leak about the route's authority rule).
      if (request.agent) {
        throw forbidden(
          "Explicit assignment is admin-only; agents must claim via POST /tasks/:id/claim",
          "AGENT_CANNOT_ASSIGN",
        );
      }

      // Guard 2 — `created_unassigned` attempt check (Fix-P1 / C1).
      // This route is ONLY for retrying a failed targeted assignment on a
      // post-cutover Task whose creation attempt terminalized to
      // `created_unassigned` (the coordinator released the reservation
      // gate). Resolution path: taskId → taskCreationEnvelopes.taskId →
      // attemptId → taskCreationAttempts.state.
      //
      // A task with NO linked creation attempt (a legacy/ordinary Task), OR
      // one whose attempt is still recovering (`published_pending_*`), OR
      // already terminalized to `created` → rejected as 409 Conflict (the
      // task exists but is not in a retryable state). This closes the
      // "assign ANY pending task" bypass identified in cold review #1.
      const envelope = getDb()
        .select({ attemptId: taskCreationEnvelopes.attemptId })
        .from(taskCreationEnvelopes)
        .where(eq(taskCreationEnvelopes.taskId, taskId))
        .get();
      if (!envelope) {
        throw conflict("Task is not eligible for assignment retry: no linked creation attempt", {
          category: "not_retryable",
          reason: "no_creation_attempt",
        });
      }
      const attempt = getDb()
        .select({ state: taskCreationAttempts.state })
        .from(taskCreationAttempts)
        .where(eq(taskCreationAttempts.id, envelope.attemptId))
        .get();
      if (!attempt || attempt.state !== "created_unassigned") {
        throw conflict(
          "Task is not eligible for assignment retry: creation attempt did not terminalize to created_unassigned",
          {
            category: "not_retryable",
            reason: attempt ? `attempt_state_${attempt.state}` : "attempt_missing",
          },
        );
      }

      // 2. Call `claimWithAuthority(db, taskId, {kind:"local", id: requestedAgentId})`
      // DIRECTLY. Not the coordinator — there is no live creation attempt
      // on retry, and the reservation was released/expired at
      // `created_unassigned`. The retry is a fresh local-claim against an
      // existing pending Task.
      const claim = claimWithAuthority(undefined, taskId, { kind: "local", id: requestedAgentId });

      // 3. Map the typed `ClaimResult` to an HTTP response.
      if (claim.success) {
        return {
          outcome: "assigned",
          taskId,
          assigneeId: requestedAgentId,
        };
      }

      // `not_found` from the authority means the task vanished between
      // step 1 and the authority's tx (race). Surface as 404 — the typed
      // vocabulary stays consistent.
      if (claim.category === "not_found") {
        throw notFound("Task not found");
      }

      const mapped = failureToOutcome(claim, taskId);

      // Idempotent-lost: caller already holds the claim (or another
      // identity does). HTTP 200 with `{outcome:"lost", currentAssignee}`
      // — the retry is a no-op reporting current state.
      if (mapped.outcome === "lost") {
        return {
          outcome: "lost" as const,
          taskId: mapped.taskId,
          currentAssignee: mapped.currentAssignee,
        };
      }

      // Typed refusal: 403 for identity / governance / reservation
      // categories; the body carries the category + reason + (for
      // reserved_for_other) the reserved identity. Cross-habitat attempts
      // are already blocked by step 1; this layer only governs task-
      // intrinsic refusals.
      if (mapped.outcome === "refused") {
        throw forbidden(`Assignment refused: ${mapped.category}`, mapped.category.toUpperCase(), {
          category: mapped.category,
          reason: mapped.reason,
        });
      }

      // Infrastructure / version / observation failures: 503 (retryable)
      // for infra + version, 409 for observation_pending (the task is in a
      // publication gate the retry cannot advance).
      if (claim.category === "observation_pending") {
        throw conflict("Task is awaiting publication observation", {
          category: claim.category,
          reason: claim.reason,
        });
      }
      throw serviceUnavailable(`Assignment retry could not complete (${claim.category})`, {
        category: claim.category,
        reason: claim.reason,
        // Narrowed above (`observation_pending` returned first); only
        // `version_conflict` and `infrastructure_failure` carry `causeCode`.
        ...((claim.category === "version_conflict" ||
          claim.category === "infrastructure_failure") &&
        "causeCode" in claim
          ? { causeCode: claim.causeCode }
          : {}),
      });
    },
  );
}

/**
 * Re-export the route registration as default for test harnesses that import
 * the file directly. Mirrors `taskCreationAttemptRoutes` (`routes/taskCreationAttempts.ts`).
 */
export default taskAssignmentRoutes;
