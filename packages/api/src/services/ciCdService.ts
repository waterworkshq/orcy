import * as pipelineRepo from "../repositories/pipelineEvent.js";
import * as taskRepo from "../repositories/task.js";
import { getHabitatIdForTask } from "../repositories/task.js";
import * as habitatRepo from "../repositories/board.js";
import * as eventRepo from "../repositories/event.js";
import * as prRepo from "../repositories/pullRequest.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import type { CiCdSettings, PipelineEventStatus } from "../models/index.js";
import {
  verifyGitHubHmac,
  verifyGitLabToken as secureVerifyGitLabToken,
} from "../config/integrationSecurity.js";
import * as codeEvidenceService from "./codeEvidenceService.js";
import { logger } from "../lib/logger.js";

function publishTaskUpdated(habitatId: string, taskId: string): void {
  const task = taskRepo.getTaskById(taskId);
  if (!task) {
    logger.warn({ taskId, habitatId }, "Skipping task.updated SSE: task no longer exists");
    return;
  }
  sseBroadcaster.publish(habitatId, { type: "task.updated", data: task });
}

/** Verifies an inbound GitHub webhook payload's HMAC signature against the shared secret. */
export function verifyGitHubSignature(payload: string, signature: string, secret: string): boolean {
  return verifyGitHubHmac(payload, signature, secret);
}

/** Verifies an inbound GitLab webhook's `X-Gitlab-Token` header against the shared secret. */
export function verifyGitLabToken(providedToken: string, secret: string): boolean {
  return secureVerifyGitLabToken(providedToken, secret);
}

function getCiCdSettingsForHabitat(habitatId: string): CiCdSettings | null {
  const habitat = habitatRepo.getHabitatById(habitatId);
  if (!habitat) return null;
  const raw = (habitat as unknown as Record<string, unknown>).ci_cd_settings;
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as CiCdSettings;
  } catch {
    return null;
  }
}

function findTaskAcrossHabitats(repo: string, branch: string): string | null {
  const habitats = habitatRepo.listHabitats();
  for (const habitat of habitats) {
    const settings = getCiCdSettingsForHabitat(habitat.id);
    if (!settings) continue;
    const pattern = settings.taskPattern || "[?&;]taskId=([0-9a-f-]{36})";
    const taskId = prRepo.findTaskIdByPattern(branch, pattern);
    if (taskId) {
      const task = taskRepo.getTaskById(taskId);
      if (task) return taskId;
    }
  }
  return null;
}

interface GitHubWorkflowRunEvent {
  action: string;
  workflow_run: {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    head_branch: string;
    head_sha: string;
    repository: { full_name: string };
    html_url: string;
  };
}

interface GitHubWorkflowJobEvent {
  action: string;
  workflow_job: {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    head_branch: string;
    head_sha: string;
    run_id: number;
    repository: { full_name: string };
    html_url: string;
  };
}

interface GitLabPipelineEvent {
  object_kind: "pipeline";
  object_attributes: {
    id: number;
    status: string;
    ref: string;
    sha: string;
  };
  project: {
    path_with_namespace: string;
    web_url: string;
  };
}

interface GitLabJobEvent {
  object_kind: "build";
  build_id: number;
  build_name: string;
  build_status: string;
  ref: string;
  sha: string;
  pipeline_id: number;
  project: {
    path_with_namespace: string;
    web_url: string;
  };
}

function mapGitHubStatus(status: string, conclusion: string | null): PipelineEventStatus {
  if (status === "queued") return "queued";
  if (status === "in_progress") return "in_progress";
  if (status === "completed") {
    if (conclusion === "success") return "success";
    if (conclusion === "failure") return "failure";
    if (conclusion === "cancelled") return "cancelled";
    return "failure";
  }
  return "queued";
}

function mapGitLabStatus(status: string): PipelineEventStatus {
  const map: Record<string, PipelineEventStatus> = {
    pending: "queued",
    running: "in_progress",
    success: "success",
    failed: "failure",
    canceled: "cancelled",
    created: "queued",
  };
  return map[status] ?? "queued";
}

interface PipelineEventArgs {
  provider: "github" | "gitlab";
  repo: string;
  branch: string;
  runId: string;
  commitSha: string;
  mappedStatus: PipelineEventStatus;
  actorId: string;
  artifactInfo?: { name: string; url: string };
}

