import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  remoteParticipantAuth,
  remoteActionScope,
  mapParticipantToActorType,
} from "../middleware/remoteAuth.js";
import {
  idempotentRemoteWrite,
  completeRemoteIdempotency,
  failRemoteIdempotency,
} from "../middleware/idempotency.js";
import {
  isTargetVisibleToParticipant,
  listMyGrants,
} from "../services/sharedGrantVisibilityService.js";
import {
  badRequest,
  forbidden,
  notFound,
  unauthorized,
  conflict,
  InterceptorVetoError,
} from "../errors.js";
import { logger } from "../lib/logger.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as credentialService from "../services/remoteCredentialService.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as commentService from "../services/commentService.js";
import * as featureCommentService from "../services/missionCommentService.js";
import * as pulseService from "../services/pulseService.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as codeEvidenceLinking from "../services/codeEvidence/linking.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as workflowService from "../services/workflowService.js";
import { emitRemoteOriginatedNotification } from "../services/remoteNotifications.js";
import {
  claimTaskForRemote,
  submitTaskForRemote,
  releaseTaskForRemote,
} from "../services/tasks/remote-task-lifecycle.js";
import type { CodeEvidenceActor } from "../services/codeEvidence/types.js";
import { routeFinding as routeFindingLifecycle } from "../services/findingTriageLifecycle.js";
import { checkRemoteRouteAuthority } from "../services/triageLifecycleAuthority.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const heartbeatTaskSchema = z.object({ progress: z.string().max(500).optional() }).strict();
const submitTaskSchema = z
  .object({
    result: z.string().min(1).max(10000),
    artifacts: z
      .array(
        z.object({
          kind: z.string().min(1).max(64),
          url: z.string().url().optional(),
          metadata: z.record(z.unknown()).optional(),
        }),
      )
      .max(20)
      .optional()
      .default([]),
  })
  .strict();
const releaseTaskSchema = z.object({ reason: z.string().min(1).max(500) }).strict();

const commentBodySchema = z
  .object({
    content: z.string().min(1).max(5000),
    parentId: z.string().uuid().optional(),
  })
  .strict();

const pulseSignalTypes = [
  "finding",
  "blocker",
  "offer",
  "warning",
  "question",
  "answer",
  "directive",
  "context",
  "handoff",
] as const;
const postPulseSchema = z
  .object({
    signalType: z.enum(pulseSignalTypes),
    subject: z.string().min(1).max(256),
    body: z.string().max(5000).optional(),
    taskId: z.string().uuid().optional(),
    replyToId: z.string().uuid().optional(),
  })
  .strict();

const evidenceLinkSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine(
        (url) => url.startsWith("http://") || url.startsWith("https://"),
        "Evidence URL must use http or https",
      ),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

const snoozeSchema = z.object({ snoozedUntil: z.string().datetime() }).strict();

/**
 * Remote triage-route body. Same discriminated union as the local
 * `/triage/findings/:id/route` body — the lifecycle command kernel consumes
 * the canonical {@link RoutePayload} regardless of transport.
 */
const remoteFixNowRouteSchema = z
  .object({
    bucket: z.literal("fix_now"),
    missionTitle: z.string().min(1).max(500),
    missionDescription: z.string().min(1).max(20000),
    dependencies: z.array(z.string().max(200)).max(50).optional(),
  })
  .strict();
const remoteDeferRouteSchema = z
  .object({
    bucket: z.enum(["defer_to_patch", "defer_to_release"]),
    missionTitle: z.string().min(1).max(500),
    missionDescription: z.string().min(1).max(20000),
    dependencies: z.array(z.string().max(200)).max(50).optional(),
    releaseGateType: z.enum(["patch", "minor", "major"]),
    releaseGateVersion: z.string().min(1).max(64),
  })
  .strict();
const remoteNoWorkRouteSchema = z
  .object({ bucket: z.literal("document_as_known_limitation") })
  .strict();
const remoteInvestigationRouteSchema = z
  .object({ bucket: z.literal("needs_investigation") })
  .strict();
const remoteRouteBodySchema = z.union([
  remoteFixNowRouteSchema,
  remoteDeferRouteSchema,
  remoteNoWorkRouteSchema,
  remoteInvestigationRouteSchema,
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireRemoteContext(request: FastifyRequest) {
  if (!request.remoteParticipant) {
    throw unauthorized("Remote participant authentication required", "REMOTE_AUTH_REQUIRED");
  }
  return request.remoteParticipant;
}

function asPulsePostCaller(ctx: ReturnType<typeof requireRemoteContext>) {
  return {
    type: mapParticipantToActorType(
      ctx.participant.participantType as "remote_human" | "remote_orcy",
    ),
    id: ctx.participant.id,
  };
}

function asCodeEvidenceActor(ctx: ReturnType<typeof requireRemoteContext>): CodeEvidenceActor {
  return {
    type: mapParticipantToActorType(
      ctx.participant.participantType as "remote_human" | "remote_orcy",
    ),
    id: ctx.participant.id,
  };
}

function parseBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw badRequest(`Invalid request body: ${issues}`);
  }
  return result.data;
}

