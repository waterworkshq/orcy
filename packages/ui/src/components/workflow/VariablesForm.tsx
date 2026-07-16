import React from "react";
import { Button } from "../ui/Button.js";
import type { WorkflowTemplateVariable } from "../../types/index.js";

/** Props for the {@link VariablesForm} component. */
interface VariablesFormProps {
  variables: WorkflowTemplateVariable[];
  onChange: (next: WorkflowTemplateVariable[]) => void;
}

const inputClass =
  "mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary";
const labelClass = "text-xs font-medium";

/** Edits the list of template variable definitions that resolve via `{{key}}` substitution at instantiation time. */
export function VariablesForm({ variables, onChange }: VariablesFormProps) {
  function addVariable() {
    onChange([...variables, { key: "", description: "", required: false }]);
  }

  function updateVariable(index: number, patch: Partial<WorkflowTemplateVariable>) {
    const next = [...variables];
    next[index] = { ...next[index], ...patch };
    onChange(next);
  }

  function removeVariable(index: number) {
    onChange(variables.filter((_, i) => i !== index));
  }

  return (
    <div data-testid="variables-form" className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Variables are replaced as {"{{key}}"} → value at mission creation time. No conditional
        logic. Usable in task titles, descriptions, gate {"subjectContains"}, and recovery template
        fields.
      </p>

      {variables.length === 0 && (
        <p className="text-sm text-muted-foreground">No variables defined.</p>
      )}

      {variables.map((variable, index) => (
        <div
          key={index}
          data-testid={`variable-row-${index}`}
          className="grid grid-cols-12 gap-2 items-end rounded-md border border-border p-2"
        >
          <div className="col-span-3">
            <label className={labelClass}>Key</label>
            <input
              type="text"
              data-testid={`variable-key-${index}`}
              value={variable.key}
              onChange={(e) => updateVariable(index, { key: e.target.value })}
              placeholder="mission_name"
              className={`${inputClass} font-mono`}
            />
          </div>

          <div className="col-span-4">
            <label className={labelClass}>Description</label>
            <input
              type="text"
              data-testid={`variable-description-${index}`}
              value={variable.description}
              onChange={(e) => updateVariable(index, { description: e.target.value })}
              placeholder="Name of the feature"
              className={inputClass}
            />
          </div>

          <div className="col-span-3">
            <label className={labelClass}>Default</label>
            <input
              type="text"
              data-testid={`variable-default-${index}`}
              value={variable.default ?? ""}
              onChange={(e) =>
                updateVariable(index, {
                  default: e.target.value || undefined,
                })
              }
              placeholder="(optional)"
              className={inputClass}
            />
          </div>

          <div className="col-span-1 flex items-center justify-center pb-1.5">
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                data-testid={`variable-required-${index}`}
                checked={variable.required ?? false}
                onChange={(e) => updateVariable(index, { required: e.target.checked })}
                className="h-4 w-4 rounded border-input"
              />
              <span className="text-xs">Req</span>
            </label>
          </div>

          <div className="col-span-1 flex items-center justify-center pb-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => removeVariable(index)}
              data-testid={`variable-remove-${index}`}
            >
              ✕
            </Button>
          </div>
        </div>
      ))}

      <Button variant="outline" size="sm" onClick={addVariable} data-testid="variable-add">
        + Add Variable
      </Button>
    </div>
  );
}
