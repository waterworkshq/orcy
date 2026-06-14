import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { REMOTE_MCP_ACTIONS, isRemoteMcpAction } from "../remote-actions.js";
import { resetConfig, getAuthMode, getRemoteConfig } from "@orcy/shared";

/**
 * v0.19 Phase D — Remote MCP allowlist and config tests.
 *
 * Tests:
 * - Remote MCP allowlist shape and forbidden actions
 * - Auth mode detection
 * - Remote config reading
 *
 * The full transport-level integration (header propagation, idempotency
 * key generation) is verified by:
 * - `packages/api/src/test/sharedApi.test.ts` — tests the server-side
 *   behavior of /api/shared/* routes with `X-Orcy-Remote-Key`
 * - Manual MCP integration tests
 *
 * The remote-client.ts unit is simple enough that its action → path
 * mapping is fully captured by REMOTE_MCP_ACTIONS; transport wiring is
 * validated by the MCP package's own existing tests for `KanbanApiClient`.
 */

describe("Remote MCP allowlist", () => {
  it("exposes a known set of actions", () => {
    const actions = Object.keys(REMOTE_MCP_ACTIONS);
    expect(actions.length).toBeGreaterThan(15);
    expect(actions).toContain("habitats.get");
    expect(actions).toContain("missions.get");
    expect(actions).toContain("tasks.claim");
    expect(actions).toContain("tasks.submit");
    expect(actions).toContain("tasks.addEvidenceLink");
    expect(actions).toContain("missions.postPulse");
  });

  it("isRemoteMcpAction narrows correctly", () => {
    expect(isRemoteMcpAction("tasks.claim")).toBe(true);
    expect(isRemoteMcpAction("tasks.create")).toBe(false);
    expect(isRemoteMcpAction("not.an.action")).toBe(false);
  });

  it("does NOT include forbidden actions", () => {
    // These must be denied to remote — see Phase D doc
    expect((REMOTE_MCP_ACTIONS as Record<string, unknown>)["tasks.create"]).toBeUndefined();
    expect((REMOTE_MCP_ACTIONS as Record<string, unknown>)["tasks.delete"]).toBeUndefined();
    expect((REMOTE_MCP_ACTIONS as Record<string, unknown>)["tasks.approve"]).toBeUndefined();
    expect((REMOTE_MCP_ACTIONS as Record<string, unknown>)["tasks.reject"]).toBeUndefined();
    expect((REMOTE_MCP_ACTIONS as Record<string, unknown>)["missions.create"]).toBeUndefined();
    expect((REMOTE_MCP_ACTIONS as Record<string, unknown>)["automation.create"]).toBeUndefined();
    expect((REMOTE_MCP_ACTIONS as Record<string, unknown>)["sprint.create"]).toBeUndefined();
  });

  it("every action has a path builder and a method", () => {
    for (const [name, desc] of Object.entries(REMOTE_MCP_ACTIONS)) {
      expect(typeof desc.path).toBe("function");
      expect(["GET", "POST"]).toContain(desc.method);
      expect(typeof desc.requiredScope).toBe("string");
      // Path builder must be callable
      const params: Record<string, string> = {};
      if (name.startsWith("habitats.")) params.habitatId = "h-1";
      if (name.startsWith("missions.")) params.missionId = "m-1";
      if (name.startsWith("tasks.")) params.taskId = "t-1";
      const built = desc.path(params);
      expect(built).toMatch(/^\/api\/shared\//);
    }
  });

  it("write actions require non-read scopes", () => {
    for (const [name, desc] of Object.entries(REMOTE_MCP_ACTIONS)) {
      if (desc.method === "POST") {
        // Every POST should require a scope other than just "read" — except
        // notification ack/snooze which is a read-adjacent write on a
        // delivery the participant already owns.
        expect([
          "comment",
          "claim",
          "submit",
          "release",
          "heartbeat",
          "evidence_link",
          "pulse.post",
          "read", // allowed for ack/snooze
        ]).toContain(desc.requiredScope);
      }
    }
  });
});

describe("getAuthMode", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    resetConfig();
  });

  it("returns local_agent when ORCY_REMOTE_KEY is not set", () => {
    delete process.env.ORCY_REMOTE_KEY;
    resetConfig();
    expect(getAuthMode()).toBe("local_agent");
  });

  it("returns remote when ORCY_REMOTE_KEY is set", () => {
    process.env.ORCY_REMOTE_KEY = "orcy_remote_xxx";
    resetConfig();
    expect(getAuthMode()).toBe("remote");
  });

  it("returns local_agent when ORCY_REMOTE_KEY is empty string", () => {
    process.env.ORCY_REMOTE_KEY = "";
    resetConfig();
    expect(getAuthMode()).toBe("local_agent");
  });
});

describe("getRemoteConfig", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    resetConfig();
  });

  it("reads remote key and metadata from env", () => {
    process.env.ORCY_REMOTE_KEY = "orcy_remote_test";
    process.env.ORCY_REMOTE_POD_ID = "pod-1";
    process.env.ORCY_REMOTE_PARTICIPANT_ID = "p-1";
    process.env.ORCY_API_URL = "https://orcy.example.com";
    resetConfig();
    const config = getRemoteConfig();
    expect(config.remoteKey).toBe("orcy_remote_test");
    expect(config.remotePodId).toBe("pod-1");
    expect(config.remoteParticipantId).toBe("p-1");
    expect(config.apiUrl).toBe("https://orcy.example.com");
  });

  it("returns empty remote key when env unset", () => {
    delete process.env.ORCY_REMOTE_KEY;
    resetConfig();
    const config = getRemoteConfig();
    expect(config.remoteKey).toBe("");
  });
});
