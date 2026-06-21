import React, { useState } from "react";
import { Button } from "../ui/Button.js";
import type {
  WorkflowTemplateDefinition,
  WorkflowTemplateGate,
  TaskTemplateEntry,
  JoinMode,
} from "../../types/index.js";
import { GateForm } from "./GateForm.js";
import { JoinSpecForm } from "./JoinSpecForm.js";
import { FailureHandlerForm } from "./FailureHandlerForm.js";
import { VariablesForm } from "./VariablesForm.js";
import { WorkflowPreviewSvg } from "./WorkflowPreviewSvg.js";
import { JsonImportExport } from "./JsonImportExport.js";
import {
  validateWorkflow,
  resolveTaskKey,
  countUpstreamGates,
  type ValidationMessage,
} from "./workflowEditorUtils.js";

/** Props for the {@link WorkflowTemplateEditor} component. */
interface WorkflowTemplateEditorProps {
  tasks: TaskTemplateEntry[];
  value: WorkflowTemplateDefinition;
  onChange: (next: WorkflowTemplateDefinition) => void;
}

function SectionToggle({
  title,
  defaultOpen = false,
  children,
  testId,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  testId: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        data-testid={testId}
        className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium hover:bg-accent/30"
      >
        <span>{title}</span>
        <span className="text-xs text-muted-foreground">{open ? "▼" : "▶"}</span>
      </button>
      {open && <div className="border-t border-border p-3">{children}</div>}
    </div>
  );
}

