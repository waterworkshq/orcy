import { beforeEach, describe, expect, it, vi } from "vitest";

const integrationSecurityMocks = vi.hoisted(() => ({
  isRemotePosture: vi.fn(() => false),
  verifyGitHubHmac: vi.fn(),
  verifyGitLabToken: vi.fn(),
}));

const secretCacheMocks = vi.hoisted(() => ({
  lookupHabitatIdBySecret: vi.fn(),
  hasAnySecretsConfigured: vi.fn(),
  findHabitatIdByGithubSignature: vi.fn(),
  hasGithubSecretsConfigured: vi.fn(),
}));

const habitatRepoMocks = vi.hoisted(() => ({
  listHabitats: vi.fn(),
}));

vi.mock("../config/integrationSecurity.js", () => integrationSecurityMocks);
vi.mock("../services/boardSecretCache.js", () => secretCacheMocks);
vi.mock("../repositories/habitat.js", () => habitatRepoMocks);

import {
  createCiCdSecretSource,
  createCodeReviewSecretSource,
  handleGitHubWebhook,
  handleGitLabWebhook,
} from "../services/webhooks/webhook-secret-verification.js";

describe("webhook secret verification service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    integrationSecurityMocks.isRemotePosture.mockReturnValue(false);
    integrationSecurityMocks.verifyGitHubHmac.mockReturnValue(false);
    integrationSecurityMocks.verifyGitLabToken.mockReturnValue(false);
    secretCacheMocks.lookupHabitatIdBySecret.mockReturnValue(null);
    secretCacheMocks.hasAnySecretsConfigured.mockReturnValue(false);
    secretCacheMocks.findHabitatIdByGithubSignature.mockReturnValue(null);
    secretCacheMocks.hasGithubSecretsConfigured.mockReturnValue(false);
    habitatRepoMocks.listHabitats.mockReturnValue([]);
  });

  it("uses code-review secret cache lookups for GitHub and GitLab sources", () => {
    secretCacheMocks.findHabitatIdByGithubSignature.mockReturnValue("habitat-1");
    secretCacheMocks.hasGithubSecretsConfigured.mockReturnValue(true);
    secretCacheMocks.lookupHabitatIdBySecret.mockReturnValue("habitat-2");
    secretCacheMocks.hasAnySecretsConfigured.mockReturnValue(true);
    const source = createCodeReviewSecretSource();

    expect(source.verifyGitHubSignature("raw-body", "sha256=abc")).toEqual({
      matched: true,
      secretsPresent: true,
    });
    expect(source.verifyGitLabToken("gitlab-token")).toEqual({
      matched: true,
      secretsPresent: true,
    });
    expect(secretCacheMocks.findHabitatIdByGithubSignature).toHaveBeenCalledWith(
      "raw-body",
      "sha256=abc",
    );
    expect(secretCacheMocks.lookupHabitatIdBySecret).toHaveBeenCalledWith("gitlab-token");
  });

  it("parses CI/CD habitat settings and ignores null rows", () => {
    habitatRepoMocks.listHabitats.mockReturnValue([
      { id: "no-settings", ciCdSettings: null },
      {
        id: "no-secret",
        ciCdSettings: { githubSecret: null, gitlabSecret: null, taskPattern: "" },
      },
      {
        id: "github-secret",
        ciCdSettings: { githubSecret: "gh-secret", gitlabSecret: null, taskPattern: "" },
      },
      {
        id: "gitlab-secret",
        ciCdSettings: { githubSecret: null, gitlabSecret: "gl-secret", taskPattern: "" },
      },
    ]);
    integrationSecurityMocks.verifyGitHubHmac.mockImplementation(
      (_body, _sig, secret) => secret === "gh-secret",
    );
    integrationSecurityMocks.verifyGitLabToken.mockImplementation(
      (provided, secret) => provided === "token" && secret === "gl-secret",
    );
    const source = createCiCdSecretSource();

    expect(source.verifyGitHubSignature("raw", "sha256=ok")).toEqual({
      matched: true,
      secretsPresent: true,
    });
    expect(source.verifyGitLabToken("token")).toEqual({ matched: true, secretsPresent: true });
  });

  it("rejects GitHub requests with missing events before checking signatures", async () => {
    const source = createCodeReviewSecretSource();

    expect(
      await handleGitHubWebhook(
        source,
        {
          body: {},
          rawBody: "{}",
          event: undefined,
          signature: undefined,
        },
        {},
      ),
    ).toEqual({ statusCode: 400, body: { error: "Missing X-GitHub-Event header" } });
    expect(secretCacheMocks.findHabitatIdByGithubSignature).not.toHaveBeenCalled();
  });

  it("fail-opens unsigned GitHub requests only when no secrets are configured locally", async () => {
    secretCacheMocks.hasGithubSecretsConfigured.mockReturnValue(false);
    const handler = vi.fn(() => ({ ok: true }));

    const response = await handleGitHubWebhook(
      createCodeReviewSecretSource(),
      {
        body: { action: "opened" },
        rawBody: '{"action":"opened"}',
        event: "issues",
        signature: undefined,
      },
      { issues: handler },
    );

    expect(response).toEqual({ statusCode: 200, body: { ok: true } });
    expect(handler).toHaveBeenCalledWith({ action: "opened" });
  });

  it("fail-closes unsigned GitHub requests when secrets exist or remote posture is active", async () => {
    secretCacheMocks.hasGithubSecretsConfigured.mockReturnValue(true);

    expect(
      await handleGitHubWebhook(
        createCodeReviewSecretSource(),
        {
          body: {},
          rawBody: "{}",
          event: "issues",
          signature: undefined,
        },
        {},
      ),
    ).toEqual({ statusCode: 401, body: { error: "Invalid or missing signature" } });

    secretCacheMocks.hasGithubSecretsConfigured.mockReturnValue(false);
    integrationSecurityMocks.isRemotePosture.mockReturnValue(true);

    expect(
      await handleGitHubWebhook(
        createCodeReviewSecretSource(),
        {
          body: {},
          rawBody: "{}",
          event: "issues",
          signature: undefined,
        },
        {},
        { failClosed: true },
      ),
    ).toEqual({ statusCode: 401, body: { error: "Invalid or missing signature" } });
  });

  it("handles GitLab missing object kind, invalid token, handled events, and ignored events", () => {
    const source = createCodeReviewSecretSource();

    expect(
      handleGitLabWebhook(
        source,
        { body: {}, providedToken: undefined, objectKind: undefined },
        {},
      ),
    ).toEqual({ statusCode: 400, body: { error: "Missing object_kind" } });

    secretCacheMocks.hasAnySecretsConfigured.mockReturnValue(true);
    expect(
      handleGitLabWebhook(source, { body: {}, providedToken: "bad", objectKind: "push" }, {}),
    ).toEqual({ statusCode: 401, body: { error: "Invalid or missing token" } });

    secretCacheMocks.lookupHabitatIdBySecret.mockReturnValue("habitat-1");
    const handler = vi.fn(() => ({ processed: true }));
    expect(
      handleGitLabWebhook(
        source,
        { body: { object_kind: "push" }, providedToken: "good", objectKind: "push" },
        { push: handler },
      ),
    ).toEqual({ statusCode: 200, body: { processed: true } });
    expect(
      handleGitLabWebhook(
        source,
        { body: {}, providedToken: "good", objectKind: "merge_request" },
        {},
      ),
    ).toEqual({ statusCode: 200, body: { status: "ignored", objectKind: "merge_request" } });
  });
});
