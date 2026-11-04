import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as taskService from "../../services/tasks/index.js";
import * as taskRepo from "../../repositories/task.js";
import * as retryService from "../../services/retryService.js";
import {
  claimTaskSchema,
  approveTaskSchema,
  rejectTaskSchema,
  releaseTaskSchema,
  failTaskSchema,
  submitTaskSchema,
  completeTaskSchema,
  startTaskSchema,
} from "../../models/schemas.js";
import { authorizeTaskAction, getPrincipalFromRequest } from "../../middleware/taskAuth.js";
import * as reviewAssignment from "../../services/reviewAssignmentService.js";
import type { Artifact } from "../../models/index.js";
import {
  AppError,
  notFound,
  unauthorized,
  forbidden,
  conflict,
  conflictWithCode,
  badRequest,
  internalError,
  unprocessableEntity,
  InterceptorVetoError,
} from "../../errors.js";
import { applyDeclaredAuthPolicies } from "../../authPolicy.js";
import { authorizeRecoveryWithClient } from "../../services/reviewRecoveryService.js";
import { getDb } from "../../db/index.js";

const taskParamsSchema = z.object({ id: z.string() });

export async function taskLifecycleRoutes(fastify: FastifyInstance): Promise<void> {
  applyDeclaredAuthPolicies(fastify);

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .post(
      "/tasks/:id/claim",
      { schema: { params: taskParamsSchema, body: claimTaskSchema }, config: { authPolicy: "agent" } },
      async (request, _reply) => {
        const task = taskService.getTask(request.params.id);
        if (!task) {
          throw notFound("Task not found");
        }

        if (!request.agent) {
          throw unauthorized("Agent authentication required");
        }
        const agentId = request.agent.id;

        if (
          task.requiredDomain &&
          request.agent.domain !== task.requiredDomain &&
          request.agent.domain !== "fullstack"
        ) {
          throw forbidden("Domain mismatch");
        }

        if (task.requiredCapabilities && task.requiredCapabilities.length > 0) {
          const agentCaps = new Set((request.agent.capabilities || []).map((c) => c.toLowerCase()));
          const missing = (task.requiredCapabilities as string[]).filter(
            (c) => !agentCaps.has(c.toLowerCase()),
          );
          if (missing.length > 0) {
            throw forbidden("Capability mismatch", undefined, { missingCapabilities: missing });
          }
        }

        if (
          task.delegatedToAgentId === agentId &&
          (task.status === "claimed" || task.status === "in_progress")
        ) {
          try {
            const result = taskService.claimDelegatedTask(request.params.id, agentId);
            if (!result.success) {
              throw conflict(result.reason, {
                message: result.message,
                missingCapabilities: result.missingCapabilities,
              });
            }
            return { task: result.task };
          } catch (err) {
            if (err instanceof InterceptorVetoError) {
              throw forbidden("Transition blocked by lifecycle interceptor", "INTERCEPTOR_VETO", {
                blockedBy: { reason: err.veto.reason, details: err.veto.details },
              });
            }
            throw err;
          }
        }

        try {
          const result = taskService.claimTask(request.params.id, agentId);
          if (!result.success) {
            throw conflict(result.reason, { missingCapabilities: result.missingCapabilities });
          }
          return { task: result.task };
        } catch (err) {
          if (err instanceof InterceptorVetoError) {
            throw forbidden("Transition blocked by lifecycle interceptor", "INTERCEPTOR_VETO", {
              blockedBy: { reason: err.veto.reason, details: err.veto.details },
            });
          }
          throw err;
        }
      },
    );

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .post(
      "/tasks/:id/start",
      {
        schema: { params: taskParamsSchema, body: startTaskSchema },
        config: { authPolicy: "agent" },
      },
      async (request, _reply) => {
        const task = taskService.getTask(request.params.id);
        if (!task) {
          throw notFound("Task not found");
        }

        const agentId = request.agent!.id;
        const principal = getPrincipalFromRequest(request);
        const auth = authorizeTaskAction(task, principal, "start");
        if (!auth.allowed) {
          throw forbidden(auth.reason ?? "Forbidden");
        }

        // Epoch-mutation guard: the agent wire always activates the guard —
        // omitted/null/no-body token maps to null (typed identically); the
        // disjunction inside the authority tx decides allow vs 409.
        const parsed = request.body;
        const result = taskService.startTask(
          request.params.id,
          agentId,
          parsed?.executionToken ?? null,
        );
        if (!result) {
          throw conflict("Cannot start task in current state");
        }
        return { task: result };
      },
    );

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .post(
      "/tasks/:id/approve",
      { schema: { params: taskParamsSchema, body: approveTaskSchema }, config: { authPolicy: "local_actor" } },
      async (request, _reply) => {
        const task = taskService.getTask(request.params.id);
        if (!task) {
          throw notFound("Task not found");
        }

        const principal = getPrincipalFromRequest(request);
        const auth = authorizeTaskAction(task, principal, "approve", {
          hasPendingAgentReviewerRow: reviewAssignment.hasPendingAgentReviewerRow,
        });
        if (!auth.allowed) {
          throw forbidden(auth.reason ?? "Forbidden");
        }

        // Reviewer identity derives from the authenticated principal — never
        // the request body. Humans keep today's semantics exactly; agents are
        // admitted only through the pending typed reviewer row above.
        const reviewerId = principal!.id;
        const reviewerType = principal!.type;
        try {
          const approved = taskService.approveTask(request.params.id, reviewerId, reviewerType);

          if (!approved) {
            throw badRequest("Task cannot be approved in current state");
          }
          return { task: approved };
        } catch (err) {
          if (err instanceof InterceptorVetoError) {
            throw forbidden("Transition blocked by lifecycle interceptor", "INTERCEPTOR_VETO", {
              blockedBy: { reason: err.veto.reason, details: err.veto.details },
            });
          }
          throw err;
        }
      },
    );

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .post(
      "/tasks/:id/reject",
      { schema: { params: taskParamsSchema, body: rejectTaskSchema }, config: { authPolicy: "local_actor" } },
      async (request, _reply) => {
        const task = taskService.getTask(request.params.id);
        if (!task) {
          throw notFound("Task not found");
        }

        const principal = getPrincipalFromRequest(request);
        const auth = authorizeTaskAction(task, principal, "reject", {
          hasPendingAgentReviewerRow: reviewAssignment.hasPendingAgentReviewerRow,
        });
        if (!auth.allowed) {
          throw forbidden(auth.reason ?? "Forbidden");
        }

        const parsed = request.body;
        // Reviewer identity derives from the authenticated principal — never
        // the request body.
        const reviewerId = principal!.id;
        const reviewerType = principal!.type;
        try {
          const rejected = taskService.rejectTask(
            request.params.id,
            reviewerId,
            parsed.reason,
            reviewerType,
          );

          if (!rejected) {
            throw badRequest("Task cannot be rejected in current state");
          }
          return { task: rejected };
        } catch (err) {
          if (err instanceof InterceptorVetoError) {
            throw forbidden("Transition blocked by lifecycle interceptor", "INTERCEPTOR_VETO", {
              blockedBy: { reason: err.veto.reason, details: err.veto.details },
            });
          }
          throw err;
        }
      },
    );

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .post(
      "/tasks/:id/release",
      { schema: { params: taskParamsSchema, body: releaseTaskSchema }, config: { authPolicy: "agent" } },
      async (request, _reply) => {
        const task = taskService.getTask(request.params.id);
        if (!task) {
          throw notFound("Task not found");
        }

        const principal = getPrincipalFromRequest(request);
        const auth = authorizeTaskAction(task, principal, "release");
        if (!auth.allowed) {
          throw forbidden(auth.reason ?? "Forbidden");
        }

        const actorId = request.agent!.id;
        const parsed = request.body;
        const released = taskService.releaseTask(
          request.params.id,
          actorId,
          parsed.reason ?? "",
          parsed.executionToken ?? null,
        );

        if (!released) {
          throw conflict("Cannot release task in current state");
        }
        return { task: released };
      },
    );

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .post(
      "/tasks/:id/fail",
      { schema: { params: taskParamsSchema, body: failTaskSchema }, config: { authPolicy: "agent" } },
      async (request, _reply) => {
        const task = taskService.getTask(request.params.id);
        if (!task) {
          throw notFound("Task not found");
        }

        const principal = getPrincipalFromRequest(request);
        const auth = authorizeTaskAction(task, principal, "fail");
        if (!auth.allowed) {
          throw forbidden(auth.reason ?? "Forbidden");
        }

        const agentId = request.agent!.id;
        const parsed = request.body;
        const failed = taskService.failTask(
          request.params.id,
          agentId,
          "agent",
          parsed.reason ?? "",
          parsed.executionToken ?? null,
        );

        if (!failed) {
          throw conflict("Cannot fail task in current state");
        }
        return { task: failed };
      },
    );

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .post(
      "/tasks/:id/submit",
      { schema: { params: taskParamsSchema, body: submitTaskSchema }, config: { authPolicy: "agent" } },
      async (request, _reply) => {
        const task = taskService.getTask(request.params.id);
        if (!task) {
          throw notFound("Task not found");
        }

        const principal = getPrincipalFromRequest(request);
        const auth = authorizeTaskAction(task, principal, "submit");
        if (!auth.allowed) {
          throw forbidden(auth.reason ?? "Forbidden");
        }

        const agentId = request.agent!.id;
        const parsed = request.body;

        try {
          const submitted = taskService.submitTask(
            request.params.id,
            agentId,
            parsed.result ?? "",
            parsed.artifacts ?? [],
            parsed.executionToken ?? null,
          );

          if (!submitted.task) {
            if (submitted.error === "QUALITY_GATES_NOT_MET") {
              throw unprocessableEntity(
                submitted.error ?? "Cannot submit task in current state",
                "QUALITY_GATES_NOT_MET",
                { missingQualityItems: submitted.missingQualityItems },
              );
            }
            throw conflict(submitted.error ?? "Cannot submit task in current state", {
              missingQualityItems: submitted.missingQualityItems,
            });
          }

          return {
            success: true,
            task: {
              id: submitted.task.id,
              status: submitted.task.status,
              submittedAt: submitted.task.submittedAt,
            },
            message: "Task submitted for review.",
          };
        } catch (err) {
          if (err instanceof InterceptorVetoError) {
            throw forbidden("Transition blocked by lifecycle interceptor", "INTERCEPTOR_VETO", {
              blockedBy: { reason: err.veto.reason, details: err.veto.details },
            });
          }
          throw err;
        }
      },
    );

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .post(
      "/tasks/:id/complete",
      { schema: { params: taskParamsSchema, body: completeTaskSchema }, config: { authPolicy: "agent" } },
      async (request, _reply) => {
        const task = taskService.getTask(request.params.id);
        if (!task) {
          throw notFound("Task not found");
        }

        const principal = getPrincipalFromRequest(request);
        const auth = authorizeTaskAction(task, principal, "complete");
        if (!auth.allowed) {
          throw forbidden(auth.reason ?? "Forbidden");
        }

        const agentId = request.agent!.id;
        const parsed = request.body;

        try {
          const result = taskService.completeTask(
            request.params.id,
            agentId,
            parsed.reviewNote,
            parsed.artifacts as Artifact[],
            parsed.skipQualityGates,
          );

          if (!result.task) {
            if (result.error === "TASK_BLOCKED_BY_DEPENDENCIES") {
              throw unprocessableEntity(
                result.error ??
                  "Cannot complete task in current state. Task must be in submitted status.",
                "TASK_BLOCKED",
                { blockedBy: result.blockedBy },
              );
            }
            if (result.error === "QUALITY_GATES_NOT_MET") {
              throw unprocessableEntity(
                result.error ??
                  "Cannot complete task in current state. Task must be in submitted status.",
                "QUALITY_GATES_NOT_MET",
                { missingQualityItems: result.missingQualityItems },
              );
            }
            if (result.error === "REVIEW_REQUIRED") {
              throw unprocessableEntity(
                "Task requires review approval before completion",
                "REVIEW_REQUIRED",
                {},
              );
            }
            throw conflict(
              result.error ??
                "Cannot complete task in current state. Task must be in submitted status.",
              { blockedBy: result.blockedBy, missingQualityItems: result.missingQualityItems },
            );
          }

          return {
            success: true,
            task: {
              id: result.task.id,
              status: result.task.status,
              completedAt: result.task.completedAt,
              result: result.task.result,
              artifacts: result.task.artifacts,
            },
            message: "Task completed and moved to done.",
          };
        } catch (err) {
          if (err instanceof InterceptorVetoError) {
            throw forbidden("Transition blocked by lifecycle interceptor", "INTERCEPTOR_VETO", {
              blockedBy: { reason: err.veto.reason, details: err.veto.details },
            });
          }
          throw err;
        }
      },
    );

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .post(
      "/tasks/:id/retry",
      { schema: { params: taskParamsSchema }, config: { authPolicy: "local_actor" } },
      async (request, _reply) => {
        const task = taskRepo.getTaskById(request.params.id);
        if (!task) {
          throw notFound("Task not found");
        }

        const principal = getPrincipalFromRequest(request);
        const humanRetry = principal?.type === "human";

        // Human lane object authorization: the manual human retry is a
        // CUSTODY-ENDING MUTATION, so it binds to the repo's established
        // recovery-mutation policy (authorizeRecoveryWithClient — the
        // review-safety precedent), NOT the broad habitat READ rule (any
        // authenticated human on personal habitats) and NOT the JWT
        // admin/editor role: persisted global admin; personal habitat → its
        // explicit owner; team habitat → team owner/admin. Persisted viewer
        // is refused everywhere; the JWT role is an identity hint, never
        // authority (the persisted users row decides). This admission is a
        // UX preflight, NOT the sole gate: the same policy is re-checked
        // INSIDE the retry writer's transaction (retryOptions.authorize), so
        // a revocation in between still refuses. Agents keep the
        // historical authorizeTaskAction admission; the agent wire is
        // unchanged.
        if (humanRetry) {
          const authorized = authorizeRecoveryWithClient(
            getDb(),
            principal.id,
            request.params.id,
          );
          if (!authorized) {
            throw forbidden("Not authorized to recover this task");
          }
        } else {
          const auth = authorizeTaskAction(task, principal, "retry");
          if (!auth.allowed) {
            throw forbidden(auth.reason ?? "Forbidden");
          }
        }

        // Status gate asymmetry: the agent lane stays failed-only (unchanged
        // contract); a human may additionally retry a `rejected`
        // task — the custody-ending reset that returns an owner-stranded
        // rejected row to the claim pool. `submitted` still blocks both.
        const retryableStatus = humanRetry
          ? task.status === "failed" || task.status === "rejected"
          : task.status === "failed";
        if (!retryableStatus) {
          throw badRequest(
            humanRetry
              ? "Task must be in failed or rejected status to retry"
              : "Task must be in failed status to retry",
          );
        }

        // Both manual lanes pin the admission preimage from THIS request's
        // read: a row that moves between the fetch and the writer (owner
        // rework restart minting a fresh epoch, a concurrent claim) refuses
        // with no effects instead of erasing live custody — and the CAS runs
        // BEFORE the writer's transition-budget gate, so a stale retry
        // always answers VERSION_CONFLICT, never a spurious budget breach.
        // The human recovery lane additionally reserves transition-budget
        // headroom for FOUR slots (reset + the replacement's claim, start,
        // and submit) INSIDE the writer's transaction — a custody-ending
        // reset whose replacement path cannot be afforded refuses typed
        // rather than stranding the row — and re-checks the recovery-policy
        // authorization INSIDE the same transaction (a persisted-role or
        // membership revocation landing between this admission and the
        // writer answers the typed 403 with zero effects), preserving the
        // reviewer's rejection feedback for the replacement claimant.
        // Failed-lane/background retries keep the historical clear.
        const retryOptions: retryService.ExecuteRetryOptions = {
          expected: { status: task.status, version: task.version },
          // Attribution (agent lane only): the retry_executed event names the
          // authenticated agent principal. The human lane stays unattributed
          // (historical system actor) until human-lane verification lands.
          actor: principal && !humanRetry ? { type: "agent", id: principal.id } : undefined,
        };
        if (humanRetry) {
          retryOptions.requireClaimHeadroom = true;
          retryOptions.authorize = (tx) =>
            authorizeRecoveryWithClient(tx, principal.id, request.params.id);
          if (task.status === "rejected") {
            retryOptions.preserveRejectionReason = true;
          }
        }
        const retried = retryService.executeRetryWithOutcome(task, retryOptions);
        if (retried.outcome === "refused") {
          // Policy refusal on either lane: the budget is spent or cannot
          // cover the recovery lane's reserved replacement claim.
          throw conflictWithCode(
            "TRANSITION_BUDGET_EXHAUSTED",
            "Manual retry refused: the task's transition budget is exhausted",
            {
              category: retried.refusal.reason,
              count: retried.refusal.count,
              ceiling: retried.refusal.ceiling,
            },
          );
        }
        if (retried.outcome === "failed") {
          if (retried.reason === "preimage_conflict") {
            // The CAS refused: the row moved between this request's read and
            // the writer. Nothing was written — reload the task and decide.
            throw new AppError(
              409,
              "VERSION_CONFLICT",
              "Task changed before the retry could run — reload the task and retry",
              { expectedStatus: task.status, expectedVersion: task.version },
            );
          }
          throw internalError("Failed to execute retry");
        }
        return { task: retried.task };
      },
    );

  fastify
    .withTypeProvider<ZodTypeProvider>()
    .post(
      "/tasks/:id/unblock",
      { schema: { params: taskParamsSchema }, config: { authPolicy: "agent" } },
      async (request, _reply) => {
        if (!request.agent) {
          throw unauthorized("Authentication required");
        }

        throw forbidden("Unblock is an internal-only action");
      },
    );
}
