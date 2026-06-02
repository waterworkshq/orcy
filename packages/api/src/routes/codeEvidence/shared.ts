import { z } from "zod";
import type { CodeEvidenceActorType } from "@orcy/shared";

import * as eventRepo from "../../repositories/events/event-crud.js";
import * as missionEventRepo from "../../repositories/events/event-feature.js";
import * as missionRepo from "../../repositories/feature.js";
import * as taskRepo from "../../repositories/task.js";
import { sseBroadcaster } from "../../sse/broadcaster.js";

export const taskIdParamsSchema = z.object({ taskId: z.string() });
export const missionIdParamsSchema = z.object({ missionId: z.string() });
export const linkIdParamsSchema = z.object({ taskId: z.string(), linkId: z.string() });
export const missionLinkIdParamsSchema = z.object({ missionId: z.string(), linkId: z.string() });
export const gapIdParamsSchema = z.object({ taskId: z.string(), gapId: z.string() });
export const missionGapIdParamsSchema = z.object({ missionId: z.string(), gapId: z.string() });
export const habitatIdParamsSchema = z.object({ habitatId: z.string() });

export const includeHistoryQuerySchema = z.object({
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

export const linkCodeSchema = z.object({
  branch: branchInputSchema.optional(),
  commits: z.array(commitInputSchema).optional(),
  changedFiles: z.array(changedFileInputSchema).optional(),
  pullRequestUrl: z.string().optional(),
  pipelineUrl: z.string().optional(),
  externalUrls: z.array(z.string()).optional(),
  allowExternalRepository: z.boolean().optional(),
});

export const correctLinkSchema = z.object({
  status: z.enum(["incorrect", "removed", "superseded"]),
  reason: z.string(),
  customReason: z.string().optional(),
  replacementLinkId: z.string().optional(),
});

export const notApplicableSchema = z.object({
  reasonCode: z.string().optional(),
  reasonNote: z.string().optional(),
});

export const gapSchema = z.object({
  reasonCode: z.string(),
  reasonNote: z.string().optional(),
});

export const gapResolveSchema = z.object({
  resolutionReason: z.string(),
});

export const repositoryInputSchema = z.object({
  provider: z.string().optional(),
  providerBaseUrl: z.string().optional(),
  externalId: z.string().optional(),
  repoSlug: z.string().optional(),
  displayName: z.string().optional(),
  localPath: z.string().optional(),
});

export const inferFromWorktreeSchema = z.object({
  worktreePath: z.string().optional(),
});

export const inferFromIntegrationSchema = z.object({
  integrationId: z.string().optional(),
});

export function getActor(request: {
  agent?: { id: string } | null;
  user?: { id: string; role: string } | null;
}): { type: CodeEvidenceActorType; id: string } {
  if (request.agent) return { type: "agent", id: request.agent.id };
  if (request.user) return { type: "human", id: request.user.id };
  return { type: "system", id: "system" };
}

export function emitEvidenceEvent(
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
    data: { targetType, targetId, evidenceLinkId, changeKind },
  });

  if (targetType === "task") {
    const task = taskRepo.getTaskById(targetId);
    if (task) sseBroadcaster.publish(habitatId, { type: "task.updated", data: task });
  } else {
    const mission = missionRepo.getMissionById(targetId);
    if (mission) sseBroadcaster.publish(habitatId, { type: "mission.updated", data: mission });
  }
}

export function getHabitatIdForTask(taskId: string): string | null {
  const task = taskRepo.getTaskById(taskId);
  if (!task) return null;
  const mission = missionRepo.getMissionById(task.missionId);
  if (!mission) return null;
  return mission.habitatId;
}

export function getHabitatIdForMission(missionId: string): string | null {
  const mission = missionRepo.getMissionById(missionId);
  if (!mission) return null;
  return mission.habitatId;
}
