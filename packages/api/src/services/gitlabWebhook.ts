import * as prRepo from "../repositories/pullRequest.js";
import * as taskRepo from "../repositories/task.js";
import { getHabitatIdForTask } from "../repositories/task.js";
import * as habitatRepo from "../repositories/habitat.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import type { CodeReviewSettings } from "../models/index.js";
import { verifyGitLabToken as secureVerifyGitLabToken } from "../config/integrationSecurity.js";
import * as codeEvidenceService from "./codeEvidenceService.js";
import { resolveCodeReviewHabitatIdsByGitlabToken } from "./habitatSecretCache.js";
import { isGitlabProjectAllowed, normalizeProviderRepoId } from "./webhooks/repoAllowlist.js";
import { approveTaskForMergedPR } from "./webhooks/mergeApproval.js";

/** Verifies a GitLab webhook token against the configured secret. */
export function verifyGitLabToken(providedToken: string, secret: string): boolean {
  return secureVerifyGitLabToken(providedToken, secret);
}

/**
 * Ingress credentials for the GitLab MR/note webhook handlers (REC-06 C1).
 * The handlers verify the presented token against configured code-review
 * secrets as their FIRST action, before any write, task scan, evidence link,
 * or SSE broadcast.
 */
export interface GitLabWebhookIngress {
  token: string | undefined;
}

/**
 * Docs-conformant GitLab merge_request payload (webhook_events, "Merge
 * request events"): the action lives in `object_attributes.action` — real
 * deliveries carry NO top-level `action` field, so no top-level fallback
 * exists (an invented fallback could let a conflicting stray field override
 * the canonical nested value).
 */
interface GitLabMergeRequestEvent {
  object_kind: "merge_request";
  object_attributes: {
    action: string;
    iid: number;
    title: string;
    url: string;
    state: string;
    merge_status: string;
    source_branch: string;
    target_project_id: number;
  };
  project: {
    id?: number | string;
    path_with_namespace: string;
  };
}

/**
 * Docs-conformant GitLab note payload: `noteable_type` lives in
 * `object_attributes` (the note object itself), alongside `merge_request`
 * and `project` at the top level. The note path is intentionally inert — it
 * performs no writes; the nested read keeps it correct for real traffic.
 */
