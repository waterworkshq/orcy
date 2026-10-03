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
import * as missionEventRepo from "../../repositories/events/event-feature.js";
import * as missionRepo from "../../repositories/mission.js";
import { badRequest, notFound } from "../../errors.js";
import { sseBroadcaster } from "../../sse/broadcaster.js";
import {
  correctLinkSchema,
  emitEvidenceEvent,
  gapResolveSchema,
  gapSchema,
  getActor,
  includeHistoryQuerySchema,
  linkCodeSchema,
  missionGapIdParamsSchema,
  missionIdParamsSchema,
  missionLinkIdParamsSchema,
  notApplicableSchema,
} from "./shared.js";
import { applyDeclaredAuthPolicies } from "../../authPolicy.js";
import {
  admitReportDestinations,
  buildReportPlan,
  executeReportPlan,
  finalizeReportPlan,
  validateReportContexts,
} from "../../services/codeEvidence/reportPlan.js";

export async function missionCodeEvidenceRoutes(fastify: FastifyInstance): Promise<void> {
  applyDeclaredAuthPolicies(fastify);

  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/missions/:missionId/code-evidence",
    {
      schema: { params: missionIdParamsSchema, querystring: includeHistoryQuerySchema },
      config: { authPolicy: "local_actor" },
    },
    async (request) => {
      const mission = missionRepo.getMissionById(request.params.missionId);
      if (!mission) throw notFound("Mission not found");

      // Canonical identity is the fetched Mission row (exact-first resolver);
      // the compatibility projection keys off the persisted row id.
      return codeEvidenceService.getMissionCodeEvidence(mission.id, {
        includeHistory: request.query.includeHistory,
        habitatId: mission.habitatId,
      });
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/missions/:missionId/code-evidence",
    {
      schema: { params: missionIdParamsSchema, body: linkCodeSchema },
      config: { authPolicy: "local_actor" },
    },
    async (request) => {
      // Mission ORIGIN admission is unchanged: local_actor plus existence,
      // no new membership predicate. Storage/event parity is the cutover:
      // distinct trailer destinations receive the existing target-derived
      // admission (Task→Mission→Habitat / Mission→Habitat) in first-seen
      // order; occurrences resolving to the reporting Mission itself reuse
      // origin admission. First 403/404 rejects the whole request with zero
      // evidence/event effects.
      const { missionId } = request.params;
      const mission = missionRepo.getMissionById(missionId);
      if (!mission) throw notFound("Mission not found");

      const actor = getActor(request);
      const plan = buildReportPlan(
        { kind: "mission", rawId: missionId },
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
    "/missions/:missionId/code-evidence/:linkId/correct",
    {
      schema: { params: missionLinkIdParamsSchema, body: correctLinkSchema },
      config: { authPolicy: "local_actor" },
    },
    async (request) => {
      const { missionId, linkId } = request.params;
      const mission = missionRepo.getMissionById(missionId);
      if (!mission) throw notFound("Mission not found");

      const actor = getActor(request);
      // Compatibility adapter: the source link must belong to the canonical
      // fetched Mission pair or its one verified legacy pair; the UPDATE
      // fences the row's OWN stored pair. Mission admission is unchanged.
      const corrected = codeEvidenceService.correctEvidenceLink(
        "mission",
        mission.id,
        linkId,
        request.body as CodeEvidenceCorrectionInput,
        actor,
      );
      if (!corrected) throw notFound("Evidence link not found");

      emitEvidenceEvent("mission", mission.id, mission.habitatId, corrected.id, "corrected", actor, {
        mission,
      });
      return { link: corrected };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/missions/:missionId/code-evidence/not-applicable",
    {
      schema: { params: missionIdParamsSchema, body: notApplicableSchema },
      config: { authPolicy: "local_actor" },
    },
    async (request) => {
      const { missionId } = request.params;
      const mission = missionRepo.getMissionById(missionId);
      if (!mission) throw notFound("Mission not found");

      const actor = getActor(request);
      // Same transactional mark compatibility adapter as the Task route: a
      // verified legacy Mission-pair override refuses 409 before writes.
      // Mission admission (local_actor + existence) is unchanged.
      const result = codeEvidenceService.markCodeEvidenceNotApplicable(
        "mission",
        mission.id,
        request.body as CodeEvidenceNotApplicableInput,
        actor,
      );

      emitEvidenceEvent("mission", mission.id, mission.habitatId, "", "not_applicable", actor, {
        mission,
      });
      return { completeness: result };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().delete(
    "/missions/:missionId/code-evidence/not-applicable",
    {
      schema: { params: missionIdParamsSchema },
      config: { authPolicy: "local_actor" },
    },
    async (request) => {
      const { missionId } = request.params;
      const mission = missionRepo.getMissionById(missionId);
      if (!mission) throw notFound("Mission not found");

      const actor = getActor(request);
      // Clears the canonical override and every verified equivalent legacy
      // override together in one immediate transaction.
      codeEvidenceService.clearCodeEvidenceNotApplicable("mission", mission.id);

      missionEventRepo.createMissionEvent({
        missionId: mission.id,
        actorType: actor.type,
        actorId: actor.id,
        action: "code_evidence_cleared_not_applicable",
        metadata: {},
      });
      sseBroadcaster.publish(mission.habitatId, {
        type: "code_evidence.updated",
        data: {
          targetType: "mission",
          targetId: mission.id,
          evidenceLinkId: "",
          changeKind: "not_applicable",
        },
      });

      return { success: true };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/missions/:missionId/code-evidence/gaps",
    {
      schema: { params: missionIdParamsSchema, body: gapSchema },
      config: { authPolicy: "local_actor" },
    },
    async (request) => {
      const { missionId } = request.params;
      const mission = missionRepo.getMissionById(missionId);
      if (!mission) throw notFound("Mission not found");

      const actor = getActor(request);
      // New gaps store the fetched canonical Mission row id.
      const gap = codeEvidenceService.reportCodeEvidenceGap(
        "mission",
        mission.id,
        request.body as CodeEvidenceGapInput,
        actor,
      );
      if (!gap) throw badRequest("Failed to create evidence gap");

      emitEvidenceEvent("mission", mission.id, mission.habitatId, gap.id, "gap_reported", actor, {
        mission,
      });
      return { gap };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/missions/:missionId/code-evidence/gaps/:gapId/resolve",
    {
      schema: { params: missionGapIdParamsSchema, body: gapResolveSchema },
      config: { authPolicy: "local_actor" },
    },
    async (request) => {
      const { missionId, gapId } = request.params;
      const mission = missionRepo.getMissionById(missionId);
      if (!mission) throw notFound("Mission not found");

      const actor = getActor(request);
      // Same canonical/verified-legacy stored-pair containment as the
      // Mission correction POST.
      const resolved = codeEvidenceService.resolveCodeEvidenceGap(
        "mission",
        mission.id,
        gapId,
        request.body as CodeEvidenceGapResolveInput,
        actor,
      );
      if (!resolved) throw notFound("Evidence gap not found");

      missionEventRepo.createMissionEvent({
        missionId: mission.id,
        actorType: actor.type,
        actorId: actor.id,
        action: "code_evidence_gap_resolved",
        metadata: { gapId: resolved.id },
      });
      sseBroadcaster.publish(mission.habitatId, {
        type: "code_evidence.updated",
        data: {
          targetType: "mission",
          targetId: mission.id,
          evidenceLinkId: "",
          changeKind: "verified",
        },
      });

      return { gap: resolved };
    },
  );
}
