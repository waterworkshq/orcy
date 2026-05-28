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
}));
vi.mock("../repositories/task.js", () => ({
  getTaskById: vi.fn(),
  releaseTask: vi.fn(),
  getHabitatIdForTask: vi.fn(),
}));
vi.mock("./timeTrackingService.js", () => ({ recordWork: vi.fn() }));
vi.mock("../sse/broadcaster.js", () => ({ sseBroadcaster: { publish: vi.fn() } }));
vi.mock("../plugins/pluginManager.js", () => ({
  emitAgentRegistered: vi.fn(() => Promise.resolve()),
}));
vi.mock("../lib/logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

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

describe("agentService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("createAgent delegates and emits event", () => {
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
    vi.mocked(taskRepo.getTaskById).mockReturnValue({ title: "Build API" } as any);
    const r = listAgentsWithTasks();
    expect(r[0].currentTaskTitle).toBe("Build API");
  });

  it("listAgentsWithTasks handles missing task", () => {
    vi.mocked(agentRepo.listAgents).mockReturnValue([
      { id: "a1", status: "online", domain: "be", currentTaskId: "t1" } as any,
    ]);
    vi.mocked(taskRepo.getTaskById).mockReturnValue(null);
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

  it("releaseStaleTasks processes stale agents", () => {
    vi.mocked(agentRepo.getStaleAgents).mockReturnValue([{ id: "a1", currentTaskId: "t1" } as any]);
    vi.mocked(taskRepo.releaseTask).mockReturnValue({ id: "t1" } as any);
    vi.mocked(taskRepo.getHabitatIdForTask).mockReturnValue("h1");
    releaseStaleTasks(30);
    expect(agentRepo.setAgentOffline).toHaveBeenCalledWith("a1");
    expect(taskRepo.releaseTask).toHaveBeenCalledWith("t1", "stale_timeout");
    expect(sseBroadcaster.publish).toHaveBeenCalled();
  });
});
