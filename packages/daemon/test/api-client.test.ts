import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { DaemonApiClient } from "../src/api-client.js";
import type { DaemonConfig } from "../src/types.js";

function makeConfig(overrides?: Partial<DaemonConfig>): DaemonConfig {
  return {
    apiUrl: "http://localhost:3000",
    registrationToken: null,
    name: "test",
    maxConcurrent: 4,
    pollIntervalSeconds: 30,
    heartbeatIntervalSeconds: 30,
    sessionTimeoutSeconds: 600,
    dataDir: "/tmp/orcy-daemon",
    habitatIds: ["hab-1"],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as any;
}

describe("DaemonApiClient", () => {
  let client: DaemonApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new DaemonApiClient(makeConfig());
  });

  describe("register", () => {
    it("sends registration request and returns result", async () => {
      const response = {
        daemonId: "d1",
        daemonToken: "daemon-test-token",
        heartbeatIntervalSeconds: 30,
        agents: [
          { id: "a1", name: "daemon-test-claude-code", type: "claude-code", apiKey: "key-1" },
        ],
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(response, 201));

      const result = await client.register(
        "ws",
        "host.local",
        "0.14.0",
        [{ type: "claude-code", version: "1.0", path: "/usr/bin/claude" }],
        ["hab-1"],
      );

      expect(result.daemonId).toBe("d1");
      expect(result.daemonToken).toBe("daemon-test-token");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/v1/daemon/register",
        expect.objectContaining({ method: "POST" }),
      );

      const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body);
      expect(body.name).toBe("ws");
      expect(body.detectedClis).toHaveLength(1);
    });

    it("sends registration token when configured", async () => {
      client = new DaemonApiClient(makeConfig({ registrationToken: "secret-token" }));
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            daemonId: "d1",
            daemonToken: "dt",
            heartbeatIntervalSeconds: 30,
            agents: [],
          },
          201,
        ),
      );

      await client.register("ws", "h", "0.14", [], ["hab-1"]);

      const headers = (mockFetch.mock.calls[0][1] as any).headers;
      expect(headers["X-Registration-Token"]).toBe("secret-token");
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: "bad" }, 400));

      await expect(client.register("ws", "h", "0.14", [], ["hab-1"])).rejects.toThrow(
        "Registration failed (400)",
      );
    });
  });

  describe("heartbeat", () => {
    it("sends heartbeat with daemon token", async () => {
      client.setDaemonToken("my-token");
      mockFetch.mockResolvedValueOnce(jsonResponse({ nextCheckInSeconds: 30 }));

      const result = await client.heartbeat();
      expect(result.nextCheckInSeconds).toBe(30);

      const headers = (mockFetch.mock.calls[0][1] as any).headers;
      expect(headers["X-Daemon-Token"]).toBe("my-token");
    });

    it("throws when token not set", async () => {
      await expect(client.heartbeat()).rejects.toThrow("Daemon token not set");
    });
  });

  describe("claimNext", () => {
    it("returns claim result on success", async () => {
      client.setDaemonToken("my-token");
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          task: { id: "t1", title: "Do thing" },
          worktreeSettings: { repoPath: "/repo" },
        }),
      );

      const result = await client.claimNext("agent-1", "hab-1");
      expect(result?.task.id).toBe("t1");
    });

    it("returns null on 204", async () => {
      client.setDaemonToken("my-token");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: () => Promise.resolve(null),
      } as any);

      const result = await client.claimNext("agent-1", "hab-1");
      expect(result).toBeNull();
    });

    it("throws when token not set", async () => {
      await expect(client.claimNext("a", "h")).rejects.toThrow("Daemon token not set");
    });
  });

  describe("updateSession", () => {
    it("sends session update", async () => {
      client.setDaemonToken("my-token");
      mockFetch.mockResolvedValueOnce(jsonResponse({ session: { id: "s1" } }));

      await client.updateSession("s1", { status: "running" });

      const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body);
      expect(body.status).toBe("running");
    });

    it("throws on error", async () => {
      client.setDaemonToken("my-token");
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: "not found" }, 404));

      await expect(client.updateSession("s1", {})).rejects.toThrow("Session update failed (404)");
    });
  });
});
