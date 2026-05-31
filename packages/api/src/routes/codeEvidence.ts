import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as codeEvidenceService from "../services/codeEvidenceService.js";
import * as taskRepo from "../repositories/task.js";
import * as missionRepo from "../repositories/feature.js";
import * as habitatRepo from "../repositories/board.js";
import * as codeEvidenceRepository from "../repositories/codeEvidenceRepository.js";
import * as connectionRepo from "../repositories/integrationConnection.js";
import { agentOrHumanAuth, humanAuth, agentAuth } from "../middleware/auth.js";
import { notFound, badRequest, forbidden } from "../errors.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import * as eventRepo from "../repositories/events/event-crud.js";
import * as missionEventRepo from "../repositories/events/event-feature.js";
import {
  type CodeEvidenceLinkInput,
  type CodeEvidenceCorrectionInput,
  type CodeEvidenceNotApplicableInput,
  type CodeEvidenceGapInput,
  type CodeEvidenceGapResolveInput,
  type CodeEvidenceActorType,
} from "@orcy/shared";

const taskIdParamsSchema = z.object({ taskId: z.string() });
const missionIdParamsSchema = z.object({ missionId: z.string() });
const linkIdParamsSchema = z.object({ taskId: z.string(), linkId: z.string() });
const missionLinkIdParamsSchema = z.object({ missionId: z.string(), linkId: z.string() });
const gapIdParamsSchema = z.object({ taskId: z.string(), gapId: z.string() });
const missionGapIdParamsSchema = z.object({ missionId: z.string(), gapId: z.string() });
const habitatIdParamsSchema = z.object({ habitatId: z.string() });

const includeHistoryQuerySchema = z.object({
  includeHistory: z.coerce.boolean().optional().default(false),
});

const branchInputSchema = z.object({
  name: z.string(),
  headSha: z.string().optional(),
  baseBranch: z.string().optional(),
  url: z.string().optional(),
});

const commitInputSchema = z.object({
  sha: z.string(),
  message: z.string().optional(),
  authorName: z.string().optional(),
  authorEmail: z.string().optional(),
  authoredAt: z.string().optional(),
  url: z.string().optional(),
  branch: z.string().optional(),
  trailers: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
});

const changedFileInputSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  changeType: z.enum(["added", "modified", "deleted", "renamed"]),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  commitSha: z.string().optional(),
  pullRequestNumber: z.number().optional(),
});

const linkCodeSchema = z.object({
  branch: branchInputSchema.optional(),
  commits: z.array(commitInputSchema).optional(),
  changedFiles: z.array(changedFileInputSchema).optional(),
  pullRequestUrl: z.string().optional(),
  pipelineUrl: z.string().optional(),
  externalUrls: z.array(z.string()).optional(),
  allowExternalRepository: z.boolean().optional(),
});

const correctLinkSchema = z.object({
  status: z.enum(["incorrect", "removed", "superseded"]),
  reason: z.string(),
  customReason: z.string().optional(),
  replacementLinkId: z.string().optional(),
});

const notApplicableSchema = z.object({
  reasonCode: z.string().optional(),
  reasonNote: z.string().optional(),
});

const gapSchema = z.object({
  reasonCode: z.string(),
  reasonNote: z.string().optional(),
});

const gapResolveSchema = z.object({
  resolutionReason: z.string(),
});

const repositoryInputSchema = z.object({
  provider: z.string().optional(),
  providerBaseUrl: z.string().optional(),
  externalId: z.string().optional(),
  repoSlug: z.string().optional(),
  displayName: z.string().optional(),
  localPath: z.string().optional(),
});

const inferFromWorktreeSchema = z.object({
  worktreePath: z.string().optional(),
});

const inferFromIntegrationSchema = z.object({
  integrationId: z.string().optional(),
});

function getActor(request: {
  agent?: { id: string } | null;
  user?: { id: string; role: string } | null;
}): { type: CodeEvidenceActorType; id: string } {
  if (request.agent) {
    return { type: "agent", id: request.agent.id };
  }
  if (request.user) {
    return { type: "human", id: request.user.id };
  }
  return { type: "system", id: "system" };
}

