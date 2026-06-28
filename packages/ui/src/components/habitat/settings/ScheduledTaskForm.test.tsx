import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ScheduledTaskForm } from "./ScheduledTaskForm.js";
import type { ScheduledTask, MissionTemplate } from "../../../types/index.js";

const mockTemplates: MissionTemplate[] = [
  {
    id: "tmpl-1",
    habitatId: "board-1",
    name: "Sprint Template",
    titlePattern: "Sprint {{date}}",
    descriptionPattern: "Weekly sprint tasks",
    priority: "high",
    labels: ["sprint"],
    requiredDomain: null,
    requiredCapabilities: [],
    isDefault: false,
    usageCount: 3,
    createdBy: "user-1",
    createdAt: "2024-01-01T00:00:00Z",
    tasksTemplate: [],
  },
];

const mockExisting: ScheduledTask = {
  id: "st-1",
  habitatId: "board-1",
  templateId: null,
  name: "Weekly Sprint",
  description: "Create weekly sprint",
  scheduleType: "cron",
  cronExpression: "0 9 * * 1",
  intervalMinutes: null,
  scheduledAt: null,
  timezone: "UTC",
  missionTitle: "Sprint",
  missionDescription: "Weekly sprint",
  missionPriority: "medium",
  missionLabels: ["sprint"],
  missionDomain: null,
  handlerKey: null,
  tasksTemplate: [],
  enabled: true,
  lastRunAt: null,
  nextRunAt: "2025-01-06T09:00:00Z",
  runCount: 0,
  lastCreatedMissionId: null,
  createdBy: "user-1",
  createdAt: "2024-12-01T00:00:00Z",
  updatedAt: "2024-12-01T00:00:00Z",
};

