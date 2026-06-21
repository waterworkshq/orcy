import React from "react";
import { Button } from "../ui/Button.js";
import type { WorkflowFailureHandlerConfig } from "../../types/index.js";

/** Props for the {@link FailureHandlerForm} component. */
interface FailureHandlerFormProps {
  value: WorkflowFailureHandlerConfig | undefined;
  onChange: (next: WorkflowFailureHandlerConfig | undefined) => void;
}

const inputClass =
  "mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary";
const labelClass = "text-sm font-medium";

/** Edits the workflow-level failure handler, configuring the recovery task template and agent selector for `on_fail` gates. */
export function FailureHandlerForm({ value, onChange }: FailureHandlerFormProps) {
  const template = value?.recoveryTaskTemplate;
  const selector = value?.agentSelector;

  function updateTemplate(patch: Partial<NonNullable<typeof template>>) {
    const current = value?.recoveryTaskTemplate ?? {
      title: '',
      description: '',
    };
    const next: WorkflowFailureHandlerConfig = {
      recoveryTaskTemplate: { ...current, ...patch },
      ...(value?.agentSelector !== undefined
        ? { agentSelector: value.agentSelector }
        : {}),
    };
    onChange(next);
  }

  function updateSelector(patch: Partial<NonNullable<typeof selector>>) {
    const current = value?.agentSelector ?? {};
    const next: WorkflowFailureHandlerConfig = {
      recoveryTaskTemplate: value?.recoveryTaskTemplate ?? { title: '', description: '' },
      agentSelector: { ...current, ...patch },
    };
    onChange(next);
  }

  function handleCapabilitiesChange(text: string, field: "requiredCapabilities") {
    const caps = text
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    if (field === "requiredCapabilities") {
      updateTemplate({ requiredCapabilities: caps });
    }
  }

  function handleAgentCapabilitiesChange(text: string) {
    const caps = text
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    updateSelector({ requiredCapabilities: caps });
  }

  return (
    <div data-testid="failure-handler-form" className="space-y-3">
      <div className="rounded-md border border-border p-3 space-y-3">
        <p className="text-xs font-medium text-muted-foreground">Recovery Task Template</p>
        <p className="text-xs text-muted-foreground">
          Variables: {"{{failedTaskTitle}}"}, {"{{failureReason}}"}, {"{{failedAgentName}}"} resolve
          at recovery-spawn time.
        </p>

        <div>
          <label className={labelClass}>Title</label>
          <input
            type="text"
            data-testid="fh-title"
            value={template?.title ?? ""}
            onChange={(e) => updateTemplate({ title: e.target.value })}
            placeholder="Investigate {{failedTaskTitle}} failure"
            className={inputClass}
          />
        </div>

        <div>
          <label className={labelClass}>Description</label>
          <textarea
            data-testid="fh-description"
            value={template?.description ?? ""}
            onChange={(e) => updateTemplate({ description: e.target.value })}
            placeholder="Recovery task description"
            rows={2}
            className={inputClass}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelClass}>Required Domain</label>
            <select
              data-testid="fh-required-domain"
              value={template?.requiredDomain ?? ""}
              onChange={(e) =>
                updateTemplate({
                  requiredDomain: e.target.value || undefined,
                })
              }
              className={inputClass}
            >
              <option value="">Any domain</option>
              <option value="frontend">Frontend</option>
              <option value="backend">Backend</option>
              <option value="devops">DevOps</option>
              <option value="testing">Testing</option>
            </select>
          </div>

          <div>
            <label className={labelClass}>Estimated Minutes</label>
            <input
              type="number"
              min={1}
              data-testid="fh-estimated-minutes"
              value={template?.estimatedMinutes ?? ""}
              onChange={(e) =>
                updateTemplate({
                  estimatedMinutes: parseInt(e.target.value, 10) || undefined,
                })
              }
              className={inputClass}
            />
          </div>
        </div>

        <div>
          <label className={labelClass}>Required Capabilities (comma-separated)</label>
          <input
            type="text"
            data-testid="fh-required-capabilities"
            value={template?.requiredCapabilities?.join(", ") ?? ""}
            onChange={(e) => handleCapabilitiesChange(e.target.value, "requiredCapabilities")}
            placeholder="debugging, testing"
            className={inputClass}
          />
        </div>
      </div>

      <div className="rounded-md border border-border p-3 space-y-3">
        <p className="text-xs font-medium text-muted-foreground">Agent Selector</p>
        <p className="text-xs text-muted-foreground">
          No {"excludeFailedAgent"} — dropped from v0.20 per ADR-0003. Use {"assignedAgentId"} for
          specific targeting.
        </p>

        <div>
          <label className={labelClass}>Assigned Agent ID (optional)</label>
          <input
            type="text"
            data-testid="fh-assigned-agent-id"
            value={selector?.assignedAgentId ?? ""}
            onChange={(e) =>
              updateSelector({
                assignedAgentId: e.target.value || undefined,
              })
            }
            placeholder="Specific agent to assign the recovery task"
            className={inputClass}
          />
        </div>

        <div>
          <label className={labelClass}>Required Domain (agent filter)</label>
          <select
            data-testid="fh-agent-domain"
            value={selector?.requiredDomain ?? ""}
            onChange={(e) =>
              updateSelector({
                requiredDomain: e.target.value || null,
              })
            }
            className={inputClass}
          >
            <option value="">Any domain</option>
            <option value="frontend">Frontend</option>
            <option value="backend">Backend</option>
            <option value="devops">DevOps</option>
            <option value="testing">Testing</option>
          </select>
        </div>

        <div>
          <label className={labelClass}>
            Required Capabilities (agent filter, comma-separated)
          </label>
          <input
            type="text"
            data-testid="fh-agent-capabilities"
            value={selector?.requiredCapabilities?.join(", ") ?? ""}
            onChange={(e) => handleAgentCapabilitiesChange(e.target.value)}
            placeholder="debugging"
            className={inputClass}
          />
        </div>
      </div>

      {value && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange(undefined)}
          data-testid="fh-remove"
        >
          Remove Failure Handler
        </Button>
      )}
    </div>
  );
}
