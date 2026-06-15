import { describe, it, expect, vi } from "vitest";
import { runPollTick } from "../daemon-poll.js";
import { WorkdirError } from "../workdir-error.js";
import type {
  ISessionManager,
  IClaimStrategy,
  RegisteredAgent,
  ClaimResult,
} from "../types/daemon.js";

function makeManager(overrides?: Partial<ISessionManager>): ISessionManager {
  return {
    activeCount: 0,
    activeSessions: [],
    getSession: () => undefined,
    startSession: vi.fn().mockResolvedValue({} as never),
    terminateSession: vi.fn(),
    releaseSession: vi.fn(),
    shutdownAll: vi.fn(),
    startTimeoutCheck: vi.fn(),
    stopTimeoutCheck: vi.fn(),
    ...overrides,
  };
}

function makeAgent(id: string): RegisteredAgent {
  return { id, name: `agent-${id}`, type: "claude-code", apiKey: "k", binPath: "/bin/claude" };
}

function makeClaim(habitatId = "h1"): ClaimResult {
  return {
    task: {
      id: "t1",
      title: "T",
      description: null,
      missionId: "m1",
      habitatId,
      priority: "p",
      requiredDomain: null,
      requiredCapabilities: null,
    },
    worktreeSettings: null,
  };
}

describe("runPollTick", () => {
  it("returns zero counts when no idle agents", async () => {
    const sm = makeManager({
      activeSessions: [{ agentId: "a1" } as never],
    });
    const result = await runPollTick({
      sessionManager: sm,
      agents: [makeAgent("a1")],
      habitatIds: ["h1"],
      maxConcurrent: 4,
      claim: { claimNext: vi.fn() },
    });
    expect(result.claimed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.idleAgentCount).toBe(0);
  });

  it("claims an agent's task and starts a session", async () => {
    const sm = makeManager();
    const claimStrategy: IClaimStrategy = {
      claimNext: vi.fn().mockResolvedValue(makeClaim()),
    };
    const result = await runPollTick({
      sessionManager: sm,
      agents: [makeAgent("a1")],
      habitatIds: ["h1"],
      maxConcurrent: 4,
      claim: claimStrategy,
    });
    expect(result.claimed).toBe(1);
    expect(sm.startSession).toHaveBeenCalledOnce();
  });

  it("tries next habitat when claimNext returns null", async () => {
    const claim = makeClaim("h2");
    const claimStrategy: IClaimStrategy = {
      claimNext: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(claim),
    };
    const sm = makeManager();
    const result = await runPollTick({
      sessionManager: sm,
      agents: [makeAgent("a1")],
      habitatIds: ["h1", "h2"],
      maxConcurrent: 4,
      claim: claimStrategy,
    });
    expect(result.claimed).toBe(1);
    expect(claimStrategy.claimNext).toHaveBeenCalledTimes(2);
  });

  it("retries next habitat on WorkdirError (B4)", async () => {
    const claim = makeClaim("h2");
    const sm = makeManager({
      startSession: vi
        .fn()
        .mockRejectedValueOnce(new WorkdirError("bad config"))
        .mockResolvedValueOnce({} as never),
    });
    const claimStrategy: IClaimStrategy = {
      claimNext: vi.fn().mockResolvedValueOnce(claim).mockResolvedValueOnce(claim),
    };
    const result = await runPollTick({
      sessionManager: sm,
      agents: [makeAgent("a1")],
      habitatIds: ["h1", "h2"],
      maxConcurrent: 4,
      claim: claimStrategy,
    });
    expect(result.claimed).toBe(1);
    expect(result.errorsByKind.workdir).toBe(1);
  });

  it("counts claim errors and retries next habitat (B6a)", async () => {
    const sm = makeManager();
    const claimStrategy: IClaimStrategy = {
      claimNext: vi.fn().mockRejectedValue(new Error("network")),
    };
    const result = await runPollTick({
      sessionManager: sm,
      agents: [makeAgent("a1")],
      habitatIds: ["h1"],
      maxConcurrent: 4,
      claim: claimStrategy,
    });
    expect(result.failed).toBe(1);
    expect(result.errorsByKind.claim).toBe(1);
  });

  it("caps concurrent at maxConcurrent", async () => {
    const sm = makeManager({ activeCount: 3 });
    const result = await runPollTick({
      sessionManager: sm,
      agents: [makeAgent("a1"), makeAgent("a2")],
      habitatIds: ["h1"],
      maxConcurrent: 4,
      claim: { claimNext: vi.fn() },
    });
    expect(result.availableSlots).toBe(1);
    expect(result.claimed).toBe(0);
  });

  it("returns zero slots when at maxConcurrent", async () => {
    const sm = makeManager({ activeCount: 4 });
    const result = await runPollTick({
      sessionManager: sm,
      agents: [makeAgent("a1")],
      habitatIds: ["h1"],
      maxConcurrent: 4,
      claim: { claimNext: vi.fn() },
    });
    expect(result.availableSlots).toBe(0);
    expect(result.idleAgentCount).toBe(1);
    expect(result.claimed).toBe(0);
  });

  it("counts other (non-WorkdirError) startSession errors", async () => {
    const sm = makeManager({
      startSession: vi.fn().mockRejectedValue(new Error("spawn failed")),
    });
    const claimStrategy: IClaimStrategy = {
      claimNext: vi.fn().mockResolvedValue(makeClaim()),
    };
    const result = await runPollTick({
      sessionManager: sm,
      agents: [makeAgent("a1")],
      habitatIds: ["h1", "h2"],
      maxConcurrent: 4,
      claim: claimStrategy,
    });
    expect(result.claimed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errorsByKind.other).toBeGreaterThanOrEqual(1);
  });

  it("handles multiple idle agents and claims up to available slots", async () => {
    const sm = makeManager({ activeCount: 0 });
    const claimStrategy: IClaimStrategy = {
      claimNext: vi.fn().mockResolvedValue(makeClaim()),
    };
    const result = await runPollTick({
      sessionManager: sm,
      agents: [makeAgent("a1"), makeAgent("a2"), makeAgent("a3")],
      habitatIds: ["h1"],
      maxConcurrent: 2,
      claim: claimStrategy,
    });
    expect(result.claimed).toBe(2);
    expect(result.availableSlots).toBe(2);
  });
});
