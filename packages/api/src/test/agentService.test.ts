import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../repositories/agent.js", () => ({
  createAgent: vi.fn(),
  getAgentById: vi.fn(),
  listAgents: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  heartbeat: vi.fn(),
  getAgentByApiKey: vi.fn(),
  getStaleAgents: vi.fn(),
  setAgentOffline: vi.fn(),
  getStaleSweepCandidates: vi.fn(),
  markAgentOfflineKeepingTask: vi.fn(),
  clearAgentTaskPointerIfStale: vi.fn(),
}));
vi.mock("../repositories/task.js", () => ({
  getTaskById: vi.fn(),
  getTasksByIds: vi.fn(),
  releaseTask: vi.fn(),
  getHabitatIdForTask: vi.fn(),
}));
vi.mock("./timeTrackingService.js", () => ({ recordWork: vi.fn() }));
vi.mock("../sse/broadcaster.js", () => ({ sseBroadcaster: { publish: vi.fn() } }));
vi.mock("../lib/logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("../services/effects/releaseEffects.js", () => ({ releaseTaskWithEffects: vi.fn() }));
vi.mock("../services/tasks/transition-emitter.js", () => ({ emitTransitionNonRequired: vi.fn() }));
vi.mock("../services/tasks/transitionBudget.js", () => ({
  guardTransitionTop: vi.fn(() => ({ outcome: "allow", count: 0, ceiling: 21 })),
}));
vi.mock("../services/effects/effectDeliverer.js", () => ({ requestEffectDeliveryPass: vi.fn() }));

import {
  createAgent,
  getAgent,
  listAgents,
  listAgentsWithTasks,
  updateAgent,
  deleteAgent,
  heartbeat,
  getAgentByApiKey,
  getAgentWithTask,
  releaseStaleTasks,
} from "../services/agentService.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskRepo from "../repositories/task.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { releaseTaskWithEffects } from "../services/effects/releaseEffects.js";
import { emitTransitionNonRequired } from "../services/tasks/transition-emitter.js";
import { requestEffectDeliveryPass } from "../services/effects/effectDeliverer.js";

describe("agentService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("createAgent delegates", () => {
    vi.mocked(agentRepo.createAgent).mockReturnValue({
      agent: { id: "a1", name: "B" },
      plainApiKey: "k1",
    } as any);
    const r = createAgent({ name: "B", domain: "backend" } as any);
    expect(r.agent.id).toBe("a1");
    expect(r.plainApiKey).toBe("k1");
  });

  it("getAgent delegates", () => {
    vi.mocked(agentRepo.getAgentById).mockReturnValue({ id: "a1" } as any);
    expect(getAgent("a1")!.id).toBe("a1");
  });

  it("getAgent returns null", () => {
    vi.mocked(agentRepo.getAgentById).mockReturnValue(null);
    expect(getAgent("x")).toBeNull();
  });

  it("listAgents filters by status", () => {
    vi.mocked(agentRepo.listAgents).mockReturnValue([
      { id: "a1", status: "online", domain: "be" } as any,
      { id: "a2", status: "offline", domain: "be" } as any,
    ]);
    const r = listAgents("online");
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe("a1");
  });

  it("listAgents filters by domain", () => {
    vi.mocked(agentRepo.listAgents).mockReturnValue([
      { id: "a1", status: "online", domain: "be" } as any,
      { id: "a2", status: "online", domain: "fe" } as any,
    ]);
    expect(listAgents(undefined, "fe")).toHaveLength(1);
  });

  it("listAgentsWithTasks enriches with titles", () => {
    vi.mocked(agentRepo.listAgents).mockReturnValue([
      { id: "a1", status: "online", domain: "be", currentTaskId: "t1" } as any,
    ]);
    vi.mocked(taskRepo.getTasksByIds).mockReturnValue([{ id: "t1", title: "Build API" }] as any);
    const r = listAgentsWithTasks();
    expect(r[0].currentTaskTitle).toBe("Build API");
  });

  it("listAgentsWithTasks handles missing task", () => {
    vi.mocked(agentRepo.listAgents).mockReturnValue([
      { id: "a1", status: "online", domain: "be", currentTaskId: "t1" } as any,
    ]);
    vi.mocked(taskRepo.getTasksByIds).mockReturnValue([]);
    expect(listAgentsWithTasks()[0].currentTaskTitle).toBeNull();
  });

  it("updateAgent broadcasts status change", () => {
    vi.mocked(agentRepo.getAgentById).mockReturnValue({ id: "a1", status: "idle" } as any);
    vi.mocked(agentRepo.updateAgent).mockReturnValue({ id: "a1", status: "offline" } as any);
    updateAgent("a1", { status: "offline" } as any);
    expect(sseBroadcaster.publish).toHaveBeenCalledWith(
      "global",
      expect.objectContaining({ type: "agent.status_changed" }),
    );
  });

  it("deleteAgent releases task and deletes", () => {
    vi.mocked(agentRepo.getAgentById).mockReturnValue({ id: "a1", currentTaskId: "t1" } as any);
    vi.mocked(taskRepo.releaseTask).mockReturnValue({ id: "t1" } as any);
    deleteAgent("a1");
    expect(taskRepo.releaseTask).toHaveBeenCalledWith("t1", "system");
    expect(agentRepo.deleteAgent).toHaveBeenCalledWith("a1");
  });

  it("heartbeat returns status info", () => {
    vi.mocked(agentRepo.heartbeat).mockReturnValue({ id: "a1", status: "working" } as any);
    vi.mocked(taskRepo.getTaskById).mockReturnValue({ id: "t1", status: "in_progress" } as any);
    const r = heartbeat("a1", "t1");
    expect(r).not.toBeNull();
    expect(r!.status).toBe("working");
    expect(r!.taskStatus).toBe("in_progress");
  });

  it("heartbeat returns null when agent not found", () => {
    vi.mocked(agentRepo.heartbeat).mockReturnValue(null);
    expect(heartbeat("a1")).toBeNull();
  });

  it("getAgentByApiKey delegates", () => {
    vi.mocked(agentRepo.getAgentByApiKey).mockReturnValue({ id: "a1" } as any);
    expect(getAgentByApiKey("key")!.id).toBe("a1");
  });

  it("getAgentWithTask returns agent and task", () => {
    vi.mocked(agentRepo.getAgentById).mockReturnValue({ id: "a1", currentTaskId: "t1" } as any);
    vi.mocked(taskRepo.getTaskById).mockReturnValue({ id: "t1" } as any);
    const r = getAgentWithTask("a1")!;
    expect(r.agent.id).toBe("a1");
    expect(r.currentTask!.id).toBe("t1");
  });

  it("releaseStaleTasks processes stale agents through the canonical seam", async () => {
    vi.mocked(agentRepo.getStaleSweepCandidates).mockReturnValue([
      {
        id: "a1",
        status: "working",
        currentTaskId: "t1",
        lastHeartbeat: new Date(Date.now() - 31 * 60_000).toISOString(),
      } as any,
    ]);
    vi.mocked(agentRepo.markAgentOfflineKeepingTask).mockReturnValue(true);
    vi.mocked(taskRepo.getTaskById).mockReturnValue({
      id: "t1",
      status: "in_progress",
      assignedAgentId: "a1",
    } as any);
    vi.mocked(taskRepo.getHabitatIdForTask).mockReturnValue("h1");
    vi.mocked(releaseTaskWithEffects).mockReturnValue({
      task: { id: "t1", status: "pending" },
      eventId: "e1",
    } as any);

    releaseStaleTasks(30);

    expect(agentRepo.markAgentOfflineKeepingTask).toHaveBeenCalledWith("a1", expect.any(String));
    expect(sseBroadcaster.publish).toHaveBeenCalledWith(
      "global",
      expect.objectContaining({ type: "agent.status_changed" }),
    );
    expect(releaseTaskWithEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "t1",
        actorId: "stale-sweep",
        reason: "stale_timeout",
        guard: { expectedAssigneeAgentId: "a1", staleHeartbeatBefore: expect.any(String) },
      }),
    );
    expect(emitTransitionNonRequired).toHaveBeenCalledWith(
      "t1",
      "released",
      "h1",
      expect.objectContaining({ existingEventId: "e1" }),
    );
    expect(requestEffectDeliveryPass).toHaveBeenCalled();
    expect(agentRepo.clearAgentTaskPointerIfStale).toHaveBeenCalledWith(
      "a1",
      "t1",
      expect.any(String),
    );
    expect(taskRepo.releaseTask).not.toHaveBeenCalled(); // legacy repo path gone
  });

  it("releaseStaleTasks skips a candidate when the offline CAS misses (revived)", () => {
    vi.mocked(agentRepo.getStaleSweepCandidates).mockReturnValue([
      {
        id: "a1",
        status: "working",
        currentTaskId: "t1",
        lastHeartbeat: new Date(Date.now() - 31 * 60_000).toISOString(),
      } as any,
    ]);
    vi.mocked(agentRepo.markAgentOfflineKeepingTask).mockReturnValue(false);

    releaseStaleTasks(30);

    expect(sseBroadcaster.publish).not.toHaveBeenCalled();
    expect(taskRepo.releaseTask).not.toHaveBeenCalled();
  });
});
