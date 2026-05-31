import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Code2,
  GitBranch,
  GitPullRequest,
  GitCommitHorizontal,
  Activity,
  CheckCircle,
  ExternalLink,
  FileCode,
  Plus,
  AlertTriangle,
  Ban,
  Loader2,
  Link2,
} from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/Card.js";
import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { notify } from "../../lib/toast.js";
import { api } from "../../api/index.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { GAP_REASONS, NOT_APPLICABLE_REASONS } from "@orcy/shared";
import type {
  CodeEvidenceResponse,
  CodeEvidenceLinkItem,
  CodeEvidenceGapItem,
  CodeEvidenceCompletenessStatus,
  CodeEvidenceVerificationState,
  CodeEvidenceType,
  GapReason,
  NotApplicableReason,
} from "../../types/index.js";

interface TaskCodeEvidenceProps {
  taskId: string;
}

const COMPLETENESS_BADGE: Record<CodeEvidenceCompletenessStatus, string> = {
  complete: "glass-badge-done",
  partial: "glass-badge-review",
  missing: "glass-badge-blocked",
  not_applicable: "glass-badge-low",
  unknown: "glass-badge-low",
};

const COMPLETENESS_LABEL: Record<CodeEvidenceCompletenessStatus, string> = {
  complete: "Complete",
  partial: "Partial",
  missing: "Missing",
  not_applicable: "Not Applicable",
  unknown: "Unknown",
};

const VERIFICATION_BADGE: Record<CodeEvidenceVerificationState, string> = {
  verified: "glass-badge-done",
  unverified: "glass-badge-low",
  stale: "glass-badge-review",
  failed: "glass-badge-blocked",
};

const EVIDENCE_ICON: Record<CodeEvidenceType, React.ElementType> = {
  branch: GitBranch,
  pull_request: GitPullRequest,
  commit: GitCommitHorizontal,
  pipeline_run: Activity,
  review: CheckCircle,
  external_url: ExternalLink,
  changed_file: FileCode,
};

const EVIDENCE_LABEL: Record<CodeEvidenceType, string> = {
  branch: "Branches",
  pull_request: "Pull Requests",
  commit: "Commits",
  pipeline_run: "Pipelines",
  review: "Reviews",
  external_url: "External Links",
  changed_file: "Changed Files",
};

const LINK_STATUS_BADGE: Record<string, string> = {
  active: "glass-badge-done",
  superseded: "glass-badge-low",
  incorrect: "glass-badge-blocked",
  removed: "glass-badge-low",
};

function formatConfidence(value: number | null): string {
  if (value === null) return "—";
  return `${Math.round(value * 100)}%`;
}

function EvidenceLinkItem({ item }: { item: CodeEvidenceLinkItem }) {
  return (
    <div className="flex items-center gap-2 rounded border p-2 text-sm">
      <Badge className={VERIFICATION_BADGE[item.verificationState]}>{item.verificationState}</Badge>
      <div className="flex-1 min-w-0">
        {item.url ? (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary hover:underline truncate block"
          >
            {item.title || item.url}
          </a>
        ) : (
          <span className="truncate block text-muted-foreground">
            {item.title || item.evidenceId || "Untitled"}
          </span>
        )}
      </div>
      {item.confidence !== null && (
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatConfidence(item.confidence)}
        </span>
      )}
      {item.linkSources.length > 0 && (
        <Badge className="glass-badge-low">{item.linkSources[0].replace(/_/g, " ")}</Badge>
      )}
      <Badge className={LINK_STATUS_BADGE[item.status] || "glass-badge-low"}>{item.status}</Badge>
    </div>
  );
}

