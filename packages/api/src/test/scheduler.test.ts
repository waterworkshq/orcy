import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkOverdueTasks } from "../services/scheduler.js";

let _overdueData: { id: string; habitatId: string }[] = [];
let _dbShouldThrow = false;

function table(name: string) {
  return { _table: name };
}

function createMockDb() {
  const doSelect = () => {
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      all: () => {
        if (_dbShouldThrow) throw new Error("db crash");
        return _overdueData;
      },
    };
    return chain;
  };
  return { select: () => doSelect() };
}

vi.mock("../db/index.js", () => ({
  getDb: () => createMockDb(),
  initDb: vi.fn(),
  closeDb: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: any, val: any) => ({ col, val }),
  and: (...conditions: any[]) => ({ _type: "and", conditions }),
  notInArray: (col: any, vals: any[]) => ({ _type: "notInArray", col, vals }),
  or: (...conditions: any[]) => ({ _type: "or", conditions }),
  sql: (strings: any, ...values: any[]) => ({ _type: "sql", strings, values }),
  desc: (col: any) => ({ _type: "desc", col }),
}));

const mockPublish = vi.hoisted(() => vi.fn());
vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: mockPublish },
}));

vi.mock("../db/schema/index.js", () => {
  return {
    habitats: table("habitats"),
    missions: { id: "id", habitatId: "habitatId", dueAt: "dueAt", slaDeadlineAt: "slaDeadlineAt" },
    missionDependencies: table("missionDependencies"),
    missionEvents: table("missionEvents"),
    missionWatchers: table("missionWatchers"),
    columns: { id: "id", name: "name", habitatId: "habitatId", ...table("columns") },
    missionTemplates: table("missionTemplates"),
    savedFilters: table("savedFilters"),
    chatIntegrations: table("chatIntegrations"),
    missionComments: table("missionComments"),
    missionCommentMentions: table("missionCommentMentions"),
    auditExportSchedules: table("auditExportSchedules"),
    scheduledTasks: table("scheduledTasks"),
    habitatHealthSnapshots: table("habitatHealthSnapshots"),
    tasks: { id: "id", missionId: "missionId", status: "status" },
    taskEvents: table("taskEvents"),
    taskDependencies: table("taskDependencies"),
    taskComments: table("taskComments"),
    taskSubtasks: table("taskSubtasks"),
    taskWatchers: table("taskWatchers"),
    taskCommentMentions: table("taskCommentMentions"),
    taskAttachments: table("taskAttachments"),
    taskTimeRecords: table("taskTimeRecords"),
    agents: { id: "id", name: "name", type: "type", ...table("agents") },
    agentMessages: table("agentMessages"),
    users: { id: "id", username: "username", email: "email" },
    organizations: table("organizations"),
    teams: table("teams"),
    teamMembers: table("teamMembers"),
    notificationPreferences: { id: "id", ...table("notificationPreferences") },
    webhookSubscriptions: table("webhookSubscriptions"),
    webhookDeliveries: table("webhookDeliveries"),
    pulses: table("pulses"),
    pulseCursors: table("pulseCursors"),
    projectInsights: table("projectInsights"),
    pulseReactions: table("pulseReactions"),
    pullRequests: table("pullRequests"),
    pipelineEvents: table("pipelineEvents"),
    qualityChecklistTemplates: table("qualityChecklistTemplates"),
    qualityChecklistItems: table("qualityChecklistItems"),
    taskQualityChecklists: table("taskQualityChecklists"),
    taskQualityChecklistItems: table("taskQualityChecklistItems"),
    daemonInstances: table("daemonInstances"),
    daemonAgents: table("daemonAgents"),
    daemonSessions: table("daemonSessions"),
  };
});

vi.mock("../db/dialect-helpers.js", () => ({
  nowExpr: () => ({ _type: "now" }),
}));

describe("checkOverdueTasks", () => {
  beforeEach(() => {
    _overdueData = [];
    _dbShouldThrow = false;
    mockPublish.mockClear();
  });

  it("publishes events for all overdue tasks on first run", () => {
    _overdueData = [
      { id: "t-1", habitatId: "b-1" },
      { id: "t-2", habitatId: "b-1" },
    ];
    const notified = new Set<string>();
    const onError = vi.fn();

    const published = checkOverdueTasks(notified, onError);

    expect(published).toBe(2);
    expect(mockPublish).toHaveBeenCalledTimes(2);
    expect(mockPublish).toHaveBeenCalledWith(
      "b-1",
      expect.objectContaining({
        type: "task.overdue",
        data: expect.objectContaining({ taskId: "t-1" }),
      }),
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not publish events for already-notified tasks (dedup)", () => {
    _overdueData = [{ id: "t-1", habitatId: "b-1" }];
    const notified = new Set<string>(["t-1"]);
    const onError = vi.fn();

    const published = checkOverdueTasks(notified, onError);

    expect(published).toBe(0);
    expect(mockPublish).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("publishes only for newly overdue tasks when some are already notified", () => {
    _overdueData = [
      { id: "t-1", habitatId: "b-1" },
      { id: "t-2", habitatId: "b-1" },
      { id: "t-3", habitatId: "b-2" },
    ];
    const notified = new Set<string>(["t-1", "t-3"]);
    const onError = vi.fn();

    const published = checkOverdueTasks(notified, onError);

    expect(published).toBe(1);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      "b-1",
      expect.objectContaining({
        type: "task.overdue",
        data: expect.objectContaining({ taskId: "t-2" }),
      }),
    );
  });

  it("removes resolved tasks from notified set and re-publishes if they become overdue again", () => {
    _overdueData = [{ id: "t-1", habitatId: "b-1" }];
    const notified = new Set<string>(["t-1", "t-2"]);
    const onError = vi.fn();

    checkOverdueTasks(notified, onError);

    expect(notified.has("t-1")).toBe(true);
    expect(notified.has("t-2")).toBe(false);

    mockPublish.mockClear();

    _overdueData = [{ id: "t-2", habitatId: "b-1" }];
    const rePublished = checkOverdueTasks(notified, onError);

    expect(rePublished).toBe(1);
    expect(mockPublish).toHaveBeenCalledWith(
      "b-1",
      expect.objectContaining({
        type: "task.overdue",
        data: expect.objectContaining({ taskId: "t-2" }),
      }),
    );
  });

  it("updates the notified set with current overdue task ids", () => {
    _overdueData = [
      { id: "t-1", habitatId: "b-1" },
      { id: "t-2", habitatId: "b-1" },
    ];
    const notified = new Set<string>();
    const onError = vi.fn();

    checkOverdueTasks(notified, onError);

    expect(notified.has("t-1")).toBe(true);
    expect(notified.has("t-2")).toBe(true);
  });

  it("calls onError and returns 0 when the db query throws", () => {
    _dbShouldThrow = true;
    const onError = vi.fn();

    const published = checkOverdueTasks(new Set<string>(), onError);

    expect(published).toBe(0);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});
