import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

const { spawnCli, terminateProcess } = await import("../../src/session/spawner.js");

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

describe("spawner", () => {
  let capturedStdout: string[];
  let capturedStderr: string[];
  let exitEvents: Array<{ code: number | null; signal: NodeJS.Signals | null }>;

  beforeEach(() => {
    spawnMock.mockReset();
    capturedStdout = [];
    capturedStderr = [];
    exitEvents = [];
  });

  describe("spawnCli", () => {
    it("spawns process with adapter args and env", () => {
      spawnMock.mockReturnValue(makeMockChild());

      const result = spawnCli(
        "claude-code",
        "task-1",
        "Fix bug",
        "/workdir",
        "agent-1",
        "api-key",
        "http://localhost:3000",
        "/usr/bin/claude",
        {
          onStdout: (d) => capturedStdout.push(d),
          onStderr: (d) => capturedStderr.push(d),
          onExit: (code, signal) => exitEvents.push({ code, signal }),
        },
      );

      expect(result.pid).toBe(12345);
      expect(spawnMock).toHaveBeenCalledWith(
        "/usr/bin/claude",
        expect.arrayContaining([expect.stringContaining("Fix bug")]),
        expect.objectContaining({ cwd: "/workdir" }),
      );
    });

    it("uses adapter bin as fallback when binPath is empty", () => {
      spawnMock.mockReturnValue(makeMockChild());

      spawnCli("codex", "task-2", "Test", "/workdir", "agent-2", "key", "http://api", "", {
        onStdout: () => {},
        onStderr: () => {},
        onExit: () => {},
      });

      expect(spawnMock).toHaveBeenCalledWith("codex", expect.any(Array), expect.any(Object));
    });

    it("passes agent env vars to spawned process", () => {
      spawnMock.mockReturnValue(makeMockChild());

      spawnCli(
        "opencode",
        "task-3",
        "Work",
        "/workdir",
        "agent-3",
        "my-key",
        "http://api:3000",
        "/bin/opencode",
        {
          onStdout: () => {},
          onStderr: () => {},
          onExit: () => {},
        },
      );

      const callArgs = spawnMock.mock.calls[0] as unknown as [
        string,
        string[],
        Record<string, unknown>,
      ];
      const env = callArgs[2].env as Record<string, string>;
      expect(env.ORCY_API_URL).toBe("http://api:3000");
      expect(env.ORCY_AGENT_ID).toBe("agent-3");
      expect(env.ORCY_API_KEY).toBe("my-key");
    });

    it("drains stdout to callback", () => {
      const child = makeMockChild();
      spawnMock.mockReturnValue(child);

      spawnCli("claude-code", "t", "title", "/w", "a", "k", "u", "/b", {
        onStdout: (d) => capturedStdout.push(d),
        onStderr: () => {},
        onExit: () => {},
      });

      child.stdout.emit("data", Buffer.from("progress update"));
      expect(capturedStdout).toEqual(["progress update"]);
    });

    it("drains stderr to callback", () => {
      const child = makeMockChild();
      spawnMock.mockReturnValue(child);

      spawnCli("claude-code", "t", "title", "/w", "a", "k", "u", "/b", {
        onStdout: () => {},
        onStderr: (d) => capturedStderr.push(d),
        onExit: () => {},
      });

      child.stderr.emit("data", Buffer.from("warning msg"));
      expect(capturedStderr).toEqual(["warning msg"]);
    });

    it("calls onExit with code when process exits", () => {
      const child = makeMockChild();
      spawnMock.mockReturnValue(child);

      spawnCli("claude-code", "t", "title", "/w", "a", "k", "u", "/b", {
        onStdout: () => {},
        onStderr: () => {},
        onExit: (code, signal) => exitEvents.push({ code, signal }),
      });

      child.emit("exit", 0, null);
      expect(exitEvents).toEqual([{ code: 0, signal: null }]);
    });

    it("calls onExit with signal when process is killed", () => {
      const child = makeMockChild();
      spawnMock.mockReturnValue(child);

      spawnCli("claude-code", "t", "title", "/w", "a", "k", "u", "/b", {
        onStdout: () => {},
        onStderr: () => {},
        onExit: (code, signal) => exitEvents.push({ code, signal }),
      });

      child.emit("exit", null, "SIGTERM");
      expect(exitEvents).toEqual([{ code: null, signal: "SIGTERM" }]);
    });

    it("throws when spawn produces no PID", () => {
      const child = makeMockChild();
      child.pid = undefined;
      spawnMock.mockReturnValue(child);

      expect(() =>
        spawnCli("claude-code", "t", "title", "/w", "a", "k", "u", "/b", {
          onStdout: () => {},
          onStderr: () => {},
          onExit: () => {},
        }),
      ).toThrow("no PID");
    });
  });

  describe("terminateProcess", () => {
    it("sends SIGTERM by default", () => {
      const child = makeMockChild();
      const result = terminateProcess(child);
      expect(result).toBe(true);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("sends custom signal", () => {
      const child = makeMockChild();
      terminateProcess(child, "SIGKILL");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("returns false if already killed", () => {
      const child = makeMockChild();
      child.killed = true;
      const result = terminateProcess(child);
      expect(result).toBe(false);
      expect(child.kill).not.toHaveBeenCalled();
    });
  });
});
