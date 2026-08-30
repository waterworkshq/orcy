import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac, generateKeyPairSync, sign } from "crypto";
import { buildPinnedLookup, fetchValidated, validateOutboundUrl, UrlRejectedError } from "../config/integrationSecurity.js";
const dnsState = vi.hoisted(() => ({
  v4: ["93.184.216.34"],
  v6: [] as string[],
  fail: false,
}));
vi.mock("node:dns", () => ({
  promises: {
    resolve4: async () => {
      if (dnsState.fail) throw new Error("SERVFAIL");
      return dnsState.v4;
    },
    resolve6: async () => {
      if (dnsState.fail) throw new Error("SERVFAIL");
      return dnsState.v6;
    },
  },
}));


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

    // Ed25519 characterization: a generated keypair stands in for the Discord
    // application key (raw 32-byte hex — SPKI DER's last 32 bytes, the form
    // DISCORD_PUBLIC_KEY takes). These cases pin the acceptance/rejection
    // domain the verifier must preserve across implementations.
    const keypair = generateKeyPairSync("ed25519");
    const rawPublicHex = keypair.publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("hex");
    const BODY = '{"type": 1}';
    const TS = "1719420000";
    const VALID_SIG = sign(null, Buffer.from(TS + BODY), keypair.privateKey).toString("hex");

    it("accepts a valid Ed25519 signature over exact timestamp+body bytes", async () => {
      const { verifyDiscordSignature } = await import("../config/integrationSecurity.js");
      expect(verifyDiscordSignature(VALID_SIG, TS, BODY, rawPublicHex)).toBe(true);
    });

    it("rejects a one-byte body change", async () => {
      const { verifyDiscordSignature } = await import("../config/integrationSecurity.js");
      expect(verifyDiscordSignature(VALID_SIG, TS, '{"type": 2}', rawPublicHex)).toBe(false);
    });

    it("rejects a changed timestamp over the same body", async () => {
      const { verifyDiscordSignature } = await import("../config/integrationSecurity.js");
      expect(verifyDiscordSignature(VALID_SIG, "1719420001", BODY, rawPublicHex)).toBe(false);
    });

    it("rejects a valid signature made under a different key", async () => {
      const { verifyDiscordSignature } = await import("../config/integrationSecurity.js");
      const other = generateKeyPairSync("ed25519");
      const otherSig = sign(null, Buffer.from(TS + BODY), other.privateKey).toString("hex");
      expect(verifyDiscordSignature(otherSig, TS, BODY, rawPublicHex)).toBe(false);
    });

    it("rejects malformed hex signature text", async () => {
      const { verifyDiscordSignature } = await import("../config/integrationSecurity.js");
      expect(verifyDiscordSignature("zz".repeat(64), TS, BODY, rawPublicHex)).toBe(false);
    });

    it("rejects odd-length and non-hex public key text", async () => {
      const { verifyDiscordSignature } = await import("../config/integrationSecurity.js");
      expect(verifyDiscordSignature(VALID_SIG, TS, BODY, rawPublicHex.slice(0, 63))).toBe(false);
      expect(verifyDiscordSignature(VALID_SIG, TS, BODY, "nothexkey")).toBe(false);
    });

    it("rejects 63-byte and 65-byte signatures", async () => {
      const { verifyDiscordSignature } = await import("../config/integrationSecurity.js");
      expect(verifyDiscordSignature(VALID_SIG.slice(0, 126), TS, BODY, rawPublicHex)).toBe(false);
      expect(verifyDiscordSignature(VALID_SIG + "00", TS, BODY, rawPublicHex)).toBe(false);
    });

    it("rejects 31-byte and 33-byte public keys", async () => {
      const { verifyDiscordSignature } = await import("../config/integrationSecurity.js");
      expect(verifyDiscordSignature(VALID_SIG, TS, BODY, rawPublicHex.slice(0, 62))).toBe(false);
      expect(verifyDiscordSignature(VALID_SIG, TS, BODY, rawPublicHex + "00")).toBe(false);
    });

    // Strict encoding: Buffer.from(x, 'hex') stops silently at the first
    // non-hex character, so valid hex plus trailing junk decodes to the
    // valid prefix bytes — the verifier must reject it as malformed.
    it("rejects a valid signature with trailing non-hex text", async () => {
      const { verifyDiscordSignature } = await import("../config/integrationSecurity.js");
      expect(verifyDiscordSignature(VALID_SIG + "zz", TS, BODY, rawPublicHex)).toBe(false);
    });

    it("rejects a valid public key with trailing non-hex text", async () => {
      const { verifyDiscordSignature } = await import("../config/integrationSecurity.js");
      expect(verifyDiscordSignature(VALID_SIG, TS, BODY, rawPublicHex + "zz")).toBe(false);
    });

    it("rejects an odd-length signature", async () => {
      const { verifyDiscordSignature } = await import("../config/integrationSecurity.js");
      expect(verifyDiscordSignature(VALID_SIG + "a", TS, BODY, rawPublicHex)).toBe(false);
    });

    it("accepts an uppercase exact valid signature and key", async () => {
      const { verifyDiscordSignature } = await import("../config/integrationSecurity.js");
      expect(verifyDiscordSignature(VALID_SIG.toUpperCase(), TS, BODY, rawPublicHex.toUpperCase())).toBe(true);
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

describe("validateOutboundUrl (canonical SSRF checker)", () => {
  beforeEach(() => {
    dnsState.v4 = ["93.184.216.34"];
    dnsState.v6 = [];
    dnsState.fail = false;
  });

  it("rejects hostnames that DNS-resolve to private space", async () => {
    dnsState.v4 = ["10.0.0.5"];
    const r = await validateOutboundUrl("https://attacker.example.com/hook");
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("private");
  });

  it("fails closed when DNS returns no addresses (both families reject)", async () => {
    dnsState.fail = true;
    const r = await validateOutboundUrl("https://rebind.example.com/hook");
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("no addresses");
  });

  it("returns its resolved IPs so callers can pin the fetch", async () => {
    dnsState.v4 = ["93.184.216.34"];
    dnsState.v6 = ["2606:2800:220:1:248:1893:25c8:1946"];
    const r = await validateOutboundUrl("https://example.com/hook");
    expect(r.valid).toBe(true);
    expect(r.resolvedIps).toEqual(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]);
  });

  it("allowlisted hosts stay valid without DNS (empty resolvedIps)", async () => {
    process.env.ORCY_SSRF_ALLOWLIST = "ntfy.internal";
    dnsState.fail = true; // would fail closed if resolution ran — allowlist must skip it
    try {
      const r = await validateOutboundUrl("https://ntfy.internal/hook");
      expect(r.valid).toBe(true);
      expect(r.resolvedIps ?? []).toEqual([]);
    } finally {
      delete process.env.ORCY_SSRF_ALLOWLIST;
      dnsState.fail = false;
    }
  });

  it("public literal-IP hosts stay valid without DNS (their address was already checked)", async () => {
    dnsState.fail = true; // literal IPs must not depend on resolution
    const r = await validateOutboundUrl("http://93.184.216.34/hook");
    expect(r.valid).toBe(true);
    expect(r.resolvedIps).toEqual(["93.184.216.34"]);
  });

  it("out-of-range dotted-quad hostnames never validate (rejected at URL parse)", async () => {
    dnsState.fail = true; // no DNS answers either — every layer rejects
    const r = await validateOutboundUrl("http://1.2.3.999/hook");
    expect(r.valid).toBe(false);
  });

  it("rejects IPv4-mapped IPv6 literals (dotted and hex forms)", async () => {
    for (const url of [
      "http://[::ffff:127.0.0.1]/x",
      "http://[::ffff:10.0.0.5]/x",
      "http://[::ffff:7f00:1]/x",
    ]) {
      const r = await validateOutboundUrl(url);
      expect(r.valid, url).toBe(false);
    }
  });

  it("accepts a public hostname resolving to public space", async () => {
    const r = await validateOutboundUrl("https://example.com/hook");
    expect(r.valid).toBe(true);
  });
});

describe("fetchValidated (pinned outbound fetch)", () => {
  beforeEach(() => {
    dnsState.v4 = ["93.184.216.34"];
    dnsState.v6 = [];
    dnsState.fail = false;
  });

  it("throws UrlRejectedError without fetching when the URL is rejected", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      dnsState.fail = true;
      await expect(fetchValidated("https://rebind.example.com/hook")).rejects.toThrow(
        "URL rejected",
      );
      await expect(fetchValidated("https://rebind.example.com/hook")).rejects.toBeInstanceOf(
        UrlRejectedError,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fetches with a pinned dispatcher, fail-closed redirect, and a default timeout", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await fetchValidated("https://example.com/hook", { method: "POST", body: "x" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchSpy.mock.calls[0] as [
        string,
        RequestInit & { dispatcher?: unknown },
      ];
      expect(calledUrl).toBe("https://example.com/hook");
      expect(init.method).toBe("POST");
      expect(init.body).toBe("x");
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.dispatcher, "fetch must be pinned to the validated answers").toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("allowlisted hosts fetch WITHOUT pinning (no dispatcher)", async () => {
    process.env.ORCY_SSRF_ALLOWLIST = "ntfy.internal";
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await fetchValidated("https://ntfy.internal/hook");
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { dispatcher?: unknown }];
      expect(init.dispatcher).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      delete process.env.ORCY_SSRF_ALLOWLIST;
    }
  });

  it("buildPinnedLookup answers only with the validated addresses, never live DNS", () => {
    dnsState.v4 = ["10.0.0.5"]; // hostile live answer — must be ignored entirely
    const lookup = buildPinnedLookup(["93.184.216.34", "2606:2800::1"]);
    const allCb = vi.fn();
    lookup("example.com", { all: true }, allCb);
    expect(allCb).toHaveBeenCalledWith(null, [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800::1", family: 6 },
    ]);
    const singleCb = vi.fn();
    lookup("example.com", {}, singleCb);
    expect(singleCb).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });
});
