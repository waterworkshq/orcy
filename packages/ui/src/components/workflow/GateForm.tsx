import React, { useState } from "react";
import { Button } from "../ui/Button.js";
import type {
  WorkflowTemplateGate,
  TaskTemplateEntry,
  SignalMatch,
  GateType,
  AutomationCondition,
} from "../../types/index.js";
import {
  SELECTABLE_GATE_TYPES,
  ALL_GATE_TYPES,
  GATE_TYPE_LABELS,
  SIGNAL_TYPE_OPTIONS,
  EXPERIENCE_CATEGORY_OPTIONS,
  MATCH_SCOPE_OPTIONS,
  resolveTaskOptions,
} from "./workflowEditorUtils.js";

/** Props for the {@link GateForm} component. */
interface GateFormProps {
  gate: WorkflowTemplateGate;
  tasks: TaskTemplateEntry[];
  index: number;
  onChange: (next: WorkflowTemplateGate) => void;
  onRemove: () => void;
}

const inputClass =
  "mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary";
const labelClass = "text-sm font-medium";

/** Edits a single workflow gate edge: upstream task, gate type, downstream task, optional match config, and optional condition predicate. */
export function GateForm({ gate, tasks, index, onChange, onRemove }: GateFormProps) {
  const taskOptions = resolveTaskOptions(tasks);
  const [showCondition, setShowCondition] = useState(gate.condition != null);
  const [conditionText, setConditionText] = useState(
    gate.condition ? JSON.stringify(gate.condition, null, 2) : "",
  );
  const [conditionError, setConditionError] = useState("");

  function update(patch: Partial<WorkflowTemplateGate>) {
    onChange({ ...gate, ...patch });
  }

  function handleGateTypeChange(gateType: GateType) {
    if (gateType === "on_signal") {
      const existing = gate.matchConfig as SignalMatch | undefined;
      update({
        gateType,
        matchConfig: existing ?? { signalType: "blocker", matchScope: "task" },
      });
    } else {
      update({ gateType, matchConfig: undefined });
    }
  }

  function updateSignalMatch(patch: Partial<SignalMatch>) {
    const current = (gate.matchConfig as SignalMatch | undefined) ?? {
      signalType: "blocker" as const,
      matchScope: "task" as const,
    };
    update({ matchConfig: { ...current, ...patch } });
  }

  function handleToggleCondition() {
    if (showCondition) {
      setShowCondition(false);
      setConditionText("");
      setConditionError("");
      update({ condition: null });
    } else {
      setShowCondition(true);
    }
  }

  function handleConditionChange(text: string) {
    setConditionText(text);
    if (!text.trim()) {
      setConditionError("");
      update({ condition: null });
      return;
    }
    try {
      const parsed = JSON.parse(text) as AutomationCondition;
      setConditionError("");
      update({ condition: parsed });
    } catch {
      setConditionError("Invalid JSON");
    }
  }

  const signalMatch =
    gate.gateType === "on_signal" ? (gate.matchConfig as SignalMatch | undefined) : undefined;

  return (
    <div
      data-testid={`gate-form-${index}`}
      className="rounded-md border border-border p-3 space-y-3"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Gate {index + 1}</span>
        <Button variant="ghost" size="sm" onClick={onRemove} data-testid={`gate-remove-${index}`}>
          Remove
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className={labelClass}>Upstream Task</label>
          <select
            data-testid={`gate-upstream-${index}`}
            value={gate.upstreamTaskKey}
            onChange={(e) => update({ upstreamTaskKey: e.target.value })}
            className={inputClass}
          >
            {taskOptions.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass}>Gate Type</label>
          <select
            data-testid={`gate-type-${index}`}
            value={gate.gateType}
            onChange={(e) => handleGateTypeChange(e.target.value as GateType)}
            className={inputClass}
          >
            {SELECTABLE_GATE_TYPES.map((gt) => (
              <option key={gt} value={gt}>
                {GATE_TYPE_LABELS[gt]}
              </option>
            ))}
            {ALL_GATE_TYPES.includes("on_automation") && (
              <option value="on_automation" disabled title="Deferred to v0.20.1">
                {GATE_TYPE_LABELS.on_automation}
              </option>
            )}
          </select>
        </div>

        <div>
          <label className={labelClass}>Downstream Task</label>
          <select
            data-testid={`gate-downstream-${index}`}
            value={gate.downstreamTaskKey}
            onChange={(e) => update({ downstreamTaskKey: e.target.value })}
            className={inputClass}
          >
            {taskOptions.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {signalMatch && (
        <div
          data-testid={`gate-match-config-${index}`}
          className="space-y-2 rounded-md bg-accent/20 p-2"
        >
          <p className="text-xs font-medium text-muted-foreground">Signal Match Configuration</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelClass}>Signal Type</label>
              <select
                data-testid={`gate-signal-type-${index}`}
                value={signalMatch.signalType}
                onChange={(e) =>
                  updateSignalMatch({ signalType: e.target.value as SignalMatch["signalType"] })
                }
                className={inputClass}
              >
                {SIGNAL_TYPE_OPTIONS.map((st) => (
                  <option key={st} value={st}>
                    {st}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className={labelClass}>Match Scope</label>
              <select
                data-testid={`gate-match-scope-${index}`}
                value={signalMatch.matchScope ?? "task"}
                onChange={(e) =>
                  updateSignalMatch({
                    matchScope: e.target.value as SignalMatch["matchScope"],
                  })
                }
                className={inputClass}
              >
                {MATCH_SCOPE_OPTIONS.map((ms) => (
                  <option key={ms} value={ms}>
                    {ms}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {signalMatch.signalType === "experience" && (
            <div>
              <label className={labelClass}>Experience Category</label>
              <select
                data-testid={`gate-experience-${index}`}
                value={signalMatch.experience ?? ""}
                onChange={(e) =>
                  updateSignalMatch({
                    experience: e.target.value
                      ? (e.target.value as SignalMatch["experience"])
                      : undefined,
                  })
                }
                className={inputClass}
              >
                <option value="">Any category</option>
                {EXPERIENCE_CATEGORY_OPTIONS.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className={labelClass}>Subject Contains (optional)</label>
            <input
              type="text"
              data-testid={`gate-subject-contains-${index}`}
              value={signalMatch.subjectContains ?? ""}
              onChange={(e) =>
                updateSignalMatch({
                  subjectContains: e.target.value || undefined,
                })
              }
              placeholder="Substring to match in signal subject"
              className={inputClass}
            />
          </div>
        </div>
      )}

      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleToggleCondition}
          data-testid={`gate-condition-toggle-${index}`}
        >
          {showCondition ? "Remove Condition" : "Add Condition"}
        </Button>
      </div>

      {showCondition && (
        <div data-testid={`gate-condition-editor-${index}`}>
          <label className={labelClass}>Condition JSON (AutomationCondition)</label>
          <textarea
            data-testid={`gate-condition-text-${index}`}
            value={conditionText}
            onChange={(e) => handleConditionChange(e.target.value)}
            placeholder='{"type":"always"}'
            rows={3}
            className={`${inputClass} font-mono`}
          />
          {conditionError && <p className="text-xs text-destructive mt-1">{conditionError}</p>}
          <p className="text-xs text-muted-foreground mt-1">
            Supports: always, and/or/not (children), field comparisons, priority_above/below.
            Variables resolve at instantiation time.
          </p>
        </div>
      )}
    </div>
  );
}
