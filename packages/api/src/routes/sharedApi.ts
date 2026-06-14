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
import { badRequest, forbidden, notFound, unauthorized, conflict } from "../errors.js";
import * as habitatRepo from "../repositories/board.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as credentialService from "../services/remoteCredentialService.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as commentService from "../services/commentService.js";
import * as featureCommentService from "../services/featureCommentService.js";
import * as pulseService from "../services/pulseService.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as codeEvidenceLinking from "../services/codeEvidence/linking.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import type { CodeEvidenceActor } from "../services/codeEvidence/types.js";

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
    url: z.string().url(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

const snoozeSchema = z.object({ snoozedUntil: z.string().min(1) }).strict();

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

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function sharedApiRoutes(fastify: FastifyInstance): Promise<void> {
  // Every route requires remote participant auth
  fastify.addHook("preHandler", remoteParticipantAuth);

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
        throw forbidden("Cannot access other habitats", "HABITAT_MISMATCH");
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
        throw forbidden("Cannot access other habitats", "HABITAT_MISMATCH");
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
        throw forbidden("Cannot access missions in other habitats", "HABITAT_MISMATCH");
      }
      const visibility = isTargetVisibleToParticipant(ctx, "mission", mission.id);
      if (!visibility.visible) {
        throw forbidden("Mission not visible to this remote participant", "TARGET_NOT_VISIBLE");
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
        throw forbidden("Cannot access tasks in other habitats", "HABITAT_MISMATCH");
      }
      const visibility = isTargetVisibleToParticipant(ctx, "task", task.id);
      if (!visibility.visible) {
        throw forbidden("Task not visible to this remote participant", "TARGET_NOT_VISIBLE");
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
        throw forbidden("Cannot claim tasks in other habitats", "HABITAT_MISMATCH");
      }
      const visibility = isTargetVisibleToParticipant(ctx, "task", task.id);
      if (!visibility.visible) {
        throw forbidden("Task not visible to this remote participant", "TARGET_NOT_VISIBLE");
      }
      try {
        const result = taskStateMachine.claimTaskByRemoteParticipant(
          request.params.id,
          ctx.participant.id,
        );
        if (!result.success) {
          throw conflict(result.reason ?? "Cannot claim task", "TASK_CLAIM_FAILED");
        }
        const responseBody = { task: result.task };
        completeRemoteIdempotency(request, 200, responseBody);
        reply.code(200).send(responseBody);
        return;
      } catch (err) {
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
        throw forbidden("Cannot heartbeat tasks in other habitats", "HABITAT_MISMATCH");
      }
      if (task.remoteAssignedParticipantId !== ctx.participant.id) {
        throw forbidden("Task is not claimed by this participant", "TASK_NOT_OWNED");
      }
      const responseBody = {
        task: {
          id: task.id,
          status: task.status,
          lastActivityAt: new Date().toISOString(),
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
        throw forbidden("Cannot submit tasks in other habitats", "HABITAT_MISMATCH");
      }
      if (task.remoteAssignedParticipantId !== ctx.participant.id) {
        throw forbidden("Task is not claimed by this participant", "TASK_NOT_OWNED");
      }
      try {
        const artifacts = (body.artifacts ?? []).map((a) => ({
          type: "pr" as const,
          url: a.url ?? "",
          description: a.kind,
        }));
        const submitted = taskStateMachine.submitTaskByRemoteParticipant(
          request.params.id,
          ctx.participant.id,
          body.result,
          artifacts,
        );
        if (!submitted) {
          throw conflict("Cannot submit task in current state", "TASK_SUBMIT_FAILED");
        }
        const responseBody = {
          success: true,
          task: {
            id: submitted.id,
            status: submitted.status,
            submittedAt: submitted.submittedAt,
          },
        };
        completeRemoteIdempotency(request, 200, responseBody);
        reply.code(200).send(responseBody);
        return;
      } catch (err) {
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
        throw forbidden("Cannot release tasks in other habitats", "HABITAT_MISMATCH");
      }
      try {
        const released = taskStateMachine.releaseTaskByRemoteParticipant(
          request.params.id,
          ctx.participant.id,
        );
        if (!released) {
          throw conflict("Cannot release task in current state", "TASK_RELEASE_FAILED");
        }
        const responseBody = { task: released };
        completeRemoteIdempotency(request, 200, responseBody);
        reply.code(200).send(responseBody);
        return;
      } catch (err) {
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
        throw forbidden("Cannot read comments in other habitats", "HABITAT_MISMATCH");
      }
      const visibility = isTargetVisibleToParticipant(ctx, "task", task.id);
      if (!visibility.visible) {
        throw forbidden("Task not visible to this remote participant", "TARGET_NOT_VISIBLE");
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
        throw forbidden("Cannot comment on tasks in other habitats", "HABITAT_MISMATCH");
      }
      const visibility = isTargetVisibleToParticipant(ctx, "task", task.id);
      if (!visibility.visible) {
        throw forbidden("Task not visible to this remote participant", "TARGET_NOT_VISIBLE");
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
        throw forbidden("Cannot read comments in other habitats", "HABITAT_MISMATCH");
      }
      const visibility = isTargetVisibleToParticipant(ctx, "mission", mission.id);
      if (!visibility.visible) {
        throw forbidden("Mission not visible to this remote participant", "TARGET_NOT_VISIBLE");
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
        throw forbidden("Cannot comment on missions in other habitats", "HABITAT_MISMATCH");
      }
      const visibility = isTargetVisibleToParticipant(ctx, "mission", mission.id);
      if (!visibility.visible) {
        throw forbidden("Mission not visible to this remote participant", "TARGET_NOT_VISIBLE");
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
        throw forbidden("Cannot read pulse in other habitats", "HABITAT_MISMATCH");
      }
      const visibility = isTargetVisibleToParticipant(ctx, "mission", mission.id);
      if (!visibility.visible) {
        throw forbidden("Mission not visible to this remote participant", "TARGET_NOT_VISIBLE");
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
        throw forbidden("Cannot post pulse in other habitats", "HABITAT_MISMATCH");
      }
      const visibility = isTargetVisibleToParticipant(ctx, "mission", mission.id);
      if (!visibility.visible) {
        throw forbidden("Mission not visible to this remote participant", "TARGET_NOT_VISIBLE");
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
        throw forbidden("Cannot link evidence in other habitats", "HABITAT_MISMATCH");
      }
      const visibility = isTargetVisibleToParticipant(ctx, "task", task.id);
      if (!visibility.visible) {
        throw forbidden("Task not visible to this remote participant", "TARGET_NOT_VISIBLE");
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
      preHandler: [idempotentRemoteWrite("notification.ack")],
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
      preHandler: [idempotentRemoteWrite("notification.snooze")],
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
      throw forbidden("Credential habitat mismatch", "HABITAT_MISMATCH");
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
}
