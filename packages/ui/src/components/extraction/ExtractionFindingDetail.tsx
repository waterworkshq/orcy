/**
 * Extraction finding detail — immutable revision lineage, confidence, sample
 * size, completeness, bounded citations with degradation states, and
 * CAS-protected review decisions.
 *
 * Citation degradation states rendered:
 *   - available: full citation with entity refs and timestamp
 *   - dangling: source no longer exists
 *   - changed: source has been modified since extraction
 *   - unauthorized: viewer lacks access
 *
 * Aggregate-only findings: NO source drill-down, exact timestamps, or
 * contributor details (entityRefs and occurredAt are null server-side).
 *
 * 409 on decision CAS → visible conflict + refresh, NOT silent overwrite.
 * Rule recommendations render as prose — NOT executable, NOT prefilling
 * Automation Rules.
 *
 * NO Wiki publish affordance (ticket 7).
 */
import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "../ui/Button.js";
import { MarkdownContent } from "../ui/MarkdownContent.js";
import { api } from "../../api/index.js";
import { notify } from "../../lib/toast.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { isVersionConflict } from "../../lib/habitatMutations.js";
import type { ExtractionFindingDetailView } from "../../types/index.js";

interface ExtractionFindingDetailProps {
  habitatId: string;
  findingId: string;
  onBack: () => void;
}