function emitEvidenceEvent(
  targetType: "task" | "mission",
  targetId: string,
  habitatId: string,
  evidenceLinkId: string,
  changeKind: "linked" | "corrected" | "gap_reported" | "not_applicable" | "verified",
  actor: { type: CodeEvidenceActorType; id: string },
) {
  if (targetType === "task") {
    eventRepo.createEvent({
      taskId: targetId,
      actorType: actor.type,
      actorId: actor.id,
      action:
        changeKind === "linked"
          ? "code_evidence_linked"
          : changeKind === "corrected"
            ? "code_evidence_corrected"
            : changeKind === "gap_reported"
              ? "code_evidence_gap_reported"
              : changeKind === "not_applicable"
                ? "code_evidence_marked_not_applicable"
                : "code_evidence_linked",
      metadata: { evidenceLinkId, changeKind },
    });
  } else {
    missionEventRepo.createMissionEvent({
      missionId: targetId,
      actorType: actor.type,
      actorId: actor.id,
      action:
        changeKind === "linked"
          ? "code_evidence_linked"
          : changeKind === "corrected"
            ? "code_evidence_corrected"
            : changeKind === "gap_reported"
              ? "code_evidence_gap_reported"
              : changeKind === "not_applicable"
                ? "code_evidence_marked_not_applicable"
                : "code_evidence_linked",
      metadata: { evidenceLinkId, changeKind },
    });
  }

  sseBroadcaster.publish(habitatId, {
    type: "code_evidence.updated",
    data: {
      targetType,
      targetId,
      evidenceLinkId,
      changeKind,
    },
  });

  if (targetType === "task") {
    const task = taskRepo.getTaskById(targetId);
    if (task) {
      sseBroadcaster.publish(habitatId, { type: "task.updated", data: { id: targetId } } as any);
    }
  } else {
    sseBroadcaster.publish(habitatId, { type: "mission.updated", data: { id: targetId } } as any);
  }
}

function getHabitatIdForTask(taskId: string): string | null {
  const task = taskRepo.getTaskById(taskId);
  if (!task) return null;
  const mission = missionRepo.getMissionById(task.missionId);
  if (!mission) return null;
  return mission.habitatId;
}

