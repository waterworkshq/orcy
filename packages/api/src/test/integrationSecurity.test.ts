import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";

type HabitatMock = {
  id: string;
  name: string;
  code_review_settings?: string;
  ciCdSettings?: {
    githubSecret: string | null;
    gitlabSecret: string | null;
    taskPattern: string;
  } | null;
};

const habitatMocks = vi.hoisted(() => {
  const state: { habitats: Record<string, HabitatMock> } = { habitats: {} };

  return {
    state,
    createHabitatMockDb: () => ({
      insert: () => ({
        values: (v: HabitatMock) => ({
          run: () => {
            state.habitats[v.id] = v;
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              all: () => Object.values(state.habitats),
            }),
          }),
          all: () => Object.values(state.habitats),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({ run: () => {} }),
        }),
      }),
      delete: () => ({
        where: () => ({ run: () => {} }),
      }),
    }),
  };
});

vi.mock("../db/index.js", () => ({
  getDb: () => habitatMocks.createHabitatMockDb(),
  initDb: vi.fn(),
  closeDb: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: string, val: any) => ({ col, val }),
  and: (...conditions: any[]) => ({ _type: "and", conditions }),
  sql: (strings: any, ...values: any[]) => ({ _type: "sql", strings, values }),
  desc: (col: any) => col,
  asc: (col: any) => col,
  or: (...conditions: any[]) => ({ _type: "or", conditions }),
  isNull: (col: string) => ({ _type: `isNull_${col}`, col }),
  not: (cond: any) => cond,
  count: () => "count",
}));

vi.mock("../db/schema/index.js", () => ({
  habitats: {
    id: "id",
    name: "name",
    codeReviewSettings: "codeReviewSettings",
    ciCdSettings: "ciCdSettings",
  },
  tasks: {
    id: "id",
    habitatId: "habitatId",
    title: "title",
    status: "status",
    artifacts: "artifacts",
    missionId: "missionId",
  },
  agents: { id: "id", name: "name" },
  pullRequests: {
    id: "id",
    taskId: "taskId",
    provider: "provider",
    repo: "repo",
    prNumber: "prNumber",
  },
  pipelineEvents: {
    id: "id",
    taskId: "taskId",
    provider: "provider",
    runId: "runId",
    status: "status",
  },
}));

vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: vi.fn() },
}));

vi.mock("../repositories/event.js", () => ({
  createEvent: vi.fn(),
}));

vi.mock("../repositories/pullRequest.js", () => ({
  createPullRequest: vi.fn(),
  getByTaskId: vi.fn(() => []),
  updatePullRequest: vi.fn(),
  findByProviderAndNumber: vi.fn(() => null),
  findTaskIdByPattern: vi.fn(() => null),
}));

vi.mock("../repositories/task.js", () => ({
  getTaskById: vi.fn(() => null),
  getHabitatIdForTask: vi.fn(() => null),
}));

vi.mock("../repositories/pipelineEvent.js", () => ({
  createPipelineEvent: vi.fn(),
  getByTaskId: vi.fn(() => []),
  updatePipelineEvent: vi.fn(),
  findByProviderAndRunId: vi.fn(() => null),
}));

vi.mock("../repositories/habitat.js", () => ({
  listHabitats: vi.fn(() => Object.values(habitatMocks.state.habitats)),
  getHabitatById: vi.fn((id: string) => habitatMocks.state.habitats[id] ?? null),
}));

