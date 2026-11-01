import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

// Only the worker-spawn boundary is stubbed: SessionManager, worktree
// materialization (real `git worktree add` against a scratch repo), the
// adapters, and reconciliation all run for real (#141 reproduce steps).
const { spawnMock, terminateProcessMock, updateSessionMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  terminateProcessMock: vi.fn(() => true),
  updateSessionMock: vi.fn(),
}));

vi.mock("../../src/session/spawner.js", () => ({
  spawnCli: spawnMock,
  terminateProcess: terminateProcessMock,
}));

const { SessionManager } = await import("../../src/session/manager.js");

interface SpawnCallbacks {
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError: (error: Error) => void;
}

let scratchRoot: string;
let repoDir: string;
let dataDir: string;
let completions: { id: string; status: string }[] = [];
let spawnCount = 0;
let manager: InstanceType<typeof SessionManager>;

function makeClaim(taskId: string) {
  return {
    task: {
      id: taskId,
      title: `Task ${taskId}`,
      description: null,
      missionId: "mission-1",
      habitatId: "habitat-1",
      priority: "high",
      requiredDomain: null,
      requiredCapabilities: [],
    },
    worktreeSettings: {
      repoPath: repoDir,
      branchPrefix: "task/",
      autoCleanup: true,
    },
  };
}

