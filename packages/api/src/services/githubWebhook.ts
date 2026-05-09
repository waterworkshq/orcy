import * as prRepo from '../repositories/pullRequest.js';
import * as taskRepo from '../repositories/task.js';
import { getBoardIdForTask } from '../repositories/task.js';
import * as boardRepo from '../repositories/board.js';
import * as eventRepo from '../repositories/event.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import type { CodeReviewSettings } from '../models/index.js';
import { verifyGitHubHmac } from '../config/integrationSecurity.js';

export function verifyGitHubSignature(payload: string, signature: string, secret: string): boolean {
  return verifyGitHubHmac(payload, signature, secret);
}

interface GitHubPREvent {
  action: string;
  number: number;
  pull_request: {
    title: string;
    html_url: string;
    state: string;
    merged: boolean;
    head: { ref: string };
    base: { repo: { full_name: string } };
  };
}

interface GitHubReviewEvent {
  action: string;
  pull_request: {
    number: number;
    html_url: string;
    title: string;
    state: string;
    merged: boolean;
    head: { ref: string };
    base: { repo: { full_name: string } };
  };
  review: {
    state: string;
  };
}

function mapPRState(pr: { state: string; merged: boolean }): 'open' | 'merged' | 'closed' {
  if (pr.merged) return 'merged';
  if (pr.state === 'closed') return 'closed';
  return 'open';
}

function mapReviewState(reviewState: string): 'pending' | 'approved' | 'changes_requested' {
  if (reviewState === 'approved') return 'approved';
  if (reviewState === 'changes_requested') return 'changes_requested';
  return 'pending';
}

function getSettingsForBoard(boardId: string): CodeReviewSettings | null {
  const board = boardRepo.getBoardById(boardId);
  if (!board) return null;
  const raw = (board as unknown as Record<string, unknown>).code_review_settings;
  if (!raw || typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as CodeReviewSettings;
  } catch {
    return null;
  }
}

function findTaskForPR(repo: string, branchName: string, prTitle: string, settings: CodeReviewSettings): string | null {
  const pattern = settings.taskPattern || '[?&;]taskId=([0-9a-f-]{36})';
  const taskIdFromBranch = prRepo.findTaskIdByPattern(branchName, pattern);
  if (taskIdFromBranch) {
    const task = taskRepo.getTaskById(taskIdFromBranch);
    if (task) return taskIdFromBranch;
  }
  const taskIdFromTitle = prRepo.findTaskIdByPattern(prTitle, pattern);
  if (taskIdFromTitle) {
    const task = taskRepo.getTaskById(taskIdFromTitle);
    if (task) return taskIdFromTitle;
  }
  return null;
}

function findTaskAcrossBoards(repo: string, branchName: string, prTitle: string): string | null {
  const boards = boardRepo.listBoards();
  for (const board of boards) {
    const settings = getSettingsForBoard(board.id);
    if (settings) {
      const taskId = findTaskForPR(repo, branchName, prTitle, settings);
      if (taskId) return taskId;
    }
  }
  return null;
}

export function handlePullRequestEvent(body: GitHubPREvent): { status: string; taskId?: string } {
  const pr = body.pull_request;
  const repo = pr.base.repo.full_name;
  const branchName = pr.head.ref;
  const prTitle = pr.title;
  const prState = mapPRState(pr);
  const prNumber = body.number;
  const prUrl = pr.html_url;

  const taskId = findTaskAcrossBoards(repo, branchName, prTitle);
  if (!taskId) return { status: 'no_matching_task' };

  const task = taskRepo.getTaskById(taskId);
  if (!task) return { status: 'task_not_found' };

  const existing = prRepo.findByProviderAndNumber('github', repo, prNumber);

  if (body.action === 'opened' || body.action === 'synchronize' || body.action === 'reopened') {
    if (existing) {
      prRepo.updatePullRequest(existing.id, { prTitle, state: 'open' });
    } else {
      prRepo.createPullRequest({
        taskId,
        provider: 'github',
        repo,
        prNumber,
        prTitle,
        prUrl,
        branchName,
        state: 'open',
      });
    }

    const boardId = getBoardIdForTask(taskId);
    if (boardId) {
      sseBroadcaster.publish(boardId, {
        type: 'task.updated',
        data: task,
      });
    }

    return { status: 'linked', taskId };
  }

  if (body.action === 'closed') {
    if (existing) {
      prRepo.updatePullRequest(existing.id, { state: prState, prTitle });

      if (prState === 'merged') {
        const settingsBoardId = getBoardIdForTask(taskId);
        const settings = settingsBoardId ? getSettingsForBoard(settingsBoardId) : null;
        if (settings?.autoApproveOnMerge && task.status === 'submitted') {
          const approved = taskRepo.approveTask(taskId);
          if (approved) {
            eventRepo.createEvent({
              taskId,
              actorType: 'system',
              actorId: 'github-webhook',
              action: 'approved',
              metadata: { provider: 'github', repo, prNumber, autoApproved: true },
            });
            const boardId2 = getBoardIdForTask(taskId);
            if (boardId2) {
              sseBroadcaster.publish(boardId2, {
                type: 'task.approved',
                data: { taskId, reviewerId: 'github-webhook' },
              });
            }
          }
        }
      }

      const boardId3 = getBoardIdForTask(taskId);
      if (boardId3) {
        sseBroadcaster.publish(boardId3, {
          type: 'task.updated',
          data: task,
        });
      }
    }
    return { status: 'closed', taskId };
  }

  return { status: 'ignored' };
}

export function handlePullRequestReviewEvent(body: GitHubReviewEvent): { status: string; taskId?: string } {
  const pr = body.pull_request;
  const repo = pr.base.repo.full_name;
  const prNumber = pr.number;

  const existing = prRepo.findByProviderAndNumber('github', repo, prNumber);
  if (!existing) return { status: 'pr_not_linked' };

  const reviewStatus = mapReviewState(body.review.state);
  prRepo.updatePullRequest(existing.id, { reviewStatus });

  const task = taskRepo.getTaskById(existing.taskId);
  if (task) {
    const boardId = getBoardIdForTask(existing.taskId);
    if (boardId) {
      sseBroadcaster.publish(boardId, {
        type: 'task.updated',
        data: task,
      });
    }
  }

  return { status: 'review_updated', taskId: existing.taskId };
}
