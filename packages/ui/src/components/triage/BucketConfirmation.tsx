import React, { useState, useEffect } from "react";
import type { FindingTriageView, SuggestedBucket, TriageRouteCommand } from "../../types/index.js";
import { useRouteFinding, useWontfixFinding } from "../../hooks/useTriage.js";

interface BucketConfirmationProps {
  finding: FindingTriageView;
  onClose: () => void;
  onConfirmed?: (finding: FindingTriageView) => void;
}

const BUCKET_CHOICES: { value: SuggestedBucket; label: string; description: string }[] = [
  {
    value: "fix_now",
    label: "Fix now",
    description: "Create one ungated corrective mission and start work now.",
  },
  {
    value: "defer_to_patch",
    label: "Defer to patch",
    description: "Create one gated corrective mission, actionable at the next patch release.",
  },
  {
    value: "defer_to_release",
    label: "Defer to release",
    description: "Create one gated corrective mission, actionable at the next minor/major release.",
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

const RELEASE_GATE_TYPES: { value: "patch" | "minor" | "major"; label: string }[] = [
  { value: "patch", label: "Patch" },
  { value: "minor", label: "Minor" },
  { value: "major", label: "Major" },
];

function isWorkBearing(bucket: SuggestedBucket): boolean {
  return bucket === "fix_now" || bucket === "defer_to_patch" || bucket === "defer_to_release";
}

function isDeferred(bucket: SuggestedBucket): boolean {
  return bucket === "defer_to_patch" || bucket === "defer_to_release";
}

/**
 * Human-in-the-loop routing confirmation modal. The agent surfaces a
 * recommended bucket (finding.bucket); the human reviews the recommendation
 * and its reasoning, then confirms or overrides before the finding is routed.
 *
 * Submits an explicit lifecycle route command (POST /triage/findings/:id/route):
 * work-bearing buckets carry the COMPLETE corrective-Mission placement
 * (title/description, plus release-gate type+version for deferrals) so the
 * Mission, its gate, and the finding link commit atomically. The superseded
 * target-release fields are gone — release coupling lives on the Mission gate.
 */
function gateChoicesForBucket(
  bucket: SuggestedBucket | null,
): { value: "patch" | "minor" | "major"; label: string }[] {
  if (bucket === "defer_to_patch") return RELEASE_GATE_TYPES.filter((c) => c.value === "patch");
  if (bucket === "defer_to_release") return RELEASE_GATE_TYPES.filter((c) => c.value !== "patch");
  return RELEASE_GATE_TYPES;
}

export function BucketConfirmation({ finding, onClose, onConfirmed }: BucketConfirmationProps) {
  const recommendation = finding.bucket;
  const [selected, setSelected] = useState<SuggestedBucket | null>(recommendation);
  const [missionTitle, setMissionTitle] = useState(`Corrective: ${finding.clusterKey}`);
  const [missionDescription, setMissionDescription] = useState(
    `Address the ${finding.findingKind} finding in cluster ${finding.clusterKey}.`,
  );
  const [releaseGateType, setReleaseGateType] = useState<"patch" | "minor" | "major">(
    recommendation === "defer_to_release" ? "minor" : "patch",
  );
  const [releaseGateVersion, setReleaseGateVersion] = useState("");
  const [wontfixReason, setWontfixReason] = useState("");
  const routeMutation = useRouteFinding();
  const wontfixMutation = useWontfixFinding();

  useEffect(() => {
    setSelected(finding.bucket);
    setMissionTitle(`Corrective: ${finding.clusterKey}`);
    setMissionDescription(
      `Address the ${finding.findingKind} finding in cluster ${finding.clusterKey}.`,
    );
    setReleaseGateType(finding.bucket === "defer_to_release" ? "minor" : "patch");
    setReleaseGateVersion("");
    setWontfixReason("");
  }, [finding.id, finding.bucket, finding.clusterKey, finding.findingKind]);

  useEffect(() => {
    if (selected === "defer_to_release" && releaseGateType === "patch") {
      setReleaseGateType("minor");
    }
    if (selected === "defer_to_patch") {
      setReleaseGateType("patch");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const reasoning = extractReasoning(finding);
  const pending = routeMutation.isPending || wontfixMutation.isPending;
  const workBearing = selected !== null && isWorkBearing(selected);
  const deferred = selected !== null && isDeferred(selected);
  const canConfirm =
    selected !== null &&
    (!workBearing ||
      (missionTitle.trim().length > 0 &&
        missionDescription.trim().length > 0 &&
        (!deferred || releaseGateVersion.trim().length > 0)));

  const handleConfirm = () => {
    if (!selected || !canConfirm) return;
    let route: TriageRouteCommand;
    if (selected === "fix_now") {
      route = {
        bucket: "fix_now",
        missionTitle: missionTitle.trim(),
        missionDescription: missionDescription.trim(),
      };
    } else if (selected === "defer_to_patch" || selected === "defer_to_release") {
      route = {
        bucket: selected,
        missionTitle: missionTitle.trim(),
        missionDescription: missionDescription.trim(),
        releaseGateType,
        releaseGateVersion: releaseGateVersion.trim(),
      };
    } else if (selected === "document_as_known_limitation") {
      route = { bucket: "document_as_known_limitation" };
    } else {
      route = { bucket: "needs_investigation" };
    }
    routeMutation.mutate(
      { id: finding.id, route },
      {
        onSuccess: (updated) => {
          onConfirmed?.(updated);
          onClose();
        },
      },
    );
  };

  const handleWontfix = () => {
    if (!wontfixReason.trim()) return;
    wontfixMutation.mutate(
      { id: finding.id, reason: wontfixReason.trim() },
      {
        onSuccess: (updated) => {
          onConfirmed?.(updated);
          onClose();
        },
      },
    );
  };

  const mutationError =
    (routeMutation.isError && (routeMutation.error as Error)) ||
    (wontfixMutation.isError && (wontfixMutation.error as Error));

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

        {workBearing && (
          <div className="mt-3 space-y-3">
            <div>
              <label htmlFor="mission-title" className="mb-1 block text-sm font-medium">
                Corrective mission title <span className="text-red-500">*</span>
              </label>
              <input
                id="mission-title"
                type="text"
                value={missionTitle}
                onChange={(e) => setMissionTitle(e.target.value)}
                className="w-full rounded border border-input px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <p className="mt-0.5 text-xs text-muted-foreground">
                One corrective mission is created and linked atomically with the route.
              </p>
            </div>
            <div>
              <label htmlFor="mission-description" className="mb-1 block text-sm font-medium">
                Corrective mission description <span className="text-red-500">*</span>
              </label>
              <textarea
                id="mission-description"
                value={missionDescription}
                onChange={(e) => setMissionDescription(e.target.value)}
                rows={3}
                className="w-full rounded border border-input px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            {deferred && (
              <div>
                <fieldset>
                  <legend className="mb-1 text-sm font-medium">
                    Release gate <span className="text-red-500">*</span>
                  </legend>
                  <div className="flex gap-3">
                    {gateChoicesForBucket(selected).map((choice) => (
                      <label
                        key={choice.value}
                        className={`flex cursor-pointer items-center gap-1.5 rounded border px-2.5 py-1 text-xs ${
                          releaseGateType === choice.value
                            ? "border-primary bg-primary/5"
                            : "border-border hover:bg-muted/50"
                        }`}
                      >
                        <input
                          type="radio"
                          name="release-gate-type"
                          value={choice.value}
                          checked={releaseGateType === choice.value}
                          onChange={() => setReleaseGateType(choice.value)}
                          className="h-3.5 w-3.5 text-primary focus:ring-primary"
                        />
                        <span>{choice.label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label
                  htmlFor="release-gate-version"
                  className="mb-1 mt-2 block text-sm font-medium"
                >
                  Gate version <span className="text-red-500">*</span>
                </label>
                <input
                  id="release-gate-version"
                  type="text"
                  value={releaseGateVersion}
                  onChange={(e) => setReleaseGateVersion(e.target.value)}
                  placeholder="e.g. v0.40.0"
                  className="w-full rounded border border-input px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <p className="mt-0.5 text-xs text-muted-foreground">
                  The mission becomes actionable when this gate is satisfied — manual activation
                  clears it, or a matching release does.
                </p>
              </div>
            )}
          </div>
        )}

        <div className="mt-5 flex items-center justify-between gap-2">
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer hover:underline">Mark as won't fix…</summary>
            <div className="mt-2 space-y-2">
              <textarea
                aria-label="Won't fix reason"
                value={wontfixReason}
                onChange={(e) => setWontfixReason(e.target.value)}
                rows={2}
                placeholder="Why won't this be fixed? (required — recorded durably)"
                className="w-full rounded border border-input px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                type="button"
                onClick={handleWontfix}
                disabled={!wontfixReason.trim() || pending}
                className="rounded border border-input px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
              >
                {wontfixMutation.isPending ? "Recording…" : "Record won't fix"}
              </button>
            </div>
          </details>
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
              disabled={!canConfirm || pending}
              className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {routeMutation.isPending ? "Routing…" : "Confirm bucket"}
            </button>
          </div>
        </div>
        {mutationError && <p className="mt-2 text-xs text-red-600">{mutationError.message}</p>}
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
