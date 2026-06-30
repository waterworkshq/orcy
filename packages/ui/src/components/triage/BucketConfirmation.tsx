import React, { useState, useEffect } from "react";
import type { FindingTriageView, SuggestedBucket } from "../../types/index.js";
import { useTransitionFinding } from "../../hooks/useTriage.js";

interface BucketConfirmationProps {
  finding: FindingTriageView;
  onClose: () => void;
  onConfirmed?: (finding: FindingTriageView) => void;
}

const BUCKET_CHOICES: { value: SuggestedBucket; label: string; description: string }[] = [
  {
    value: "fix_now",
    label: "Fix now",
    description: "Block current work — promote to a corrective mission immediately.",
  },
  {
    value: "defer_to_patch",
    label: "Defer to patch",
    description: "Address in the next patch release.",
  },
  {
    value: "defer_to_release",
    label: "Defer to release",
    description: "Address in the next minor/major release.",
  },
  {
    value: "document_as_known_limitation",
    label: "Document as known limitation",
    description: "No code change — record in docs/wiki.",
  },
  {
    value: "needs_investigation",
    label: "Needs investigation",
    description: "Insufficient signal — keep under active triage.",
  },
];

/**
 * Human-in-the-loop bucket confirmation modal. The agent surfaces a recommended
 * bucket (finding.bucket); the human reviews the recommendation and its
 * reasoning, then either confirms or overrides the bucket before the finding
 * transitions `open → triaged`. This is the key UX for the
 * "bucket decisions stay human" principle (PRD constraint #3).
 */
export function BucketConfirmation({ finding, onClose, onConfirmed }: BucketConfirmationProps) {
  const recommendation = finding.bucket;
  const [selected, setSelected] = useState<SuggestedBucket | null>(recommendation);
  const mutation = useTransitionFinding();

  useEffect(() => {
    setSelected(recommendation);
  }, [recommendation]);

  const reasoning = extractReasoning(finding);

  const handleConfirm = () => {
    if (!selected) return;
    mutation.mutate(
      { id: finding.id, body: { bucket: selected, status: "triaged" } },
      {
        onSuccess: (updated) => {
          onConfirmed?.(updated);
          onClose();
        },
      },
    );
  };

  const handleWontfix = () => {
    mutation.mutate(
      { id: finding.id, body: { status: "wontfix" } },
      {
        onSuccess: () => {
          onConfirmed?.(finding);
          onClose();
        },
      },
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="bucket-confirmation-title"
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="bucket-confirmation-title" className="text-base font-semibold">
              Confirm routing bucket
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {finding.clusterKey} · {finding.findingKind}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {recommendation && (
          <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-3 dark:border-blue-900/50 dark:bg-blue-950/30">
            <p className="text-xs font-medium text-blue-800 dark:text-blue-200">
              Agent recommendation: <span className="font-mono">{recommendation}</span>
            </p>
            {reasoning && (
              <p className="mt-1 text-xs text-blue-700 dark:text-blue-300">{reasoning}</p>
            )}
            <p className="mt-1.5 text-xs italic text-muted-foreground">
              Confirm or override below — routing decisions stay human.
            </p>
          </div>
        )}

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Routing bucket</legend>
          {BUCKET_CHOICES.map((choice) => {
            const isRecommendation = choice.value === recommendation;
            return (
              <label
                key={choice.value}
                className={`flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-sm ${
                  selected === choice.value
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-muted/50"
                }`}
              >
                <input
                  type="radio"
                  name="bucket"
                  value={choice.value}
                  checked={selected === choice.value}
                  onChange={() => setSelected(choice.value)}
                  className="mt-0.5 h-4 w-4 text-primary focus:ring-primary"
                />
                <span className="min-w-0">
                  <span className="font-medium">
                    {choice.label}
                    {isRecommendation && (
                      <span className="ml-1.5 inline-flex items-center rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-800 dark:bg-blue-900/40 dark:text-blue-200">
                        suggested
                      </span>
                    )}
                  </span>
                  <span className="block text-xs text-muted-foreground">{choice.description}</span>
                </span>
              </label>
            );
          })}
        </fieldset>

        <div className="mt-5 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={handleWontfix}
            disabled={mutation.isPending}
            className="text-xs text-muted-foreground hover:underline disabled:opacity-50"
          >
            Mark as won't fix
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-input px-3 py-1.5 text-sm hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!selected || mutation.isPending}
              className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {mutation.isPending ? "Confirming…" : "Confirm bucket"}
            </button>
          </div>
        </div>
        {mutation.isError && (
          <p className="mt-2 text-xs text-red-600">{(mutation.error as Error).message}</p>
        )}
      </div>
    </div>
  );
}

/** Extracts the agent's reasoning for the suggested bucket, if present in metadata. */
function extractReasoning(finding: FindingTriageView): string | null {
  const meta = finding.metadata ?? {};
  const reason =
    (meta.bucketReason as string | undefined) ??
    (meta.recommendationReason as string | undefined) ??
    (meta.reasoning as string | undefined);
  return typeof reason === "string" && reason.trim().length > 0 ? reason : null;
}