function makeMockChild(pid: number) {
  const child = new EventEmitter() as any;
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function sessionsMap(): Map<string, unknown> {
  return (manager as any).sessions;
}

function childrenMap(): Map<string, unknown> {
  return (manager as any).children;
}

async function startLifecycle(taskId: string, daemonSessionId: string, agentId = "agent-1") {
  let callbacks: SpawnCallbacks = {
    onStdout: () => {},
    onStderr: () => {},
    onExit: () => {},
    onError: () => {},
  };
  spawnCount++;
  spawnMock.mockImplementationOnce((...args: unknown[]) => {
    callbacks = (args as unknown[])[9] as SpawnCallbacks;
    return { pid: 1000 + spawnCount, child: makeMockChild(1000 + spawnCount) };
  });
  const session = await manager.startSession(
    makeClaim(taskId),
    agentId,
    `api-key-${taskId}`,
    "claude-code",
    "/bin/claude",
    daemonSessionId,
  );
  return { session, callbacks };
}

const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SessionManager terminal-session eviction (#141)", () => {
  beforeEach(() => {
    scratchRoot = mkdtempSync(join(tmpdir(), "orcy-141-eviction-"));
    repoDir = join(scratchRoot, "repo");
    dataDir = join(scratchRoot, "data");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@orcy.local"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "orcy test"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# scratch\n");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });

    spawnCount = 0;
    completions = [];
    manager = new SessionManager({
      sessionUpdater: { updateSession: updateSessionMock },
      apiUrl: "http://localhost:3000",
      dataDir,
      sessionTimeoutSeconds: 10,
      onSessionComplete: (session) => {
        completions.push({ id: session.id, status: session.status });
      },
    });
    spawnMock.mockReset();
    terminateProcessMock.mockReset().mockReturnValue(true);
    updateSessionMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    try {
      rmSync(scratchRoot, { recursive: true, force: true });
    } catch {}
  });

  it("repeated completed lifecycles do not grow the live-session map", async () => {
    for (let i = 1; i <= 3; i++) {
      const { session, callbacks } = await startLifecycle(`done${String(i).padStart(4, "0")}`, `daemon-session-${i}`);
      expect(session.status).toBe("running");
      expect(updateSessionMock).toHaveBeenCalledWith(
        `daemon-session-${i}`,
        expect.objectContaining({ status: "running" }),
      );

      callbacks.onExit(0, null);
      await drain();

      expect(session.status).toBe("completed");
      expect(sessionsMap().size).toBe(0);
      expect(childrenMap().size).toBe(0);
      expect(manager.activeCount).toBe(0);
      expect(completions[i - 1]).toEqual({ id: session.id, status: "completed" });
    }
    expect(completions.length).toBe(3);
  });

  it("failed (non-zero exit) sessions are evicted after reconciliation", async () => {
    const { session, callbacks } = await startLifecycle("fail00001", "daemon-session-f1");

    callbacks.onExit(1, null);
    await drain();

    expect(session.status).toBe("failed");
    expect(updateSessionMock).toHaveBeenCalledWith(
      "daemon-session-f1",
      expect.objectContaining({ status: "failed" }),
    );
    expect(sessionsMap().size).toBe(0);
    expect(childrenMap().size).toBe(0);
    expect(completions).toEqual([{ id: session.id, status: "failed" }]);
  });

  it("process-error failures are evicted after reconciliation", async () => {
    const { session, callbacks } = await startLifecycle("erro00001", "daemon-session-e1");

    callbacks.onError(new Error("spawn ENOENT"));
    await drain();

    expect(session.status).toBe("failed");
    expect(updateSessionMock).toHaveBeenCalledWith(
      "daemon-session-e1",
      expect.objectContaining({ status: "failed", lastProgress: "spawn ENOENT" }),
    );
    expect(sessionsMap().size).toBe(0);
    expect(childrenMap().size).toBe(0);
  });

  it("released sessions are evicted after the released reconciliation write", async () => {
    const { session } = await startLifecycle("rel000001", "daemon-session-r1");

    await manager.releaseSession(session.id);
    await drain();

    expect(session.status).toBe("released");
    expect(updateSessionMock).toHaveBeenCalledWith(
      "daemon-session-r1",
      expect.objectContaining({ status: "released" }),
    );
    expect(sessionsMap().size).toBe(0);
    expect(childrenMap().size).toBe(0);
    expect(manager.activeCount).toBe(0);
  });

  it("timed-out sessions are evicted while a peer with progress survives", async () => {
    vi.useFakeTimers();
    try {
      const stale = await startLifecycle("stale0001", "daemon-session-t1", "agent-1");
      const fresh = await startLifecycle("fresh0001", "daemon-session-t2", "agent-2");

      manager.startTimeoutCheck();
      await vi.advanceTimersByTimeAsync(5_000);
      fresh.callbacks.onStdout("still working...\n");
      await vi.advanceTimersByTimeAsync(5_000);

      expect(stale.session.status).toBe("failed");
      expect(updateSessionMock).toHaveBeenCalledWith(
        "daemon-session-t1",
        expect.objectContaining({ status: "failed" }),
      );
      expect(sessionsMap().has(stale.session.id)).toBe(false);
      expect(fresh.session.status).toBe("running");
      expect(sessionsMap().has(fresh.session.id)).toBe(true);
      expect(sessionsMap().size).toBe(1);
      expect(manager.activeCount).toBe(1);
      expect(manager.activeSessions.map((s) => s.id)).toEqual([fresh.session.id]);

      manager.stopTimeoutCheck();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a start failure (spawn throws) leaves no entry in the live map", async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });

    await expect(
      manager.startSession(
        makeClaim("throw001"),
        "agent-1",
        "key",
        "claude-code",
        "/bin/claude",
        "daemon-session-s1",
      ),
    ).rejects.toThrow("spawn failed");

    expect(updateSessionMock).toHaveBeenCalledWith(
      "daemon-session-s1",
      expect.objectContaining({ status: "failed" }),
    );
    expect(sessionsMap().size).toBe(0);
    expect(childrenMap().size).toBe(0);
    expect(manager.activeCount).toBe(0);
  });

  it("a rejected startup failure-reconciliation still evicts and rethrows the original spawn error", async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });
    updateSessionMock.mockRejectedValue(new Error("api down"));

    await expect(
      manager.startSession(
        makeClaim("throw002"),
        "agent-1",
        "key",
        "claude-code",
        "/bin/claude",
        "daemon-session-s2",
      ),
    ).rejects.toThrow("spawn failed");

    expect(updateSessionMock).toHaveBeenCalledWith(
      "daemon-session-s2",
      expect.objectContaining({ status: "failed" }),
    );
    expect(sessionsMap().size).toBe(0);
    expect(childrenMap().size).toBe(0);
    expect(manager.activeCount).toBe(0);
  });

  it("a throwing completion callback still evicts the completed session (exit path)", async () => {
    manager = new SessionManager({
      sessionUpdater: { updateSession: updateSessionMock },
      apiUrl: "http://localhost:3000",
      dataDir,
      sessionTimeoutSeconds: 10,
      onSessionComplete: () => {
        throw new Error("observer boom");
      },
    });
    const { session, callbacks } = await startLifecycle("late00002", "daemon-session-x2");

    await expect(callbacks.onExit(0, null)).rejects.toThrow("observer boom");

    expect(session.status).toBe("completed");
    expect(updateSessionMock).toHaveBeenCalledWith(
      "daemon-session-x2",
      expect.objectContaining({ status: "completed" }),
    );
    expect(sessionsMap().size).toBe(0);
    expect(manager.activeCount).toBe(0);
  });

  it("a throwing completion callback during the timeout sweep still evicts the timed-out session", async () => {
    vi.useFakeTimers();
    try {
      manager = new SessionManager({
        sessionUpdater: { updateSession: updateSessionMock },
        apiUrl: "http://localhost:3000",
        dataDir,
        sessionTimeoutSeconds: 10,
        onSessionComplete: () => {
          throw new Error("observer boom");
        },
      });
      const { session } = await startLifecycle("stale0002", "daemon-session-x3");

      manager.startTimeoutCheck();
      await vi.advanceTimersByTimeAsync(10_000).catch(() => {});

      expect(session.status).toBe("failed");
      expect(sessionsMap().has(session.id)).toBe(false);
      expect(sessionsMap().size).toBe(0);

      manager.stopTimeoutCheck();
    } finally {
      vi.useRealTimers();
    }
  });

  it("duplicate late exit/error callbacks after eviction are safe and idempotent", async () => {
    const { session, callbacks } = await startLifecycle("late00001", "daemon-session-l1");

    callbacks.onExit(0, null);
    await drain();
    updateSessionMock.mockClear();

    expect(() => {
      callbacks.onExit(0, null);
      callbacks.onError(new Error("late error"));
    }).not.toThrow();
    await drain();

    expect(updateSessionMock).not.toHaveBeenCalled();
    expect(completions).toEqual([{ id: session.id, status: "completed" }]);
    expect(sessionsMap().size).toBe(0);
    expect(manager.activeCount).toBe(0);
  });

  it("heartbeat selection ignores a peer's completed session and keeps the running one", async () => {
    const first = await startLifecycle("hba00001", "daemon-session-h1", "agent-1");
    const second = await startLifecycle("hbb00002", "daemon-session-h2", "agent-2");

    first.callbacks.onExit(0, null);
    await drain();

    expect(manager.activeCount).toBe(1);
    expect(manager.activeSessions.map((s) => s.agentId)).toEqual(["agent-2"]);
    expect(sessionsMap().size).toBe(1);
    expect(sessionsMap().has(second.session.id)).toBe(true);
  });
});
