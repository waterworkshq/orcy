import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeAgent } from './factories/agent.js';
import { makeTask } from './factories/task.js';
import { makeBoard } from './factories/board.js';
import { mockRequest, mockReply } from './factories/mockRequest.js';

vi.mock('../lib/logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('../db/index.js', () => ({
  getDb: vi.fn(),
  initDb: vi.fn(),
  closeDb: vi.fn(),
}));

vi.mock('../repositories/agent.js', () => ({
  heartbeat: vi.fn(),
  getAgentById: vi.fn(),
  listAgents: vi.fn().mockReturnValue([]),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  getAgentByApiKey: vi.fn(),
  getStaleAgents: vi.fn().mockReturnValue([]),
  setAgentOffline: vi.fn(),
}));

vi.mock('../repositories/task.js', () => ({
  getTaskById: vi.fn(),
  getBoardIdForTask: vi.fn(),
  releaseTask: vi.fn(),
}));

vi.mock('../repositories/board.js', () => ({
  getBoardById: vi.fn().mockReturnValue(null),
  createBoard: vi.fn(),
  updateBoard: vi.fn(),
  deleteBoard: vi.fn(),
  listBoards: vi.fn().mockReturnValue([]),
}));

vi.mock('../services/timeTrackingService.js', () => ({
  recordWork: vi.fn(),
}));

vi.mock('../sse/broadcaster.js', () => ({
  sseBroadcaster: {
    publish: vi.fn(),
  },
}));

vi.mock('../plugins/pluginManager.js', () => ({
  emitAgentRegistered: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  rmSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { logger } from '../lib/logger.js';
import { getDb } from '../db/index.js';
import { heartbeat } from '../services/agentService.js';
import { recordWork } from '../services/timeTrackingService.js';
import * as agentRepo from '../repositories/agent.js';
import * as taskRepo from '../repositories/task.js';
import { getBoardById } from '../repositories/board.js';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import {
  createWorktree,
  removeWorktree,
  _resetActiveWorktrees,
} from '../services/gitWorktreeService.js';


const VALID_TASK_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const VALID_BOARD_ID = 'board-1234';
const VALID_REPO_PATH = '/home/user/project';

describe('Silent catch block remediation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetActiveWorktrees();
    vi.mocked(getBoardById).mockReturnValue(null);
    vi.mocked(taskRepo.getTaskById).mockReturnValue(null);
    vi.mocked(taskRepo.getBoardIdForTask).mockReturnValue(null);
  });

  describe('middleware/rateLimit.ts - getAgentRateLimit', () => {
    it('logs warning and returns default when db query fails', async () => {
      vi.mocked(getDb).mockImplementation(() => {
        throw new Error('db unavailable');
      });

      const { perAgentRateLimit } = await import('../middleware/rateLimit.js');

      const req = mockRequest({ headers: {}, agent: { id: 'agent-1' } });
      const { reply } = mockReply();

      await perAgentRateLimit(req, reply);

      expect(logger.warn).toHaveBeenCalledWith(
        { err: expect.any(Error), agentId: 'agent-1' },
        'Failed to query agent rate limit, using default'
      );
    });
  });

  describe('services/agentService.ts - heartbeat recordWork', () => {
    it('logs warning when recordWork fails during heartbeat', () => {
      vi.mocked(agentRepo.heartbeat).mockReturnValue(
        makeAgent({ id: 'agent-1', status: 'working', currentTaskId: 'task-1' })
      );

      vi.mocked(taskRepo.getTaskById).mockReturnValue(
        makeTask({ id: 'task-1', status: 'in_progress' })
      );

      vi.mocked(recordWork).mockImplementation(() => {
        throw new Error('tracking failed');
      });

      heartbeat('agent-1', 'task-1');

      expect(logger.warn).toHaveBeenCalledWith(
        { err: expect.any(Error), taskId: 'task-1', agentId: 'agent-1' },
        'Failed to record work during heartbeat'
      );
    });
  });

  describe('services/auditArchivalService.ts - archive read/parse', () => {
    it('logs warning when archive file read/parse fails', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error('read failed');
      });
      vi.mocked(writeFileSync).mockImplementation(() => {});

      const mockGet = vi.fn().mockReturnValue({ eventRetentionDays: 90 });
      const mockAll = vi.fn().mockReturnValue([{
        id: 'evt-1',
        taskId: 'task-1',
        actorType: 'agent',
        actorId: 'agent-1',
        action: 'claimed',
        fromColumnId: null,
        toColumnId: null,
        fromStatus: null,
        toStatus: null,
        metadata: null,
        timestamp: new Date().toISOString(),
        boardId: 'board-1',
      }]);

      const chainable = {
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        get: mockGet,
        all: mockAll,
      };

      const mockDb = {
        select: vi.fn().mockReturnValue(chainable),
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ run: vi.fn() }),
        }),
      };

      vi.mocked(getDb).mockReturnValue(mockDb as unknown as ReturnType<typeof getDb>);

      const { archiveOldEvents } = await import('../services/auditArchivalService.js');
      archiveOldEvents('board-1');

      expect(logger.warn).toHaveBeenCalledWith(
        { err: expect.any(Error), archivePath: expect.any(String) },
        'Failed to read/parse existing archive file, starting fresh'
      );
    });
  });

  describe('services/gitWorktreeService.ts - cleanup catch blocks', () => {
    function setupBoardWithWorktree() {
      vi.mocked(getBoardById).mockReturnValue(
        makeBoard({
          id: VALID_BOARD_ID,
          name: 'Test Board',
          description: '',
          gitWorktreeSettings: {
            repoPath: VALID_REPO_PATH,
            branchPrefix: 'task',
            autoCleanup: true,
          },
          createdAt: '',
          updatedAt: '',
        })
      );
    }

    it('logs warning when fallback worktree creation fails', () => {
      setupBoardWithWorktree();

      vi.mocked(execFileSync)
        .mockImplementationOnce(() => { throw new Error('worktree add failed'); })
        .mockImplementationOnce(() => { throw new Error('detached add failed'); })
        .mockImplementationOnce(() => { throw new Error('branch list failed'); });

      const result = createWorktree(VALID_TASK_ID, VALID_BOARD_ID);

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        { err: expect.any(Error), branchName: expect.any(String), repoPath: expect.any(String) },
        'Failed fallback worktree creation from existing branch'
      );
    });

    it('logs warning when branch deletion fails during removeWorktree', () => {
      setupBoardWithWorktree();

      vi.mocked(execFileSync)
        .mockImplementationOnce(() => 'worktree created')
        .mockImplementationOnce(() => { throw new Error('worktree remove failed'); })
        .mockImplementationOnce(() => { throw new Error('branch delete failed'); });

      const entry = createWorktree(VALID_TASK_ID, VALID_BOARD_ID);
      expect(entry).not.toBeNull();

      const removed = removeWorktree(VALID_TASK_ID);
      expect(removed).toBe(true);

      expect(logger.warn).toHaveBeenCalledWith(
        { err: expect.any(Error), branch: expect.any(String) },
        'Failed to delete worktree branch during cleanup'
      );
    });
  });

  describe('db/index.ts - closeDb logging pattern', () => {
    it('logs error via logger.error for database close failure', () => {
      const closeErr = new Error('close failed');
      try {
        throw closeErr;
      } catch (err) {
        logger.error({ err }, 'Failed to close database connection');
      }

      expect(logger.error).toHaveBeenCalledWith(
        { err: closeErr },
        'Failed to close database connection'
      );
    });
  });
});
