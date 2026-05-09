import { createHmac, timingSafeEqual } from 'crypto';
import * as pipelineRepo from '../repositories/pipelineEvent.js';
import * as taskRepo from '../repositories/task.js';
import { getBoardIdForTask } from '../repositories/task.js';
import * as boardRepo from '../repositories/board.js';
import * as eventRepo from '../repositories/event.js';
import * as prRepo from '../repositories/pullRequest.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import type { CiCdSettings, PipelineEventStatus } from '../models/index.js';
import { verifyGitHubHmac, verifyGitLabToken as secureVerifyGitLabToken } from '../config/integrationSecurity.js';

export function verifyGitHubSignature(payload: string, signature: string, secret: string): boolean {
  return verifyGitHubHmac(payload, signature, secret);
}

export function verifyGitLabToken(providedToken: string, secret: string): boolean {
  return secureVerifyGitLabToken(providedToken, secret);
}

function getCiCdSettingsForBoard(boardId: string): CiCdSettings | null {
  const board = boardRepo.getBoardById(boardId);
  if (!board) return null;
  const raw = (board as unknown as Record<string, unknown>).ci_cd_settings;
  if (!raw || typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as CiCdSettings;
  } catch {
    return null;
  }
}

function findTaskAcrossBoards(repo: string, branch: string): string | null {
  const boards = boardRepo.listBoards();
  for (const board of boards) {
    const settings = getCiCdSettingsForBoard(board.id);
    if (!settings) continue;
    const pattern = settings.taskPattern || '[?&;]taskId=([0-9a-f-]{36})';
    const taskId = prRepo.findTaskIdByPattern(branch, pattern);
    if (taskId) {
      const task = taskRepo.getTaskById(taskId);
      if (task) return taskId;
    }
  }
  return null;
}

function getSettingsForTask(taskId: string): CiCdSettings | null {
  const task = taskRepo.getTaskById(taskId);
  if (!task) return null;
  const boardId = getBoardIdForTask(taskId);
  if (!boardId) return null;
  return getCiCdSettingsForBoard(boardId);
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
  object_kind: 'pipeline';
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
  object_kind: 'build';
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
  if (status === 'queued') return 'queued';
  if (status === 'in_progress') return 'in_progress';
  if (status === 'completed') {
    if (conclusion === 'success') return 'success';
    if (conclusion === 'failure') return 'failure';
    if (conclusion === 'cancelled') return 'cancelled';
    return 'failure';
  }
  return 'queued';
}

function mapGitLabStatus(status: string): PipelineEventStatus {
  const map: Record<string, PipelineEventStatus> = {
    pending: 'queued',
    running: 'in_progress',
    success: 'success',
    failed: 'failure',
    canceled: 'cancelled',
    created: 'queued',
  };
  return map[status] ?? 'queued';
}

export function handleGitHubWorkflowRunEvent(body: GitHubWorkflowRunEvent): { status: string; taskId?: string } {
  const run = body.workflow_run;
  const repo = run.repository.full_name;
  const branch = run.head_branch;
  const runId = String(run.id);
  const mappedStatus = mapGitHubStatus(run.status, run.conclusion);

  const taskId = findTaskAcrossBoards(repo, branch);
  if (!taskId) return { status: 'no_matching_task' };

  const task = taskRepo.getTaskById(taskId);
  if (!task) return { status: 'task_not_found' };

  const existing = pipelineRepo.findByProviderAndRunId('github', repo, runId);

  if (existing) {
    pipelineRepo.updatePipelineEvent(existing.id, { status: mappedStatus, commitSha: run.head_sha });
  } else {
    pipelineRepo.createPipelineEvent({
      taskId,
      provider: 'github',
      repo,
      runId,
      status: mappedStatus,
      branch,
      commitSha: run.head_sha,
    });
  }

  if (mappedStatus === 'success' || mappedStatus === 'failure') {
    const settings = getSettingsForTask(taskId);
    const pattern = settings?.taskPattern || '[?&;]taskId=([0-9a-f-]{36})';
    const artifactDesc = mappedStatus === 'success'
      ? `${run.name} passed`
      : `${run.name} failed`;
    const artifactUrl = run.html_url;
    taskRepo.addArtifact(taskId, {
      type: 'log',
      url: artifactUrl,
      description: artifactDesc,
    });
  }

  eventRepo.createEvent({
    taskId,
    actorType: 'system',
    actorId: 'github-ci',
    action: 'updated',
    metadata: { provider: 'github', runId, pipelineStatus: mappedStatus, repo, branch },
  });

  const boardId = getBoardIdForTask(taskId);
  if (boardId) {
    sseBroadcaster.publish(boardId, {
      type: 'task.updated',
      data: taskRepo.getTaskById(taskId)!,
    });
  }

  return { status: 'processed', taskId };
}

