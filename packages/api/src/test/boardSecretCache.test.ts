import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListHabitats = vi.fn();

vi.mock('../repositories/habitat.js', () => ({
  listHabitats: (...args: unknown[]) => mockListHabitats(...args),
}));

vi.mock('../config/integrationSecurity.js', () => ({
  verifyGitHubHmac: (rawBody: string, signature: string, secret: string) => {
    return signature === `sha256=${secret}`;
  },
}));

describe('boardSecretCache', () => {
  let rebuildCache: () => void;
  let lookupHabitatIdBySecret: (secret: string) => string | null;
  let findHabitatIdByGithubSignature: (rawBody: string, signature: string) => string | null;
  let hasGithubSecretsConfigured: () => boolean;
  let hasAnySecretsConfigured: () => boolean;

  beforeEach(async () => {
    vi.resetModules();
    mockListHabitats.mockReset();
    const mod = await import('../services/habitatSecretCache.js');
    rebuildCache = mod.rebuildCache;
    lookupHabitatIdBySecret = mod.lookupHabitatIdBySecret;
    findHabitatIdByGithubSignature = mod.findHabitatIdByGithubSignature;
    hasGithubSecretsConfigured = mod.hasGithubSecretsConfigured;
    hasAnySecretsConfigured = mod.hasAnySecretsConfigured;
  });

  describe('rebuildCache', () => {
    it('populates map from habitats with valid gitlabSecret', () => {
      mockListHabitats.mockReturnValue([
        {
          id: 'habitat-1',
          name: 'Habitat 1',
          codeReviewSettings: {
            gitlabSecret: 'secret-abc',
            githubSecret: null,
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
        {
          id: 'habitat-2',
          name: 'Habitat 2',
          codeReviewSettings: {
            gitlabSecret: 'secret-xyz',
            githubSecret: null,
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();

      expect(lookupHabitatIdBySecret('secret-abc')).toBe('habitat-1');
      expect(lookupHabitatIdBySecret('secret-xyz')).toBe('habitat-2');
    });

    it('skips habitats with null codeReviewSettings', () => {
      mockListHabitats.mockReturnValue([
        {
          id: 'habitat-1',
          name: 'Habitat 1',
          codeReviewSettings: null,
        },
      ]);

      rebuildCache();

      expect(hasAnySecretsConfigured()).toBe(false);
    });

    it('skips habitats with null gitlabSecret', () => {
      mockListHabitats.mockReturnValue([
        {
          id: 'habitat-1',
          name: 'Habitat 1',
          codeReviewSettings: {
            gitlabSecret: null,
            githubSecret: 'some-github-secret',
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();

      expect(lookupHabitatIdBySecret('some-github-secret')).toBeNull();
    });

    it('handles empty habitat list', () => {
      mockListHabitats.mockReturnValue([]);

      rebuildCache();

      expect(hasAnySecretsConfigured()).toBe(false);
      expect(lookupHabitatIdBySecret('anything')).toBeNull();
    });

    it('replaces previous entries on rebuild', () => {
      mockListHabitats.mockReturnValue([
        {
          id: 'habitat-1',
          name: 'Habitat 1',
          codeReviewSettings: {
            gitlabSecret: 'old-secret',
            githubSecret: null,
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();
      expect(lookupHabitatIdBySecret('old-secret')).toBe('habitat-1');

      mockListHabitats.mockReturnValue([
        {
          id: 'habitat-2',
          name: 'Habitat 2',
          codeReviewSettings: {
            gitlabSecret: 'new-secret',
            githubSecret: null,
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();
      expect(lookupHabitatIdBySecret('old-secret')).toBeNull();
      expect(lookupHabitatIdBySecret('new-secret')).toBe('habitat-2');
    });
  });

  describe('lookupHabitatIdBySecret', () => {
    it('returns correct habitatId for known secret', () => {
      mockListHabitats.mockReturnValue([
        {
          id: 'habitat-42',
          name: 'Habitat 42',
          codeReviewSettings: {
            gitlabSecret: 'known-token',
            githubSecret: null,
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();

      expect(lookupHabitatIdBySecret('known-token')).toBe('habitat-42');
    });

    it('returns null for unknown secret', () => {
      mockListHabitats.mockReturnValue([
        {
          id: 'habitat-1',
          name: 'Habitat 1',
          codeReviewSettings: {
            gitlabSecret: 'actual-secret',
            githubSecret: null,
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();

      expect(lookupHabitatIdBySecret('wrong-secret')).toBeNull();
    });

    it('returns null when cache has not been built', () => {
      expect(lookupHabitatIdBySecret('anything')).toBeNull();
    });
  });

  describe('hasAnySecretsConfigured', () => {
    it('returns true when gitlab secrets exist', () => {
      mockListHabitats.mockReturnValue([
        {
          id: 'habitat-1',
          name: 'Habitat 1',
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
      mockListHabitats.mockReturnValue([
        {
          id: 'habitat-1',
          name: 'Habitat 1',
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
      mockListHabitats.mockReturnValue([
        {
          id: 'habitat-1',
          name: 'Habitat 1',
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

  describe('findHabitatIdByGithubSignature', () => {
    it('returns habitatId when HMAC signature matches cached secret', () => {
      mockListHabitats.mockReturnValue([
        {
          id: 'habitat-1',
          name: 'Habitat 1',
          codeReviewSettings: {
            gitlabSecret: null,
            githubSecret: 'my-github-secret',
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();

      expect(findHabitatIdByGithubSignature('body', 'sha256=my-github-secret')).toBe('habitat-1');
    });

    it('returns null when no secret matches the signature', () => {
      mockListHabitats.mockReturnValue([
        {
          id: 'habitat-1',
          name: 'Habitat 1',
          codeReviewSettings: {
            gitlabSecret: null,
            githubSecret: 'correct-secret',
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();

      expect(findHabitatIdByGithubSignature('body', 'sha256=wrong-secret')).toBeNull();
    });

    it('returns null when no github secrets are cached', () => {
      mockListHabitats.mockReturnValue([
        {
          id: 'habitat-1',
          name: 'Habitat 1',
          codeReviewSettings: {
            gitlabSecret: 'gitlab-token',
            githubSecret: null,
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();

      expect(findHabitatIdByGithubSignature('body', 'sha256=anything')).toBeNull();
    });

    it('returns null when cache has not been built', () => {
      expect(findHabitatIdByGithubSignature('body', 'sha256=anything')).toBeNull();
    });

    it('matches the correct habitat when multiple github secrets exist', () => {
      mockListHabitats.mockReturnValue([
        {
          id: 'habitat-1',
          name: 'Habitat 1',
          codeReviewSettings: {
            gitlabSecret: null,
            githubSecret: 'secret-alpha',
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
        {
          id: 'habitat-2',
          name: 'Habitat 2',
          codeReviewSettings: {
            gitlabSecret: null,
            githubSecret: 'secret-beta',
            autoApproveOnMerge: false,
            taskPattern: '',
          },
        },
      ]);

      rebuildCache();

      expect(findHabitatIdByGithubSignature('body', 'sha256=secret-beta')).toBe('habitat-2');
    });
  });

  describe('hasGithubSecretsConfigured', () => {
    it('returns true when github secrets are cached', () => {
      mockListHabitats.mockReturnValue([
        {
          id: 'habitat-1',
          name: 'Habitat 1',
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
      mockListHabitats.mockReturnValue([
        {
          id: 'habitat-1',
          name: 'Habitat 1',
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
