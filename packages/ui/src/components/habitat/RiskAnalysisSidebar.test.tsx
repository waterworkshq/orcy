import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { RiskAnalysisSidebar } from "./RiskAnalysisSidebar.js";
import type { Task, MissionWithProgress, MissionEvent } from "../../types/index.js";

function makeMission(
  overrides: Partial<MissionWithProgress> & { id: string },
): MissionWithProgress {
  return {
    habitatId: "board-1",
    columnId: "col-1",
    title: "Test Feature",
    description: "",
    acceptanceCriteria: "",
    priority: "high",
    labels: [],
    status: "in_progress",
    displayOrder: 0,
    dependsOn: [],
    blocks: [],
    dueAt: null,
    slaMinutes: null,
    slaDeadlineAt: null,
    createdBy: "user-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    actualMinutes: null,
    plannedMinutes: null,
    planningAccuracy: null,
    completedAt: null,
    isArchived: false,
    sprintId: null,
    progress: {
      total: 0,
      pending: 0,
      claimed: 0,
      inProgress: 0,
      submitted: 0,
      approved: 0,
      done: 0,
      failed: 0,
      rejected: 0,
      percentage: 0,
    },
    ...overrides,
    releaseGateType: overrides.releaseGateType ?? null,
    releaseGateVersion: overrides.releaseGateVersion ?? null,
    releaseDeadlineType: overrides.releaseDeadlineType ?? null,
    releaseDeadlineVersion: overrides.releaseDeadlineVersion ?? null,
  };
}

function makeTask(overrides: Partial<Task> & { id: string; missionId: string }): Task {
  return {
    title: "Test Task",
    description: "",
    priority: "medium",
    assignedAgentId: null,
    delegatedToAgentId: null,
    requiredDomain: null,
    requiredCapabilities: [],
    status: "pending",
    claimedAt: null,
    startedAt: null,
    submittedAt: null,
    completedAt: null,
    rejectedCount: 0,
    rejectionReason: null,
    result: null,
    artifacts: [],
    order: 0,
    createdBy: "user-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    estimatedMinutes: null,
    actualMinutes: null,
    cycleTimeMinutes: null,
    leadTimeMinutes: null,
    estimationAccuracy: null,
    retryPolicy: null,
    retryCount: 0,
    nextRetryAt: null,
    labels: [],
    ...overrides,
  };
}

function makeEvent(
  overrides: Partial<MissionEvent> & { id: string; missionId: string },
): MissionEvent {
  return {
    actorType: "system",
    actorId: "user-1",
    action: "created",
    fromColumnId: null,
    toColumnId: null,
    fromStatus: null,
    toStatus: null,
    metadata: {},
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

vi.mock("lucide-react", () => ({
  AlertTriangle: () => <span data-testid="icon-alert-triangle">⚠</span>,
  Info: () => <span data-testid="icon-info">ℹ</span>,
  Settings: () => <span data-testid="icon-settings">⚙</span>,
  ArrowRight: () => <span data-testid="icon-arrow-right">→</span>,
}));

describe("RiskAnalysisSidebar", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders risk analysis header", () => {
    const feature = makeMission({ id: "feat-1" });
    render(
      <RiskAnalysisSidebar
        feature={feature}
        tasks={[]}
        events={[]}
        dependencies={{ dependsOn: [], blocks: [] }}
      />,
    );
    expect(screen.getByText("Risk Analysis")).toBeTruthy();
  });

  it("renders projected impact section", () => {
    const feature = makeMission({ id: "feat-1" });
    render(
      <RiskAnalysisSidebar
        feature={feature}
        tasks={[]}
        events={[]}
        dependencies={{ dependsOn: [], blocks: [] }}
      />,
    );
    expect(screen.getByText("Projected Impact")).toBeTruthy();
  });

  it("renders critical blockers section with no blockers message", () => {
    const feature = makeMission({ id: "feat-1" });
    render(
      <RiskAnalysisSidebar
        feature={feature}
        tasks={[]}
        events={[]}
        dependencies={{ dependsOn: [], blocks: [] }}
      />,
    );
    expect(screen.getByText("Critical Blockers")).toBeTruthy();
    expect(screen.getByText("No critical blockers")).toBeTruthy();
  });

  it("renders failed tasks as blockers", () => {
    const feature = makeMission({ id: "feat-1" });
    const tasks = [
      makeTask({
        id: "t1",
        missionId: "feat-1",
        status: "failed",
        title: "Failed Task",
        rejectionReason: "Tests failing",
      }),
    ];
    render(
      <RiskAnalysisSidebar
        feature={feature}
        tasks={tasks}
        events={[]}
        dependencies={{ dependsOn: [], blocks: [] }}
      />,
    );
    expect(screen.getByText("Failed Task")).toBeTruthy();
    expect(screen.getByText("Tests failing")).toBeTruthy();
  });

  it("renders history timeline", () => {
    const feature = makeMission({ id: "feat-1" });
    const events = [
      makeEvent({ id: "evt-1", missionId: "feat-1", action: "created", actorType: "system" }),
    ];
    render(
      <RiskAnalysisSidebar
        feature={feature}
        tasks={[]}
        events={events}
        dependencies={{ dependsOn: [], blocks: [] }}
      />,
    );
    expect(screen.getByText("History")).toBeTruthy();
    expect(screen.getByText("System")).toBeTruthy();
  });

  it("renders configure gates button", () => {
    const feature = makeMission({ id: "feat-1" });
    render(
      <RiskAnalysisSidebar
        feature={feature}
        tasks={[]}
        events={[]}
        dependencies={{ dependsOn: [], blocks: [] }}
      />,
    );
    expect(screen.getByText("Configure Gates")).toBeTruthy();
  });

  it("renders projected impact level based on task statuses", () => {
    const feature = makeMission({ id: "feat-1" });
    const tasks = [makeTask({ id: "t1", missionId: "feat-1", status: "failed" })];
    render(
      <RiskAnalysisSidebar
        feature={feature}
        tasks={tasks}
        events={[]}
        dependencies={{ dependsOn: [], blocks: [] }}
      />,
    );
    expect(screen.getByText("High")).toBeTruthy();
  });

  it("shows no history message when events are empty", () => {
    const feature = makeMission({ id: "feat-1" });
    render(
      <RiskAnalysisSidebar
        feature={feature}
        tasks={[]}
        events={[]}
        dependencies={{ dependsOn: [], blocks: [] }}
      />,
    );
    expect(screen.getByText("No history yet")).toBeTruthy();
  });

  it("shows blocked dependencies count", () => {
    const feature = makeMission({ id: "feat-1" });
    render(
      <RiskAnalysisSidebar
        feature={feature}
        tasks={[]}
        events={[]}
        dependencies={{ dependsOn: ["feat-2"], blocks: [] }}
      />,
    );
    expect(screen.getByText("1 blocked dependency")).toBeTruthy();
  });
});