interface GitLabNoteEvent {
  object_kind: "note";
  object_attributes: {
    noteable_type: string;
    noteable_iid?: number;
    note?: string;
  };
  merge_request: {
    iid: number;
    title: string;
    url: string;
    state: string;
    source_branch: string;
  };
  project: {
    id?: number | string;
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
  return habitat?.codeReviewSettings ?? null;
}

/**
 * Ingress binding (REC-06 C1, GitLab twin of the GitHub resolver): resolves
 * the EXACT ONE habitat whose configured code-review GitLab token matches the
 * presented credential. Zero matches (missing token, unknown token, or the
 * unsigned local-dev posture — closed here, matching the release-path
 * precedent) and MORE than one (a duplicated token across habitats) are both
 * refusals with zero writes; the resolved habitat is the only habitat
 * consulted for the rest of the request.
 */
function resolveIngressHabitat(
  ingress: GitLabWebhookIngress,
): { habitatId: string; settings: CodeReviewSettings } | { refusal: string } {
  const habitatIds = resolveCodeReviewHabitatIdsByGitlabToken(ingress.token);
  if (habitatIds.length === 0) return { refusal: "no_matching_habitat" };
  if (habitatIds.length > 1) return { refusal: "ambiguous_signature_habitat" };
  const settings = getSettingsForHabitat(habitatIds[0]);
  if (!settings) return { refusal: "no_matching_habitat" };
  return { habitatId: habitatIds[0], settings };
}

/**
 * Project allowlist gate (REC-06 C2): the event's immutable `project.id`
 * must be trusted by the resolved habitat. Runs BEFORE task extraction; a
 * missing, malformed, unsafe-precision, or unlisted id refuses with zero
 * writes. An empty/absent (legacy) allowlist refuses everything.
 */
function gateProjectId(
  settings: CodeReviewSettings,
  projectIdValue: unknown,
): { projectId: string } | { refusal: string } {
  const projectId = normalizeProviderRepoId(projectIdValue);
  if (!projectId) return { refusal: "invalid_project_id" };
  if (!isGitlabProjectAllowed(settings, projectId)) return { refusal: "project_not_allowed" };
  return { projectId };
}

function findTaskInHabitat(
  branchName: string,
  mrTitle: string,
  settings: CodeReviewSettings,
  habitatId: string,
): string | null {
  const pattern = settings.taskPattern || "[?&;]taskId=([0-9a-f-]{36})";
  const taskIdFromBranch = prRepo.findTaskIdByPattern(branchName, pattern);
  if (taskIdFromBranch) {
    const task = taskRepo.getTaskById(taskIdFromBranch);
    if (task && getHabitatIdForTask(taskIdFromBranch) === habitatId) return taskIdFromBranch;
  }
  const taskIdFromTitle = prRepo.findTaskIdByPattern(mrTitle, pattern);
  if (taskIdFromTitle) {
    const task = taskRepo.getTaskById(taskIdFromTitle);
    if (task && getHabitatIdForTask(taskIdFromTitle) === habitatId) return taskIdFromTitle;
  }
  return null;
}

/** Links an incoming GitLab merge request to an Orcy task, creating or updating the pull request record and broadcasting task changes via SSE. Ingress binding, project allowlist, and task resolution are scoped to the exactly-one habitat whose token verified the request; a merged MR under `autoApproveOnMerge` approves the linked submitted task atomically with its audit event and the canonical post-commit effect mask. */
export function handleMergeRequestEvent(
  body: GitLabMergeRequestEvent,
  ingress: GitLabWebhookIngress,
): {
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

  // C1: exact token→habitat resolution is the FIRST action; no write of any
  // kind (MR record, evidence link, SSE, task scan) precedes it.
  const resolved = resolveIngressHabitat(ingress);
  if ("refusal" in resolved) return { status: resolved.refusal };

  // C2: trusted project allowlist before task extraction. GitLab also sends
  // `object_attributes.target_project_id`; the payload `project.id` is the
  // canonical project identity the allowlist keys on.
  const gated = gateProjectId(resolved.settings, body.project.id);
  if ("refusal" in gated) return { status: gated.refusal };

  const taskId = findTaskInHabitat(branchName, mrTitle, resolved.settings, resolved.habitatId);
  if (!taskId) return { status: "no_matching_task" };

  const task = taskRepo.getTaskById(taskId);
  if (!task) return { status: "task_not_found" };

  const existing = prRepo.findByProviderAndNumber("gitlab", repo, mrNumber);

  if (attrs.action === "open" || attrs.action === "update" || attrs.action === "reopen") {
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

  if (attrs.action === "merge") {
    if (existing) {
      prRepo.updatePullRequest(existing.id, { state: "merged" });

      const settingsHabitatId = getHabitatIdForTask(taskId);
      const settings = settingsHabitatId ? getSettingsForHabitat(settingsHabitatId) : null;
      if (settings?.autoApproveOnMerge) {
        approveTaskForMergedPR({
          taskId,
          habitatId: settingsHabitatId ?? resolved.habitatId,
          provenance: { provider: "gitlab", repo, prNumber: mrNumber },
        });
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

  if (attrs.action === "close") {
    if (existing) {
      prRepo.updatePullRequest(existing.id, { state: "closed" });
    }
    return { status: "closed", taskId };
  }

  return { status: "ignored" };
}

/** Records a GitLab note event on a previously linked merge request and returns the associated task. The note path performs no writes, but the ingress binding and project allowlist gates still apply: the linked task must live in the exactly-one habitat whose token verified the request. */
export function handleNoteEvent(
  body: GitLabNoteEvent,
  ingress: GitLabWebhookIngress,
): { status: string; taskId?: string } {
  if (body.object_attributes.noteable_type !== "MergeRequest") return { status: "ignored" };

  const resolved = resolveIngressHabitat(ingress);
  if ("refusal" in resolved) return { status: resolved.refusal };

  const gated = gateProjectId(resolved.settings, body.project.id);
  if ("refusal" in gated) return { status: gated.refusal };

  const repo = body.project.path_with_namespace;
  const mrNumber = body.merge_request.iid;

  const existing = prRepo.findByProviderAndNumber("gitlab", repo, mrNumber);
  if (!existing) return { status: "mr_not_linked" };

  if (getHabitatIdForTask(existing.taskId) !== resolved.habitatId) {
    return { status: "mr_not_linked" };
  }

  return { status: "noted", taskId: existing.taskId };
}
