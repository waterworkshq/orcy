import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const { updateSessionMock, heartbeatMock } = vi.hoisted(() => ({
  updateSessionMock: vi.fn().mockResolvedValue(undefined),
  heartbeatMock: vi.fn().mockResolvedValue({ nextCheckInSeconds: 30 }),
}));

vi.mock("../src/api-client.js", () => ({
  DaemonApiClient: vi.fn().mockImplementation(() => ({
    updateSession: updateSessionMock,
    heartbeat: heartbeatMock,
    claimNext: vi.fn().mockResolvedValue(null),
    setDaemonToken: vi.fn(),
  })),
}));

import { SessionManager } from "../src/session/manager.js";
import { PollLoop } from "../src/poll-loop.js";
import { recoverSessions } from "../src/recovery.js";
import type { ClaimResult, RegisteredAgent } from "../src/types.js";

let workDir: string;
let fakeCliPath: string;
let fakeFailCliPath: string;
let gitRepo: string;

function makeClaim(taskId = "task-00000001-0000-0000-0000-000000000000"): ClaimResult {
  return {
    task: {
      id: taskId,
      title: "Fix auth bug",
      description: "The login page crashes",
      missionId: "miss-00000000-0000-0000-0000-000000000001",
      habitatId: "hab-00000000-0000-0000-0000-000000000001",
      priority: "high",
      requiredDomain: null,
      requiredCapabilities: [],
    },
    worktreeSettings: {
      repoPath: gitRepo,
      branchPrefix: "task/",
      autoCleanup: true,
    },
  };
}

function makeAgent(binPath?: string): RegisteredAgent {
  return {
    id: "agent-00000000-0000-0000-0000-000000000001",
    name: "daemon-test-0",
    type: "claude-code",
    apiKey: "test-api-key-00000000000000000000000000000000000000000000",
    binPath,
  };
}

function makeApiClient() {
  return {
    updateSession: updateSessionMock,
    heartbeat: heartbeatMock,
    claimNext: vi.fn().mockResolvedValue(null),
    getActiveSessions: vi.fn().mockResolvedValue([]),
    setDaemonToken: vi.fn(),
  };
}

beforeEach(() => {
  updateSessionMock.mockReset().mockResolvedValue(undefined);
  heartbeatMock.mockReset().mockResolvedValue({ nextCheckInSeconds: 30 });

  workDir = mkdtempSync(join(tmpdir(), "orcy-integ-"));

  fakeCliPath = join(workDir, "fake-cli");
  writeFileSync(
    fakeCliPath,
    `#!/usr/bin/env node
console.log("Starting task...");
console.log("Working on fix...");
console.log("Done.");
process.exit(0);
`,
    { mode: 0o755 },
  );

  fakeFailCliPath = join(workDir, "fake-cli-fail");
  writeFileSync(
    fakeFailCliPath,
    `#!/usr/bin/env node
console.error("Something went wrong");
process.exit(1);
`,
    { mode: 0o755 },
  );

  gitRepo = join(workDir, "repo");
  mkdirSync(gitRepo, { recursive: true });
  execSync("git init", { cwd: gitRepo });
  execSync("git config user.email test@test.com", { cwd: gitRepo });
  execSync("git config user.name Test", { cwd: gitRepo });
  writeFileSync(join(gitRepo, "README.md"), "test");
  execSync("git add .", { cwd: gitRepo });
  execSync("git commit -m init", { cwd: gitRepo });
});

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {}
});