function getHabitatIdForMission(missionId: string): string | null {
  const mission = missionRepo.getMissionById(missionId);
  if (!mission) return null;
  return mission.habitatId;
}

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
      const result = codeEvidenceService.linkTaskCodeEvidence(
        taskId,
        request.body as CodeEvidenceLinkInput,
        actor,
      );

      if (result.links.length > 0) {
        const habitatId = getHabitatIdForTask(taskId);
        if (habitatId) {
          for (const link of result.links) {
            emitEvidenceEvent("task", taskId, habitatId, link.linkId, "linked", actor);
          }
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
      if (habitatId) {
        emitEvidenceEvent("task", taskId, habitatId, linkId, "corrected", actor);
      }

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
      if (habitatId) {
        emitEvidenceEvent("task", taskId, habitatId, "", "not_applicable", actor);
      }

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
      if (habitatId) {
        emitEvidenceEvent("task", taskId, habitatId, gap.id, "gap_reported", actor);
      }

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
      );

      if (result.links.length > 0) {
        for (const link of result.links) {
          emitEvidenceEvent("mission", missionId, mission.habitatId, link.linkId, "linked", actor);
        }
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

export async function repositorySettingsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/habitats/:habitatId/repository",
    {
      schema: { params: habitatIdParamsSchema },
      preHandler: [agentOrHumanAuth],
    },
    async (request) => {
      const habitat = habitatRepo.getHabitatById(request.params.habitatId);
      if (!habitat) throw notFound("Habitat not found");

      const repo = codeEvidenceRepository.getByHabitatId(request.params.habitatId);
      return { repository: repo };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().put(
    "/habitats/:habitatId/repository",
    {
      schema: { params: habitatIdParamsSchema, body: repositoryInputSchema },
      preHandler: [humanAuth],
    },
    async (request) => {
      const habitat = habitatRepo.getHabitatById(request.params.habitatId);
      if (!habitat) throw notFound("Habitat not found");

      const body = request.body;
      const existing = codeEvidenceRepository.getByHabitatId(request.params.habitatId);

      let repo;
      if (existing) {
        repo = codeEvidenceRepository.updateByHabitatId(request.params.habitatId, {
          provider: body.provider,
          providerBaseUrl: body.providerBaseUrl,
          externalId: body.externalId,
          repoSlug: body.repoSlug,
          displayName: body.displayName,
          localPath: body.localPath,
        });
      } else {
        if (!body.provider || !body.repoSlug) {
          throw badRequest(
            "provider and repoSlug are required when creating a repository identity",
          );
        }
        repo = codeEvidenceRepository.create({
          habitatId: request.params.habitatId,
          provider: body.provider,
          providerBaseUrl: body.providerBaseUrl,
          externalId: body.externalId,
          repoSlug: body.repoSlug,
          displayName: body.displayName,
          localPath: body.localPath,
        });
      }

      return { repository: repo };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/habitats/:habitatId/repository/infer-from-worktree",
    {
      schema: { params: habitatIdParamsSchema, body: inferFromWorktreeSchema },
      preHandler: [humanAuth],
    },
    async (request) => {
      const habitat = habitatRepo.getHabitatById(request.params.habitatId);
      if (!habitat) throw notFound("Habitat not found");

      const worktreeSettings = habitat.gitWorktreeSettings as Record<string, unknown> | null;
      if (!worktreeSettings || !worktreeSettings.path) {
        throw badRequest("No worktree path configured for this habitat");
      }

      const worktreePath = request.body.worktreePath ?? (worktreeSettings.path as string);
      const repoSlug = worktreeSettings.repoSlug as string | undefined;
      const provider = (worktreeSettings.provider as string | undefined) ?? "local";

      const existing = codeEvidenceRepository.getByHabitatId(request.params.habitatId);
      if (existing) {
        const updated = codeEvidenceRepository.updateByHabitatId(request.params.habitatId, {
          provider,
          repoSlug: repoSlug ?? existing.repoSlug ?? undefined,
          localPath: worktreePath,
          verificationState: "unverified",
        });
        return { repository: updated };
      }

      if (!repoSlug) {
        throw badRequest("Cannot infer repository identity: no repoSlug in worktree settings");
      }

      const repo = codeEvidenceRepository.create({
        habitatId: request.params.habitatId,
        provider,
        repoSlug,
        localPath: worktreePath,
        verificationState: "unverified",
      });

      return { repository: repo };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/habitats/:habitatId/repository/infer-from-integration",
    {
      schema: { params: habitatIdParamsSchema, body: inferFromIntegrationSchema },
      preHandler: [humanAuth],
    },
    async (request) => {
      const habitat = habitatRepo.getHabitatById(request.params.habitatId);
      if (!habitat) throw notFound("Habitat not found");

      const connections = connectionRepo.listByHabitat(request.params.habitatId);
      const enabledConnections = connections.filter((c) => c.enabled);

      const githubConn = enabledConnections.find((c) => c.provider === "github");

      let provider = "";
      let repoSlug = "";
      let externalId: string | undefined;
      let providerBaseUrl: string | undefined;

      if (githubConn && githubConn.repositoryOwner && githubConn.repositoryName) {
        provider = "github";
        repoSlug = `${githubConn.repositoryOwner}/${githubConn.repositoryName}`;
        externalId = githubConn.externalAccountId ?? undefined;
        providerBaseUrl = githubConn.externalBaseUrl ?? undefined;
      } else {
        throw badRequest("No GitHub integration with repository configured for this habitat");
      }

      const existing = codeEvidenceRepository.getByHabitatId(request.params.habitatId);
      if (existing) {
        const updated = codeEvidenceRepository.updateByHabitatId(request.params.habitatId, {
          provider,
          providerBaseUrl,
          externalId,
          repoSlug,
          verificationState: "unverified",
        });
        return { repository: updated };
      }

      const repo = codeEvidenceRepository.create({
        habitatId: request.params.habitatId,
        provider,
        providerBaseUrl,
        externalId,
        repoSlug,
        verificationState: "unverified",
      });

      return { repository: repo };
    },
  );
}