/**
 * Anti-probing: collapse existence-leaking denial codes (HABITAT_MISMATCH,
 * TARGET_NOT_VISIBLE) into a generic 403 for the remote client. The specific
 * reason is logged server-side only — the `/api/shared/*` surface is
 * cross-habitat, so distinct codes would let a prober distinguish "exists,
 * other habitat" from "exists, your habitat, invisible".
 *
 * TASK_NOT_OWNED is intentionally NOT collapsed — it's legitimate ownership
 * feedback for a participant who already passed visibility checks.
 */
function remoteAccessDenied(
  reason: "HABITAT_MISMATCH" | "TARGET_NOT_VISIBLE",
  targetId: string,
  ctx: ReturnType<typeof requireRemoteContext>,
): never {
  logger.warn(
    {
      reason,
      targetId,
      participantId: ctx.participant.id,
      habitatId: ctx.habitatId,
      podId: ctx.pod.id,
    },
    "remote access denied",
  );
  throw forbidden("Access denied");
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function sharedApiRoutes(fastify: FastifyInstance): Promise<void> {
  // Every route requires remote participant auth
  fastify.addHook("preHandler", remoteParticipantAuth);

  fastify.addHook("onError", async (request, _reply) => {
    if (request.remoteIdempotency) {
      failRemoteIdempotency(request, "Route handler error");
    }
  });

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /** GET /api/shared/me — current remote participant, standing, grants, pod */
  fastify.get("/me", async (request: FastifyRequest) => {
    const ctx = requireRemoteContext(request);
    const pod = podRepo.getRemotePodById(ctx.pod.id);
    const participant = participantRepo.getRemoteParticipantById(ctx.participant.id);
    if (!pod || !participant) {
      throw notFound("Remote participant not found");
    }
    const grants = listMyGrants(ctx);
    return {
      participant: {
        id: participant.id,
        participantType: participant.participantType,
        displayName: participant.displayName,
        standing: participant.standing,
        status: participant.status,
        externalIdentityId: participant.externalIdentityId,
        approvedCapabilities: participant.approvedCapabilities,
        approvedDomains: participant.approvedDomains,
      },
      pod: {
        id: pod.id,
        name: pod.name,
        description: pod.description,
        defaultStanding: pod.defaultStanding,
        status: pod.status,
        providerPodIdentity: pod.providerPodIdentity,
      },
      habitatId: ctx.habitatId,
      grants: grants.map((g) => ({
        id: g.id,
        grantType: g.grantType,
        standing: g.standing,
        actionScopes: g.actionScopes,
        eligibilityMode: g.eligibilityMode,
        includeFutureMatches: g.includeFutureMatches,
        graceWindowHours: g.graceWindowHours,
        status: g.status,
        expiresAt: g.expiresAt,
      })),
    };
  });

  /** GET /api/shared/habitats/:id — scoped habitat summary (no internal config) */
  fastify.get<{ Params: { id: string } }>(
    "/habitats/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const ctx = requireRemoteContext(request);
      if (request.params.id !== ctx.habitatId) {
        throw remoteAccessDenied("HABITAT_MISMATCH", request.params.id, ctx);
      }
      const habitat = habitatRepo.getHabitatById(ctx.habitatId);
      if (!habitat) {
        throw notFound("Habitat not found");
      }
      return {
        habitat: {
          id: habitat.id,
          name: habitat.name,
          description: habitat.description ?? null,
          createdAt: habitat.createdAt,
        },
      };
    },
  );

  // -------------------------------------------------------------------------
  // Missions
  // -------------------------------------------------------------------------

  /** GET /api/shared/habitats/:id/missions — missions visible to this participant */
  fastify.get<{ Params: { id: string } }>(
    "/habitats/:id/missions",
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const ctx = requireRemoteContext(request);
      if (request.params.id !== ctx.habitatId) {
        throw remoteAccessDenied("HABITAT_MISMATCH", request.params.id, ctx);
      }
      const result = missionRepo.getMissionsByHabitatId(ctx.habitatId);
      const visible = result.missions.filter(
        (m) => isTargetVisibleToParticipant(ctx, "mission", m.id).visible,
      );
      return { missions: visible, total: visible.length };
    },
  );

  /** GET /api/shared/missions/:id — single mission if visible */
  fastify.get<{ Params: { id: string } }>(
    "/missions/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const ctx = requireRemoteContext(request);
      const mission = missionRepo.getMissionById(request.params.id);
      if (!mission) throw notFound("Mission not found");
      if (mission.habitatId !== ctx.habitatId) {
        throw remoteAccessDenied("HABITAT_MISMATCH", mission.id, ctx);
      }
      const visibility = isTargetVisibleToParticipant(ctx, "mission", mission.id);
      if (!visibility.visible) {
        throw remoteAccessDenied("TARGET_NOT_VISIBLE", mission.id, ctx);
      }
      return { mission };
    },
  );

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  /** GET /api/shared/tasks/:id — single task if visible */
  fastify.get<{ Params: { id: string } }>(
    "/tasks/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const ctx = requireRemoteContext(request);
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) throw notFound("Task not found");
      const taskHabitatId = taskRepo.getHabitatIdForTask(request.params.id);
      if (!taskHabitatId || taskHabitatId !== ctx.habitatId) {
        throw remoteAccessDenied("HABITAT_MISMATCH", task.id, ctx);
      }
      const visibility = isTargetVisibleToParticipant(ctx, "task", task.id);
      if (!visibility.visible) {
        throw remoteAccessDenied("TARGET_NOT_VISIBLE", task.id, ctx);
      }
      return { task };
    },
  );

  /** POST /api/shared/tasks/:id/claim — claim a task (requires "claim" action) */
  fastify.post<{ Params: { id: string } }>(
    "/tasks/:id/claim",
    {
      preHandler: [remoteActionScope("claim"), idempotentRemoteWrite("task.claim")],
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const ctx = requireRemoteContext(request);
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) throw notFound("Task not found");
      const taskHabitatId = taskRepo.getHabitatIdForTask(request.params.id);
      if (!taskHabitatId || taskHabitatId !== ctx.habitatId) {
        throw remoteAccessDenied("HABITAT_MISMATCH", task.id, ctx);
      }
      const visibility = isTargetVisibleToParticipant(ctx, "task", task.id);
      if (!visibility.visible) {
        throw remoteAccessDenied("TARGET_NOT_VISIBLE", task.id, ctx);
      }
      try {
        const result = claimTaskForRemote(request.params.id, ctx);
        if (!result.success) {
          throw conflict(result.reason ?? "Cannot claim task", "TASK_CLAIM_FAILED");
        }
        const responseBody = { task: result.task };
        completeRemoteIdempotency(request, 200, responseBody);
        reply.code(200).send(responseBody);
        return;
      } catch (err) {
        if (err instanceof InterceptorVetoError) {
          // Anti-probing: suppress blockedBy detail for remote clients
          throw forbidden("Transition blocked by lifecycle interceptor", "INTERCEPTOR_VETO");
        }
        failRemoteIdempotency(request, (err as Error).message);
        throw err;
      }
    },
  );

  /** POST /api/shared/tasks/:id/heartbeat — task heartbeat (requires "heartbeat") */
  fastify.post<{ Params: { id: string } }>(
    "/tasks/:id/heartbeat",
    {
      preHandler: [remoteActionScope("heartbeat"), idempotentRemoteWrite("task.heartbeat")],
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const ctx = requireRemoteContext(request);
      const body = parseBody(heartbeatTaskSchema, request.body ?? {});
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) throw notFound("Task not found");
      const taskHabitatId = taskRepo.getHabitatIdForTask(request.params.id);
      if (!taskHabitatId || taskHabitatId !== ctx.habitatId) {
        throw remoteAccessDenied("HABITAT_MISMATCH", task.id, ctx);
      }
      if (task.remoteAssignedParticipantId !== ctx.participant.id) {
        throw forbidden("Task is not claimed by this participant", "TASK_NOT_OWNED");
      }
      const touched = taskRepo.touchLastActivity(task.id);
      if (!touched.success) throw notFound("Task not found");
      const responseBody = {
        task: {
          id: task.id,
          status: task.status,
          lastActivityAt: touched.task.lastActivityAt,
        },
        acknowledged: true,
        progress: body.progress ?? null,
      };
      completeRemoteIdempotency(request, 200, responseBody);
      reply.code(200).send(responseBody);
    },
  );

  /** POST /api/shared/tasks/:id/submit — submit task (requires "submit") */
  fastify.post<{ Params: { id: string } }>(
    "/tasks/:id/submit",
    {
      preHandler: [remoteActionScope("submit"), idempotentRemoteWrite("task.submit")],
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const ctx = requireRemoteContext(request);
      const body = parseBody(submitTaskSchema, request.body);
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) throw notFound("Task not found");
      const taskHabitatId = taskRepo.getHabitatIdForTask(request.params.id);
      if (!taskHabitatId || taskHabitatId !== ctx.habitatId) {
        throw remoteAccessDenied("HABITAT_MISMATCH", task.id, ctx);
      }
      try {
        const artifacts = (body.artifacts ?? []).map((a) => ({
          type: "pr" as const,
          url: a.url ?? "",
          description: a.kind,
        }));
        const result = submitTaskForRemote(request.params.id, ctx, body.result, artifacts);
        if (!result.success) {
          if (result.reason === "not_owned") {
            throw forbidden("Task is not claimed by this participant", "TASK_NOT_OWNED");
          }
          throw conflict("Cannot submit task in current state", "TASK_SUBMIT_FAILED");
        }
        const responseBody = {
          success: true,
          task: {
            id: result.task.id,
            status: result.task.status,
            submittedAt: result.task.submittedAt,
          },
        };
        completeRemoteIdempotency(request, 200, responseBody);
        reply.code(200).send(responseBody);
        return;
      } catch (err) {
        if (err instanceof InterceptorVetoError) {
          // Anti-probing: suppress blockedBy detail for remote clients
          throw forbidden("Transition blocked by lifecycle interceptor", "INTERCEPTOR_VETO");
        }
        failRemoteIdempotency(request, (err as Error).message);
        throw err;
      }
    },
  );

  /** POST /api/shared/tasks/:id/release — release task (requires "release") */
  fastify.post<{ Params: { id: string } }>(
    "/tasks/:id/release",
    {
      preHandler: [remoteActionScope("release"), idempotentRemoteWrite("task.release")],
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const ctx = requireRemoteContext(request);
      const body = parseBody(releaseTaskSchema, request.body);
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) throw notFound("Task not found");
      const taskHabitatId = taskRepo.getHabitatIdForTask(request.params.id);
      if (!taskHabitatId || taskHabitatId !== ctx.habitatId) {
        throw remoteAccessDenied("HABITAT_MISMATCH", task.id, ctx);
      }
      try {
        const result = releaseTaskForRemote(request.params.id, ctx, body.reason);
        if (!result.success) {
          if (result.reason === "not_owned") {
            throw forbidden("Task is not claimed by this participant", "TASK_NOT_OWNED");
          }
          throw conflict("Cannot release task in current state", "TASK_RELEASE_FAILED");
        }
        const responseBody = { task: result.task };
        completeRemoteIdempotency(request, 200, responseBody);
        reply.code(200).send(responseBody);
        return;
      } catch (err) {
        if (err instanceof InterceptorVetoError) {
          // Anti-probing: suppress blockedBy detail for remote clients
          throw forbidden("Transition blocked by lifecycle interceptor", "INTERCEPTOR_VETO");
        }
        failRemoteIdempotency(request, (err as Error).message);
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Comments (read + write)
  // -------------------------------------------------------------------------

  /** GET /api/shared/tasks/:id/comments — list task comments */
  fastify.get<{ Params: { id: string } }>(
    "/tasks/:id/comments",
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const ctx = requireRemoteContext(request);
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) throw notFound("Task not found");
      const taskHabitatId = taskRepo.getHabitatIdForTask(request.params.id);
      if (!taskHabitatId || taskHabitatId !== ctx.habitatId) {
        throw remoteAccessDenied("HABITAT_MISMATCH", task.id, ctx);
      }
      const visibility = isTargetVisibleToParticipant(ctx, "task", task.id);
      if (!visibility.visible) {
        throw remoteAccessDenied("TARGET_NOT_VISIBLE", task.id, ctx);
      }
      return commentService.getComments(request.params.id, 50, 0);
    },
  );

  /** POST /api/shared/tasks/:id/comments — add task comment (requires "comment") */
  fastify.post<{ Params: { id: string } }>(
    "/tasks/:id/comments",
    {
      preHandler: [remoteActionScope("comment"), idempotentRemoteWrite("task.comment")],
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const ctx = requireRemoteContext(request);
      const body = parseBody(commentBodySchema, request.body);
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) throw notFound("Task not found");
      const taskHabitatId = taskRepo.getHabitatIdForTask(request.params.id);
      if (!taskHabitatId || taskHabitatId !== ctx.habitatId) {
        throw remoteAccessDenied("HABITAT_MISMATCH", task.id, ctx);
      }
      const visibility = isTargetVisibleToParticipant(ctx, "task", task.id);
      if (!visibility.visible) {
        throw remoteAccessDenied("TARGET_NOT_VISIBLE", task.id, ctx);
      }
      try {
        const authorType = mapParticipantToActorType(
          ctx.participant.participantType as "remote_human" | "remote_orcy",
        );
        const comment = commentService.addComment(
          request.params.id,
          authorType,
          ctx.participant.id,
          body.content,
          body.parentId,
        );
        const responseBody = { comment };
        completeRemoteIdempotency(request, 201, responseBody);
        reply.code(201).send(responseBody);
        return;
      } catch (err) {
        const message = (err as Error).message;
        if (message === "Task not found") {
          throw notFound("Task not found");
        }
        if (
          message === "Parent comment not found" ||
          message === "Parent comment belongs to a different task"
        ) {
          throw badRequest(message);
        }
        failRemoteIdempotency(request, message);
        throw err;
      }
    },
  );

  /** GET /api/shared/missions/:id/comments — list mission comments */
  fastify.get<{ Params: { id: string } }>(
    "/missions/:id/comments",
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const ctx = requireRemoteContext(request);
      const mission = missionRepo.getMissionById(request.params.id);
      if (!mission) throw notFound("Mission not found");
      if (mission.habitatId !== ctx.habitatId) {
        throw remoteAccessDenied("HABITAT_MISMATCH", mission.id, ctx);
      }
      const visibility = isTargetVisibleToParticipant(ctx, "mission", mission.id);
      if (!visibility.visible) {
        throw remoteAccessDenied("TARGET_NOT_VISIBLE", mission.id, ctx);
      }
      return featureCommentService.getComments(request.params.id, 50, 0);
    },
  );

  /** POST /api/shared/missions/:id/comments — add mission comment */
  fastify.post<{ Params: { id: string } }>(
    "/missions/:id/comments",
    {
      preHandler: [remoteActionScope("comment"), idempotentRemoteWrite("mission.comment")],
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const ctx = requireRemoteContext(request);
      const body = parseBody(commentBodySchema, request.body);
      const mission = missionRepo.getMissionById(request.params.id);
      if (!mission) throw notFound("Mission not found");
      if (mission.habitatId !== ctx.habitatId) {
        throw remoteAccessDenied("HABITAT_MISMATCH", mission.id, ctx);
      }
      const visibility = isTargetVisibleToParticipant(ctx, "mission", mission.id);
      if (!visibility.visible) {
        throw remoteAccessDenied("TARGET_NOT_VISIBLE", mission.id, ctx);
      }
      try {
        const authorType = mapParticipantToActorType(
          ctx.participant.participantType as "remote_human" | "remote_orcy",
        );
        const comment = featureCommentService.addComment(
          request.params.id,
          authorType,
          ctx.participant.id,
          body.content,
          body.parentId,
        );
        const responseBody = { comment };
        completeRemoteIdempotency(request, 201, responseBody);
        reply.code(201).send(responseBody);
        return;
      } catch (err) {
        const message = (err as Error).message;
        if (message === "Mission not found") {
          throw notFound("Mission not found");
        }
        if (
          message === "Parent comment not found" ||
          message === "Parent comment belongs to a different mission"
        ) {
          throw badRequest(message);
        }
        failRemoteIdempotency(request, message);
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Pulse
  // -------------------------------------------------------------------------

  /** GET /api/shared/missions/:id/pulse — read mission pulse (requires "read") */
  fastify.get<{ Params: { id: string } }>(
    "/missions/:id/pulse",
    {
      preHandler: [remoteActionScope("read")],
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const ctx = requireRemoteContext(request);
      const mission = missionRepo.getMissionById(request.params.id);
      if (!mission) throw notFound("Mission not found");
      if (mission.habitatId !== ctx.habitatId) {
        throw remoteAccessDenied("HABITAT_MISMATCH", mission.id, ctx);
      }
      const visibility = isTargetVisibleToParticipant(ctx, "mission", mission.id);
      if (!visibility.visible) {
        throw remoteAccessDenied("TARGET_NOT_VISIBLE", mission.id, ctx);
      }
      const result = pulseRepo.getPulsesByMission(request.params.id);
      return { items: result.pulses, total: result.total };
    },
  );

  /** POST /api/shared/missions/:id/pulse — post mission pulse (requires "pulse.post") */
  fastify.post<{ Params: { id: string } }>(
    "/missions/:id/pulse",
    {
      preHandler: [remoteActionScope("pulse.post"), idempotentRemoteWrite("mission.pulse.post")],
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const ctx = requireRemoteContext(request);
      const body = parseBody(postPulseSchema, request.body);
      const mission = missionRepo.getMissionById(request.params.id);
      if (!mission) throw notFound("Mission not found");
      if (mission.habitatId !== ctx.habitatId) {
        throw remoteAccessDenied("HABITAT_MISMATCH", mission.id, ctx);
      }
      const visibility = isTargetVisibleToParticipant(ctx, "mission", mission.id);
      if (!visibility.visible) {
        throw remoteAccessDenied("TARGET_NOT_VISIBLE", mission.id, ctx);
      }
      try {
        const result = pulseService.postMissionPulseSignal({
          missionId: request.params.id,
          caller: asPulsePostCaller(ctx),
          body: {
            signalType: body.signalType,
            subject: body.subject,
            body: body.body ?? "",
            taskId: body.taskId,
            replyToId: body.replyToId,
          },
        });
        emitRemoteOriginatedNotification({
          habitatId: ctx.habitatId,
          eventType: "pulse.signal_posted",
          sourceType: "pulse",
          sourceId: result.pulse.id,
          targetType: "mission",
          targetId: mission.id,
          severity: "info",
          title: body.subject,
          body: body.body ?? undefined,
          payload: {
            missionId: mission.id,
            signalType: body.signalType,
            pulseId: result.pulse.id,
          },
          actorType: ctx.participant.participantType as "remote_human" | "remote_orcy",
          actorId: ctx.participant.id,
          podId: ctx.pod.id,
        });
        const responseBody = {
          pulse: result.pulse,
          linkedTask: result.linkedTask,
          blockerTaskCreated: result.blockerTaskCreated,
        };
        completeRemoteIdempotency(request, 201, responseBody);
        reply.code(201).send(responseBody);
        return;
      } catch (err) {
        failRemoteIdempotency(request, (err as Error).message);
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Evidence links (URL/metadata only — NO branch/commit/file scan)
  // -------------------------------------------------------------------------

  /** POST /api/shared/tasks/:id/evidence-links — URL/metadata evidence (requires "evidence_link") */
  fastify.post<{ Params: { id: string } }>(
    "/tasks/:id/evidence-links",
    {
      preHandler: [remoteActionScope("evidence_link"), idempotentRemoteWrite("task.evidence_link")],
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const ctx = requireRemoteContext(request);
      const body = parseBody(evidenceLinkSchema, request.body);
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) throw notFound("Task not found");
      const taskHabitatId = taskRepo.getHabitatIdForTask(request.params.id);
      if (!taskHabitatId || taskHabitatId !== ctx.habitatId) {
        throw remoteAccessDenied("HABITAT_MISMATCH", task.id, ctx);
      }
      const visibility = isTargetVisibleToParticipant(ctx, "task", task.id);
      if (!visibility.visible) {
        throw remoteAccessDenied("TARGET_NOT_VISIBLE", task.id, ctx);
      }
      try {
        // Remote participants can ONLY link external URLs. They cannot specify
        // branches, commits, or file changes. Use the URL-only linking path.
        const result = codeEvidenceLinking.linkExternalUrl(
          "task",
          request.params.id,
          body.url,
          "remote",
          asCodeEvidenceActor(ctx),
          false,
        );
        const responseBody = { link: result };
        completeRemoteIdempotency(request, 201, responseBody);
        reply.code(201).send(responseBody);
        return;
      } catch (err) {
        failRemoteIdempotency(request, (err as Error).message);
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Workflow context (read-only — requires "read" scope)
  // -------------------------------------------------------------------------

  /** GET /api/shared/missions/:id/workflow — mission workflow shape (requires "read") */
  fastify.get<{ Params: { id: string } }>(
    "/missions/:id/workflow",
    {
      preHandler: [remoteActionScope("read")],
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const ctx = requireRemoteContext(request);
      const mission = missionRepo.getMissionById(request.params.id);
      if (!mission) throw notFound("Mission not found");
      if (mission.habitatId !== ctx.habitatId) {
        throw remoteAccessDenied("HABITAT_MISMATCH", mission.id, ctx);
      }
      const visibility = isTargetVisibleToParticipant(ctx, "mission", mission.id);
      if (!visibility.visible) {
        throw remoteAccessDenied("TARGET_NOT_VISIBLE", mission.id, ctx);
      }
      const workflow = workflowService.getWorkflowForMission(mission.id);
      if (!workflow) {
        throw notFound("No active workflow attached to this mission");
      }
      const gates = workflowService.getWorkflowShape(workflow.id);
      return { workflow, gates };
    },
  );

  /** GET /api/shared/tasks/:id/workflow-context — upstream/downstream gates for one task (requires "read") */
  fastify.get<{ Params: { id: string } }>(
    "/tasks/:id/workflow-context",
    {
      preHandler: [remoteActionScope("read")],
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const ctx = requireRemoteContext(request);
      const task = taskRepo.getTaskById(request.params.id);
      if (!task) throw notFound("Task not found");
      const taskHabitatId = taskRepo.getHabitatIdForTask(request.params.id);
      if (!taskHabitatId || taskHabitatId !== ctx.habitatId) {
        throw remoteAccessDenied("HABITAT_MISMATCH", task.id, ctx);
      }
      const visibility = isTargetVisibleToParticipant(ctx, "task", task.id);
      if (!visibility.visible) {
        throw remoteAccessDenied("TARGET_NOT_VISIBLE", task.id, ctx);
      }
      const context = workflowService.getTaskWorkflowContext(request.params.id);
      if (context.upstream.length === 0 && context.downstream.length === 0) {
        throw notFound("Task is not part of any workflow");
      }
      return context;
    },
  );

  // -------------------------------------------------------------------------
  // Notifications (scoped to remote participant as recipient)
  // -------------------------------------------------------------------------

  /** GET /api/shared/notifications — inbox for the remote participant */
  fastify.get("/notifications", async (request: FastifyRequest, _reply: FastifyReply) => {
    const ctx = requireRemoteContext(request);
    const q = paginationSchema.parse(request.query ?? {});
    const recipientType = mapParticipantToActorType(
      ctx.participant.participantType as "remote_human" | "remote_orcy",
    );
    return deliveryRepo.getActiveInbox(ctx.habitatId, recipientType, ctx.participant.id, {
      limit: q.limit,
      offset: q.offset,
    });
  });

  /** GET /api/shared/notifications/history — history for the remote participant */
  fastify.get("/notifications/history", async (request: FastifyRequest, _reply: FastifyReply) => {
    const ctx = requireRemoteContext(request);
    const q = paginationSchema.parse(request.query ?? {});
    const recipientType = mapParticipantToActorType(
      ctx.participant.participantType as "remote_human" | "remote_orcy",
    );
    return deliveryRepo.getDeliveryHistory(ctx.habitatId, recipientType, ctx.participant.id, {
      limit: q.limit,
      offset: q.offset,
    });
  });

  /** POST /api/shared/notifications/deliveries/:deliveryId/ack — acknowledge a delivery */
  fastify.post<{ Params: { deliveryId: string } }>(
    "/notifications/deliveries/:deliveryId/ack",
    {
      preHandler: [remoteActionScope("notification.write"), idempotentRemoteWrite("notification.ack")],
    },
    async (request: FastifyRequest<{ Params: { deliveryId: string } }>, reply: FastifyReply) => {
      const ctx = requireRemoteContext(request);
      const recipientType = mapParticipantToActorType(
        ctx.participant.participantType as "remote_human" | "remote_orcy",
      );
      const delivery = deliveryRepo.getNotificationDeliveryById(request.params.deliveryId);
      if (!delivery) throw notFound("Notification delivery not found");
      if (
        delivery.habitatId !== ctx.habitatId ||
        delivery.recipientType !== recipientType ||
        delivery.recipientId !== ctx.participant.id
      ) {
        throw forbidden("You can only acknowledge your own deliveries", "NOT_DELIVERY_OWNER");
      }
      const updated = deliveryRepo.acknowledgeDelivery(request.params.deliveryId);
      const responseBody = { delivery: updated };
      completeRemoteIdempotency(request, 200, responseBody);
      reply.code(200).send(responseBody);
    },
  );

  /** POST /api/shared/notifications/deliveries/:deliveryId/snooze — snooze a delivery */
  fastify.post<{ Params: { deliveryId: string } }>(
    "/notifications/deliveries/:deliveryId/snooze",
    {
      preHandler: [remoteActionScope("notification.write"), idempotentRemoteWrite("notification.snooze")],
    },
    async (request: FastifyRequest<{ Params: { deliveryId: string } }>, reply: FastifyReply) => {
      const ctx = requireRemoteContext(request);
      const body = parseBody(snoozeSchema, request.body);
      const recipientType = mapParticipantToActorType(
        ctx.participant.participantType as "remote_human" | "remote_orcy",
      );
      const delivery = deliveryRepo.getNotificationDeliveryById(request.params.deliveryId);
      if (!delivery) throw notFound("Notification delivery not found");
      if (
        delivery.habitatId !== ctx.habitatId ||
        delivery.recipientType !== recipientType ||
        delivery.recipientId !== ctx.participant.id
      ) {
        throw forbidden("You can only snooze your own deliveries", "NOT_DELIVERY_OWNER");
      }
      const updated = deliveryRepo.snoozeDelivery(request.params.deliveryId, body.snoozedUntil);
      const responseBody = { delivery: updated };
      completeRemoteIdempotency(request, 200, responseBody);
      reply.code(200).send(responseBody);
    },
  );

  // -------------------------------------------------------------------------
  // Trust metadata (self-service reads)
  // -------------------------------------------------------------------------

  /** GET /api/shared/grants — list all grants for this participant */
  fastify.get("/grants", async (request: FastifyRequest, _reply: FastifyReply) => {
    const ctx = requireRemoteContext(request);
    return { grants: listMyGrants(ctx) };
  });

  /** GET /api/shared/credentials/current — current credential metadata (NO secret) */
  fastify.get("/credentials/current", async (request: FastifyRequest, _reply: FastifyReply) => {
    const ctx = requireRemoteContext(request);
    const credential = credentialService.verifyRemoteKeyById(ctx.credentialId);
    if (!credential) throw notFound("Credential not found");
    if (credential.habitatId !== ctx.habitatId) {
      throw remoteAccessDenied("HABITAT_MISMATCH", ctx.credentialId, ctx);
    }
    return {
      credential: {
        id: credential.id,
        credentialType: credential.credentialType,
        label: credential.label,
        status: credential.status,
        expiresAt: credential.expiresAt,
        lastUsedAt: credential.lastUsedAt,
        createdAt: credential.createdAt,
      },
    };
  });

  // -------------------------------------------------------------------------
  // Finding triage lifecycle (remote route intent — T4)
  // -------------------------------------------------------------------------

  /**
   * POST /api/shared/triage/findings/:id/route — remote participant routes a
   * Finding into its lifecycle bucket. Requires the `triage.route` action
   * scope AND an exact-Task allowlist target on a same active grant; observer,
   * grace, baseline, rule-based, broader-Task, Habitat/Mission-only, split,
   * stale-claim, and disconnected states never authorize.
   *
   * Anti-probing: not-found and not-authorized are both collapsed to 403 so
   * the route cannot be used as a Finding existence oracle.
   */
  fastify.post<{ Params: { id: string } }>(
    "/triage/findings/:id/route",
    {
      preHandler: [remoteActionScope("triage.route"), idempotentRemoteWrite("triage.route")],
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const ctx = requireRemoteContext(request);
      const parsed = remoteRouteBodySchema.safeParse(request.body);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        throw badRequest(`Invalid request body: ${issues}`);
      }

      const finding = findingTriageRepo.getById(request.params.id);
      if (!finding) {
        // Anti-probing: collapse existence leak into a generic 403.
        logger.warn(
          {
            findingId: request.params.id,
            participantId: ctx.participant.id,
            podId: ctx.pod.id,
            habitatId: ctx.habitatId,
            reason: "REMOTE_FINDING_NOT_FOUND",
          },
          "remote triage route denied",
        );
        failRemoteIdempotency(request, "Access denied");
        throw forbidden("Access denied");
      }

      // Habitat boundary check
      if (finding.habitatId !== ctx.habitatId) {
        logger.warn(
          {
            findingId: finding.id,
            habitatId: finding.habitatId,
            participantId: ctx.participant.id,
            reason: "REMOTE_TRIAGE_HABITAT_MISMATCH",
          },
          "remote triage route denied",
        );
        failRemoteIdempotency(request, "Access denied");
        throw forbidden("Access denied");
      }

      // Authority: claim-bound predicate (one same active grant with both
      // `triage.route` scope AND exact Task allowlist target).
      const authResult = checkRemoteRouteAuthority({
        finding: {
          id: finding.id,
          habitatId: finding.habitatId,
          admittedByInvestigationTaskId: finding.admittedByInvestigationTaskId,
        },
        remote: {
          type: mapParticipantToActorType(
            ctx.participant.participantType as "remote_human" | "remote_orcy",
          ),
          id: ctx.participant.id,
          habitatId: ctx.habitatId,
          remoteParticipant: ctx,
        },
      });

      if (authResult.kind === "deny") {
        logger.warn(
          {
            findingId: finding.id,
            participantId: ctx.participant.id,
            habitatId: ctx.habitatId,
            code: authResult.code,
            internalReason: authResult.message,
          },
          "remote triage route authority denied",
        );
        failRemoteIdempotency(request, "Access denied");
        // Anti-probing: collapse not-found and not-authorized into a single 403.
        throw forbidden("Access denied");
      }

      const lifecycleActor = {
        type: authResult.actor,
        id: ctx.participant.id,
      } as const;

      const outcome = routeFindingLifecycle({
        findingId: finding.id,
        actor: lifecycleActor,
        route: parsed.data,
      });

      // Map the lifecycle outcome to the HTTP response. Anti-probing keeps
      // not-found and not-authorized collapsed into a single 403.
      if (outcome.outcome === "applied" || outcome.outcome === "replayed") {
        const responseBody = { finding: outcome.value };
        completeRemoteIdempotency(request, 200, responseBody);
        reply.code(200).send(responseBody);
        return;
      }
      if (outcome.outcome === "busy") {
        const retryAfterSeconds = Math.max(1, Math.ceil(outcome.retryAfterMs / 1000));
        reply.header("Retry-After", String(retryAfterSeconds));
        failRemoteIdempotency(request, `LIFECYCLE_BUSY_${retryAfterSeconds}`);
        throw conflict(
          `Lifecycle writer reservation exhausted; retry after ${retryAfterSeconds}s`,
          "LIFECYCLE_BUSY",
        );
      }

      // conflict branch — anti-probing collapse + idempotency cleanup
      const reason = outcome.reason;
      if (reason === "not_found" || reason === "not_authorized") {
        failRemoteIdempotency(request, "Access denied");
        throw forbidden("Access denied");
      }
      if (reason === "terminal") {
        failRemoteIdempotency(request, "Finding terminal");
        throw conflict(
          "Finding is in terminal state. Recurrence creates a new row.",
          "FINDING_TERMINAL",
        );
      }
      if (reason === "legacy_lineage_repair_required") {
        failRemoteIdempotency(request, "Legacy lineage repair required");
        throw conflict(
          "Finding legacy lineage repair required before automatic routing.",
          "LEGACY_LINEAGE_REPAIR_REQUIRED",
        );
      }
      if (reason === "different_route") {
        failRemoteIdempotency(request, "Different route");
        throw conflict(
          "Finding already routed with a different bucket/fingerprint.",
          "DIFFERENT_ROUTE",
        );
      }
      if (reason === "invalid_input") {
        failRemoteIdempotency(request, "Invalid input");
        throw badRequest(
          typeof outcome.current === "string"
            ? outcome.current
            : "Invalid triage command input",
        );
      }
      if (reason === "invalid_dependency") {
        // Anti-probing: missing-id and cross-Habitat produce ONE
        // indistinguishable 409 — never the id, never which condition failed,
        // only the position.
        const index =
          outcome.current && typeof outcome.current === "object" && "index" in outcome.current
            ? (outcome.current as { index: number }).index
            : null;
        const message =
          typeof index === "number"
            ? `Dependency at position ${index} is not a valid same-Habitat Mission.`
            : "One or more dependencies are not valid same-Habitat Missions.";
        failRemoteIdempotency(request, "Invalid dependency");
        throw conflict(message, "INVALID_DEPENDENCY");
      }
      failRemoteIdempotency(request, "Conflict");
      throw conflict("Triage command conflict", "TRIAGE_CONFLICT");
      // No outer catch: the success/conflict branches above explicitly
      // terminalize the idempotency record. The plugin-level onError hook
      // (registered at the top of sharedApiRoutes) marks the record as failed
      // for any error that escapes the handler.
    },
  );
}
