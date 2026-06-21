import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { WorkflowGatePanel } from "./WorkflowGatePanel.js";

afterEach(() => {
  cleanup();
});

const baseGate = {
  id: "gate-1",
  gateType: "on_complete",
  satisfied: false,
  satisfiedAt: null,
  satisfiedByEventId: null,
  upstreamTaskId: "task-a",
  downstreamTaskId: "task-b",
  recoveryTaskId: null,
  recoveryDepth: null,
};

const upstreamTask = { id: "task-a", title: "Build", status: "done" };
const downstreamTask = { id: "task-b", title: "Test", status: "pending" };

describe("WorkflowGatePanel", () => {
  it("renders gate type and state", () => {
    render(
      <WorkflowGatePanel
        gate={baseGate}
        upstreamTask={upstreamTask}
        downstreamTask={downstreamTask}
        isAdmin={true}
        unblocking={false}
        onUnblock={vi.fn()}
        onClose={vi.fn()}
        onNavigateTask={vi.fn()}
      />,
    );

    expect(screen.getByText("On Complete")).toBeTruthy();
    expect(screen.getByTestId("gate-state").textContent).toBe("Waiting");
  });

  it("shows satisfied state", () => {
    const satisfiedGate = {
      ...baseGate,
      satisfied: true,
      satisfiedAt: "2026-06-21T10:00:00Z",
      satisfiedByEventId: "evt-123",
    };

    render(
      <WorkflowGatePanel
        gate={satisfiedGate}
        upstreamTask={upstreamTask}
        downstreamTask={downstreamTask}
        isAdmin={true}
        unblocking={false}
        onUnblock={vi.fn()}
        onClose={vi.fn()}
        onNavigateTask={vi.fn()}
      />,
    );

    expect(screen.getByTestId("gate-state").textContent).toBe("Satisfied");
    expect(screen.getByText("evt-123")).toBeTruthy();
  });

  it("shows manual unblock button for on_manual gate when admin and unsatisfied", () => {
    const manualGate = { ...baseGate, gateType: "on_manual" };

    render(
      <WorkflowGatePanel
        gate={manualGate}
        upstreamTask={upstreamTask}
        downstreamTask={downstreamTask}
        isAdmin={true}
        unblocking={false}
        onUnblock={vi.fn()}
        onClose={vi.fn()}
        onNavigateTask={vi.fn()}
      />,
    );

    expect(screen.getByTestId("gate-unblock-btn")).toBeTruthy();
  });

  it("hides unblock button for non-admin", () => {
    const manualGate = { ...baseGate, gateType: "on_manual" };

    render(
      <WorkflowGatePanel
        gate={manualGate}
        upstreamTask={upstreamTask}
        downstreamTask={downstreamTask}
        isAdmin={false}
        unblocking={false}
        onUnblock={vi.fn()}
        onClose={vi.fn()}
        onNavigateTask={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("gate-unblock-btn")).toBeNull();
    expect(screen.getByText(/Admin access required/)).toBeTruthy();
  });

  it("hides unblock button for non-manual gates", () => {
    render(
      <WorkflowGatePanel
        gate={baseGate}
        upstreamTask={upstreamTask}
        downstreamTask={downstreamTask}
        isAdmin={true}
        unblocking={false}
        onUnblock={vi.fn()}
        onClose={vi.fn()}
        onNavigateTask={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("gate-unblock-btn")).toBeNull();
  });

  it("hides unblock button when gate already satisfied", () => {
    const satisfiedManual = {
      ...baseGate,
      gateType: "on_manual",
      satisfied: true,
      satisfiedAt: "2026-06-21T10:00:00Z",
    };

    render(
      <WorkflowGatePanel
        gate={satisfiedManual}
        upstreamTask={upstreamTask}
        downstreamTask={downstreamTask}
        isAdmin={true}
        unblocking={false}
        onUnblock={vi.fn()}
        onClose={vi.fn()}
        onNavigateTask={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("gate-unblock-btn")).toBeNull();
    expect(screen.getByText(/already satisfied/)).toBeTruthy();
  });

  it("calls onUnblock when unblock button clicked", () => {
    const onUnblock = vi.fn();
    const manualGate = { ...baseGate, gateType: "on_manual" };

    render(
      <WorkflowGatePanel
        gate={manualGate}
        upstreamTask={upstreamTask}
        downstreamTask={downstreamTask}
        isAdmin={true}
        unblocking={false}
        onUnblock={onUnblock}
        onClose={vi.fn()}
        onNavigateTask={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("gate-unblock-btn"));
    expect(onUnblock).toHaveBeenCalled();
  });

  it("calls onNavigateTask when upstream task clicked", () => {
    const onNavigateTask = vi.fn();

    render(
      <WorkflowGatePanel
        gate={baseGate}
        upstreamTask={upstreamTask}
        downstreamTask={downstreamTask}
        isAdmin={true}
        unblocking={false}
        onUnblock={vi.fn()}
        onClose={vi.fn()}
        onNavigateTask={onNavigateTask}
      />,
    );

    fireEvent.click(screen.getByTestId("gate-upstream-task"));
    expect(onNavigateTask).toHaveBeenCalledWith("task-a");
  });

  it("calls onClose when close button clicked", () => {
    const onClose = vi.fn();

    render(
      <WorkflowGatePanel
        gate={baseGate}
        upstreamTask={upstreamTask}
        downstreamTask={downstreamTask}
        isAdmin={true}
        unblocking={false}
        onUnblock={vi.fn()}
        onClose={onClose}
        onNavigateTask={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("gate-panel-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows recovery task info when recoveryTaskId is present", () => {
    const recoveryGate = {
      ...baseGate,
      recoveryTaskId: "task-recovery-1",
      recoveryDepth: 1,
    };

    render(
      <WorkflowGatePanel
        gate={recoveryGate}
        upstreamTask={upstreamTask}
        downstreamTask={downstreamTask}
        isAdmin={true}
        unblocking={false}
        onUnblock={vi.fn()}
        onClose={vi.fn()}
        onNavigateTask={vi.fn()}
      />,
    );

    expect(screen.getByTestId("gate-recovery-task")).toBeTruthy();
    expect(screen.getByText(/depth 1/)).toBeTruthy();
  });
});