function makeGitHubSignature(payload: string | Buffer, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

describe("integrationSecurity helpers", () => {
  describe("constantTimeEqual", () => {
    it("returns true for equal strings", async () => {
      const { constantTimeEqual } = await import("../config/integrationSecurity.js");
      expect(constantTimeEqual("abc", "abc")).toBe(true);
    });

    it("returns false for different strings", async () => {
      const { constantTimeEqual } = await import("../config/integrationSecurity.js");
      expect(constantTimeEqual("abc", "def")).toBe(false);
    });

    it("returns false for different lengths", async () => {
      const { constantTimeEqual } = await import("../config/integrationSecurity.js");
      expect(constantTimeEqual("abc", "abcd")).toBe(false);
    });
  });

  describe("verifyGitHubHmac", () => {
    it("accepts valid signature over raw payload", async () => {
      const { verifyGitHubHmac } = await import("../config/integrationSecurity.js");
      const secret = "webhook-secret";
      const payload = '{"action":"opened","number":1}';
      const sig = makeGitHubSignature(payload, secret);
      expect(verifyGitHubHmac(payload, sig, secret)).toBe(true);
    });

    it("accepts Buffer payload", async () => {
      const { verifyGitHubHmac } = await import("../config/integrationSecurity.js");
      const secret = "webhook-secret";
      const payload = Buffer.from('{"action":"opened"}');
      const sig = makeGitHubSignature(payload, secret);
      expect(verifyGitHubHmac(payload, sig, secret)).toBe(true);
    });

    it("rejects wrong secret", async () => {
      const { verifyGitHubHmac } = await import("../config/integrationSecurity.js");
      const payload = '{"action":"opened"}';
      const sig = makeGitHubSignature(payload, "correct-secret");
      expect(verifyGitHubHmac(payload, sig, "wrong-secret")).toBe(false);
    });

    it("rejects invalid signature format", async () => {
      const { verifyGitHubHmac } = await import("../config/integrationSecurity.js");
      expect(verifyGitHubHmac("{}", "not-a-valid-sig", "secret")).toBe(false);
    });

    it("uses raw bytes not re-serialized JSON", async () => {
      const { verifyGitHubHmac } = await import("../config/integrationSecurity.js");
      const rawPayload = '{"key":"value","a":1}';
      const secret = "secret";
      const sig = makeGitHubSignature(rawPayload, secret);
      expect(verifyGitHubHmac(rawPayload, sig, secret)).toBe(true);
      const reSerialized = JSON.stringify(JSON.parse(rawPayload));
      if (rawPayload !== reSerialized) {
        expect(verifyGitHubHmac(reSerialized, sig, secret)).toBe(false);
      }
    });
  });

  describe("verifyGitLabToken", () => {
    it("accepts matching token", async () => {
      const { verifyGitLabToken } = await import("../config/integrationSecurity.js");
      expect(verifyGitLabToken("my-token", "my-token")).toBe(true);
    });

    it("rejects non-matching token", async () => {
      const { verifyGitLabToken } = await import("../config/integrationSecurity.js");
      expect(verifyGitLabToken("wrong", "my-token")).toBe(false);
    });

    it("rejects empty provided token", async () => {
      const { verifyGitLabToken } = await import("../config/integrationSecurity.js");
      expect(verifyGitLabToken("", "my-token")).toBe(false);
    });

    it("rejects empty secret", async () => {
      const { verifyGitLabToken } = await import("../config/integrationSecurity.js");
      expect(verifyGitLabToken("my-token", "")).toBe(false);
    });
  });

  describe("verifySlackSignature", () => {
    it("accepts valid signature with current timestamp", async () => {
      const { verifySlackSignature } = await import("../config/integrationSecurity.js");
      const secret = "slack-secret";
      const timestamp = String(Math.floor(Date.now() / 1000));
      const rawBody = "text=hello&user_id=U123";
      const baseString = `v0:${timestamp}:${rawBody}`;
      const signature = "v0=" + createHmac("sha256", secret).update(baseString).digest("hex");

      const result = verifySlackSignature(signature, timestamp, rawBody, secret);
      expect(result.valid).toBe(true);
    });

    it("rejects missing signature", async () => {
      const { verifySlackSignature } = await import("../config/integrationSecurity.js");
      const result = verifySlackSignature(
        undefined,
        String(Math.floor(Date.now() / 1000)),
        "body",
        "secret",
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Missing");
    });

    it("rejects missing timestamp", async () => {
      const { verifySlackSignature } = await import("../config/integrationSecurity.js");
      const result = verifySlackSignature("v0=something", undefined, "body", "secret");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Missing");
    });

    it("rejects stale timestamp", async () => {
      const { verifySlackSignature } = await import("../config/integrationSecurity.js");
      const secret = "slack-secret";
      const oldTimestamp = String(Math.floor(Date.now() / 1000) - 600);
      const rawBody = "text=hello";
      const baseString = `v0:${oldTimestamp}:${rawBody}`;
      const signature = "v0=" + createHmac("sha256", secret).update(baseString).digest("hex");

      const result = verifySlackSignature(signature, oldTimestamp, rawBody, secret);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Timestamp");
    });

    it("rejects future timestamp beyond skew", async () => {
      const { verifySlackSignature } = await import("../config/integrationSecurity.js");
      const secret = "slack-secret";
      const futureTimestamp = String(Math.floor(Date.now() / 1000) + 600);
      const rawBody = "text=hello";
      const baseString = `v0:${futureTimestamp}:${rawBody}`;
      const signature = "v0=" + createHmac("sha256", secret).update(baseString).digest("hex");

      const result = verifySlackSignature(signature, futureTimestamp, rawBody, secret);
      expect(result.valid).toBe(false);
    });

    it("rejects wrong signing secret", async () => {
      const { verifySlackSignature } = await import("../config/integrationSecurity.js");
      const secret = "correct-secret";
      const timestamp = String(Math.floor(Date.now() / 1000));
      const rawBody = "text=hello";
      const baseString = `v0:${timestamp}:${rawBody}`;
      const signature =
        "v0=" + createHmac("sha256", "wrong-secret").update(baseString).digest("hex");

      const result = verifySlackSignature(signature, timestamp, rawBody, secret);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("mismatch");
    });

    it("rejects when no signing secret configured", async () => {
      const { verifySlackSignature } = await import("../config/integrationSecurity.js");
      const result = verifySlackSignature("v0=sig", "12345", "body", "");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("secret");
    });

    it("rejects invalid timestamp format", async () => {
      const { verifySlackSignature } = await import("../config/integrationSecurity.js");
      const result = verifySlackSignature("v0=sig", "not-a-number", "body", "secret");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Invalid timestamp");
    });
  });

  describe("verifyDiscordSignature", () => {
    it("rejects missing signature", async () => {
      const { verifyDiscordSignature } = await import("../config/integrationSecurity.js");
      expect(verifyDiscordSignature(undefined, "timestamp", "body", "key")).toBe(false);
    });

    it("rejects missing timestamp", async () => {
      const { verifyDiscordSignature } = await import("../config/integrationSecurity.js");
      expect(verifyDiscordSignature("sig", undefined, "body", "key")).toBe(false);
    });

    it("rejects missing public key", async () => {
      const { verifyDiscordSignature } = await import("../config/integrationSecurity.js");
      expect(verifyDiscordSignature("sig", "ts", "body", "")).toBe(false);
    });

    it("rejects invalid signature with valid-looking inputs", async () => {
      const { verifyDiscordSignature } = await import("../config/integrationSecurity.js");
      const result = verifyDiscordSignature(
        "a".repeat(128),
        String(Math.floor(Date.now() / 1000)),
        '{"type":1}',
        "b".repeat(64),
      );
      expect(result).toBe(false);
    });
  });
});

describe("Service-level verification delegation", () => {
  describe("githubWebhook.verifyGitHubSignature", () => {
    it("delegates to shared helper", async () => {
      const { verifyGitHubSignature } = await import("../services/githubWebhook.js");
      const secret = "test";
      const payload = '{"action":"opened"}';
      const sig = makeGitHubSignature(payload, secret);
      expect(verifyGitHubSignature(payload, sig, secret)).toBe(true);
      expect(verifyGitHubSignature(payload, sig, "wrong")).toBe(false);
    });
  });

  describe("gitlabWebhook.verifyGitLabToken", () => {
    it("uses constant-time comparison", async () => {
      const { verifyGitLabToken } = await import("../services/gitlabWebhook.js");
      expect(verifyGitLabToken("token", "token")).toBe(true);
      expect(verifyGitLabToken("wrong", "token")).toBe(false);
    });
  });

  describe("ciCdService.verifyGitHubSignature", () => {
    it("delegates to shared helper", async () => {
      const { verifyGitHubSignature } = await import("../services/ciCdService.js");
      const secret = "ci-secret";
      const payload = '{"action":"completed"}';
      const sig = makeGitHubSignature(payload, secret);
      expect(verifyGitHubSignature(payload, sig, secret)).toBe(true);
    });
  });

  describe("ciCdService.verifyGitLabToken", () => {
    it("uses constant-time comparison", async () => {
      const { verifyGitLabToken } = await import("../services/ciCdService.js");
      expect(verifyGitLabToken("token", "token")).toBe(true);
      expect(verifyGitLabToken("wrong", "token")).toBe(false);
    });
  });

  describe("slackService.verifySlackRequest", () => {
    it("rejects missing signature", async () => {
      const { verifySlackRequest } = await import("../services/slackService.js");
      expect(verifySlackRequest(undefined, "body", "secret")).toBe(false);
    });
  });

  describe("discordService.verifyDiscordRequest", () => {
    it("rejects missing inputs", async () => {
      const { verifyDiscordRequest } = await import("../services/discordService.js");
      expect(verifyDiscordRequest(undefined, "ts", "body", "key")).toBe(false);
      expect(verifyDiscordRequest("sig", undefined, "body", "key")).toBe(false);
    });
  });
});

describe("Route-level webhook fail-closed behavior", () => {
  beforeEach(() => {
    habitatMocks.state.habitats = {};
  });

  describe("GitHub code-review webhook", () => {
    it("rejects dummy signature with unmatched repo secret (returns 401)", async () => {
      habitatMocks.state.habitats["habitat-1"] = {
        id: "habitat-1",
        name: "Test",
        code_review_settings: JSON.stringify({ githubSecret: "actual-secret" }),
      };

      const { verifyGitHubHmac } = await import("../config/integrationSecurity.js");
      const fakeSig = makeGitHubSignature('{"forged":true}', "wrong-secret");
      expect(
        verifyGitHubHmac('{"repository":{"full_name":"org/repo"}}', fakeSig, "actual-secret"),
      ).toBe(false);
    });

    it("fails closed when secrets are configured but no signature provided", async () => {
      habitatMocks.state.habitats["habitat-1"] = {
        id: "habitat-1",
        name: "Test",
        code_review_settings: JSON.stringify({ githubSecret: "actual-secret" }),
      };

      const { verifyGitHubHmac } = await import("../config/integrationSecurity.js");
      expect(verifyGitHubHmac('{"test":true}', "sha256=invalid", "actual-secret")).toBe(false);
    });
  });

  describe("GitHub CI/CD webhook", () => {
    it("rejects invalid signature when secret configured", async () => {
      habitatMocks.state.habitats["habitat-1"] = {
        id: "habitat-1",
        name: "Test",
        ciCdSettings: { githubSecret: "ci-secret", gitlabSecret: null, taskPattern: "" },
      };

      const { verifyGitHubHmac } = await import("../config/integrationSecurity.js");
      const fakeSig = makeGitHubSignature('{"forged":true}', "wrong");
      expect(verifyGitHubHmac('{"test":true}', fakeSig, "ci-secret")).toBe(false);
    });
  });

  describe("GitLab code-review webhook", () => {
    it("rejects wrong token using constant-time comparison", async () => {
      const { verifyGitLabToken } = await import("../config/integrationSecurity.js");
      expect(verifyGitLabToken("wrong-token", "actual-token")).toBe(false);
    });
  });

  describe("GitLab CI/CD webhook", () => {
    it("rejects wrong token using constant-time comparison", async () => {
      const { verifyGitLabToken } = await import("../config/integrationSecurity.js");
      expect(verifyGitLabToken("wrong-token", "ci-token")).toBe(false);
    });
  });
});

describe("Slack command verification", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("unsigned Slack command cannot execute actions when secret is configured", async () => {
    process.env.SLACK_SIGNING_SECRET = "test-secret";
    const { verifySlackRequestWithTimestamp } = await import("../services/slackService.js");
    const result = verifySlackRequestWithTimestamp(
      undefined,
      undefined,
      "text=test",
      "test-secret",
    );
    expect(result.valid).toBe(false);
  });

  it("rejects stale timestamp", async () => {
    const { verifySlackSignature } = await import("../config/integrationSecurity.js");
    const secret = "test-secret";
    const oldTs = String(Math.floor(Date.now() / 1000) - 600);
    const rawBody = "text=approve+task-123";
    const base = `v0:${oldTs}:${rawBody}`;
    const sig = "v0=" + createHmac("sha256", secret).update(base).digest("hex");
    const result = verifySlackSignature(sig, oldTs, rawBody, secret);
    expect(result.valid).toBe(false);
  });

  it("accepts valid signature with current timestamp", async () => {
    const { verifySlackSignature } = await import("../config/integrationSecurity.js");
    const secret = "test-secret";
    const ts = String(Math.floor(Date.now() / 1000));
    const rawBody = "text=list";
    const base = `v0:${ts}:${rawBody}`;
    const sig = "v0=" + createHmac("sha256", secret).update(base).digest("hex");
    const result = verifySlackSignature(sig, ts, rawBody, secret);
    expect(result.valid).toBe(true);
  });
});

describe("Discord interaction verification", () => {
  it("unsigned Discord interaction cannot execute commands", async () => {
    const { verifyDiscordSignature } = await import("../config/integrationSecurity.js");
    const result = verifyDiscordSignature(undefined, undefined, '{"type":2}', "some-key");
    expect(result).toBe(false);
  });

  it("rejects invalid Ed25519 signature when public key configured", async () => {
    const { verifyDiscordSignature } = await import("../config/integrationSecurity.js");
    const result = verifyDiscordSignature(
      "c".repeat(128),
      String(Math.floor(Date.now() / 1000)),
      '{"type":2}',
      "d".repeat(64),
    );
    expect(result).toBe(false);
  });

  it("rejects missing signature when public key is required", async () => {
    const { verifyDiscordSignature } = await import("../config/integrationSecurity.js");
    const result = verifyDiscordSignature(undefined, "12345", "{}", "public-key");
    expect(result).toBe(false);
  });
});

describe("Remote posture fail-closed", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("isRemotePosture returns true in production", async () => {
    process.env.NODE_ENV = "production";
    const { isRemotePosture } = await import("../config/integrationSecurity.js");
    expect(isRemotePosture()).toBe(true);
    delete process.env.NODE_ENV;
  });

  it("isRemotePosture returns false on localhost", async () => {
    delete process.env.NODE_ENV;
    process.env.HOST = "127.0.0.1";
    const mod = await import("../config/integrationSecurity.js");
    expect(mod.isRemotePosture()).toBe(false);
    delete process.env.HOST;
  });
});