function GapItem({ gap }: { gap: CodeEvidenceGapItem }) {
  return (
    <div className="flex items-start gap-2 rounded border border-yellow-300 bg-yellow-50 p-2 text-sm dark:border-yellow-800 dark:bg-yellow-950">
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-yellow-600 dark:text-yellow-400" />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-yellow-800 dark:text-yellow-200">
          {gap.reasonCode.replace(/_/g, " ")}
        </div>
        {gap.reasonNote && (
          <p className="mt-0.5 text-xs text-yellow-700 dark:text-yellow-300">{gap.reasonNote}</p>
        )}
        <div className="mt-1 text-[10px] text-yellow-600 dark:text-yellow-400">
          Reported {new Date(gap.reportedAt).toLocaleDateString()}
        </div>
      </div>
    </div>
  );
}

export function TaskCodeEvidence({ taskId }: TaskCodeEvidenceProps) {
  const queryClient = useQueryClient();

  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [notApplicableDialogOpen, setNotApplicableDialogOpen] = useState(false);
  const [gapDialogOpen, setGapDialogOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [selectedNotApplicableReason, setSelectedNotApplicableReason] = useState<
    NotApplicableReason | ""
  >("");
  const [notApplicableNote, setNotApplicableNote] = useState("");
  const [selectedGapReason, setSelectedGapReason] = useState<GapReason | "">("");
  const [gapNote, setGapNote] = useState("");

  const invalidateQueries = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.codeEvidence.task(taskId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(taskId) });
  };

  const {
    data: evidence,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.codeEvidence.task(taskId),
    queryFn: () => api.codeEvidence.getTaskEvidence(taskId),
  });

  const linkMutation = useMutation({
    mutationFn: (url: string) => api.codeEvidence.linkTaskCode(taskId, { pullRequestUrl: url }),
    onSuccess: () => {
      notify.success("Evidence linked");
      setLinkDialogOpen(false);
      setLinkUrl("");
      invalidateQueries();
    },
    onError: (err: Error) => {
      notify.error(err.message);
    },
  });

  const notApplicableMutation = useMutation({
    mutationFn: (input: { reasonCode?: string; reasonNote?: string }) =>
      api.codeEvidence.markTaskNotApplicable(taskId, input),
    onSuccess: () => {
      notify.success("Marked as not applicable");
      setNotApplicableDialogOpen(false);
      setSelectedNotApplicableReason("");
      setNotApplicableNote("");
      invalidateQueries();
    },
    onError: (err: Error) => {
      notify.error(err.message);
    },
  });

  const gapMutation = useMutation({
    mutationFn: (input: { reasonCode: string; reasonNote?: string }) =>
      api.codeEvidence.reportTaskGap(taskId, input),
    onSuccess: () => {
      notify.success("Gap reported");
      setGapDialogOpen(false);
      setSelectedGapReason("");
      setGapNote("");
      invalidateQueries();
    },
    onError: (err: Error) => {
      notify.error(err.message);
    },
  });

  const handleLink = () => {
    const trimmed = linkUrl.trim();
    if (!trimmed) return;
    linkMutation.mutate(trimmed);
  };

  const handleNotApplicable = () => {
    if (!selectedNotApplicableReason) return;
    notApplicableMutation.mutate({
      reasonCode: selectedNotApplicableReason,
      reasonNote: notApplicableNote.trim() || undefined,
    });
  };

  const handleGap = () => {
    if (!selectedGapReason) return;
    gapMutation.mutate({
      reasonCode: selectedGapReason,
      reasonNote: gapNote.trim() || undefined,
    });
  };

  if (isLoading) {
    return (
      <Card className="mb-4">
        <CardContent className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading code evidence...
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="mb-4">
        <CardContent className="p-4 text-sm text-red-600 dark:text-red-400">
          Failed to load code evidence: {error.message}
        </CardContent>
      </Card>
    );
  }

  const completeness = evidence?.completeness;
  const groups = evidence?.groups ?? [];
  const gaps = evidence?.activeGaps ?? [];
  const hasLinks = groups.some((g) => g.items.length > 0);

  if (!hasLinks && gaps.length === 0 && completeness?.status === "unknown") {
    return (
      <Card className="mb-4">
        <CardHeader className="p-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Code2 className="h-4 w-4" />
            Code Evidence
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          <div className="mb-3 flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setLinkDialogOpen(true)}>
              <Plus className="mr-1 h-3 w-3" />
              Link Evidence
            </Button>
            <Button size="sm" variant="outline" onClick={() => setNotApplicableDialogOpen(true)}>
              <Ban className="mr-1 h-3 w-3" />
              Mark Not Applicable
            </Button>
            <Button size="sm" variant="outline" onClick={() => setGapDialogOpen(true)}>
              <AlertTriangle className="mr-1 h-3 w-3" />
              Report Gap
            </Button>
          </div>

          {linkDialogOpen && (
            <div className="mb-4 rounded border bg-card p-3">
              <div className="mb-2 text-sm font-medium">Link Code Evidence</div>
              <div className="flex gap-2">
                <input
                  type="url"
                  className="flex-1 rounded border bg-input px-3 py-1.5 text-sm"
                  placeholder="GitHub PR, commit, or pipeline URL"
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleLink();
                  }}
                />
                <Button size="sm" onClick={handleLink} loading={linkMutation.isPending}>
                  Link
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setLinkDialogOpen(false);
                    setLinkUrl("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {notApplicableDialogOpen && (
            <div className="mb-4 rounded border bg-card p-3">
              <div className="mb-2 text-sm font-medium">Mark Not Applicable</div>
              <select
                className="mb-2 w-full rounded border bg-input px-3 py-1.5 text-sm"
                value={selectedNotApplicableReason}
                onChange={(e) =>
                  setSelectedNotApplicableReason(e.target.value as NotApplicableReason)
                }
              >
                <option value="">Select reason...</option>
                {NOT_APPLICABLE_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
              <input
                type="text"
                className="mb-2 w-full rounded border bg-input px-3 py-1.5 text-sm"
                placeholder="Additional note (optional)"
                value={notApplicableNote}
                onChange={(e) => setNotApplicableNote(e.target.value)}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleNotApplicable}
                  loading={notApplicableMutation.isPending}
                  disabled={!selectedNotApplicableReason}
                >
                  Confirm
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setNotApplicableDialogOpen(false);
                    setSelectedNotApplicableReason("");
                    setNotApplicableNote("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {gapDialogOpen && (
            <div className="mb-4 rounded border bg-card p-3">
              <div className="mb-2 text-sm font-medium">Report Evidence Gap</div>
              <select
                className="mb-2 w-full rounded border bg-input px-3 py-1.5 text-sm"
                value={selectedGapReason}
                onChange={(e) => setSelectedGapReason(e.target.value as GapReason)}
              >
                <option value="">Select reason...</option>
                {GAP_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
              <input
                type="text"
                className="mb-2 w-full rounded border bg-input px-3 py-1.5 text-sm"
                placeholder="Additional note (optional)"
                value={gapNote}
                onChange={(e) => setGapNote(e.target.value)}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleGap}
                  loading={gapMutation.isPending}
                  disabled={!selectedGapReason}
                >
                  Report
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setGapDialogOpen(false);
                    setSelectedGapReason("");
                    setGapNote("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          <div className="py-4 text-center text-sm text-muted-foreground">
            <Link2 className="mx-auto mb-1 h-6 w-6 opacity-40" />
            No code evidence linked
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mb-4">
      <CardHeader className="p-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Code2 className="h-4 w-4" />
          Code Evidence
          {completeness && (
            <Badge className={COMPLETENESS_BADGE[completeness.status]}>
              {COMPLETENESS_LABEL[completeness.status]}
            </Badge>
          )}
          {evidence?.summary && (
            <span className="ml-auto text-xs text-muted-foreground">
              {evidence.summary.activeLinks} linked
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        <div className="mb-3 flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setLinkDialogOpen(true)}>
            <Plus className="mr-1 h-3 w-3" />
            Link Evidence
          </Button>
          <Button size="sm" variant="outline" onClick={() => setNotApplicableDialogOpen(true)}>
            <Ban className="mr-1 h-3 w-3" />
            Mark Not Applicable
          </Button>
          <Button size="sm" variant="outline" onClick={() => setGapDialogOpen(true)}>
            <AlertTriangle className="mr-1 h-3 w-3" />
            Report Gap
          </Button>
        </div>

        {linkDialogOpen && (
          <div className="mb-4 rounded border bg-card p-3">
            <div className="mb-2 text-sm font-medium">Link Code Evidence</div>
            <div className="flex gap-2">
              <input
                type="url"
                className="flex-1 rounded border bg-input px-3 py-1.5 text-sm"
                placeholder="GitHub PR, commit, or pipeline URL"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleLink();
                }}
              />
              <Button size="sm" onClick={handleLink} loading={linkMutation.isPending}>
                Link
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setLinkDialogOpen(false);
                  setLinkUrl("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {notApplicableDialogOpen && (
          <div className="mb-4 rounded border bg-card p-3">
            <div className="mb-2 text-sm font-medium">Mark Not Applicable</div>
            <select
              className="mb-2 w-full rounded border bg-input px-3 py-1.5 text-sm"
              value={selectedNotApplicableReason}
              onChange={(e) =>
                setSelectedNotApplicableReason(e.target.value as NotApplicableReason)
              }
            >
              <option value="">Select reason...</option>
              {NOT_APPLICABLE_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <input
              type="text"
              className="mb-2 w-full rounded border bg-input px-3 py-1.5 text-sm"
              placeholder="Additional note (optional)"
              value={notApplicableNote}
              onChange={(e) => setNotApplicableNote(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleNotApplicable}
                loading={notApplicableMutation.isPending}
                disabled={!selectedNotApplicableReason}
              >
                Confirm
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setNotApplicableDialogOpen(false);
                  setSelectedNotApplicableReason("");
                  setNotApplicableNote("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {gapDialogOpen && (
          <div className="mb-4 rounded border bg-card p-3">
            <div className="mb-2 text-sm font-medium">Report Evidence Gap</div>
            <select
              className="mb-2 w-full rounded border bg-input px-3 py-1.5 text-sm"
              value={selectedGapReason}
              onChange={(e) => setSelectedGapReason(e.target.value as GapReason)}
            >
              <option value="">Select reason...</option>
              {GAP_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <input
              type="text"
              className="mb-2 w-full rounded border bg-input px-3 py-1.5 text-sm"
              placeholder="Additional note (optional)"
              value={gapNote}
              onChange={(e) => setGapNote(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleGap}
                loading={gapMutation.isPending}
                disabled={!selectedGapReason}
              >
                Report
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setGapDialogOpen(false);
                  setSelectedGapReason("");
                  setGapNote("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {groups.map((group) => {
          if (group.items.length === 0) return null;
          const Icon = EVIDENCE_ICON[group.evidenceType] ?? Code2;
          const label = EVIDENCE_LABEL[group.evidenceType] ?? group.evidenceType;
          return (
            <div key={group.evidenceType} className="mb-3">
              <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
                <Icon className="h-3 w-3" />
                {label} ({group.items.length})
              </h4>
              <div className="space-y-1.5">
                {group.items.map((item) => (
                  <EvidenceLinkItem key={item.linkId} item={item} />
                ))}
              </div>
            </div>
          );
        })}

        {gaps.length > 0 && (
          <div className="mt-4">
            <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
              <AlertTriangle className="h-3 w-3" />
              Active Gaps ({gaps.length})
            </h4>
            <div className="space-y-1.5">
              {gaps.map((gap: any) => (
                <GapItem key={gap.id} gap={gap} />
              ))}
            </div>
          </div>
        )}

        {evidence?.warnings && evidence.warnings.length > 0 && (
          <div className="mt-3 space-y-1">
            {evidence.warnings.map((w: any, i: number) => (
              <div key={i} className="text-xs text-yellow-600 dark:text-yellow-400">
                {w}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