export function handleGitHubWorkflowJobEvent(body: GitHubWorkflowJobEvent): { status: string; taskId?: string } {
  const job = body.workflow_job;
  const repo = job.repository.full_name;
  const branch = job.head_branch;
  const runId = String(job.run_id);
  const mappedStatus = mapGitHubStatus(job.status, job.conclusion);

  const taskId = findTaskAcrossBoards(repo, branch);
  if (!taskId) return { status: 'no_matching_task' };

  const task = taskRepo.getTaskById(taskId);
  if (!task) return { status: 'task_not_found' };

  const existing = pipelineRepo.findByProviderAndRunId('github', repo, runId);

  if (existing) {
    pipelineRepo.updatePipelineEvent(existing.id, { status: mappedStatus });
  } else {
    pipelineRepo.createPipelineEvent({
      taskId,
      provider: 'github',
      repo,
      runId,
      status: mappedStatus,
      branch,
      commitSha: job.head_sha,
    });
  }

  const boardId2 = getBoardIdForTask(taskId);
  if (boardId2) {
    sseBroadcaster.publish(boardId2, {
      type: 'task.updated',
      data: taskRepo.getTaskById(taskId)!,
    });
  }

  return { status: 'processed', taskId };
}

export function handleGitLabPipelineEvent(body: GitLabPipelineEvent): { status: string; taskId?: string } {
  const attrs = body.object_attributes;
  const repo = body.project.path_with_namespace;
  const branch = attrs.ref;
  const runId = String(attrs.id);
  const mappedStatus = mapGitLabStatus(attrs.status);

  const taskId = findTaskAcrossBoards(repo, branch);
  if (!taskId) return { status: 'no_matching_task' };

  const task = taskRepo.getTaskById(taskId);
  if (!task) return { status: 'task_not_found' };

  const existing = pipelineRepo.findByProviderAndRunId('gitlab', repo, runId);

  if (existing) {
    pipelineRepo.updatePipelineEvent(existing.id, { status: mappedStatus, commitSha: attrs.sha });
  } else {
    pipelineRepo.createPipelineEvent({
      taskId,
      provider: 'gitlab',
      repo,
      runId,
      status: mappedStatus,
      branch,
      commitSha: attrs.sha,
    });
  }

  if (mappedStatus === 'success' || mappedStatus === 'failure') {
    const pipelineUrl = `${body.project.web_url}/-/pipelines/${attrs.id}`;
    const artifactDesc = mappedStatus === 'success'
      ? 'Pipeline passed'
      : 'Pipeline failed';
    taskRepo.addArtifact(taskId, {
      type: 'log',
      url: pipelineUrl,
      description: artifactDesc,
    });
  }

  eventRepo.createEvent({
    taskId,
    actorType: 'system',
    actorId: 'gitlab-ci',
    action: 'updated',
    metadata: { provider: 'gitlab', runId, pipelineStatus: mappedStatus, repo, branch },
  });

  const boardId3 = getBoardIdForTask(taskId);
  if (boardId3) {
    sseBroadcaster.publish(boardId3, {
      type: 'task.updated',
      data: taskRepo.getTaskById(taskId)!,
    });
  }

  return { status: 'processed', taskId };
}

export function handleGitLabJobEvent(body: GitLabJobEvent): { status: string; taskId?: string } {
  const repo = body.project.path_with_namespace;
  const branch = body.ref;
  const runId = String(body.pipeline_id);
  const mappedStatus = mapGitLabStatus(body.build_status);

  const taskId = findTaskAcrossBoards(repo, branch);
  if (!taskId) return { status: 'no_matching_task' };

  const task = taskRepo.getTaskById(taskId);
  if (!task) return { status: 'task_not_found' };

  const existing = pipelineRepo.findByProviderAndRunId('gitlab', repo, runId);

  if (existing) {
    pipelineRepo.updatePipelineEvent(existing.id, { status: mappedStatus });
  } else {
    pipelineRepo.createPipelineEvent({
      taskId,
      provider: 'gitlab',
      repo,
      runId,
      status: mappedStatus,
      branch,
      commitSha: body.sha,
    });
  }

  const boardId4 = getBoardIdForTask(taskId);
  if (boardId4) {
    sseBroadcaster.publish(boardId4, {
      type: 'task.updated',
      data: taskRepo.getTaskById(taskId)!,
    });
  }

  return { status: 'processed', taskId };
}
