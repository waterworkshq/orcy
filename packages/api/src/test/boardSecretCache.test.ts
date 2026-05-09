import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListBoards = vi.fn();

vi.mock('../repositories/board.js', () => ({
  listBoards: (...args: unknown[]) => mockListBoards(...args),
}));

vi.mock('../config/integrationSecurity.js', () => ({
  verifyGitHubHmac: (rawBody: string, signature: string, secret: string) => {
    return signature === `sha256=${secret}`;
  },
}));

describe('boardSecretCache', () => {
  let rebuildCache: () => void;
  let lookupBoardIdBySecret: (secret: string) => string | null;
  let findBoardIdByGithubSignature: (rawBody: string, signature: string) => string | null;
  let hasGithubSecretsConfigured: () => boolean;
  let hasAnySecretsConfigured: () => boolean;

  beforeEach(async () => {
    vi.resetModules();
    mockListBoards.mockReset();
    const mod = await import('../services/boardSecretCache.js');
    rebuildCache = mod.rebuildCache;
    lookupBoardIdBySecret = mod.lookupBoardIdBySecret;
    findBoardIdByGithubSignature = mod.findBoardIdByGithubSignature;
    hasGithubSecretsConfigured = mod.hasGithubSecretsConfigured;
    hasAnySecretsConfigured = mod.hasAnySecretsConfigured;
  });

  describe('rebuildCache', () => {
    it('populates map from boards with valid gitlabSecret', () => {
      mockListBoards.mockReturnValue([
        {
          id: 'board-1',
          name: 'Board 1',
          codeReviewSettings: {
            gitlabSecret: 'secret-abc',
            githubSecret: null,
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
        {
          id: 'board-2',
          name: 'Board 2',
          codeReviewSettings: {
            gitlabSecret: 'secret-xyz',
            githubSecret: null,
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();

      expect(lookupBoardIdBySecret('secret-abc')).toBe('board-1');
      expect(lookupBoardIdBySecret('secret-xyz')).toBe('board-2');
    });

    it('skips boards with null codeReviewSettings', () => {
      mockListBoards.mockReturnValue([
        {
          id: 'board-1',
          name: 'Board 1',
          codeReviewSettings: null,
        },
      ]);

      rebuildCache();

      expect(hasAnySecretsConfigured()).toBe(false);
    });

    it('skips boards with null gitlabSecret', () => {
      mockListBoards.mockReturnValue([
        {
          id: 'board-1',
          name: 'Board 1',
          codeReviewSettings: {
            gitlabSecret: null,
            githubSecret: 'some-github-secret',
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();

      expect(lookupBoardIdBySecret('some-github-secret')).toBeNull();
    });

    it('handles empty board list', () => {
      mockListBoards.mockReturnValue([]);

      rebuildCache();

      expect(hasAnySecretsConfigured()).toBe(false);
      expect(lookupBoardIdBySecret('anything')).toBeNull();
    });

    it('replaces previous entries on rebuild', () => {
      mockListBoards.mockReturnValue([
        {
          id: 'board-1',
          name: 'Board 1',
          codeReviewSettings: {
            gitlabSecret: 'old-secret',
            githubSecret: null,
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();
      expect(lookupBoardIdBySecret('old-secret')).toBe('board-1');

      mockListBoards.mockReturnValue([
        {
          id: 'board-2',
          name: 'Board 2',
          codeReviewSettings: {
            gitlabSecret: 'new-secret',
            githubSecret: null,
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();
      expect(lookupBoardIdBySecret('old-secret')).toBeNull();
      expect(lookupBoardIdBySecret('new-secret')).toBe('board-2');
    });
  });

  describe('lookupBoardIdBySecret', () => {
    it('returns correct boardId for known secret', () => {
      mockListBoards.mockReturnValue([
        {
          id: 'board-42',
          name: 'Board 42',
          codeReviewSettings: {
            gitlabSecret: 'known-token',
            githubSecret: null,
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();

      expect(lookupBoardIdBySecret('known-token')).toBe('board-42');
    });

    it('returns null for unknown secret', () => {
      mockListBoards.mockReturnValue([
        {
          id: 'board-1',
          name: 'Board 1',
          codeReviewSettings: {
            gitlabSecret: 'actual-secret',
            githubSecret: null,
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();

      expect(lookupBoardIdBySecret('wrong-secret')).toBeNull();
    });

    it('returns null when cache has not been built', () => {
      expect(lookupBoardIdBySecret('anything')).toBeNull();
    });
  });

  describe('hasAnySecretsConfigured', () => {
    it('returns true when gitlab secrets exist', () => {
      mockListBoards.mockReturnValue([
        {
          id: 'board-1',
          name: 'Board 1',
          codeReviewSettings: {
            gitlabSecret: 'secret-1',
            githubSecret: null,
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();

      expect(hasAnySecretsConfigured()).toBe(true);
    });

    it('returns true when github secrets exist', () => {
      mockListBoards.mockReturnValue([
        {
          id: 'board-1',
          name: 'Board 1',
          codeReviewSettings: {
            gitlabSecret: null,
            githubSecret: 'gh-secret',
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();

      expect(hasAnySecretsConfigured()).toBe(true);
    });

    it('returns false when no secrets exist', () => {
      mockListBoards.mockReturnValue([
        {
          id: 'board-1',
          name: 'Board 1',
          codeReviewSettings: null,
        },
      ]);

      rebuildCache();

      expect(hasAnySecretsConfigured()).toBe(false);
    });

    it('returns false when cache has not been built', () => {
      expect(hasAnySecretsConfigured()).toBe(false);
    });
  });

  describe('findBoardIdByGithubSignature', () => {
    it('returns boardId when HMAC signature matches cached secret', () => {
      mockListBoards.mockReturnValue([
        {
          id: 'board-1',
          name: 'Board 1',
          codeReviewSettings: {
            gitlabSecret: null,
            githubSecret: 'my-github-secret',
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();

      expect(findBoardIdByGithubSignature('body', 'sha256=my-github-secret')).toBe('board-1');
    });

    it('returns null when no secret matches the signature', () => {
      mockListBoards.mockReturnValue([
        {
          id: 'board-1',
          name: 'Board 1',
          codeReviewSettings: {
            gitlabSecret: null,
            githubSecret: 'correct-secret',
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();

      expect(findBoardIdByGithubSignature('body', 'sha256=wrong-secret')).toBeNull();
    });

    it('returns null when no github secrets are cached', () => {
      mockListBoards.mockReturnValue([
        {
          id: 'board-1',
          name: 'Board 1',
          codeReviewSettings: {
            gitlabSecret: 'gitlab-token',
            githubSecret: null,
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();

      expect(findBoardIdByGithubSignature('body', 'sha256=anything')).toBeNull();
    });

    it('returns null when cache has not been built', () => {
      expect(findBoardIdByGithubSignature('body', 'sha256=anything')).toBeNull();
    });

    it('matches the correct board when multiple github secrets exist', () => {
      mockListBoards.mockReturnValue([
        {
          id: 'board-1',
          name: 'Board 1',
          codeReviewSettings: {
            gitlabSecret: null,
            githubSecret: 'secret-alpha',
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
        {
          id: 'board-2',
          name: 'Board 2',
          codeReviewSettings: {
            gitlabSecret: null,
            githubSecret: 'secret-beta',
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();

      expect(findBoardIdByGithubSignature('body', 'sha256=secret-beta')).toBe('board-2');
    });
  });

  describe('hasGithubSecretsConfigured', () => {
    it('returns true when github secrets are cached', () => {
      mockListBoards.mockReturnValue([
        {
          id: 'board-1',
          name: 'Board 1',
          codeReviewSettings: {
            gitlabSecret: null,
            githubSecret: 'gh-secret',
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();

      expect(hasGithubSecretsConfigured()).toBe(true);
    });

    it('returns false when no github secrets are cached', () => {
      mockListBoards.mockReturnValue([
        {
          id: 'board-1',
          name: 'Board 1',
          codeReviewSettings: {
            gitlabSecret: 'gitlab-token',
            githubSecret: null,
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();

      expect(hasGithubSecretsConfigured()).toBe(false);
    });

    it('returns false when cache has not been built', () => {
      expect(hasGithubSecretsConfigured()).toBe(false);
    });
  });
});
