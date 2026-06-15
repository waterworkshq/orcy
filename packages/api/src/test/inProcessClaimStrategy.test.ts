import { describe, it, expect, vi } from "vitest";
import { InProcessClaimStrategy } from "../services/inProcessClaimStrategy.js";
import type { InProcessClaimDeps } from "../services/inProcessClaimStrategy.js";

function makeDeps(overrides?: Partial<InProcessClaimDeps>): InProcessClaimDeps {
  return {
    daemonId: "d1",
    isAgentOwnedByDaemon: vi.fn().mockReturnValue(true),
    getHabitatById: vi.fn().mockReturnValue({ id: "h1", gitWorktreeSettings: null }),
    getSuggestionsForAgent: vi.fn().mockReturnValue({ suggestions: [{ taskId: "t1" }] }),
    claimTask: vi.fn().mockReturnValue({ success: true }),
    getTaskById: vi.fn().mockReturnValue({
      id: "t1",
      title: "T",
      description: null,
      missionId: "m1",
      priority: "p",
      requiredDomain: null,
      requiredCapabilities: null,
    }),
    createDaemonSession: vi.fn().mockReturnValue({ id: "s1" }),
    ...overrides,
  };
}

describe("InProcessClaimStrategy", () => {
  it("returns null when agent is not owned by daemon", async () => {
    const strategy = new InProcessClaimStrategy(makeDeps({ isAgentOwnedByDaemon: () => false }));
    expect(await strategy.claimNext("a1", "h1", "d1")).toBeNull();
  });

  it("returns null when habitat does not exist", async () => {
    const strategy = new InProcessClaimStrategy(makeDeps({ getHabitatById: () => null }));
    expect(await strategy.claimNext("a1", "h1", "d1")).toBeNull();
  });

  it("claims a task and creates a session", async () => {
    const deps = makeDeps();
    const strategy = new InProcessClaimStrategy(deps);
    const result = await strategy.claimNext("a1", "h1", "d1");
    expect(result).toMatchObject({
      daemonSessionId: "s1",
      task: { id: "t1", title: "T", missionId: "m1", habitatId: "h1" },
    });
    expect(deps.claimTask).toHaveBeenCalledWith("t1", "a1");
    expect(deps.createDaemonSession).toHaveBeenCalledWith({
      daemonId: "d1",
      agentId: "a1",
      taskId: "t1",
      habitatId: "h1",
      workdir: "pending",
    });
  });

  it("returns null when no suggestions are claimable", async () => {
    const strategy = new InProcessClaimStrategy(
      makeDeps({
        getSuggestionsForAgent: () => ({ suggestions: [] }),
      }),
    );
    expect(await strategy.claimNext("a1", "h1", "d1")).toBeNull();
  });

  it("returns null when claimTask fails for all suggestions", async () => {
    const strategy = new InProcessClaimStrategy(
      makeDeps({
        getSuggestionsForAgent: () => ({
          suggestions: [{ taskId: "t1" }, { taskId: "t2" }],
        }),
        claimTask: vi.fn().mockReturnValue({ success: false }),
      }),
    );
    expect(await strategy.claimNext("a1", "h1", "d1")).toBeNull();
  });

  it("passes through worktreeSettings from habitat", async () => {
    const strategy = new InProcessClaimStrategy(
      makeDeps({
        getHabitatById: () => ({
          id: "h1",
          gitWorktreeSettings: { repoPath: "/repo", branchPrefix: "feat/", autoCleanup: true },
        }),
      }),
    );
    const result = await strategy.claimNext("a1", "h1", "d1");
    expect(result?.worktreeSettings).toEqual({
      repoPath: "/repo",
      branchPrefix: "feat/",
      autoCleanup: true,
    });
  });
});
