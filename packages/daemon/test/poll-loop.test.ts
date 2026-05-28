import { describe, it, expect, vi, beforeEach } from "vitest";

const { claimNextMock, heartbeatMock } = vi.hoisted(() => ({
  claimNextMock: vi.fn(),
  heartbeatMock: vi.fn(),
}));

vi.mock("../src/api-client.js", () => ({
  DaemonApiClient: vi.fn(),
}));

vi.mock("../src/session/manager.js", () => ({
  SessionManager: class {},
}));

vi.mock("../src/workdir.js", () => ({
  validateWorktreeConfig: vi.fn(),
  createWorkdir: vi.fn(),
  WorkdirError: class extends Error {},
}));

const { PollLoop } = await import("../src/poll-loop.js");

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    apiUrl: "http://localhost:3000",
    registrationToken: null,
    name: "test-daemon",
    maxConcurrent: 2,
    pollIntervalSeconds: 1,
    heartbeatIntervalSeconds: 1,
    sessionTimeoutSeconds: 600,
    dataDir: "/tmp/orcy",
    habitatIds: ["hab-1"],
    ...overrides,
  };
}

function makeAgents(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `agent-${i}`,
    name: `daemon-test-agent-${i}`,
    type: "claude-code",
    apiKey: `key-${i}`,
  }));
}

describe("PollLoop", () => {
  let apiClient: any;
  let sessionManager: any;

  beforeEach(() => {
    apiClient = {
      claimNext: claimNextMock,
      heartbeat: heartbeatMock,
    };
    sessionManager = {
      activeCount: 0,
      activeSessions: [],
      startSession: vi.fn(),
      releaseSession: vi.fn(),
      shutdownAll: vi.fn(),
    };
    claimNextMock.mockReset();
    heartbeatMock.mockReset().mockResolvedValue({ nextCheckInSeconds: 30 });
  });

  describe("start/stop", () => {
    it("sets isRunning to true on start", () => {
      const loop = new PollLoop({
        config: makeConfig({ pollIntervalSeconds: 600 }),
        apiClient,
        sessionManager,
        agents: makeAgents(1),
      });

      loop.start();
      expect(loop.isRunning).toBe(true);
      loop.stop();
    });

    it("sets isRunning to false on stop", () => {
      const loop = new PollLoop({
        config: makeConfig({ pollIntervalSeconds: 600 }),
        apiClient,
        sessionManager,
        agents: makeAgents(1),
      });

      loop.start();
      loop.stop();
      expect(loop.isRunning).toBe(false);
    });

    it("does not start twice", () => {
      const loop = new PollLoop({
        config: makeConfig({ pollIntervalSeconds: 600 }),
        apiClient,
        sessionManager,
        agents: makeAgents(1),
      });

      loop.start();
      loop.start();
      expect(loop.isRunning).toBe(true);
      loop.stop();
    });
  });

  describe("tick", () => {
    it("does nothing when no agents available", async () => {
      const loop = new PollLoop({
        config: makeConfig(),
        apiClient,
        sessionManager,
        agents: [],
      });
      (loop as any).running = true;

      await loop.tick();
      expect(claimNextMock).not.toHaveBeenCalled();
    });

    it("does nothing when at maxConcurrent", async () => {
      sessionManager.activeCount = 2;
      sessionManager.activeSessions = [{ agentId: "agent-0" }, { agentId: "agent-1" }];

      const loop = new PollLoop({
        config: makeConfig({ maxConcurrent: 2 }),
        apiClient,
        sessionManager,
        agents: makeAgents(2),
      });
      (loop as any).running = true;

      await loop.tick();
      expect(claimNextMock).not.toHaveBeenCalled();
    });

    it("claims tasks for idle agents when capacity available", async () => {
      sessionManager.activeCount = 0;
      sessionManager.activeSessions = [];

      const claim = {
        task: {
          id: "task-1",
          title: "Test",
          description: null,
          missionId: "m-1",
          habitatId: "hab-1",
          priority: "high",
          requiredDomain: null,
          requiredCapabilities: [],
        },
        worktreeSettings: { repoPath: "/tmp/repo", branchPrefix: "task/", autoCleanup: true },
      };
      claimNextMock.mockResolvedValue(claim);
      sessionManager.startSession.mockResolvedValue({ id: "s-1" });

      const loop = new PollLoop({
        config: makeConfig(),
        apiClient,
        sessionManager,
        agents: makeAgents(1),
      });
      (loop as any).running = true;

      await loop.tick();

      expect(claimNextMock).toHaveBeenCalledWith("agent-0", "hab-1");
      expect(sessionManager.startSession).toHaveBeenCalled();
    });

    it("skips when claimNext returns null (no tasks)", async () => {
      sessionManager.activeCount = 0;
      sessionManager.activeSessions = [];
      claimNextMock.mockResolvedValue(null);

      const loop = new PollLoop({
        config: makeConfig(),
        apiClient,
        sessionManager,
        agents: makeAgents(1),
      });
      (loop as any).running = true;

      await loop.tick();

      expect(claimNextMock).toHaveBeenCalled();
      expect(sessionManager.startSession).not.toHaveBeenCalled();
    });

    it("continues on claim error", async () => {
      sessionManager.activeCount = 0;
      sessionManager.activeSessions = [];
      claimNextMock.mockRejectedValue(new Error("network error"));

      const loop = new PollLoop({
        config: makeConfig(),
        apiClient,
        sessionManager,
        agents: makeAgents(1),
      });
      (loop as any).running = true;

      await loop.tick();
      expect(sessionManager.startSession).not.toHaveBeenCalled();
    });
  });
});
