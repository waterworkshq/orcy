import React from "react";
import type { JoinMode } from "../../types/index.js";
import { JOIN_MODE_OPTIONS } from "./workflowEditorUtils.js";

/** Props for the {@link JoinSpecForm} component. */
interface JoinSpecFormProps {
  taskKey: string;
  taskTitle: string;
  joinSpec: { mode: JoinMode; n?: number } | undefined;
  upstreamGateCount: number;
  onChange: (next: { mode: JoinMode; n?: number } | undefined) => void;
}

const inputClass =
  "mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary";
const labelClass = "text-sm font-medium";

/** Edits the join mode for a single downstream task, controlling how multiple upstream gates combine. */
export function JoinSpecForm({
  taskKey,
  taskTitle,
  joinSpec,
  upstreamGateCount,
  onChange,
}: JoinSpecFormProps) {
  const mode = joinSpec?.mode ?? "all_of";
  const n = joinSpec?.n ?? 1;

  function handleModeChange(newMode: JoinMode) {
    if (newMode === "n_of") {
      onChange({ mode: newMode, n: Math.max(1, Math.min(n, upstreamGateCount || 1)) });
    } else {
      onChange({ mode: newMode });
    }
  }

  const showWarning = upstreamGateCount > 1 && !joinSpec;

  return (
    <div
      data-testid={`join-spec-${taskKey}`}
      className="rounded-md border border-border p-3 space-y-2"
    >
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium">{taskKey}</span>
        <span className="text-xs text-muted-foreground">{taskTitle}</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelClass}>Join Mode</label>
          <select
            data-testid={`join-mode-${taskKey}`}
            value={mode}
            onChange={(e) => handleModeChange(e.target.value as JoinMode)}
            className={inputClass}
          >
            {JOIN_MODE_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m === "all_of" ? "All (all_of)" : m === "any_of" ? "Any (any_of)" : "N of (n_of)"}
              </option>
            ))}
          </select>
        </div>

        {mode === "n_of" && (
          <div>
            <label className={labelClass}>N (minimum required)</label>
            <input
              type="number"
              min={1}
              max={upstreamGateCount || 1}
              data-testid={`join-n-${taskKey}`}
              value={n}
              onChange={(e) => onChange({ mode: "n_of", n: parseInt(e.target.value, 10) || 1 })}
              className={inputClass}
            />
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {upstreamGateCount} upstream gate{upstreamGateCount === 1 ? "" : "s"}
        {mode === "all_of" && " — all must be satisfied"}
        {mode === "any_of" && " — any one must be satisfied"}
        {mode === "n_of" && ` — ${n} must be satisfied`}
      </p>

      {showWarning && (
        <p className="text-xs text-yellow-600" data-testid={`join-warning-${taskKey}`}>
          This task has {upstreamGateCount} upstream gates but no explicit join spec — defaults to
          all_of.
        </p>
      )}
    </div>
  );
}
