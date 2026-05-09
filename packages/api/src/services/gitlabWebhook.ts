import * as prRepo from '../repositories/pullRequest.js';
import * as taskRepo from '../repositories/task.js';
import { getBoardIdForTask } from '../repositories/task.js';
import * as boardRepo from '../repositories/board.js';
import * as eventRepo from '../repositories/event.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import type { CodeReviewSettings } from '../models/index.js';
import { verifyGitLabToken as secureVerifyGitLabToken } from '../config/integrationSecurity.js';

export function verifyGitLabToken(providedToken: string, secret: string): boolean {
  return secureVerifyGitLabToken(providedToken, secret);
}

interface GitLabMergeRequestEvent {
  object_kind: 'merge_request';
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
  object_kind: 'note';
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

function mapMRState(attrs: { state: string }): 'open' | 'merged' | 'closed' {
  if (attrs.state === 'merged') return 'merged';
  if (attrs.state === 'closed') return 'closed';
  return 'open';
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

function findTaskAcrossBoards(repo: string, branchName: string, mrTitle: string): string | null {
  const boards = boardRepo.listBoards();
  for (const board of boards) {
    const settings = getSettingsForBoard(board.id);
    if (settings) {
      const pattern = settings.taskPattern || '[?&;]taskId=([0-9a-f-]{36})';
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

export function handleMergeRequestEvent(body: GitLabMergeRequestEvent): { status: string; taskId?: string } {
  const attrs = body.object_attributes;
  const repo = body.project.path_with_namespace;
  const branchName = attrs.source_branch;
  const mrTitle = attrs.title;
  const mrNumber = attrs.iid;
  const mrUrl = attrs.url;
  const mrState = mapMRState(attrs);

  const taskId = findTaskAcrossBoards(repo, branchName, mrTitle);
  if (!taskId) return { status: 'no_matching_task' };

  const task = taskRepo.getTaskById(taskId);
  if (!task) return { status: 'task_not_found' };

  const existing = prRepo.findByProviderAndNumber('gitlab', repo, mrNumber);

  if (body.action === 'open' || body.action === 'update' || body.action === 'reopen') {
    if (existing) {
      prRepo.updatePullRequest(existing.id, { prTitle: mrTitle, state: mrState });
    } else {
      prRepo.createPullRequest({
        taskId,
        provider: 'gitlab',
        repo,
        prNumber: mrNumber,
        prTitle: mrTitle,
        prUrl: mrUrl,
        branchName,
        state: mrState,
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

  if (body.action === 'merge') {
    if (existing) {
      prRepo.updatePullRequest(existing.id, { state: 'merged' });

      const settingsBoardId = getBoardIdForTask(taskId);
      const settings = settingsBoardId ? getSettingsForBoard(settingsBoardId) : null;
      if (settings?.autoApproveOnMerge && task.status === 'submitted') {
        const approved = taskRepo.approveTask(taskId);
        if (approved) {
          eventRepo.createEvent({
            taskId,
            actorType: 'system',
            actorId: 'gitlab-webhook',
            action: 'approved',
            metadata: { provider: 'gitlab', repo, prNumber: mrNumber, autoApproved: true },
          });
          const boardId2 = getBoardIdForTask(taskId);
          if (boardId2) {
            sseBroadcaster.publish(boardId2, {
              type: 'task.approved',
              data: { taskId, reviewerId: 'gitlab-webhook' },
            });
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
    return { status: 'merged', taskId };
  }

  if (body.action === 'close') {
    if (existing) {
      prRepo.updatePullRequest(existing.id, { state: 'closed' });
    }
    return { status: 'closed', taskId };
  }

  return { status: 'ignored' };
}

export function handleNoteEvent(body: GitLabNoteEvent): { status: string; taskId?: string } {
  if (body.noteable_type !== 'MergeRequest') return { status: 'ignored' };

  const repo = body.project.path_with_namespace;
  const mrNumber = body.merge_request.iid;

  const existing = prRepo.findByProviderAndNumber('gitlab', repo, mrNumber);
  if (!existing) return { status: 'mr_not_linked' };

  return { status: 'noted', taskId: existing.taskId };
}
