import { beforeEach, describe, expect, it } from "vitest";
import { useHabitatStore } from "./habitatStore.js";
import type { Notification } from "../types/index.js";

describe("habitat store mission selection", () => {
  beforeEach(() => {
    useHabitatStore.setState({
      isBulkSelectMode: false,
      selectedMissionIds: [],
    });
  });

  it("toggleMissionSelection adds and removes ids", () => {
    const { toggleMissionSelection } = useHabitatStore.getState();

    toggleMissionSelection("feat-1");
    expect(useHabitatStore.getState().selectedMissionIds).toEqual(["feat-1"]);

    toggleMissionSelection("feat-2");
    expect(useHabitatStore.getState().selectedMissionIds).toEqual(["feat-1", "feat-2"]);

    toggleMissionSelection("feat-1");
    expect(useHabitatStore.getState().selectedMissionIds).toEqual(["feat-2"]);
  });

  it("setBulkSelectMode(false) clears selection", () => {
    const { toggleMissionSelection, setBulkSelectMode } = useHabitatStore.getState();

    toggleMissionSelection("feat-1");
    toggleMissionSelection("feat-2");
    expect(useHabitatStore.getState().selectedMissionIds).toHaveLength(2);

    setBulkSelectMode(false);
    expect(useHabitatStore.getState().selectedMissionIds).toEqual([]);
    expect(useHabitatStore.getState().isBulkSelectMode).toBe(false);
  });

  it("handleSSEEvent task.deleted does not mutate zustand server state (RQ-managed)", () => {
    const { handleSSEEvent } = useHabitatStore.getState();

    handleSSEEvent({ type: "task.deleted", data: { taskId: "task-1" } });

    const state = useHabitatStore.getState();
    expect(state.recentSSEEvents.at(-1)).toEqual({ type: "task.deleted", data: { taskId: "task-1" } });
  });
});

describe("habitat store server state stays empty after SSE events", () => {
  beforeEach(() => {
    useHabitatStore.setState({
      wipAlerts: {},
      presence: [],
    });
  });

  it("mission.created does not mutate zustand server state (server projector owns it)", () => {
    const { handleSSEEvent } = useHabitatStore.getState();
    handleSSEEvent({
      type: "mission.created",
      data: {
        id: "feat-new",
        habitatId: "h1",
        columnId: "col-1",
        title: "New",
      },
    } as never);

    const state = useHabitatStore.getState();
    expect(state.wipAlerts).toEqual({});
  });

  it("mission events are idempotent at the store layer (no server-state duplication)", () => {
    const { handleSSEEvent } = useHabitatStore.getState();
    const event = {
      type: "mission.created",
      data: { id: "feat-d", habitatId: "h1", columnId: "col-1" },
    } as never;
    handleSSEEvent(event);
    handleSSEEvent(event);

    expect(useHabitatStore.getState().wipAlerts).toEqual({});
  });
});

describe("habitat store notifications", () => {
  beforeEach(() => {
    useHabitatStore.setState({ notifications: [] });
  });

  it("addNotification generates unique ID and sets read=false", () => {
    const { addNotification } = useHabitatStore.getState();

    addNotification({
      type: "task.claimed",
      taskId: "task-1",
      taskTitle: "Test task",
      message: "Agent claimed task",
      timestamp: "2026-04-30T00:00:00.000Z",
    });

    const state = useHabitatStore.getState();
    expect(state.notifications).toHaveLength(1);
    const n = state.notifications[0];
    expect(n.id).toBeTruthy();
    expect(n.read).toBe(false);
    expect(n.type).toBe("task.claimed");
    expect(n.taskId).toBe("task-1");
    expect(n.taskTitle).toBe("Test task");
    expect(n.message).toBe("Agent claimed task");
  });

  it("addNotification prepends to notifications array (newest first)", () => {
    const { addNotification } = useHabitatStore.getState();

    addNotification({
      type: "a",
      taskId: "t1",
      taskTitle: "First",
      message: "m1",
      timestamp: "2026-04-30T00:00:00.000Z",
    });
    addNotification({
      type: "b",
      taskId: "t2",
      taskTitle: "Second",
      message: "m2",
      timestamp: "2026-04-30T00:01:00.000Z",
    });

    const state = useHabitatStore.getState();
    expect(state.notifications).toHaveLength(2);
    expect(state.notifications[0].type).toBe("b");
    expect(state.notifications[1].type).toBe("a");
  });

  it("addNotification generates unique IDs for each call", () => {
    const { addNotification } = useHabitatStore.getState();

    addNotification({
      type: "a",
      taskId: "t1",
      taskTitle: "T1",
      message: "m",
      timestamp: "2026-04-30T00:00:00.000Z",
    });
    addNotification({
      type: "b",
      taskId: "t2",
      taskTitle: "T2",
      message: "m",
      timestamp: "2026-04-30T00:00:00.000Z",
    });

    const [n1, n2] = useHabitatStore.getState().notifications;
    expect(n1.id).not.toBe(n2.id);
  });

  it("addNotification preserves optional agentName", () => {
    const { addNotification } = useHabitatStore.getState();

    addNotification({
      type: "a",
      taskId: "t1",
      taskTitle: "T",
      message: "m",
      agentName: "Agent-1",
      timestamp: "2026-04-30T00:00:00.000Z",
    });
    addNotification({
      type: "b",
      taskId: "t2",
      taskTitle: "T",
      message: "m",
      timestamp: "2026-04-30T00:00:00.000Z",
    });

    const state = useHabitatStore.getState();
    expect(state.notifications[0].agentName).toBeUndefined();
    expect(state.notifications[1].agentName).toBe("Agent-1");
  });

  it("markNotificationRead sets read=true for matching ID", () => {
    const { addNotification, markNotificationRead } = useHabitatStore.getState();

    addNotification({
      type: "a",
      taskId: "t1",
      taskTitle: "T",
      message: "m",
      timestamp: "2026-04-30T00:00:00.000Z",
    });

    const id = useHabitatStore.getState().notifications[0].id;
    markNotificationRead(id);

    expect(useHabitatStore.getState().notifications[0].read).toBe(true);
  });

  it("markNotificationRead does not affect other notifications", () => {
    const { addNotification, markNotificationRead } = useHabitatStore.getState();

    addNotification({
      type: "a",
      taskId: "t1",
      taskTitle: "T1",
      message: "m",
      timestamp: "2026-04-30T00:00:00.000Z",
    });
    addNotification({
      type: "b",
      taskId: "t2",
      taskTitle: "T2",
      message: "m",
      timestamp: "2026-04-30T00:00:00.000Z",
    });

    const id = useHabitatStore.getState().notifications[1].id;
    markNotificationRead(id);

    const state = useHabitatStore.getState();
    expect(state.notifications[0].read).toBe(false);
    expect(state.notifications[1].read).toBe(true);
  });

  it("clearNotifications empties the notifications array", () => {
    const { addNotification, clearNotifications } = useHabitatStore.getState();

    addNotification({
      type: "a",
      taskId: "t1",
      taskTitle: "T",
      message: "m",
      timestamp: "2026-04-30T00:00:00.000Z",
    });
    addNotification({
      type: "b",
      taskId: "t2",
      taskTitle: "T",
      message: "m",
      timestamp: "2026-04-30T00:00:00.000Z",
    });
    expect(useHabitatStore.getState().notifications).toHaveLength(2);

    clearNotifications();
    expect(useHabitatStore.getState().notifications).toEqual([]);
  });
});