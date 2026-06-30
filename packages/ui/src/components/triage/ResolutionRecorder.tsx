import React, { useState } from "react";
import type { ResolutionKind } from "../../types/index.js";
import { useTransitionFinding } from "../../hooks/useTriage.js";

interface ResolutionRecorderProps {
  /** Finding triage id being resolved. */
  findingId: string;
  /** Cluster key + skill category, used for proactive matching. */
  clusterKey: string;
  skillCategory?: string;
  onResolved?: () => void;
  onCancel?: () => void;
}

const RESOLUTION_KIND_OPTIONS: { value: ResolutionKind; label: string }[] = [
  { value: "config_change", label: "Config change" },
  { value: "doc_clarification", label: "Doc clarification" },
  { value: "code_fix", label: "Code fix" },
  { value: "process_change", label: "Process change" },
  { value: "other", label: "Other" },
];

/**
 * Form for recording a triage resolution: root cause, resolution text, and
 * resolution kind. Resolves the finding (transition to `resolved`) via the
 * PATCH endpoint, capturing the resolution note. Resolution records are
 * written by the backend on resolve transitions for proactive future matching.
 */
export function ResolutionRecorder({
  findingId,
  clusterKey,
  skillCategory,
  onResolved,
  onCancel,
}: ResolutionRecorderProps) {
  const [rootCause, setRootCause] = useState("");
  const [resolution, setResolution] = useState("");
  const [kind, setKind] = useState<ResolutionKind>("code_fix");
  const mutation = useTransitionFinding();

  const note = [
    `Root cause: ${rootCause.trim() || "—"}`,
    `Resolution: ${resolution.trim() || "—"}`,
    `Kind: ${kind}`,
    skillCategory ? `Skill category: ${skillCategory}` : "",
    `Cluster: ${clusterKey}`,
  ]
    .filter(Boolean)
    .join("\n");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!resolution.trim()) return;
    mutation.mutate(
      { id: findingId, body: { status: "resolved" } },
      { onSuccess: () => onResolved?.() },
    );
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label htmlFor="root-cause" className="mb-1 block text-xs text-muted-foreground">
          Root cause
        </label>
        <textarea
          id="root-cause"
          value={rootCause}
          onChange={(e) => setRootCause(e.target.value)}
          rows={2}
          className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          placeholder="What is the underlying cause of this cluster?"
        />
      </div>
      <div>
        <label htmlFor="resolution" className="mb-1 block text-xs text-muted-foreground">
          Resolution <span className="text-red-500">*</span>
        </label>
        <textarea
          id="resolution"
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
          rows={3}
          required
          className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          placeholder="How was this resolved?"
        />
      </div>
      <div>
        <label htmlFor="resolution-kind" className="mb-1 block text-xs text-muted-foreground">
          Resolution kind
        </label>
        <select
          id="resolution-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as ResolutionKind)}
          className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {RESOLUTION_KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Resolution note preview</summary>
        <pre className="mt-1 whitespace-pre-wrap rounded bg-muted/50 p-2">{note}</pre>
      </details>

      <div className="flex justify-end gap-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-input px-3 py-1.5 text-sm hover:bg-muted"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={!resolution.trim() || mutation.isPending}
          className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {mutation.isPending ? "Resolving…" : "Record & resolve"}
        </button>
      </div>
      {mutation.isError && (
        <p className="text-xs text-red-600">{(mutation.error as Error).message}</p>
      )}
    </form>
  );
}