/** Orchestrates the full workflow template editor: gates list, join specs, failure handler, variables, JSON import/export, validation, and SVG preview. */
export function WorkflowTemplateEditor({ tasks, value, onChange }: WorkflowTemplateEditorProps) {
  const validation: ValidationMessage[] = validateWorkflow(tasks, value);
  const errors = validation.filter((m) => m.severity === "error");
  const warnings = validation.filter((m) => m.severity === "warning");

  function update(patch: Partial<WorkflowTemplateDefinition>) {
    onChange({ ...value, ...patch });
  }

  function addGate() {
    const taskKeys = tasks.map((t, i) => resolveTaskKey(t, i));
    const firstKey = taskKeys[0] ?? "";
    const secondKey = taskKeys[1] ?? taskKeys[0] ?? "";
    const newGate: WorkflowTemplateGate = {
      upstreamTaskKey: firstKey,
      downstreamTaskKey: secondKey,
      gateType: "on_complete",
    };
    update({ gates: [...value.gates, newGate] });
  }

  function updateGate(index: number, next: WorkflowTemplateGate) {
    const gates = [...value.gates];
    gates[index] = next;
    update({ gates });
  }

  function removeGate(index: number) {
    update({ gates: value.gates.filter((_, i) => i !== index) });
  }

  function updateJoinSpec(taskKey: string, spec: { mode: JoinMode; n?: number } | undefined) {
    const joinSpecs = { ...value.joinSpecs };
    if (spec === undefined || spec.mode === "all_of") {
      delete joinSpecs[taskKey];
    } else {
      joinSpecs[taskKey] = spec;
    }
    update({ joinSpecs: Object.keys(joinSpecs).length > 0 ? joinSpecs : undefined });
  }

  function updateFailureHandler(next: typeof value.failureHandler) {
    update({ failureHandler: next });
  }

  function updateVariables(next: typeof value.variables) {
    update({ variables: next && next.length > 0 ? next : undefined });
  }

  function handleJsonImport(next: WorkflowTemplateDefinition) {
    onChange(next);
  }

  const taskKeysWithOptions = tasks.map((t, i) => ({
    key: resolveTaskKey(t, i),
    title: t.title || "(untitled)",
    upstreamCount: countUpstreamGates(resolveTaskKey(t, i), value.gates),
  }));

  return (
    <div data-testid="workflow-template-editor" className="space-y-3">
      {/* Gates section */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-semibold">Gates ({value.gates.length})</h4>
          <Button
            variant="outline"
            size="sm"
            onClick={addGate}
            disabled={tasks.length < 2}
            data-testid="add-gate"
          >
            + Add Gate
          </Button>
        </div>
        {tasks.length < 2 && (
          <p className="text-xs text-muted-foreground">
            At least 2 tasks are required to add gates.
          </p>
        )}
        <div className="space-y-2">
          {value.gates.map((gate, index) => (
            <GateForm
              key={index}
              gate={gate}
              tasks={tasks}
              index={index}
              onChange={(next) => updateGate(index, next)}
              onRemove={() => removeGate(index)}
            />
          ))}
        </div>
      </div>

      {/* Validation messages */}
      {(errors.length > 0 || warnings.length > 0) && (
        <div data-testid="validation-messages" className="space-y-1">
          {errors.map((msg, i) => (
            <p
              key={`err-${i}`}
              className="text-xs text-destructive"
              data-testid={`validation-error-${i}`}
            >
              ✕ {msg.text}
            </p>
          ))}
          {warnings.map((msg, i) => (
            <p
              key={`warn-${i}`}
              className="text-xs text-yellow-600"
              data-testid={`validation-warning-${i}`}
            >
              ⚠ {msg.text}
            </p>
          ))}
        </div>
      )}

      {/* Join specs (collapsed) */}
      <SectionToggle
        title={`Join Specs (${Object.keys(value.joinSpecs ?? {}).length})`}
        testId="section-join-specs"
      >
        <p className="mb-2 text-xs text-muted-foreground">
          Controls how multiple upstream gates combine for a downstream task. Default is all_of (all
          gates must be satisfied).
        </p>
        <div className="space-y-2">
          {taskKeysWithOptions
            .filter((t) => t.upstreamCount > 0)
            .map((t) => (
              <JoinSpecForm
                key={t.key}
                taskKey={t.key}
                taskTitle={t.title}
                joinSpec={value.joinSpecs?.[t.key]}
                upstreamGateCount={t.upstreamCount}
                onChange={(spec) => updateJoinSpec(t.key, spec)}
              />
            ))}
          {taskKeysWithOptions.filter((t) => t.upstreamCount > 0).length === 0 && (
            <p className="text-sm text-muted-foreground">
              No tasks with upstream gates. Add gates first.
            </p>
          )}
        </div>
      </SectionToggle>

      {/* Failure handler (collapsed) */}
      <SectionToggle
        title={`Failure Handler ${value.failureHandler ? "✓" : "(none)"}`}
        testId="section-failure-handler"
      >
        <p className="mb-2 text-xs text-muted-foreground">
          When an `on_fail` gate fires, this handler spawns a recovery task. Per-task overrides are
          set on individual task templates.
        </p>
        <FailureHandlerForm value={value.failureHandler} onChange={updateFailureHandler} />
      </SectionToggle>

      {/* Variables (collapsed) */}
      <SectionToggle
        title={`Variables (${value.variables?.length ?? 0})`}
        testId="section-variables"
      >
        <VariablesForm variables={value.variables ?? []} onChange={updateVariables} />
      </SectionToggle>

      {/* JSON import/export (collapsed) */}
      <SectionToggle title="JSON Import / Export" testId="section-json">
        <JsonImportExport value={value} onImport={handleJsonImport} />
      </SectionToggle>

      {/* SVG preview */}
      <div>
        <h4 className="mb-2 text-sm font-semibold">Workflow Preview</h4>
        <WorkflowPreviewSvg tasks={tasks} gates={value.gates} />
      </div>

      {/* Dry-run summary */}
      <div
        data-testid="dry-run-summary"
        className="rounded-md bg-accent/20 p-2 text-xs text-muted-foreground"
      >
        This template will create: {tasks.length} task{tasks.length === 1 ? "" : "s"},{" "}
        {value.gates.length} gate{value.gates.length === 1 ? "" : "s"}
        {value.failureHandler ? ", 1 failure handler" : ""}
        {value.variables && value.variables.length > 0
          ? `, ${value.variables.length} variable${value.variables.length === 1 ? "" : "s"}`
          : ""}
        .
      </div>
    </div>
  );
}
