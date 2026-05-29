import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const {
  spawnMock,
  updateSessionMock,
  createWorkdirMock,
  validateWorktreeConfigMock,
  terminateProcessMock,
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  updateSessionMock: vi.fn(),
  createWorkdirMock: vi.fn(),
  validateWorktreeConfigMock: vi.fn(),
  terminateProcessMock: vi.fn(() => true),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("../../src/session/spawner.js", () => ({
  spawnCli: spawnMock,
  terminateProcess: terminateProcessMock,
}));

vi.mock("../../src/workdir.js", () => ({
  validateWorktreeConfig: validateWorktreeConfigMock,
  createWorkdir: createWorkdirMock,
  WorkdirError: class extends Error {},
}));

const { SessionManager } = await import("../../src/session/manager.js");

function makeMockChild(pid = 12345) {
  const child = new EventEmitter() as any;
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

function makeClaim() {
  return {
    task: {
      id: "task-001",
      title: "Fix auth",
      description: null,
      missionId: "mission-1",
      habitatId: "hab-1",
      priority: "high",
      requiredDomain: null,
      requiredCapabilities: [],
    },
    worktreeSettings: {
      repoPath: "/tmp/repo",
      branchPrefix: "task/",
      autoCleanup: true,
    },
  };
}

describe("SessionManager", () => {
  let manager: InstanceType<typeof SessionManager>;
  let apiClient: any;

  beforeEach(() => {
    apiClient = {
      updateSession: updateSessionMock.mockResolvedValue(undefined),
    };
    manager = new SessionManager({
      sessionUpdater: apiClient,
      apiUrl: "http://localhost:3000",
      dataDir: "/tmp/orcy",
      sessionTimeoutSeconds: 600,
    });
    spawnMock.mockReset();
    terminateProcessMock.mockReset().mockReturnValue(true);
    updateSessionMock.mockReset().mockResolvedValue(undefined);
    validateWorktreeConfigMock.mockReset();
    createWorkdirMock.mockReset();
  });

  describe("activeCount", () => {
    it("returns 0 when no sessions", () => {
      expect(manager.activeCount).toBe(0);
    });
  });

  describe("startSession", () => {
    it("throws WorkdirError when worktree config is invalid", async () => {
      validateWorktreeConfigMock.mockReturnValue("missing settings");

      await expect(
        manager.startSession(makeClaim(), "agent-1", "key", "claude-code", "/bin/claude"),
      ).rejects.toThrow("missing settings");
    });

    it("marks the daemon session failed when worktree config is invalid after claim", async () => {
      validateWorktreeConfigMock.mockReturnValue("missing settings");

      await expect(
        manager.startSession(
          makeClaim(),
          "agent-1",
          "key",
          "claude-code",
          "/bin/claude",
          "daemon-session-1",
        ),
      ).rejects.toThrow("missing settings");

      expect(updateSessionMock).toHaveBeenCalledWith(
        "daemon-session-1",
        expect.objectContaining({
          status: "failed",
          lastProgress: "Cannot start session: missing settings",
        }),
      );
    });

    it("creates workdir and spawns process", async () => {
      validateWorktreeConfigMock.mockReturnValue(null);
      createWorkdirMock.mockReturnValue({
        path: "/tmp/workdir",
        branch: "task/task-001",
        worktreePath: "/tmp/workdir",
      });

      const mockChild = makeMockChild();
      spawnMock.mockReturnValue({ pid: 12345, child: mockChild });

      const session = await manager.startSession(
        makeClaim(),
        "agent-1",
        "key",
        "claude-code",
        "/bin/claude",
      );

      expect(session.status).toBe("running");
      expect(session.pid).toBe(12345);
      expect(session.taskId).toBe("task-001");
      expect(manager.activeCount).toBe(1);
    });

    it("sets session to failed when spawn throws", async () => {
      validateWorktreeConfigMock.mockReturnValue(null);
      createWorkdirMock.mockReturnValue({
        path: "/tmp/workdir",
        branch: "task/task-001",
        worktreePath: "/tmp/workdir",
      });
      spawnMock.mockImplementation(() => {
        throw new Error("spawn failed");
      });

      await expect(
        manager.startSession(makeClaim(), "agent-1", "key", "claude-code", "/bin/claude"),
      ).rejects.toThrow("spawn failed");
    });

    it("updates API session status on spawn", async () => {
      validateWorktreeConfigMock.mockReturnValue(null);
      createWorkdirMock.mockReturnValue({
        path: "/tmp/workdir",
        branch: "task/task-001",
        worktreePath: "/tmp/workdir",
      });
      spawnMock.mockReturnValue({ pid: 999, child: makeMockChild() });

      await manager.startSession(
        makeClaim(),
        "agent-1",
        "key",
        "claude-code",
        "/bin/claude",
        "daemon-session-1",
      );

      expect(updateSessionMock).toHaveBeenCalledWith(
        "daemon-session-1",
        expect.objectContaining({ status: "running", pid: 999 }),
      );
    });

    it("terminates the child process if the running status update fails", async () => {
      validateWorktreeConfigMock.mockReturnValue(null);
      createWorkdirMock.mockReturnValue({
        path: "/tmp/workdir",
        branch: "task/task-001",
        worktreePath: "/tmp/workdir",
      });
      const mockChild = makeMockChild(999);
      spawnMock.mockReturnValue({ pid: 999, child: mockChild });
      updateSessionMock.mockRejectedValueOnce(new Error("api down"));

      await expect(
        manager.startSession(
          makeClaim(),
          "agent-1",
          "key",
          "claude-code",
          "/bin/claude",
          "daemon-session-1",
        ),
      ).rejects.toThrow("api down");

      expect(terminateProcessMock).toHaveBeenCalledWith(mockChild);
      expect(manager.activeCount).toBe(0);
    });

    it("handles exit code 0 as completed", async () => {
      validateWorktreeConfigMock.mockReturnValue(null);
      createWorkdirMock.mockReturnValue({
        path: "/tmp/workdir",
        branch: "task/task-001",
        worktreePath: "/tmp/workdir",
      });

      let capturedOnExit: (code: number | null, signal: NodeJS.Signals | null) => void = () => {};
      spawnMock.mockImplementation((...args: unknown[]) => {
        const callbacks = (args as any[])[8] as { onExit: typeof capturedOnExit };
        capturedOnExit = callbacks.onExit;
        return { pid: 111, child: makeMockChild(111) };
      });

      const session = await manager.startSession(
        makeClaim(),
        "agent-1",
        "key",
        "claude-code",
        "/bin/claude",
      );

      expect(session.status).toBe("running");

      capturedOnExit(0, null);

      expect(session.status).toBe("completed");
      expect(manager.activeCount).toBe(0);
    });

    it("updates the daemon session id when a process exits", async () => {
      validateWorktreeConfigMock.mockReturnValue(null);
      createWorkdirMock.mockReturnValue({
        path: "/tmp/workdir",
        branch: "task/task-001",
        worktreePath: "/tmp/workdir",
      });

      let capturedOnExit: (code: number | null, signal: NodeJS.Signals | null) => void = () => {};
      spawnMock.mockImplementation((...args: unknown[]) => {
        const callbacks = (args as any[])[8] as { onExit: typeof capturedOnExit };
        capturedOnExit = callbacks.onExit;
        return { pid: 111, child: makeMockChild(111) };
      });

      await manager.startSession(
        makeClaim(),
        "agent-1",
        "key",
        "claude-code",
        "/bin/claude",
        "daemon-session-1",
      );
      updateSessionMock.mockClear();

      capturedOnExit(0, null);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(updateSessionMock).toHaveBeenCalledWith(
        "daemon-session-1",
        expect.objectContaining({ status: "completed" }),
      );
    });

    it("does not let a late process exit overwrite a released session", async () => {
      validateWorktreeConfigMock.mockReturnValue(null);
      createWorkdirMock.mockReturnValue({
        path: "/tmp/workdir",
        branch: "task/task-001",
        worktreePath: "/tmp/workdir",
      });

      let capturedOnExit: (code: number | null, signal: NodeJS.Signals | null) => void = () => {};
      spawnMock.mockImplementation((...args: unknown[]) => {
        const callbacks = (args as any[])[8] as { onExit: typeof capturedOnExit };
        capturedOnExit = callbacks.onExit;
        return { pid: 111, child: makeMockChild(111) };
      });

      const session = await manager.startSession(
        makeClaim(),
        "agent-1",
        "key",
        "claude-code",
        "/bin/claude",
        "daemon-session-1",
      );
      await manager.releaseSession(session.id);
      updateSessionMock.mockClear();

      capturedOnExit(null, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(session.status).toBe("released");
      expect(updateSessionMock).not.toHaveBeenCalled();
    });

    it("marks sessions failed when the child process emits an error", async () => {
      validateWorktreeConfigMock.mockReturnValue(null);
      createWorkdirMock.mockReturnValue({
        path: "/tmp/workdir",
        branch: "task/task-001",
        worktreePath: "/tmp/workdir",
      });

      let capturedOnError: (error: Error) => void = () => {};
      spawnMock.mockImplementation((...args: unknown[]) => {
        const callbacks = (args as any[])[8] as { onError: typeof capturedOnError };
        capturedOnError = callbacks.onError;
        return { pid: 111, child: makeMockChild(111) };
      });

      const session = await manager.startSession(
        makeClaim(),
        "agent-1",
        "key",
        "claude-code",
        "/bin/claude",
        "daemon-session-1",
      );
      updateSessionMock.mockClear();

      capturedOnError(new Error("spawn ENOENT"));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(session.status).toBe("failed");
      expect(updateSessionMock).toHaveBeenCalledWith(
        "daemon-session-1",
        expect.objectContaining({ status: "failed", lastProgress: "spawn ENOENT" }),
      );
    });

    it("handles non-zero exit code as failed", async () => {
      validateWorktreeConfigMock.mockReturnValue(null);
      createWorkdirMock.mockReturnValue({
        path: "/tmp/workdir",
        branch: "task/task-001",
        worktreePath: "/tmp/workdir",
      });

      let capturedOnExit: (code: number | null, signal: NodeJS.Signals | null) => void = () => {};
      spawnMock.mockImplementation((...args: unknown[]) => {
        const callbacks = (args as any[])[8] as { onExit: typeof capturedOnExit };
        capturedOnExit = callbacks.onExit;
        return { pid: 111, child: makeMockChild(111) };
      });

      const session = await manager.startSession(
        makeClaim(),
        "agent-1",
        "key",
        "claude-code",
        "/bin/claude",
      );

      capturedOnExit(1, null);
      expect(session.status).toBe("failed");
    });

    it("handles signal exit as lost", async () => {
      validateWorktreeConfigMock.mockReturnValue(null);
      createWorkdirMock.mockReturnValue({
        path: "/tmp/workdir",
        branch: "task/task-001",
        worktreePath: "/tmp/workdir",
      });

      let capturedOnExit: (code: number | null, signal: NodeJS.Signals | null) => void = () => {};
      spawnMock.mockImplementation((...args: unknown[]) => {
        const callbacks = (args as any[])[8] as { onExit: typeof capturedOnExit };
        capturedOnExit = callbacks.onExit;
        return { pid: 111, child: makeMockChild(111) };
      });

      const session = await manager.startSession(
        makeClaim(),
        "agent-1",
        "key",
        "claude-code",
        "/bin/claude",
      );

      capturedOnExit(null, "SIGKILL");
      expect(session.status).toBe("lost");
    });
  });

  describe("releaseSession", () => {
    it("releases an active session", async () => {
      validateWorktreeConfigMock.mockReturnValue(null);
      createWorkdirMock.mockReturnValue({
        path: "/tmp/workdir",
        branch: "task/task-001",
        worktreePath: "/tmp/workdir",
      });
      spawnMock.mockReturnValue({ pid: 111, child: makeMockChild(111) });

      const session = await manager.startSession(
        makeClaim(),
        "agent-1",
        "key",
        "claude-code",
        "/bin/claude",
      );

      await manager.releaseSession(session.id);
      expect(session.status).toBe("released");
    });
  });

  describe("inactivity timeout", () => {
    it("kills sessions with no activity beyond timeout", async () => {
      vi.useFakeTimers();
      const timeoutManager = new SessionManager({
        sessionUpdater: apiClient,
        apiUrl: "http://localhost:3000",
        dataDir: "/tmp/orcy",
        sessionTimeoutSeconds: 10,
      });

      validateWorktreeConfigMock.mockReturnValue(null);
      createWorkdirMock.mockReturnValue({
        path: "/tmp/workdir",
        branch: "task/task-001",
        worktreePath: "/tmp/workdir",
      });

      let capturedOnExit: (code: number | null, signal: NodeJS.Signals | null) => void = () => {};
      spawnMock.mockImplementation((...args: unknown[]) => {
        const callbacks = (args as any[])[8] as { onExit: typeof capturedOnExit };
        capturedOnExit = callbacks.onExit;
        return { pid: 222, child: makeMockChild(222) };
      });

      const session = await timeoutManager.startSession(
        makeClaim(),
        "agent-1",
        "key",
        "claude-code",
        "/bin/claude",
      );

      timeoutManager.startTimeoutCheck();

      vi.advanceTimersByTime(10_000);

      expect(session.status).toBe("failed");
      expect(updateSessionMock).toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({ status: "failed" }),
      );

      timeoutManager.stopTimeoutCheck();
      vi.useRealTimers();
    });

    it("does not kill sessions with recent activity", async () => {
      vi.useFakeTimers();
      const timeoutManager = new SessionManager({
        sessionUpdater: apiClient,
        apiUrl: "http://localhost:3000",
        dataDir: "/tmp/orcy",
        sessionTimeoutSeconds: 10,
      });

      validateWorktreeConfigMock.mockReturnValue(null);
      createWorkdirMock.mockReturnValue({
        path: "/tmp/workdir",
        branch: "task/task-001",
        worktreePath: "/tmp/workdir",
      });

      let capturedOnStdout: (data: string) => void = () => {};
      let capturedOnExit: (code: number | null, signal: NodeJS.Signals | null) => void = () => {};
      spawnMock.mockImplementation((...args: unknown[]) => {
        const callbacks = (args as any[])[8] as {
          onStdout: typeof capturedOnStdout;
          onExit: typeof capturedOnExit;
        };
        capturedOnStdout = callbacks.onStdout;
        capturedOnExit = callbacks.onExit;
        return { pid: 333, child: makeMockChild(333) };
      });

      const session = await timeoutManager.startSession(
        makeClaim(),
        "agent-1",
        "key",
        "claude-code",
        "/bin/claude",
      );

      timeoutManager.startTimeoutCheck();

      vi.advanceTimersByTime(5_000);
      capturedOnStdout("still working...\n");

      vi.advanceTimersByTime(5_000);

      expect(session.status).toBe("running");

      capturedOnExit(0, null);

      timeoutManager.stopTimeoutCheck();
      vi.useRealTimers();
    });

    it("stops timeout check on shutdownAll", async () => {
      vi.useFakeTimers();
      const timeoutManager = new SessionManager({
        sessionUpdater: apiClient,
        apiUrl: "http://localhost:3000",
        dataDir: "/tmp/orcy",
        sessionTimeoutSeconds: 10,
      });

      validateWorktreeConfigMock.mockReturnValue(null);
      createWorkdirMock.mockReturnValue({
        path: "/tmp/workdir",
        branch: "task/task-001",
        worktreePath: "/tmp/workdir",
      });
      spawnMock.mockReturnValue({ pid: 444, child: makeMockChild(444) });

      await timeoutManager.startSession(
        makeClaim(),
        "agent-1",
        "key",
        "claude-code",
        "/bin/claude",
      );

      timeoutManager.startTimeoutCheck();
      await timeoutManager.shutdownAll();

      vi.advanceTimersByTime(10_000);
      expect(updateSessionMock).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ lastProgress: expect.stringContaining("timed out") }),
      );

      vi.useRealTimers();
    });
  });

  describe("shutdown resume behavior", () => {
    it("fails sessions when CLI does not support resume", async () => {
      validateWorktreeConfigMock.mockReturnValue(null);
      createWorkdirMock.mockReturnValue({
        path: "/tmp/workdir",
        branch: "task/task-001",
        worktreePath: "/tmp/workdir",
      });
      spawnMock.mockReturnValue({ pid: 555, child: makeMockChild(555) });

      await manager.startSession(makeClaim(), "agent-1", "key", "claude-code", "/bin/claude");

      await manager.shutdownAll();

      expect(updateSessionMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: "failed",
          lastProgress: expect.stringContaining("does not support session resume"),
        }),
      );
    });
  });
});