function handlePipelineEvent(args: PipelineEventArgs): { status: string; taskId?: string } {
  const taskId = findTaskAcrossHabitats(args.repo, args.branch);
  if (!taskId) return { status: "no_matching_task" };

  const task = taskRepo.getTaskById(taskId);
  if (!task) return { status: "task_not_found" };

  const existing = pipelineRepo.findByProviderAndRunId(args.provider, args.repo, args.runId);

  let pipelineRecord: {
    id: string;
    taskId: string;
    provider: string;
    repo: string;
    runId: string;
    branch: string;
    commitSha: string | null;
  } | null = null;

  const updateFields: { status: PipelineEventStatus; commitSha?: string } = {
    status: args.mappedStatus,
  };
  if (args.commitSha) updateFields.commitSha = args.commitSha;

  if (existing) {
    pipelineRepo.updatePipelineEvent(existing.id, updateFields);
    pipelineRecord = existing;
  } else {
    pipelineRecord = pipelineRepo.createPipelineEvent({
      taskId,
      provider: args.provider,
      repo: args.repo,
      runId: args.runId,
      status: args.mappedStatus,
      branch: args.branch,
      commitSha: args.commitSha || null,
    });
  }

  if (args.artifactInfo) {
    const { name, url } = args.artifactInfo;
    const desc = args.mappedStatus === "success" ? `${name} passed` : `${name} failed`;
    taskRepo.addArtifact(taskId, {
      type: "log",
      url,
      description: desc,
    });
  }

  eventRepo.createEvent({
    taskId,
    actorType: "system",
    actorId: args.actorId,
    action: "updated",
    metadata: {
      provider: args.provider,
      runId: args.runId,
      pipelineStatus: args.mappedStatus,
      repo: args.repo,
      branch: args.branch,
    },
  });

  const habitatId = getHabitatIdForTask(taskId);
  if (habitatId) {
    if (pipelineRecord) {
      try {
        codeEvidenceService.ensureEvidenceLinkForPipelineEvent(
          pipelineRecord,
          "webhook",
          habitatId,
        );
      } catch {
        /* non-blocking enrichment */
      }
    }
    publishTaskUpdated(habitatId, taskId);
  }

  return { status: "processed", taskId };
}

/** Processes a GitHub `workflow_run` webhook by persisting the pipeline status for the matching task and emitting a `task.updated` SSE event to its habitat. */
export function handleGitHubWorkflowRunEvent(body: GitHubWorkflowRunEvent) {
  const run = body.workflow_run;
  return handlePipelineEvent({
    provider: "github",
    repo: run.repository.full_name,
    branch: run.head_branch,
    runId: String(run.id),
    commitSha: run.head_sha,
    mappedStatus: mapGitHubStatus(run.status, run.conclusion),
    actorId: "github-ci",
    artifactInfo: {
      name: run.name,
      url: run.html_url,
    },
  });
}

/** Processes a GitHub `workflow_job` webhook by persisting the pipeline status for the matching task and emitting a `task.updated` SSE event to its habitat. */
export function handleGitHubWorkflowJobEvent(body: GitHubWorkflowJobEvent) {
  const job = body.workflow_job;
  return handlePipelineEvent({
    provider: "github",
    repo: job.repository.full_name,
    branch: job.head_branch,
    runId: String(job.run_id),
    commitSha: job.head_sha,
    mappedStatus: mapGitHubStatus(job.status, job.conclusion),
    actorId: "github-ci",
  });
}

/** Processes a GitLab `pipeline` webhook by persisting the pipeline status for the matching task and emitting a `task.updated` SSE event to its habitat. */
export function handleGitLabPipelineEvent(body: GitLabPipelineEvent) {
  const attrs = body.object_attributes;
  return handlePipelineEvent({
    provider: "gitlab",
    repo: body.project.path_with_namespace,
    branch: attrs.ref,
    runId: String(attrs.id),
    commitSha: attrs.sha,
    mappedStatus: mapGitLabStatus(attrs.status),
    actorId: "gitlab-ci",
    artifactInfo: {
      name: "Pipeline",
      url: `${body.project.web_url}/-/pipelines/${attrs.id}`,
    },
  });
}

/** Processes a GitLab `build` (job) webhook by persisting the pipeline status for the matching task and emitting a `task.updated` SSE event to its habitat. */
export function handleGitLabJobEvent(body: GitLabJobEvent) {
  return handlePipelineEvent({
    provider: "gitlab",
    repo: body.project.path_with_namespace,
    branch: body.ref,
    runId: String(body.pipeline_id),
    commitSha: body.sha,
    mappedStatus: mapGitLabStatus(body.build_status),
    actorId: "gitlab-ci",
  });
}