describe("ScheduledTaskForm", () => {
  const mockOnSave = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders new scheduled task form", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    expect(screen.getByText("New Scheduled Task")).toBeTruthy();
    expect(screen.getByTestId("st-name")).toBeTruthy();
    expect(screen.getByTestId("st-submit")).toBeTruthy();
  });

  it("renders edit form when existing task provided", () => {
    render(
      <ScheduledTaskForm
        existing={mockExisting}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    expect(screen.getByText("Edit Scheduled Task")).toBeTruthy();
    const nameInput = screen.getByTestId("st-name") as HTMLInputElement;
    expect(nameInput.value).toBe("Weekly Sprint");
  });

  it("populates fields from existing scheduled task", () => {
    render(
      <ScheduledTaskForm
        existing={mockExisting}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    const cronInput = screen.getByTestId("st-cron-expression") as HTMLInputElement;
    expect(cronInput.value).toBe("0 9 * * 1");
    const titleInput = screen.getByTestId("st-feature-title") as HTMLInputElement;
    expect(titleInput.value).toBe("Sprint");
  });

  it("shows cron expression input when schedule type is cron", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    expect(screen.getByTestId("st-cron-expression")).toBeTruthy();
    expect(screen.getByTestId("cron-patterns")).toBeTruthy();
  });

  it("shows interval input when schedule type is interval", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    fireEvent.change(screen.getByTestId("st-schedule-type"), { target: { value: "interval" } });
    expect(screen.getByTestId("st-interval-minutes")).toBeTruthy();
    expect(screen.queryByTestId("st-cron-expression")).toBeNull();
  });

  it("shows datetime input when schedule type is once", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    fireEvent.change(screen.getByTestId("st-schedule-type"), { target: { value: "once" } });
    expect(screen.getByTestId("st-scheduled-at")).toBeTruthy();
    expect(screen.queryByTestId("st-cron-expression")).toBeNull();
  });

  it("template selector shows available templates", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={mockTemplates}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    const select = screen.getByTestId("st-template") as HTMLSelectElement;
    expect(select.innerHTML).toContain("Sprint Template");
  });

  it("template selection populates feature fields", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={mockTemplates}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    fireEvent.change(screen.getByTestId("st-template"), { target: { value: "tmpl-1" } });
    const titleInput = screen.getByTestId("st-feature-title") as HTMLInputElement;
    expect(titleInput.value).toBe("Sprint {{date}}");
  });

  it("validates required fields before submit", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    fireEvent.click(screen.getByTestId("st-submit"));
    expect(screen.getByText("Name is required")).toBeTruthy();
    expect(screen.getByText("Feature title is required")).toBeTruthy();
    expect(screen.getByText("Cron expression is required")).toBeTruthy();
    expect(mockOnSave).not.toHaveBeenCalled();
  });

  it("creates schedule with cron expression on valid submit", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    fireEvent.change(screen.getByTestId("st-name"), { target: { value: "Daily Standup" } });
    fireEvent.change(screen.getByTestId("st-cron-expression"), { target: { value: "0 9 * * *" } });
    fireEvent.change(screen.getByTestId("st-feature-title"), { target: { value: "Standup" } });
    fireEvent.click(screen.getByTestId("st-submit"));
    expect(mockOnSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Daily Standup",
        scheduleType: "cron",
        cronExpression: "0 9 * * *",
        missionTitle: "Standup",
      }),
    );
  });

  it("creates schedule with interval on valid submit", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    fireEvent.change(screen.getByTestId("st-name"), { target: { value: "Check Health" } });
    fireEvent.change(screen.getByTestId("st-schedule-type"), { target: { value: "interval" } });
    fireEvent.change(screen.getByTestId("st-interval-minutes"), { target: { value: "30" } });
    fireEvent.change(screen.getByTestId("st-feature-title"), { target: { value: "Health Check" } });
    fireEvent.click(screen.getByTestId("st-submit"));
    expect(mockOnSave).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleType: "interval",
        intervalMinutes: 30,
        cronExpression: null,
      }),
    );
  });

  it("cron pattern click fills cron expression", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    const patterns = screen.getByTestId("cron-patterns");
    const firstPattern = patterns.querySelector("button");
    if (firstPattern) {
      fireEvent.click(firstPattern);
      const cronInput = screen.getByTestId("st-cron-expression") as HTMLInputElement;
      expect(cronInput.value).toBe("0 9 * * 1");
    }
  });

  it("calls onCancel when cancel button clicked", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    const cancelButtons = screen.getAllByText("Cancel");
    fireEvent.click(cancelButtons[cancelButtons.length - 1]);
    expect(mockOnCancel).toHaveBeenCalled();
  });

  it("disables submit when saving", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={[]}
        saving={true}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    const submitBtn = screen.getByTestId("st-submit");
    expect(submitBtn).toHaveProperty("disabled", true);
  });

  it("rejects syntactically invalid cron expression", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    fireEvent.change(screen.getByTestId("st-name"), { target: { value: "Bad Cron" } });
    fireEvent.change(screen.getByTestId("st-cron-expression"), {
      target: { value: "every monday" },
    });
    fireEvent.change(screen.getByTestId("st-feature-title"), { target: { value: "Test" } });
    fireEvent.click(screen.getByTestId("st-submit"));
    expect(screen.getByText("Invalid cron expression")).toBeTruthy();
    expect(mockOnSave).not.toHaveBeenCalled();
  });

  it("rejects cron expression with out-of-range values", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    fireEvent.change(screen.getByTestId("st-name"), { target: { value: "Bad Range" } });
    fireEvent.change(screen.getByTestId("st-cron-expression"), {
      target: { value: "99 99 99 99 99" },
    });
    fireEvent.change(screen.getByTestId("st-feature-title"), { target: { value: "Test" } });
    fireEvent.click(screen.getByTestId("st-submit"));
    expect(screen.getByText("Invalid cron expression")).toBeTruthy();
    expect(mockOnSave).not.toHaveBeenCalled();
  });

  it("rejects non-cron text as cron expression", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    fireEvent.change(screen.getByTestId("st-name"), { target: { value: "Bad Text" } });
    fireEvent.change(screen.getByTestId("st-cron-expression"), { target: { value: "not a cron" } });
    fireEvent.change(screen.getByTestId("st-feature-title"), { target: { value: "Test" } });
    fireEvent.click(screen.getByTestId("st-submit"));
    expect(screen.getByText("Invalid cron expression")).toBeTruthy();
    expect(mockOnSave).not.toHaveBeenCalled();
  });

  it("timezone select defaults to UTC", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    const tzSelect = screen.getByTestId("st-timezone") as HTMLSelectElement;
    expect(tzSelect.value).toBe("UTC");
  });

  it("timezone select contains IANA timezone options", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    const tzSelect = screen.getByTestId("st-timezone") as HTMLSelectElement;
    expect(tzSelect.options.length).toBeGreaterThan(100);
    const optionValues = Array.from(tzSelect.options).map((o) => o.value);
    expect(optionValues).toContain("America/New_York");
    expect(optionValues).toContain("Europe/London");
    expect(optionValues).toContain("Asia/Tokyo");
  });

  it("preserves tasksTemplate during edit", () => {
    const existingWithTasks = {
      ...mockExisting,
      tasksTemplate: [{ title: "Subtask" }],
    };
    render(
      <ScheduledTaskForm
        existing={existingWithTasks}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    fireEvent.click(screen.getByTestId("st-submit"));
    expect(mockOnSave).toHaveBeenCalledWith(
      expect.objectContaining({
        tasksTemplate: [{ title: "Subtask" }],
      }),
    );
  });

  it("sends empty tasksTemplate for new schedules", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    fireEvent.change(screen.getByTestId("st-name"), { target: { value: "New Task" } });
    fireEvent.change(screen.getByTestId("st-cron-expression"), { target: { value: "0 9 * * *" } });
    fireEvent.change(screen.getByTestId("st-feature-title"), { target: { value: "Test" } });
    fireEvent.click(screen.getByTestId("st-submit"));
    expect(mockOnSave).toHaveBeenCalledWith(
      expect.objectContaining({
        tasksTemplate: [],
      }),
    );
  });

  it("accepts valid cron expressions", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    fireEvent.change(screen.getByTestId("st-name"), { target: { value: "Good Cron" } });
    fireEvent.change(screen.getByTestId("st-cron-expression"), {
      target: { value: "*/15 * * * *" },
    });
    fireEvent.change(screen.getByTestId("st-feature-title"), { target: { value: "Test" } });
    fireEvent.click(screen.getByTestId("st-submit"));
    expect(mockOnSave).toHaveBeenCalledWith(
      expect.objectContaining({
        cronExpression: "*/15 * * * *",
      }),
    );
  });

  it("renders token hints below Feature Title input", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    const titleHints = screen.getByTestId("title-token-hints");
    expect(titleHints).toBeTruthy();
    expect(titleHints.textContent).toContain("{{date}}");
    expect(titleHints.textContent).toContain("{{counter}}");
    expect(titleHints.textContent).toContain("YYYY-MM-DD");
  });

  it("renders token hints below Feature Description input", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    const descHints = screen.getByTestId("desc-token-hints");
    expect(descHints).toBeTruthy();
    expect(descHints.textContent).toContain("{{date}}");
    expect(descHints.textContent).toContain("{{counter}}");
  });

  it("token hints show example syntax", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    const titleHints = screen.getByTestId("title-token-hints");
    expect(titleHints.textContent).toContain("Sprint {{counter}} — {{date}}");
    expect(titleHints.textContent).toContain("Sprint 7 — 2026-05-19");
  });

  it("form submits correctly with token hints present", () => {
    render(
      <ScheduledTaskForm
        existing={null}
        templates={[]}
        saving={false}
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />,
    );
    expect(screen.getByTestId("title-token-hints")).toBeTruthy();
    expect(screen.getByTestId("desc-token-hints")).toBeTruthy();
    fireEvent.change(screen.getByTestId("st-name"), { target: { value: "Sprint Task" } });
    fireEvent.change(screen.getByTestId("st-cron-expression"), { target: { value: "0 9 * * 1" } });
    fireEvent.change(screen.getByTestId("st-feature-title"), {
      target: { value: "Sprint {{counter}} — {{date}}" },
    });
    fireEvent.click(screen.getByTestId("st-submit"));
    expect(mockOnSave).toHaveBeenCalledWith(
      expect.objectContaining({
        missionTitle: "Sprint {{counter}} — {{date}}",
      }),
    );
  });
});