export function ExtractionFindingDetail({
  habitatId,
  findingId,
  onBack,
}: ExtractionFindingDetailProps) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.extraction.findingDetail(habitatId, findingId),
    queryFn: ({ signal }: { signal?: AbortSignal }) =>
      api.extraction.getFindingDetail(habitatId, findingId, signal),
    enabled: !!habitatId && !!findingId,
  });

  function invalidateFinding() {
    queryClient.invalidateQueries({
      queryKey: queryKeys.extraction.findingDetail(habitatId, findingId),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.extraction.reviewQueue(habitatId),
    });
  }

  const acceptMutation = useMutation({
    mutationFn: () =>
      api.extraction.acceptFinding(habitatId, findingId, {
        expectedDecisionVersion: data?.finding.decisionVersion ?? 0,
        reason: reason.trim() || undefined,
      }),
    onSuccess: () => {
      notify.success("Finding accepted");
      setReason("");
      setConflictMessage(null);
      invalidateFinding();
    },
    onError: (err: Error) => {
      if (isVersionConflict(err)) {
        setConflictMessage(
          "Another reviewer acted on this finding first. The view has been refreshed — review the current state and try again.",
        );
        invalidateFinding();
      } else {
        notify.error(err.message);
      }
    },
  });

  const rejectMutation = useMutation({
    mutationFn: () =>
      api.extraction.rejectFinding(habitatId, findingId, {
        expectedDecisionVersion: data?.finding.decisionVersion ?? 0,
        reason: reason.trim() || undefined,
      }),
    onSuccess: () => {
      notify.success("Finding rejected");
      setReason("");
      setConflictMessage(null);
      invalidateFinding();
    },
    onError: (err: Error) => {
      if (isVersionConflict(err)) {
        setConflictMessage(
          "Another reviewer acted on this finding first. The view has been refreshed — review the current state and try again.",
        );
        invalidateFinding();
      } else {
        notify.error(err.message);
      }
    },
  });

  const reviseMutation = useMutation({
    mutationFn: () =>
      api.extraction.requestRevision(habitatId, findingId, {
        expectedDecisionVersion: data?.finding.decisionVersion ?? 0,
        reason: reason.trim() || undefined,
      }),
    onSuccess: () => {
      notify.success("Revision requested");
      setReason("");
      setConflictMessage(null);
      invalidateFinding();
    },
    onError: (err: Error) => {
      if (isVersionConflict(err)) {
        setConflictMessage(
          "Another reviewer acted on this finding first. The view has been refreshed — review the current state and try again.",
        );
        invalidateFinding();
      } else {
        notify.error(err.message);
      }
    },
  });

  const withdrawMutation = useMutation({
    mutationFn: () =>
      api.extraction.withdrawFinding(habitatId, findingId, {
        expectedDecisionVersion: data?.finding.decisionVersion ?? 0,
        reason: reason.trim() || undefined,
      }),
    onSuccess: () => {
      notify.success("Finding withdrawn");
      setReason("");
      setConflictMessage(null);
      invalidateFinding();
    },
    onError: (err: Error) => {
      if (isVersionConflict(err)) {
        setConflictMessage(
          "Another reviewer acted on this finding first. The view has been refreshed — review the current state and try again.",
        );
        invalidateFinding();
      } else {
        notify.error(err.message);
      }
    },
  });

  const refreshCitationsMutation = useMutation({
    mutationFn: () => api.extraction.refreshCitations(habitatId, findingId),
    onSuccess: () => {
      notify.success("Citation states refreshed");
      invalidateFinding();
    },
    onError: (err: Error) => {
      notify.error(err.message);
    },
  });

  if (isLoading) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        Loading finding detail...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Back to queue
        </Button>
        <div className="rounded border border-border p-6 text-center">
          <p className="text-sm text-muted-foreground">
            {error ? error.message : "Finding not found."}
          </p>
        </div>
      </div>
    );
  }

  const { finding, citations, reviews } = data;
  const isAggregateOnly = finding.visibilityCeiling === "aggregate_only";
  const isProposed = finding.status === "proposed";
  const isWithdrawn = finding.status === "withdrawn";
  const isRuleRec = finding.findingType === "rule_recommendation";

  return (
    <div className="space-y-4" data-testid="finding-detail">
      {/* Back button */}
      <Button variant="ghost" size="sm" onClick={onBack}>
        ← Back to queue
      </Button>

      {/* Conflict banner */}
      {conflictMessage && (
        <div
          className="rounded border border-orange-500/30 bg-orange-500/10 p-3"
          data-testid="conflict-banner"
        >
          <p className="text-sm text-orange-700">{conflictMessage}</p>
        </div>
      )}

      {/* Status banner */}
      <div
        className={`rounded border p-3 ${
          isWithdrawn
            ? "border-red-500/30 bg-red-500/5"
            : finding.status === "accepted"
              ? "border-green-500/30 bg-green-500/5"
              : finding.status === "rejected"
                ? "border-red-500/30 bg-red-500/5"
                : "border-border bg-muted/20"
        }`}
      >
        <p className="text-sm font-medium capitalize">
          {finding.status} · Decision version {finding.decisionVersion}
        </p>
      </div>

      {/* Finding header */}
      <div>
        <h3 className="text-base font-semibold">{finding.subject}</h3>
        <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
          <span className="px-2 py-1 rounded bg-muted">{finding.findingType}</span>
          <span>Confidence: {(finding.confidence * 100).toFixed(0)}%</span>
          <span>Sample size: {finding.sampleSize}</span>
          <span className={completenessClass(finding.completeness)}>
            {finding.completeness}
          </span>
          <span>Revision: {finding.revision}</span>
          {isAggregateOnly && (
            <span className="px-2 py-1 rounded bg-purple-500/10 text-purple-600" data-testid="aggregate-only-badge">
              aggregate-only
            </span>
          )}
        </div>
      </div>

      {/* Finding body — rendered as markdown */}
      <div className="rounded border border-border p-4">
        <MarkdownContent content={finding.body} />
        {finding.caveats.length > 0 && (
          <div className="mt-3 pt-3 border-t border-border">
            <p className="text-xs font-medium text-muted-foreground mb-1">Caveats</p>
            <ul className="text-xs text-muted-foreground space-y-1">
              {finding.caveats.map((caveat, i) => (
                <li key={i}>• {caveat}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Rule recommendation prose-only notice */}
      {isRuleRec && (
        <div className="rounded border border-blue-500/30 bg-blue-500/5 p-3" data-testid="rule-recommendation-notice">
          <p className="text-xs text-blue-700">
            This is a recommendation rendered as prose. It is not an executable
            Automation Rule and cannot be prefilled or enabled from this view.
          </p>
        </div>
      )}

      {/* Citations */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium">
            Citations ({citations.length})
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refreshCitationsMutation.mutate()}
            loading={refreshCitationsMutation.isPending}
          >
            Refresh states
          </Button>
        </div>
        <div className="space-y-2">
          {citations.map((citation) => (
            <CitationRow key={citation.id} citation={citation} />
          ))}
          {citations.length === 0 && (
            <p className="text-xs text-muted-foreground">No citations recorded.</p>
          )}
        </div>
      </div>

      {/* Immutable revision lineage */}
      <div>
        <p className="text-sm font-medium mb-2">Lineage</p>
        <div className="rounded border border-border p-3 text-xs space-y-1">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Lineage root:</span>
            <span className="font-mono">{finding.lineageRootId.slice(0, 12)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Supersedes:</span>
            <span className="font-mono">
              {finding.supersedesFindingId ? finding.supersedesFindingId.slice(0, 12) : "—"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Revision:</span>
            <span>{finding.revision}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">First seen:</span>
            <span>{new Date(finding.firstSeenAt).toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Last seen:</span>
            <span>{new Date(finding.lastSeenAt).toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Occurrences:</span>
            <span>{finding.occurrenceCount}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Evidence digest:</span>
            <span className="font-mono text-[10px]">{finding.evidenceDigest.slice(0, 24)}…</span>
          </div>
        </div>
      </div>

      {/* Review history */}
      {reviews.length > 0 && (
        <div>
          <p className="text-sm font-medium mb-2">Review History</p>
          <div className="space-y-1" data-testid="review-history">
            {reviews.map((review) => (
              <div
                key={review.id}
                className="rounded border border-border p-2 text-xs"
                data-testid={`review-${review.id}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium capitalize">
                    {review.decision === "reject" && review.reason?.startsWith("Withdrawn:")
                      ? "withdrawn"
                      : review.decision}
                  </span>
                  <span className="text-muted-foreground">
                    {new Date(review.createdAt).toLocaleString()}
                  </span>
                </div>
                {review.reason && (
                  <p className="text-muted-foreground mt-1">{review.reason}</p>
                )}
                <p className="text-muted-foreground mt-1">
                  v{review.expectedDecisionVersion} → v{review.resultingDecisionVersion}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Decision actions — only for proposed findings */}
      {isProposed && (
        <div className="space-y-3 pt-3 border-t border-border" data-testid="decision-actions">
          <div>
            <label
              className="mb-1 block text-xs text-muted-foreground"
              htmlFor="decision-reason"
            >
              Reason (required for accept/reject)
            </label>
            <textarea
              id="decision-reason"
              className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              rows={2}
              placeholder="Explain your decision..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-label="Decision reason"
            />
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button
              onClick={() => acceptMutation.mutate()}
              loading={acceptMutation.isPending}
              disabled={!reason.trim()}
              aria-label="Accept finding"
            >
              Accept
            </Button>
            <Button
              variant="ghost"
              onClick={() => rejectMutation.mutate()}
              loading={rejectMutation.isPending}
              disabled={!reason.trim()}
              aria-label="Reject finding"
            >
              Reject
            </Button>
            <Button
              variant="ghost"
              onClick={() => reviseMutation.mutate()}
              loading={reviseMutation.isPending}
              aria-label="Request revision"
            >
              Request Revision
            </Button>
            <Button
              variant="ghost"
              onClick={() => withdrawMutation.mutate()}
              loading={withdrawMutation.isPending}
              className="text-destructive hover:text-destructive/80"
              aria-label="Withdraw finding"
            >
              Withdraw
            </Button>
          </div>
        </div>
      )}

      {/* NO Wiki publish affordance — ticket 7 composes into this view */}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Citation row — renders degradation states clearly
// ---------------------------------------------------------------------------

function CitationRow({
  citation,
}: {
  citation: ExtractionFindingDetailView["citations"][number];
}) {
  const isAggregate = citation.visibilityClass === "aggregate_only";
  const state = citation.resolutionState;

  return (
    <div
      className="rounded border border-border p-2 text-xs"
      data-testid={`citation-${citation.id}`}
      data-resolution-state={state}
      data-visibility={citation.visibilityClass}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium">{citation.sourceType}</span>
        <div className="flex items-center gap-2">
          <span className="capitalize text-muted-foreground">{citation.role}</span>
          <span
            className={`px-1.5 py-0.5 rounded ${resolutionStateClass(state)}`}
            data-testid={`citation-state-${citation.id}`}
          >
            {state}
          </span>
        </div>
      </div>
      {/* Aggregate-only: NO source drill-down, exact timestamps, or contributor details */}
      {isAggregate ? (
        <p className="text-muted-foreground mt-1" data-testid={`aggregate-citation-${citation.id}`}>
          Aggregate-only — source details withheld for privacy.
        </p>
      ) : state === "available" && citation.entityRefs ? (
        <div className="mt-1 space-y-1">
          {citation.occurredAt && (
            <p className="text-muted-foreground">
              Occurred: {new Date(citation.occurredAt).toLocaleString()}
            </p>
          )}
          <div className="flex flex-wrap gap-1">
            {citation.entityRefs.map((ref, i) => (
              <span key={i} className="px-1.5 py-0.5 rounded bg-muted font-mono text-[10px]">
                {ref.type}:{ref.id.slice(0, 8)}
              </span>
            ))}
          </div>
        </div>
      ) : state === "dangling" ? (
        <p className="text-yellow-600 mt-1" data-testid={`dangling-citation-${citation.id}`}>
          Source no longer exists.
        </p>
      ) : state === "changed" ? (
        <p className="text-orange-600 mt-1" data-testid={`changed-citation-${citation.id}`}>
          Source has been modified since extraction.
        </p>
      ) : state === "unauthorized" ? (
        <p className="text-red-600 mt-1">Access restricted.</p>
      ) : null}
      {/* Completeness marker */}
      <span className={`mt-1 inline-block ${completenessClass(citation.completeness)}`}>
        {citation.completeness}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function completenessClass(completeness: string): string {
  if (completeness === "complete") return "px-1.5 py-0.5 rounded bg-green-500/10 text-green-600";
  if (completeness === "partial") return "px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-600";
  if (completeness === "stale") return "px-1.5 py-0.5 rounded bg-red-500/10 text-red-600";
  return "px-1.5 py-0.5 rounded bg-muted text-muted-foreground";
}

function resolutionStateClass(state: string): string {
  switch (state) {
    case "available":
      return "bg-green-500/10 text-green-600";
    case "dangling":
      return "bg-yellow-500/10 text-yellow-600";
    case "changed":
      return "bg-orange-500/10 text-orange-600";
    case "unauthorized":
      return "bg-red-500/10 text-red-600";
    default:
      return "bg-muted text-muted-foreground";
  }
}
