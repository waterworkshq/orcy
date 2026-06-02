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
import * as missionEventRepo from "../../repositories/events/event-feature.js";
import * as missionRepo from "../../repositories/feature.js";
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

export async function missionCodeEvidenceRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/missions/:missionId/code-evidence",
    {
      schema: { params: missionIdParamsSchema, querystring: includeHistoryQuerySchema },
      preHandler: [agentOrHumanAuth],
    },
    async (request) => {
      const mission = missionRepo.getMissionById(request.params.missionId);
      if (!mission) throw notFound("Mission not found");

      return codeEvidenceService.getMissionCodeEvidence(request.params.missionId, {
        includeHistory: request.query.includeHistory,
        habitatId: mission.habitatId,
      });
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/missions/:missionId/code-evidence",
    {
      schema: { params: missionIdParamsSchema, body: linkCodeSchema },
      preHandler: [agentOrHumanAuth],
    },
    async (request) => {
      const { missionId } = request.params;
      const mission = missionRepo.getMissionById(missionId);
      if (!mission) throw notFound("Mission not found");

      const actor = getActor(request);
      const result = codeEvidenceService.linkMissionCodeEvidence(
        missionId,
        request.body as CodeEvidenceLinkInput,
        actor,
        { habitatId: mission.habitatId },
      );

      for (const link of result.links) {
        emitEvidenceEvent("mission", missionId, mission.habitatId, link.linkId, "linked", actor);
      }

      return result;
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/missions/:missionId/code-evidence/:linkId/correct",
    {
      schema: { params: missionLinkIdParamsSchema, body: correctLinkSchema },
      preHandler: [agentOrHumanAuth],
    },
    async (request) => {
      const { missionId, linkId } = request.params;
      const mission = missionRepo.getMissionById(missionId);
      if (!mission) throw notFound("Mission not found");

      const actor = getActor(request);
      const corrected = codeEvidenceService.correctEvidenceLink(
        linkId,
        request.body as CodeEvidenceCorrectionInput,
        actor,
      );
      if (!corrected) throw notFound("Evidence link not found");

      emitEvidenceEvent("mission", missionId, mission.habitatId, linkId, "corrected", actor);
      return { link: corrected };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/missions/:missionId/code-evidence/not-applicable",
    {
      schema: { params: missionIdParamsSchema, body: notApplicableSchema },
      preHandler: [agentOrHumanAuth],
    },
    async (request) => {
      const { missionId } = request.params;
      const mission = missionRepo.getMissionById(missionId);
      if (!mission) throw notFound("Mission not found");

      const actor = getActor(request);
      const result = codeEvidenceService.markCodeEvidenceNotApplicable(
        "mission",
        missionId,
        request.body as CodeEvidenceNotApplicableInput,
        actor,
      );

      emitEvidenceEvent("mission", missionId, mission.habitatId, "", "not_applicable", actor);
      return { completeness: result };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().delete(
    "/missions/:missionId/code-evidence/not-applicable",
    {
      schema: { params: missionIdParamsSchema },
      preHandler: [agentOrHumanAuth],
    },
    async (request) => {
      const { missionId } = request.params;
      const mission = missionRepo.getMissionById(missionId);
      if (!mission) throw notFound("Mission not found");

      const actor = getActor(request);
      codeEvidenceService.clearCodeEvidenceNotApplicable("mission", missionId);

      missionEventRepo.createMissionEvent({
        missionId,
        actorType: actor.type,
        actorId: actor.id,
        action: "code_evidence_cleared_not_applicable",
        metadata: {},
      });
      sseBroadcaster.publish(mission.habitatId, {
        type: "code_evidence.updated",
        data: {
          targetType: "mission",
          targetId: missionId,
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
      preHandler: [agentOrHumanAuth],
    },
    async (request) => {
      const { missionId } = request.params;
      const mission = missionRepo.getMissionById(missionId);
      if (!mission) throw notFound("Mission not found");

      const actor = getActor(request);
      const gap = codeEvidenceService.reportCodeEvidenceGap(
        "mission",
        missionId,
        request.body as CodeEvidenceGapInput,
        actor,
      );
      if (!gap) throw badRequest("Failed to create evidence gap");

      emitEvidenceEvent("mission", missionId, mission.habitatId, gap.id, "gap_reported", actor);
      return { gap };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/missions/:missionId/code-evidence/gaps/:gapId/resolve",
    {
      schema: { params: missionGapIdParamsSchema, body: gapResolveSchema },
      preHandler: [agentOrHumanAuth],
    },
    async (request) => {
      const { missionId, gapId } = request.params;
      const mission = missionRepo.getMissionById(missionId);
      if (!mission) throw notFound("Mission not found");

      const actor = getActor(request);
      const resolved = codeEvidenceService.resolveCodeEvidenceGap(
        gapId,
        request.body as CodeEvidenceGapResolveInput,
        actor,
      );
      if (!resolved) throw notFound("Evidence gap not found");

      missionEventRepo.createMissionEvent({
        missionId,
        actorType: actor.type,
        actorId: actor.id,
        action: "code_evidence_gap_resolved",
        metadata: { gapId },
      });
      sseBroadcaster.publish(mission.habitatId, {
        type: "code_evidence.updated",
        data: {
          targetType: "mission",
          targetId: missionId,
          evidenceLinkId: "",
          changeKind: "verified",
        },
      });

      return { gap: resolved };
    },
  );
}
