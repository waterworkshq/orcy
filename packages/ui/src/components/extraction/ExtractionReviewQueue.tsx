/**
 * Extraction review queue — habitat-scoped list of proposed findings awaiting
 * human review.
 *
 * Renders each finding with confidence, sample size, completeness, and
 * visibility ceiling. Clicking a finding navigates to the detail view via
 * search-param state (?finding=<id>), following the in-page-panel convention.
 */
import React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/index.js";
import { queryKeys } from "../../lib/queryKeys.js";

interface ExtractionReviewQueueProps {
  habitatId: string;
  selectedFindingId?: string;
  onSelectFinding: (findingId: string) => void;
}

export function ExtractionReviewQueue({
  habitatId,
  selectedFindingId,
  onSelectFinding,
}: ExtractionReviewQueueProps) {
  const { data: findings = [], isLoading } = useQuery({
    queryKey: queryKeys.extraction.reviewQueue(habitatId),
    queryFn: ({ signal }: { signal?: AbortSignal }) =>
      api.extraction.getReviewQueue(habitatId, undefined, signal),
    enabled: !!habitatId,
  });

  if (isLoading) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        Loading review queue...
      </div>
    );
  }

  if (findings.length === 0) {
    return (
      <div className="rounded border border-border p-6 text-center" data-testid="empty-review-queue">
        <p className="text-sm text-muted-foreground">
          No findings awaiting review.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="review-queue">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Review Queue ({findings.length})</p>
      </div>
      {findings.map((finding) => (
        <button
          key={finding.id}
          type="button"
          onClick={() => onSelectFinding(finding.id)}
          className={`w-full text-left rounded border p-3 transition-colors ${
            selectedFindingId === finding.id
              ? "border-primary bg-primary/5"
              : "border-border hover:bg-muted/30"
          }`}
          aria-label={`Review finding: ${finding.subject}`}
          data-testid={`queue-item-${finding.id}`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{finding.subject}</p>
              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                <span className="px-1.5 py-0.5 rounded bg-muted">
                  {finding.findingType}
                </span>
                <span>Confidence: {(finding.confidence * 100).toFixed(0)}%</span>
                <span>Sample: {finding.sampleSize}</span>
                <span
                  className={completenessClass(finding.completeness)}
                  data-completeness={finding.completeness}
                >
                  {finding.completeness}
                </span>
                {finding.visibilityCeiling === "aggregate_only" && (
                  <span
                    className="px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-600"
                    data-testid={`aggregate-badge-${finding.id}`}
                  >
                    aggregate-only
                  </span>
                )}
              </div>
            </div>
            <div className="flex-shrink-0 text-right">
              <p className="text-xs text-muted-foreground">
                {finding.occurrenceCount > 1
                  ? `${finding.occurrenceCount} occurrences`
                  : "1 occurrence"}
              </p>
              <p className="text-xs text-muted-foreground">
                {new Date(finding.lastSeenAt).toLocaleDateString()}
              </p>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

function completenessClass(completeness: string): string {
  if (completeness === "complete") return "px-1.5 py-0.5 rounded bg-green-500/10 text-green-600";
  if (completeness === "partial") return "px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-600";
  if (completeness === "stale") return "px-1.5 py-0.5 rounded bg-red-500/10 text-red-600";
  return "px-1.5 py-0.5 rounded bg-muted text-muted-foreground";
}