describe("integration: session lifecycle", () => {
  it("spawns fake CLI, captures output, and marks session completed on exit 0", async () => {
    const apiClient = makeApiClient();
    const manager = new SessionManager({
      sessionUpdater: apiClient as any,
      apiUrl: "http://localhost:3000",
      dataDir: workDir,
      sessionTimeoutSeconds: 600,
    });

    const claim = makeClaim();
    const agent = makeAgent();

    const session = await manager.startSession(
      claim,
      agent.id,
      agent.apiKey,
      agent.type as any,
      fakeCliPath,
    );

    expect(session.status).toBe("running");
    expect(session.pid).toBeDefined();
    expect(manager.activeCount).toBe(1);

    const deadline = Date.now() + 3000;
    while (session.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(session.status).toBe("completed");
    expect(session.lastProgress).toBeTruthy();
    expect(manager.activeCount).toBe(0);
    expect(updateSessionMock).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("marks session failed when fake CLI exits non-zero", async () => {
    const apiClient = makeApiClient();
    const manager = new SessionManager({
      sessionUpdater: apiClient as any,
      apiUrl: "http://localhost:3000",
      dataDir: workDir,
      sessionTimeoutSeconds: 600,
    });

    const claim = makeClaim();
    const agent = makeAgent();

    const session = await manager.startSession(
      claim,
      agent.id,
      agent.apiKey,
      agent.type as any,
      fakeFailCliPath,
    );

    const deadline = Date.now() + 3000;
    while (session.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(session.status).toBe("failed");
    expect(updateSessionMock).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("poll loop claims and starts a session for an idle agent", async () => {
    const apiClient = makeApiClient();
    const claim = makeClaim();
    apiClient.claimNext = vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null);

    const manager = new SessionManager({
      sessionUpdater: apiClient as any,
      apiUrl: "http://localhost:3000",
      dataDir: workDir,
      sessionTimeoutSeconds: 600,
    });

    const agent = makeAgent(fakeCliPath);

    const loop = new PollLoop({
      config: {
        apiUrl: "http://localhost:3000",
        registrationToken: null,
        name: "test",
        maxConcurrent: 2,
        pollIntervalSeconds: 600,
        heartbeatIntervalSeconds: 600,
        sessionTimeoutSeconds: 600,
        dataDir: workDir,
        habitatIds: ["hab-00000000-0000-0000-0000-000000000001"],
      },
      apiClient: apiClient as any,
      sessionManager: manager,
      agents: [agent],
    });

    (loop as any).running = true;
    await loop.tick();

    expect(apiClient.claimNext).toHaveBeenCalledWith(
      agent.id,
      "hab-00000000-0000-0000-0000-000000000001",
    );
    expect(manager.activeCount).toBe(1);
  });

  it("recovery marks orphaned sessions on startup", async () => {
    const apiClient = makeApiClient();
    apiClient.getActiveSessions = vi.fn().mockResolvedValue([
      {
        id: "s-00000000-0000-0000-0000-000000000001",
        agentId: "agent-00000000-0000-0000-0000-000000000001",
        taskId: "task-00000001-0000-0000-0000-000000000000",
        workdir: "/tmp/workdir",
      },
    ]);

    const results = await recoverSessions(apiClient as any, [makeAgent()]);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("failed");
    expect(updateSessionMock).toHaveBeenCalledWith(
      "s-00000000-0000-0000-0000-000000000001",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("full flow: claim -> start -> complete -> heartbeat", async () => {
    const apiClient = makeApiClient();
    const claim = makeClaim();
    apiClient.claimNext = vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null);

    const onSessionComplete = vi.fn();
    const manager = new SessionManager({
      sessionUpdater: apiClient as any,
      apiUrl: "http://localhost:3000",
      dataDir: workDir,
      sessionTimeoutSeconds: 600,
      onSessionComplete,
    });

    const agent = makeAgent(fakeCliPath);

    const loop = new PollLoop({
      config: {
        apiUrl: "http://localhost:3000",
        registrationToken: null,
        name: "test",
        maxConcurrent: 2,
        pollIntervalSeconds: 600,
        heartbeatIntervalSeconds: 600,
        sessionTimeoutSeconds: 600,
        dataDir: workDir,
        habitatIds: ["hab-00000000-0000-0000-0000-000000000001"],
      },
      apiClient: apiClient as any,
      sessionManager: manager,
      agents: [agent],
    });

    (loop as any).running = true;
    await loop.tick();

    expect(manager.activeCount).toBe(1);

    const deadline = Date.now() + 3000;
    while (manager.activeCount > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(manager.activeCount).toBe(0);
    expect(onSessionComplete).toHaveBeenCalled();
    const completedSession = onSessionComplete.mock.calls[0][0];
    expect(completedSession.status).toBe("completed");

    (loop as any).running = true;
    await loop.tick();
    expect(apiClient.claimNext).toHaveBeenCalledTimes(2);
  });
});
