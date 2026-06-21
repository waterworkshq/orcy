import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { GateForm } from "./GateForm.js";
import type { WorkflowTemplateGate, TaskTemplateEntry } from "../../types/index.js";

afterEach(() => {
  cleanup();
});

const sampleTasks: TaskTemplateEntry[] = [
  { key: "build", title: "Build" },
  { key: "test", title: "Test" },
  { key: "deploy", title: "Deploy" },
];

const baseGate: WorkflowTemplateGate = {
  upstreamTaskKey: "build",
  downstreamTaskKey: "test",
  gateType: "on_complete",
};

describe("GateForm", () => {
  it("renders gate with upstream, type, and downstream dropdowns", () => {
    render(
      <GateForm
        gate={baseGate}
        tasks={sampleTasks}
        index={0}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByTestId("gate-form-0")).toBeTruthy();
    expect(screen.getByTestId("gate-upstream-0")).toBeTruthy();
    expect(screen.getByTestId("gate-type-0")).toBeTruthy();
    expect(screen.getByTestId("gate-downstream-0")).toBeTruthy();
  });

  it("shows all 3 task options in upstream dropdown", () => {
    render(
      <GateForm
        gate={baseGate}
        tasks={sampleTasks}
        index={0}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    const select = screen.getByTestId("gate-upstream-0") as HTMLSelectElement;
    expect(select.options).toHaveLength(3);
  });

  it("calls onChange when gate type changes", () => {
    const onChange = vi.fn();
    render(
      <GateForm
        gate={baseGate}
        tasks={sampleTasks}
        index={0}
        onChange={onChange}
        onRemove={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByTestId("gate-type-0"), { target: { value: "on_fail" } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ gateType: "on_fail", matchConfig: undefined }),
    );
  });

  it("shows signal match config when gate type is on_signal", () => {
    const signalGate: WorkflowTemplateGate = {
      upstreamTaskKey: "build",
      downstreamTaskKey: "test",
      gateType: "on_signal",
      matchConfig: { signalType: "blocker", matchScope: "task" },
    };

    render(
      <GateForm
        gate={signalGate}
        tasks={sampleTasks}
        index={0}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByTestId("gate-match-config-0")).toBeTruthy();
    expect(screen.getByTestId("gate-signal-type-0")).toBeTruthy();
    expect(screen.getByTestId("gate-match-scope-0")).toBeTruthy();
  });

  it("hides match config for on_complete gates", () => {
    render(
      <GateForm
        gate={baseGate}
        tasks={sampleTasks}
        index={0}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("gate-match-config-0")).toBeNull();
  });

  it("shows experience category dropdown when signalType is experience", () => {
    const signalGate: WorkflowTemplateGate = {
      upstreamTaskKey: "build",
      downstreamTaskKey: "test",
      gateType: "on_signal",
      matchConfig: { signalType: "experience", matchScope: "task" },
    };

    render(
      <GateForm
        gate={signalGate}
        tasks={sampleTasks}
        index={0}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByTestId("gate-experience-0")).toBeTruthy();
  });

  it("hides experience dropdown when signalType is not experience", () => {
    const signalGate: WorkflowTemplateGate = {
      upstreamTaskKey: "build",
      downstreamTaskKey: "test",
      gateType: "on_signal",
      matchConfig: { signalType: "blocker", matchScope: "task" },
    };

    render(
      <GateForm
        gate={signalGate}
        tasks={sampleTasks}
        index={0}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("gate-experience-0")).toBeNull();
  });

  it("toggles condition editor on Add Condition click", () => {
    render(
      <GateForm
        gate={baseGate}
        tasks={sampleTasks}
        index={0}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("gate-condition-editor-0")).toBeNull();

    fireEvent.click(screen.getByTestId("gate-condition-toggle-0"));
    expect(screen.getByTestId("gate-condition-editor-0")).toBeTruthy();
    expect(screen.getByTestId("gate-condition-text-0")).toBeTruthy();
  });

  it("parses valid JSON condition", () => {
    const onChange = vi.fn();
    render(
      <GateForm
        gate={baseGate}
        tasks={sampleTasks}
        index={0}
        onChange={onChange}
        onRemove={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("gate-condition-toggle-0"));
    fireEvent.change(screen.getByTestId("gate-condition-text-0"), {
      target: { value: '{"type":"always"}' },
    });

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ condition: { type: "always" } }),
    );
  });

  it("shows error for invalid JSON condition", () => {
    render(
      <GateForm
        gate={baseGate}
        tasks={sampleTasks}
        index={0}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("gate-condition-toggle-0"));
    fireEvent.change(screen.getByTestId("gate-condition-text-0"), {
      target: { value: "{invalid json" },
    });

    expect(screen.getByText("Invalid JSON")).toBeTruthy();
  });

  it("calls onRemove when Remove button clicked", () => {
    const onRemove = vi.fn();
    render(
      <GateForm
        gate={baseGate}
        tasks={sampleTasks}
        index={0}
        onChange={vi.fn()}
        onRemove={onRemove}
      />,
    );

    fireEvent.click(screen.getByTestId("gate-remove-0"));
    expect(onRemove).toHaveBeenCalled();
  });
});
