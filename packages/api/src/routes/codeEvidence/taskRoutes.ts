import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type {
  CodeEvidenceCorrectionInput,
  CodeEvidenceGapInput,
  CodeEvidenceGapResolveInput,
  CodeEvidenceLinkInput,
  CodeEvidenceNotApplicableInput,
} from "@orcy/shared";

import * as codeEvidenceService from "../../services/codeEvidenceService.js";
import { agentOrHumanAuth } from "../../middleware/auth.js";
import * as eventRepo from "../../repositories/events/event-crud.js";
import * as taskRepo from "../../repositories/task.js";
import { badRequest, notFound } from "../../errors.js";
import { sseBroadcaster } from "../../sse/broadcaster.js";
import {
  correctLinkSchema,
  emitEvidenceEvent,
  gapIdParamsSchema,
  gapResolveSchema,
  gapSchema,
  getActor,
  getHabitatIdForTask,
  includeHistoryQuerySchema,
  linkCodeSchema,
  linkIdParamsSchema,
  notApplicableSchema,
  taskIdParamsSchema,
} from "./shared.js";

export async function taskCodeEvidenceRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/tasks/:taskId/code-evidence",
    {
      schema: { params: taskIdParamsSchema, querystring: includeHistoryQuerySchema },
      preHandler: [agentOrHumanAuth],
    },
    async (request) => {
      const task = taskRepo.getTaskById(request.params.taskId);
      if (!task) throw notFound("Task not found");

      return codeEvidenceService.getTaskCodeEvidence(request.params.taskId, {
        includeHistory: request.query.includeHistory,
        habitatId: getHabitatIdForTask(request.params.taskId) ?? undefined,
      });
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/tasks/:taskId/code-evidence",
    {
      schema: { params: taskIdParamsSchema, body: linkCodeSchema },
      preHandler: [agentOrHumanAuth],
    },
    async (request) => {
      const { taskId } = request.params;
      const task = taskRepo.getTaskById(taskId);
      if (!task) throw notFound("Task not found");

      const actor = getActor(request);
      const habitatId = getHabitatIdForTask(taskId);
      const result = codeEvidenceService.linkTaskCodeEvidence(
        taskId,
        request.body as CodeEvidenceLinkInput,
        actor,
        { habitatId: habitatId ?? undefined },
      );

      if (result.links.length > 0 && habitatId) {
        for (const link of result.links) {
          emitEvidenceEvent("task", taskId, habitatId, link.linkId, "linked", actor);
        }
      }

      return result;
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/tasks/:taskId/code-evidence/:linkId/correct",
    {
      schema: { params: linkIdParamsSchema, body: correctLinkSchema },
      preHandler: [agentOrHumanAuth],
    },
    async (request) => {
      const { taskId, linkId } = request.params;
      const task = taskRepo.getTaskById(taskId);
      if (!task) throw notFound("Task not found");

      const actor = getActor(request);
      const corrected = codeEvidenceService.correctEvidenceLink(
        linkId,
        request.body as CodeEvidenceCorrectionInput,
        actor,
      );
      if (!corrected) throw notFound("Evidence link not found");

      const habitatId = getHabitatIdForTask(taskId);
      if (habitatId) emitEvidenceEvent("task", taskId, habitatId, linkId, "corrected", actor);

      return { link: corrected };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/tasks/:taskId/code-evidence/not-applicable",
    {
      schema: { params: taskIdParamsSchema, body: notApplicableSchema },
      preHandler: [agentOrHumanAuth],
    },
    async (request) => {
      const { taskId } = request.params;
      const task = taskRepo.getTaskById(taskId);
      if (!task) throw notFound("Task not found");

      const actor = getActor(request);
      const result = codeEvidenceService.markCodeEvidenceNotApplicable(
        "task",
        taskId,
        request.body as CodeEvidenceNotApplicableInput,
        actor,
      );

      const habitatId = getHabitatIdForTask(taskId);
      if (habitatId) emitEvidenceEvent("task", taskId, habitatId, "", "not_applicable", actor);

      return { completeness: result };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().delete(
    "/tasks/:taskId/code-evidence/not-applicable",
    {
      schema: { params: taskIdParamsSchema },
      preHandler: [agentOrHumanAuth],
    },
    async (request) => {
      const { taskId } = request.params;
      const task = taskRepo.getTaskById(taskId);
      if (!task) throw notFound("Task not found");

      const actor = getActor(request);
      codeEvidenceService.clearCodeEvidenceNotApplicable("task", taskId);

      const habitatId = getHabitatIdForTask(taskId);
      if (habitatId) {
        eventRepo.createEvent({
          taskId,
          actorType: actor.type,
          actorId: actor.id,
          action: "code_evidence_cleared_not_applicable",
          metadata: {},
        });
        sseBroadcaster.publish(habitatId, {
          type: "code_evidence.updated",
          data: {
            targetType: "task",
            targetId: taskId,
            evidenceLinkId: "",
            changeKind: "not_applicable",
          },
        });
      }

      return { success: true };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/tasks/:taskId/code-evidence/gaps",
    {
      schema: { params: taskIdParamsSchema, body: gapSchema },
      preHandler: [agentOrHumanAuth],
    },
    async (request) => {
      const { taskId } = request.params;
      const task = taskRepo.getTaskById(taskId);
      if (!task) throw notFound("Task not found");

      const actor = getActor(request);
      const gap = codeEvidenceService.reportCodeEvidenceGap(
        "task",
        taskId,
        request.body as CodeEvidenceGapInput,
        actor,
      );
      if (!gap) throw badRequest("Failed to create evidence gap");

      const habitatId = getHabitatIdForTask(taskId);
      if (habitatId) emitEvidenceEvent("task", taskId, habitatId, gap.id, "gap_reported", actor);

      return { gap };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/tasks/:taskId/code-evidence/gaps/:gapId/resolve",
    {
      schema: { params: gapIdParamsSchema, body: gapResolveSchema },
      preHandler: [agentOrHumanAuth],
    },
    async (request) => {
      const { taskId, gapId } = request.params;
      const task = taskRepo.getTaskById(taskId);
      if (!task) throw notFound("Task not found");

      const actor = getActor(request);
      const resolved = codeEvidenceService.resolveCodeEvidenceGap(
        gapId,
        request.body as CodeEvidenceGapResolveInput,
        actor,
      );
      if (!resolved) throw notFound("Evidence gap not found");

      const habitatId = getHabitatIdForTask(taskId);
      if (habitatId) {
        eventRepo.createEvent({
          taskId,
          actorType: actor.type,
          actorId: actor.id,
          action: "code_evidence_gap_resolved",
          metadata: { gapId },
        });
        sseBroadcaster.publish(habitatId, {
          type: "code_evidence.updated",
          data: {
            targetType: "task",
            targetId: taskId,
            evidenceLinkId: "",
            changeKind: "verified",
          },
        });
      }

      return { gap: resolved };
    },
  );
}
