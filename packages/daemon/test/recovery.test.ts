import { describe, it, expect, vi, beforeEach } from "vitest";

const { getActiveSessionsMock, updateSessionMock } = vi.hoisted(() => ({
  getActiveSessionsMock: vi.fn(),
  updateSessionMock: vi.fn(),
}));

vi.mock("../src/api-client.js", () => ({
  DaemonApiClient: vi.fn(),
}));

const { recoverSessions } = await import("../src/recovery.js");

function makeAgents(): Array<{ id: string; name: string; type: string; apiKey: string }> {
  return [
    { id: "agent-1", name: "daemon-test-0", type: "claude-code", apiKey: "key-1" },
    { id: "agent-2", name: "daemon-test-1", type: "codex", apiKey: "key-2" },
  ];
}

describe("recoverSessions", () => {
  let apiClient: any;

  beforeEach(() => {
    getActiveSessionsMock.mockReset().mockResolvedValue([]);
    updateSessionMock.mockReset().mockResolvedValue(undefined);
    apiClient = {
      getActiveSessions: getActiveSessionsMock,
      updateSession: updateSessionMock,
    };
  });

  it("returns empty when no active sessions", async () => {
    const results = await recoverSessions(apiClient, makeAgents());
    expect(results).toEqual([]);
  });

  it("returns empty when getActiveSessions throws", async () => {
    getActiveSessionsMock.mockRejectedValue(new Error("network error"));

    const results = await recoverSessions(apiClient, makeAgents());
    expect(results).toEqual([]);
  });

  it("releases sessions with no matching agent", async () => {
    getActiveSessionsMock.mockResolvedValue([
      { id: "s-1", agentId: "unknown-agent", taskId: "t-1", workdir: "/tmp/w" },
    ]);

    const results = await recoverSessions(apiClient, makeAgents());

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      sessionId: "s-1",
      action: "released",
      reason: "Agent no longer managed by this daemon",
    });
    expect(updateSessionMock).toHaveBeenCalledWith("s-1", {
      status: "released",
      lastProgress: "Recovered: agent no longer available",
    });
  });

  it("releases sessions in pending workdir state", async () => {
    getActiveSessionsMock.mockResolvedValue([
      { id: "s-2", agentId: "agent-1", taskId: "t-2", workdir: "pending" },
    ]);

    const results = await recoverSessions(apiClient, makeAgents());

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      sessionId: "s-2",
      action: "released",
      reason: "Session was in pending workdir state at crash",
    });
    expect(updateSessionMock).toHaveBeenCalledWith("s-2", {
      status: "released",
      lastProgress: "Recovered: session never fully started",
    });
  });

  it("fails sessions that were active with a valid workdir", async () => {
    getActiveSessionsMock.mockResolvedValue([
      { id: "s-3", agentId: "agent-2", taskId: "t-3", workdir: "/tmp/workdir-3" },
    ]);

    const results = await recoverSessions(apiClient, makeAgents());

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      sessionId: "s-3",
      action: "failed",
      reason: "Daemon restarted while session was active",
    });
    expect(updateSessionMock).toHaveBeenCalledWith("s-3", {
      status: "failed",
      lastProgress: "Recovered: daemon restarted mid-session",
    });
  });

  it("handles mixed session states", async () => {
    getActiveSessionsMock.mockResolvedValue([
      { id: "s-1", agentId: "unknown", taskId: "t-1", workdir: "/w" },
      { id: "s-2", agentId: "agent-1", taskId: "t-2", workdir: "pending" },
      { id: "s-3", agentId: "agent-2", taskId: "t-3", workdir: "/tmp/workdir" },
    ]);

    const results = await recoverSessions(apiClient, makeAgents());

    expect(results).toHaveLength(3);
    expect(results[0].action).toBe("released");
    expect(results[1].action).toBe("released");
    expect(results[2].action).toBe("failed");
  });

  it("continues when updateSession throws", async () => {
    getActiveSessionsMock.mockResolvedValue([
      { id: "s-1", agentId: "agent-1", taskId: "t-1", workdir: "/w" },
      { id: "s-2", agentId: "agent-2", taskId: "t-2", workdir: "/w2" },
    ]);
    updateSessionMock.mockRejectedValueOnce(new Error("update failed"));

    const results = await recoverSessions(apiClient, makeAgents());

    expect(results).toHaveLength(2);
    expect(updateSessionMock).toHaveBeenCalledTimes(2);
  });
});
