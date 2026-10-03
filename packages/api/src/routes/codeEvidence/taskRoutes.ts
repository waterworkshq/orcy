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
  includeHistoryQuerySchema,
  linkCodeSchema,
  linkIdParamsSchema,
  notApplicableSchema,
  taskIdParamsSchema,
} from "./shared.js";
import { applyDeclaredAuthPolicies } from "../../authPolicy.js";
import { authorizeTaskAccess } from "../../middleware/realtimeAuth.js";
import {
  admitReportDestinations,
  buildReportPlan,
  executeReportPlan,
  finalizeReportPlan,
  validateReportContexts,
} from "../../services/codeEvidence/reportPlan.js";

export async function taskCodeEvidenceRoutes(fastify: FastifyInstance): Promise<void> {
  applyDeclaredAuthPolicies(fastify);

  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/tasks/:taskId/code-evidence",
    {
      schema: { params: taskIdParamsSchema, querystring: includeHistoryQuerySchema },
      config: { authPolicy: "local_actor" },
    },
    async (request) => {
      // Object access resolves through the TARGET task's actual
      // Mission/Habitat and authorizes BEFORE any evidence row is read;
      // the service receives the validated habitat id, not a
      // caller-supplied or nullable substitute.
      const habitatId = await authorizeTaskAccess(request, request.params.taskId);

      // Canonical identity is the fetched row selected by the URL spelling —
      // the read model (canonical primary + verified legacy projection)
      // keys off the persisted row id, never the raw URL text.
      const task = taskRepo.getTaskById(request.params.taskId);
      if (!task) throw notFound("Task not found");

      return codeEvidenceService.getTaskCodeEvidence(task.id, {
        includeHistory: request.query.includeHistory,
        habitatId,
      });
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/tasks/:taskId/code-evidence",
    {
      schema: { params: taskIdParamsSchema, body: linkCodeSchema },
      config: { authPolicy: "local_actor" },
    },
    async (request) => {
      // Origin admission is target-derived (settled owner decision): the
      // URL Task's actual Mission/Habitat is authorized before any plan,
      // write, or event. A denied origin rejects the whole request with
      // zero evidence effects.
      await authorizeTaskAccess(request, request.params.taskId);

      const actor = getActor(request);
      // Raw dispatch plan (occurrences before canonicalization), whole-
      // request first-seen destination admission, reporting-domain storage
      // selection, then ONE synchronous immediate write bundle with drift
      // recheck. The entire returned context batch is validated before the
      // first route event; an invalid context fails 500 with zero events
      // (committed evidence may remain — no rollback claim). Later emitter
      // failures may partially fan out.
      const plan = buildReportPlan(
        { kind: "task", rawId: request.params.taskId },
        request.body as CodeEvidenceLinkInput,
      );
      await admitReportDestinations(request, plan);
      finalizeReportPlan(plan);
      const { result, contexts } = executeReportPlan(plan, actor);
      validateReportContexts(plan, contexts, result);

      for (const context of contexts) {
        emitEvidenceEvent(
          context.targetType,
          context.targetId,
          context.habitatId,
          context.linkId,
          "linked",
          actor,
          {
            task: context.entityTask ?? undefined,
            mission: context.entityMission ?? undefined,
          },
        );
      }

      return result;
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/tasks/:taskId/code-evidence/:linkId/correct",
    {
      schema: { params: linkIdParamsSchema, body: correctLinkSchema },
      config: { authPolicy: "local_actor" },
    },
    async (request) => {
      const { taskId, linkId } = request.params;
      // Object access resolves through the TARGET task's actual
      // Mission/Habitat before any evidence row is read. The service then
      // fences the source link on this exact task, and every effect below is
      // emitted for the row the UPDATE actually corrected rather than for
      // the URL input.
      const habitatId = await authorizeTaskAccess(request, taskId);
      const task = taskRepo.getTaskById(taskId);
      if (!task) throw notFound("Task not found");

      const actor = getActor(request);
      // The source link must belong to the canonical fetched row's pair or
      // its one verified legacy pair; the UPDATE fences the row's OWN stored
      // pair (a legacy row keeps its alias pair and id).
      const corrected = codeEvidenceService.correctEvidenceLink(
        "task",
        task.id,
        linkId,
        request.body as CodeEvidenceCorrectionInput,
        actor,
      );
      if (!corrected) throw notFound("Evidence link not found");

      // The RESPONSE keeps the raw stored row (a legacy row retains its
      // alias pair), but the EVENT names the canonical entity that the URL
      // actually resolved to.
      emitEvidenceEvent("task", task.id, habitatId, corrected.id, "corrected", actor, {
        task,
      });

      return { link: corrected };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/tasks/:taskId/code-evidence/not-applicable",
    {
      schema: { params: taskIdParamsSchema, body: notApplicableSchema },
      config: { authPolicy: "local_actor" },
    },
    async (request) => {
      // Requested-Task admission (accepted four-write obligation): the URL
      // Task's actual Mission/Habitat is resolved and admitted BEFORE any
      // evidence row is read or written. local_actor and the established
      // actor matrix are unchanged; the admitted Habitat and the fetched
      // exact Task row (never a normalized refetch) drive every effect.
      const habitatId = await authorizeTaskAccess(request, request.params.taskId);
      const task = taskRepo.getTaskById(request.params.taskId);
      if (!task) throw notFound("Task not found");

      const actor = getActor(request);
      // Compatibility adapter: candidate/override checks and the canonical
      // upsert share one immediate transaction; a verified legacy override
      // refuses 409 before any write. The stored pair is the fetched row id.
      const result = codeEvidenceService.markCodeEvidenceNotApplicable(
        "task",
        task.id,
        request.body as CodeEvidenceNotApplicableInput,
        actor,
      );

      emitEvidenceEvent("task", task.id, habitatId, "", "not_applicable", actor, {
        task,
      });

      return { completeness: result };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().delete(
    "/tasks/:taskId/code-evidence/not-applicable",
    {
      schema: { params: taskIdParamsSchema },
      config: { authPolicy: "local_actor" },
    },
    async (request) => {
      // Requested-Task admission as the mark POST: before any evidence row
      // is read or deleted; the admitted Habitat and exact fetched row
      // drive the effects.
      const habitatId = await authorizeTaskAccess(request, request.params.taskId);
      const task = taskRepo.getTaskById(request.params.taskId);
      if (!task) throw notFound("Task not found");

      const actor = getActor(request);
      // Clears the canonical override and every verified equivalent legacy
      // override together in one immediate transaction (at most two exact
      // stored pairs); unrelated or unresolvable pairs are untouched. The
      // no-op keeps its 200 {success:true} envelope.
      codeEvidenceService.clearCodeEvidenceNotApplicable("task", task.id);

      eventRepo.createEvent({
        taskId: task.id,
        actorType: actor.type,
        actorId: actor.id,
        action: "code_evidence_cleared_not_applicable",
        metadata: {},
      });
      sseBroadcaster.publish(habitatId, {
        type: "code_evidence.updated",
        data: {
          targetType: "task",
          targetId: task.id,
          evidenceLinkId: "",
          changeKind: "not_applicable",
        },
      });

      return { success: true };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/tasks/:taskId/code-evidence/gaps",
    {
      schema: { params: taskIdParamsSchema, body: gapSchema },
      config: { authPolicy: "local_actor" },
    },
    async (request) => {
      // Requested-Task admission as the mark/clear POSTs: before any gap
      // row is inserted or any event emitted.
      const habitatId = await authorizeTaskAccess(request, request.params.taskId);
      const task = taskRepo.getTaskById(request.params.taskId);
      if (!task) throw notFound("Task not found");

      const actor = getActor(request);
      // New gaps store the fetched canonical row id; historical alias gaps
      // stay visible and are resolved explicitly by resource id.
      const gap = codeEvidenceService.reportCodeEvidenceGap(
        "task",
        task.id,
        request.body as CodeEvidenceGapInput,
        actor,
      );
      if (!gap) throw badRequest("Failed to create evidence gap");

      emitEvidenceEvent("task", task.id, habitatId, gap.id, "gap_reported", actor, {
        task,
      });

      return { gap };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/tasks/:taskId/code-evidence/gaps/:gapId/resolve",
    {
      schema: { params: gapIdParamsSchema, body: gapResolveSchema },
      config: { authPolicy: "local_actor" },
    },
    async (request) => {
      const { taskId, gapId } = request.params;
      // Same target admission and exact-pair source containment as the
      // correction POST; the audit and SSE below name the gap the UPDATE
      // actually resolved.
      const habitatId = await authorizeTaskAccess(request, taskId);
      const task = taskRepo.getTaskById(taskId);
      if (!task) throw notFound("Task not found");

      const actor = getActor(request);
      // Same canonical/verified-legacy stored-pair containment as the
      // correction POST; the UPDATE fences the gap row's own stored pair.
      const resolved = codeEvidenceService.resolveCodeEvidenceGap(
        "task",
        task.id,
        gapId,
        request.body as CodeEvidenceGapResolveInput,
        actor,
      );
      if (!resolved) throw notFound("Evidence gap not found");

      // Response keeps the resolved gap's raw stored row; events name the
      // canonical entity and its validated habitat stream.
      eventRepo.createEvent({
        taskId: task.id,
        actorType: actor.type,
        actorId: actor.id,
        action: "code_evidence_gap_resolved",
        metadata: { gapId: resolved.id },
      });
      sseBroadcaster.publish(habitatId, {
        type: "code_evidence.updated",
        data: {
          targetType: "task",
          targetId: task.id,
          evidenceLinkId: "",
          changeKind: "verified",
        },
      });

      return { gap: resolved };
    },
  );
}
