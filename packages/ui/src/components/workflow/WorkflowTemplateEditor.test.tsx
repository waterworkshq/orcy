import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { WorkflowTemplateEditor } from "./WorkflowTemplateEditor.js";
import type { TaskTemplateEntry, WorkflowTemplateDefinition } from "../../types/index.js";

afterEach(() => {
  cleanup();
});

vi.mock("../../lib/toast.js", () => ({
  notify: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const sampleTasks: TaskTemplateEntry[] = [
  { key: "build", title: "Build" },
  { key: "test", title: "Test" },
  { key: "deploy", title: "Deploy" },
];

const sampleWorkflow: WorkflowTemplateDefinition = {
  gates: [
    { upstreamTaskKey: "build", downstreamTaskKey: "test", gateType: "on_complete" },
    { upstreamTaskKey: "test", downstreamTaskKey: "deploy", gateType: "on_approve" },
  ],
};

describe("WorkflowTemplateEditor", () => {
  it("renders gates list with correct count", () => {
    render(
      <WorkflowTemplateEditor tasks={sampleTasks} value={sampleWorkflow} onChange={vi.fn()} />,
    );

    expect(screen.getByText(/Gates \(2\)/)).toBeTruthy();
    expect(screen.getByTestId("gate-form-0")).toBeTruthy();
    expect(screen.getByTestId("gate-form-1")).toBeTruthy();
  });

  it("renders SVG preview with nodes", () => {
    render(
      <WorkflowTemplateEditor tasks={sampleTasks} value={sampleWorkflow} onChange={vi.fn()} />,
    );

    expect(screen.getByTestId("workflow-preview-svg")).toBeTruthy();
  });

  it("renders dry-run summary with task and gate counts", () => {
    render(
      <WorkflowTemplateEditor tasks={sampleTasks} value={sampleWorkflow} onChange={vi.fn()} />,
    );

    const summary = screen.getByTestId("dry-run-summary");
    expect(summary.textContent).toContain("3 tasks");
    expect(summary.textContent).toContain("2 gates");
  });

  it("calls onChange when Add Gate is clicked", () => {
    const onChange = vi.fn();
    render(
      <WorkflowTemplateEditor tasks={sampleTasks} value={{ gates: [] }} onChange={onChange} />,
    );

    fireEvent.click(screen.getByTestId("add-gate"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        gates: expect.arrayContaining([expect.objectContaining({ gateType: "on_complete" })]),
      }),
    );
  });

  it("disables Add Gate when fewer than 2 tasks", () => {
    render(
      <WorkflowTemplateEditor
        tasks={[{ key: "only", title: "Only Task" }]}
        value={{ gates: [] }}
        onChange={vi.fn()}
      />,
    );

    const addGateBtn = screen.getByTestId("add-gate") as HTMLButtonElement;
    expect(addGateBtn.disabled).toBe(true);
  });

  it("shows validation errors for dangling references", () => {
    const badWorkflow: WorkflowTemplateDefinition = {
      gates: [
        { upstreamTaskKey: "nonexistent", downstreamTaskKey: "test", gateType: "on_complete" },
      ],
    };

    render(<WorkflowTemplateEditor tasks={sampleTasks} value={badWorkflow} onChange={vi.fn()} />);

    expect(screen.getByTestId("validation-messages")).toBeTruthy();
    expect(screen.getByText(/nonexistent/)).toBeTruthy();
  });

  it("shows warning for multi-gate task without join spec", () => {
    const multiGateWorkflow: WorkflowTemplateDefinition = {
      gates: [
        { upstreamTaskKey: "build", downstreamTaskKey: "deploy", gateType: "on_complete" },
        { upstreamTaskKey: "test", downstreamTaskKey: "deploy", gateType: "on_approve" },
      ],
    };

    render(
      <WorkflowTemplateEditor tasks={sampleTasks} value={multiGateWorkflow} onChange={vi.fn()} />,
    );

    expect(screen.getByTestId("validation-messages")).toBeTruthy();
  });

  it("opens join specs section on click", () => {
    render(
      <WorkflowTemplateEditor tasks={sampleTasks} value={sampleWorkflow} onChange={vi.fn()} />,
    );

    fireEvent.click(screen.getByTestId("section-join-specs"));
    expect(screen.getByText(/Controls how multiple upstream gates/)).toBeTruthy();
  });

  it("opens failure handler section on click", () => {
    render(
      <WorkflowTemplateEditor tasks={sampleTasks} value={sampleWorkflow} onChange={vi.fn()} />,
    );

    fireEvent.click(screen.getByTestId("section-failure-handler"));
    expect(screen.getByTestId("failure-handler-form")).toBeTruthy();
  });

  it("opens variables section on click", () => {
    render(
      <WorkflowTemplateEditor
        tasks={sampleTasks}
        value={{ ...sampleWorkflow, variables: [{ key: "feat", description: "Feature" }] }}
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("section-variables"));
    expect(screen.getByTestId("variables-form")).toBeTruthy();
    expect(screen.getByTestId("variable-key-0")).toBeTruthy();
  });

  it("opens JSON section and shows export/import buttons", () => {
    render(
      <WorkflowTemplateEditor tasks={sampleTasks} value={sampleWorkflow} onChange={vi.fn()} />,
    );

    fireEvent.click(screen.getByTestId("section-json"));
    expect(screen.getByTestId("json-textarea")).toBeTruthy();
    expect(screen.getByTestId("json-export")).toBeTruthy();
    expect(screen.getByTestId("json-import")).toBeTruthy();
  });

  it("shows empty preview when no tasks", () => {
    render(<WorkflowTemplateEditor tasks={[]} value={{ gates: [] }} onChange={vi.fn()} />);

    expect(screen.getByTestId("workflow-preview-empty")).toBeTruthy();
  });

  it("includes failure handler in dry-run summary when present", () => {
    const workflowWithHandler: WorkflowTemplateDefinition = {
      gates: [],
      failureHandler: {
        recoveryTaskTemplate: { title: "Recovery" },
      },
    };

    render(
      <WorkflowTemplateEditor tasks={sampleTasks} value={workflowWithHandler} onChange={vi.fn()} />,
    );

    const summary = screen.getByTestId("dry-run-summary");
    expect(summary.textContent).toContain("1 failure handler");
  });
});
