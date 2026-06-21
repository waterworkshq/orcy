import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { TemplateManagerDialog } from "../ui/TemplateManagerDialog.js";

const mockListTemplates = vi.fn();
const mockCreateTemplate = vi.fn();
const mockUpdateTemplate = vi.fn();
const mockDeleteTemplate = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

vi.mock("../../api/index.js", () => ({
  api: {
    templates: {
      list: (...args: unknown[]) => mockListTemplates(...args),
      create: (...args: unknown[]) => mockCreateTemplate(...args),
      update: (...args: unknown[]) => mockUpdateTemplate(...args),
      delete: (...args: unknown[]) => mockDeleteTemplate(...args),
    },
  },
}));

vi.mock("../../lib/toast.js", () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
  },
}));

function createTestWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

describe("TemplateManagerDialog — workflow integration", () => {
  const defaultProps = {
    habitatId: "board-1",
    open: true,
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockListTemplates.mockResolvedValue({ templates: [] });
    mockCreateTemplate.mockResolvedValue({ template: { id: "t3" } });
    mockUpdateTemplate.mockResolvedValue({ template: { id: "t1" } });
  });

  afterEach(() => {
    cleanup();
  });

  it("shows task templates section in edit form", async () => {
    render(<TemplateManagerDialog {...defaultProps} />, {
      wrapper: createTestWrapper(),
    });

    await waitFor(() => {
      expect(screen.getByText("+ New Mission Template")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("+ New Mission Template"));

    await waitFor(() => {
      expect(screen.getByTestId("task-templates-section")).toBeTruthy();
    });
  });

  it("adds a task template on Add Task click", async () => {
    render(<TemplateManagerDialog {...defaultProps} />, {
      wrapper: createTestWrapper(),
    });

    await waitFor(() => {
      expect(screen.getByText("+ New Mission Template")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("+ New Mission Template"));

    await waitFor(() => {
      expect(screen.getByTestId("add-task-template")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("add-task-template"));

    expect(screen.getByTestId("task-template-row-0")).toBeTruthy();
    expect(screen.getByTestId("task-title-0")).toBeTruthy();
  });

  it("shows workflow section in edit form", async () => {
    render(<TemplateManagerDialog {...defaultProps} />, {
      wrapper: createTestWrapper(),
    });

    await waitFor(() => {
      expect(screen.getByText("+ New Mission Template")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("+ New Mission Template"));

    await waitFor(() => {
      expect(screen.getByTestId("workflow-section")).toBeTruthy();
    });
  });

  it("disables Add Workflow button when fewer than 2 tasks", async () => {
    render(<TemplateManagerDialog {...defaultProps} />, {
      wrapper: createTestWrapper(),
    });

    await waitFor(() => {
      expect(screen.getByText("+ New Mission Template")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("+ New Mission Template"));

    await waitFor(() => {
      expect(screen.getByTestId("add-workflow")).toBeTruthy();
    });

    const btn = screen.getByTestId("add-workflow") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("enables Add Workflow after adding 2+ tasks", async () => {
    render(<TemplateManagerDialog {...defaultProps} />, {
      wrapper: createTestWrapper(),
    });

    await waitFor(() => {
      expect(screen.getByText("+ New Mission Template")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("+ New Mission Template"));

    await waitFor(() => {
      expect(screen.getByTestId("add-task-template")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("add-task-template"));
    fireEvent.click(screen.getByTestId("add-task-template"));

    const workflowBtn = screen.getByTestId("add-workflow") as HTMLButtonElement;
    expect(workflowBtn.disabled).toBe(false);
  });

  it("shows workflow editor after clicking Add Workflow", async () => {
    render(<TemplateManagerDialog {...defaultProps} />, {
      wrapper: createTestWrapper(),
    });

    await waitFor(() => {
      expect(screen.getByText("+ New Mission Template")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("+ New Mission Template"));

    await waitFor(() => {
      expect(screen.getByTestId("add-task-template")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("add-task-template"));
    fireEvent.click(screen.getByTestId("add-task-template"));
    fireEvent.click(screen.getByTestId("add-workflow"));

    expect(screen.getByTestId("workflow-template-editor")).toBeTruthy();
  });

  it("loads existing workflow template when editing", async () => {
    const templateWithWorkflow = {
      id: "t1",
      name: "BTRD",
      titlePattern: "Release: ",
      descriptionPattern: "",
      priority: "high" as const,
      labels: ["release"],
      habitatId: null,
      usageCount: 0,
      isDefault: true,
      tasksTemplate: [
        { key: "build", title: "Build" },
        { key: "test", title: "Test" },
      ],
      workflowTemplate: {
        gates: [{ upstreamTaskKey: "build", downstreamTaskKey: "test", gateType: "on_approve" }],
      },
    };
    mockListTemplates.mockResolvedValue({ templates: [templateWithWorkflow] });

    render(<TemplateManagerDialog {...defaultProps} />, {
      wrapper: createTestWrapper(),
    });

    await waitFor(() => {
      expect(screen.getByText("BTRD")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Edit"));

    await waitFor(() => {
      expect(screen.getByTestId("workflow-template-editor")).toBeTruthy();
    });

    expect(screen.getByText(/Gates \(1\)/)).toBeTruthy();
  });

  it("sends tasksTemplate and workflowTemplate in create data", async () => {
    render(<TemplateManagerDialog {...defaultProps} />, {
      wrapper: createTestWrapper(),
    });

    await waitFor(() => {
      expect(screen.getByText("+ New Mission Template")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("+ New Mission Template"));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Bug Fix")).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText("Bug Fix"), {
      target: { value: "Workflow Template" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Fix:/), {
      target: { value: "New Title" },
    });

    fireEvent.click(screen.getByTestId("add-task-template"));
    fireEvent.change(screen.getByTestId("task-title-0"), {
      target: { value: "Task A" },
    });

    fireEvent.click(screen.getByText("Create"));

    await waitFor(() => {
      expect(mockCreateTemplate).toHaveBeenCalledWith(
        "board-1",
        expect.objectContaining({
          name: "Workflow Template",
          titlePattern: "New Title",
          tasksTemplate: expect.arrayContaining([expect.objectContaining({ title: "Task A" })]),
          workflowTemplate: null,
        }),
      );
    });
  });

  it("removes workflow on Remove Workflow click", async () => {
    const templateWithWorkflow = {
      id: "t1",
      name: "BTRD",
      titlePattern: "Release: ",
      descriptionPattern: "",
      priority: "high" as const,
      labels: [],
      habitatId: null,
      usageCount: 0,
      isDefault: true,
      tasksTemplate: [
        { key: "a", title: "A" },
        { key: "b", title: "B" },
      ],
      workflowTemplate: {
        gates: [{ upstreamTaskKey: "a", downstreamTaskKey: "b", gateType: "on_complete" }],
      },
    };
    mockListTemplates.mockResolvedValue({ templates: [templateWithWorkflow] });

    render(<TemplateManagerDialog {...defaultProps} />, {
      wrapper: createTestWrapper(),
    });

    await waitFor(() => {
      expect(screen.getByText("BTRD")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Edit"));

    await waitFor(() => {
      expect(screen.getByTestId("remove-workflow")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("remove-workflow"));

    expect(screen.getByTestId("add-workflow")).toBeTruthy();
    expect(screen.queryByTestId("workflow-template-editor")).toBeNull();
  });
});
