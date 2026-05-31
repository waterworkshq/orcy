import * as prRepo from "../repositories/pullRequest.js";
import * as taskRepo from "../repositories/task.js";
import { getHabitatIdForTask } from "../repositories/task.js";
import * as habitatRepo from "../repositories/board.js";
import * as eventRepo from "../repositories/event.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import type { CodeReviewSettings } from "../models/index.js";
import { verifyGitLabToken as secureVerifyGitLabToken } from "../config/integrationSecurity.js";
import * as codeEvidenceService from "./codeEvidenceService.js";

export function verifyGitLabToken(providedToken: string, secret: string): boolean {
  return secureVerifyGitLabToken(providedToken, secret);
}

interface GitLabMergeRequestEvent {
  object_kind: "merge_request";
  action: string;
  object_attributes: {
    iid: number;
    title: string;
    url: string;
    state: string;
    merge_status: string;
    source_branch: string;
    target_project_id: number;
  };
  project: {
    path_with_namespace: string;
  };
}

interface GitLabNoteEvent {
  object_kind: "note";
  noteable_type: string;
  note: {
    noteable_iid: number;
  };
  merge_request: {
    iid: number;
    title: string;
    url: string;
    state: string;
    source_branch: string;
  };
  project: {
    path_with_namespace: string;
  };
}

function mapMRState(attrs: { state: string }): "open" | "merged" | "closed" {
  if (attrs.state === "merged") return "merged";
  if (attrs.state === "closed") return "closed";
  return "open";
}

function getSettingsForHabitat(habitatId: string): CodeReviewSettings | null {
  const habitat = habitatRepo.getHabitatById(habitatId);
  if (!habitat) return null;
  const raw = (habitat as unknown as Record<string, unknown>).code_review_settings;
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as CodeReviewSettings;
  } catch {
    return null;
  }
}

function findTaskAcrossHabitats(repo: string, branchName: string, mrTitle: string): string | null {
  const habitats = habitatRepo.listHabitats();
  for (const habitat of habitats) {
    const settings = getSettingsForHabitat(habitat.id);
    if (settings) {
      const pattern = settings.taskPattern || "[?&;]taskId=([0-9a-f-]{36})";
      const taskIdFromBranch = prRepo.findTaskIdByPattern(branchName, pattern);
      if (taskIdFromBranch) {
        const task = taskRepo.getTaskById(taskIdFromBranch);
        if (task) return taskIdFromBranch;
      }
      const taskIdFromTitle = prRepo.findTaskIdByPattern(mrTitle, pattern);
      if (taskIdFromTitle) {
        const task = taskRepo.getTaskById(taskIdFromTitle);
        if (task) return taskIdFromTitle;
      }
    }
  }
  return null;
}

export function handleMergeRequestEvent(body: GitLabMergeRequestEvent): {
  status: string;
  taskId?: string;
} {
  const attrs = body.object_attributes;
  const repo = body.project.path_with_namespace;
  const branchName = attrs.source_branch;
  const mrTitle = attrs.title;
  const mrNumber = attrs.iid;
  const mrUrl = attrs.url;
  const mrState = mapMRState(attrs);

  const taskId = findTaskAcrossHabitats(repo, branchName, mrTitle);
  if (!taskId) return { status: "no_matching_task" };

  const task = taskRepo.getTaskById(taskId);
  if (!task) return { status: "task_not_found" };

  const existing = prRepo.findByProviderAndNumber("gitlab", repo, mrNumber);

  if (body.action === "open" || body.action === "update" || body.action === "reopen") {
    let prRecord: {
      id: string;
      taskId: string;
      provider: string;
      repo: string;
      prNumber: number;
      prTitle: string | null;
      prUrl: string;
      branchName: string | null;
    } | null = null;
    if (existing) {
      prRepo.updatePullRequest(existing.id, { prTitle: mrTitle, state: mrState });
      prRecord = existing;
    } else {
      prRecord = prRepo.createPullRequest({
        taskId,
        provider: "gitlab",
        repo,
        prNumber: mrNumber,
        prTitle: mrTitle,
        prUrl: mrUrl,
        branchName,
        state: mrState,
      });
    }

    const habitatId = getHabitatIdForTask(taskId);
    if (habitatId && prRecord) {
      try {
        codeEvidenceService.ensureEvidenceLinkForPullRequest(prRecord, "webhook", habitatId);
      } catch {
        /* non-blocking enrichment */
      }

      sseBroadcaster.publish(habitatId, {
        type: "task.updated",
        data: task,
      });
    }

    return { status: "linked", taskId };
  }

  if (body.action === "merge") {
    if (existing) {
      prRepo.updatePullRequest(existing.id, { state: "merged" });

      const settingsHabitatId = getHabitatIdForTask(taskId);
      const settings = settingsHabitatId ? getSettingsForHabitat(settingsHabitatId) : null;
      if (settings?.autoApproveOnMerge && task.status === "submitted") {
        const approved = taskRepo.approveTask(taskId);
        if (approved) {
          eventRepo.createEvent({
            taskId,
            actorType: "system",
            actorId: "gitlab-webhook",
            action: "approved",
            metadata: { provider: "gitlab", repo, prNumber: mrNumber, autoApproved: true },
          });
          const habitatId2 = getHabitatIdForTask(taskId);
          if (habitatId2) {
            sseBroadcaster.publish(habitatId2, {
              type: "task.approved",
              data: { taskId, reviewerId: "gitlab-webhook" },
            });
          }
        }
      }

      const habitatId3 = getHabitatIdForTask(taskId);
      if (habitatId3) {
        try {
          codeEvidenceService.ensureEvidenceLinkForPullRequest(existing, "webhook", habitatId3);
        } catch {
          /* non-blocking enrichment */
        }

        sseBroadcaster.publish(habitatId3, {
          type: "task.updated",
          data: task,
        });
      }
    }
    return { status: "merged", taskId };
  }

  if (body.action === "close") {
    if (existing) {
      prRepo.updatePullRequest(existing.id, { state: "closed" });
    }
    return { status: "closed", taskId };
  }

  return { status: "ignored" };
}

export function handleNoteEvent(body: GitLabNoteEvent): { status: string; taskId?: string } {
  if (body.noteable_type !== "MergeRequest") return { status: "ignored" };

  const repo = body.project.path_with_namespace;
  const mrNumber = body.merge_request.iid;

  const existing = prRepo.findByProviderAndNumber("gitlab", repo, mrNumber);
  if (!existing) return { status: "mr_not_linked" };

  return { status: "noted", taskId: existing.taskId };
}
