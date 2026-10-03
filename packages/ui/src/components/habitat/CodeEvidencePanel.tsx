import React, { useCallback, useEffect, useRef, useState } from "react";
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
import { GAP_REASONS, NOT_APPLICABLE_REASONS } from "@orcy/shared";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/Card.js";
import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { notify } from "../../lib/toast.js";
import { api } from "../../api/index.js";
import { queryKeys } from "../../lib/queryKeys.js";
import type {
  CodeEvidenceResponse,
  MissionCodeEvidenceResponse,
  CodeEvidenceLinkItem,
  CodeEvidenceGapItem,
  CodeEvidenceCompletenessStatus,
  CodeEvidenceVerificationState,
  CodeEvidenceType,
  CodeEvidenceCompatibility,
  GapReason,
  NotApplicableReason,
} from "../../types/index.js";

const OVERRIDE_CLASSIFICATION_LABEL: Record<"canonical" | "verified_legacy", string> = {
  canonical: "canonical target",
  verified_legacy: "verified legacy target",
};

type CodeEvidencePanelProps =
  | { targetType: "task"; targetId: string }
  | { targetType: "mission"; targetId: string };

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
  if (value === null) return "-";
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

function InlineEvidenceDialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    firstFocusable?.focus();
  }, []);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((el) => !el.hasAttribute("disabled"));
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      className="mb-4 rounded border bg-card p-3"
      onKeyDown={handleKeyDown}
    >
      <div className="mb-2 text-sm font-medium">{title}</div>
      {children}
    </div>
  );
}

export function CodeEvidencePanel({ targetType, targetId }: CodeEvidencePanelProps) {
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

  const isMission = targetType === "mission";
  const title = isMission ? "Mission Code Evidence" : "Code Evidence";
  const loadingLabel = isMission ? "Loading mission code evidence..." : "Loading code evidence...";
  const errorLabel = isMission
    ? "Failed to load mission code evidence"
    : "Failed to load code evidence";

  const evidenceQueryKey = isMission
    ? queryKeys.codeEvidence.mission(targetId)
    : queryKeys.codeEvidence.task(targetId);

  const invalidateQueries = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: evidenceQueryKey });
    queryClient.invalidateQueries({
      queryKey: isMission
        ? queryKeys.missions.details(targetId)
        : queryKeys.tasks.details(targetId),
    });
  }, [evidenceQueryKey, isMission, queryClient, targetId]);

  const {
    data: evidence,
    isLoading,
    error,
  } = useQuery<CodeEvidenceResponse | MissionCodeEvidenceResponse>({
    queryKey: evidenceQueryKey,
    queryFn: () =>
      isMission
        ? api.codeEvidence.getMissionEvidence(targetId)
        : api.codeEvidence.getTaskEvidence(targetId),
  });

  // Compatibility derivation is hoisted so the clear-all action and the
  // header badge share one authority; conflict multiplicity is the signal.
  const compatibility: CodeEvidenceCompatibility | undefined = evidence?.compatibility;
  const overrides = compatibility?.overrides ?? [];
  const hasOverrideConflict = overrides.length >= 2;

  const linkMutation = useMutation({
    mutationFn: (url: string) =>
      isMission
        ? api.codeEvidence.linkMissionCode(targetId, { pullRequestUrl: url })
        : api.codeEvidence.linkTaskCode(targetId, { pullRequestUrl: url }),
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
      isMission
        ? api.codeEvidence.markMissionNotApplicable(targetId, input)
        : api.codeEvidence.markTaskNotApplicable(targetId, input),
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
      isMission
        ? api.codeEvidence.reportMissionGap(targetId, input)
        : api.codeEvidence.reportTaskGap(targetId, input),
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

  // Clear-all recovery: removes the canonical override AND every verified
  // equivalent legacy override together (the server's atomic equivalent
  // clear), through the evidence-only persisted-ID adapter for Tasks. This
  // is the documented recovery for an override conflict and for a stale
  // not-applicable mark (mark itself refuses 409 while a verified legacy
  // override exists).
  const clearNotApplicableMutation = useMutation({
    mutationFn: () =>
      isMission
        ? api.codeEvidence.clearMissionNotApplicable(targetId)
        : api.codeEvidence.clearTaskNotApplicable(targetId),
    onSuccess: () => {
      notify.success("Cleared not-applicable overrides");
      invalidateQueries();
    },
    onError: (err: Error) => {
      notify.error(err.message);
    },
  });

  const closeLinkDialog = () => {
    setLinkDialogOpen(false);
    setLinkUrl("");
  };

  const closeNotApplicableDialog = () => {
    setNotApplicableDialogOpen(false);
    setSelectedNotApplicableReason("");
    setNotApplicableNote("");
  };

  const closeGapDialog = () => {
    setGapDialogOpen(false);
    setSelectedGapReason("");
    setGapNote("");
  };

  const handleLink = () => {
    const trimmed = linkUrl.trim();
    if (!trimmed) return;
    if (!URL.canParse(trimmed)) {
      notify.error("Enter a valid URL before linking evidence");
      return;
    }
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

  const actionButtons = (
    <div className="mb-3 flex gap-2">
      <Button size="sm" variant="outline" onClick={() => setLinkDialogOpen(true)}>
        <Plus className="mr-1 h-3 w-3" />
        Link Evidence
      </Button>
      <Button size="sm" variant="outline" onClick={() => setNotApplicableDialogOpen(true)}>
        <Ban className="mr-1 h-3 w-3" />
        Mark Not Applicable
      </Button>
      {overrides.length > 0 && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => clearNotApplicableMutation.mutate()}
          loading={clearNotApplicableMutation.isPending}
        >
          <CheckCircle className="mr-1 h-3 w-3" />
          Clear Not Applicable
        </Button>
      )}
      <Button size="sm" variant="outline" onClick={() => setGapDialogOpen(true)}>
        <AlertTriangle className="mr-1 h-3 w-3" />
        Report Gap
      </Button>
    </div>
  );

  const dialogs = (
    <>
      {linkDialogOpen && (
        <InlineEvidenceDialog title="Link Code Evidence" onClose={closeLinkDialog}>
          <div className="flex gap-2">
            <input
              type="url"
              aria-label="Code evidence URL"
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
            <Button size="sm" variant="ghost" onClick={closeLinkDialog}>
              Cancel
            </Button>
          </div>
        </InlineEvidenceDialog>
      )}

      {notApplicableDialogOpen && (
        <InlineEvidenceDialog title="Mark Not Applicable" onClose={closeNotApplicableDialog}>
          <select
            aria-label="Not applicable reason"
            className="mb-2 w-full rounded border bg-input px-3 py-1.5 text-sm"
            value={selectedNotApplicableReason}
            onChange={(e) => setSelectedNotApplicableReason(e.target.value as NotApplicableReason)}
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
            aria-label="Not applicable note"
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
            <Button size="sm" variant="ghost" onClick={closeNotApplicableDialog}>
              Cancel
            </Button>
          </div>
        </InlineEvidenceDialog>
      )}

      {gapDialogOpen && (
        <InlineEvidenceDialog title="Report Evidence Gap" onClose={closeGapDialog}>
          <select
            aria-label="Evidence gap reason"
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
            aria-label="Evidence gap note"
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
            <Button size="sm" variant="ghost" onClick={closeGapDialog}>
              Cancel
            </Button>
          </div>
        </InlineEvidenceDialog>
      )}
    </>
  );

  if (isLoading) {
    return (
      <Card className="mb-4">
        <CardContent className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {loadingLabel}
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="mb-4">
        <CardContent className="p-4 text-sm text-red-600 dark:text-red-400">
          {errorLabel}: {error.message}
        </CardContent>
      </Card>
    );
  }

  const completeness = evidence?.completeness;
  const legacy = compatibility?.legacy;
  const groups = evidence?.groups ?? [];
  const gaps = evidence?.activeGaps ?? [];
  // The effective badge is the compatibility-aware verdict when the section
  // exists: a multi-override conflict is an explicit unknown with every
  // override shown — the canonical-only completeness is never presented as
  // overall truth in that state.
  const badgeStatus: CodeEvidenceCompletenessStatus | undefined = compatibility
    ? compatibility.effectiveCompleteness.status
    : completeness?.status;
  const hasLinks =
    groups.some((g) => g.items.length > 0) ||
    Boolean(legacy?.groups.some((g) => g.items.length > 0));
  // Override rows (including a two-override conflict with zero active
  // evidence) always keep the view NON-empty — their owners, reasons and
  // warnings stay visible, with the clear-all recovery available.
  const isEmpty =
    !hasLinks &&
    gaps.length === 0 &&
    (legacy?.activeGaps.length ?? 0) === 0 &&
    overrides.length === 0 &&
    badgeStatus === "unknown";

  return (
    <Card className="mb-4">
      <CardHeader className="p-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Code2 className="h-4 w-4" />
          {title}
          {!isEmpty && badgeStatus && (
            <Badge className={COMPLETENESS_BADGE[badgeStatus]}>
              {COMPLETENESS_LABEL[badgeStatus]}
            </Badge>
          )}
          {hasOverrideConflict && (
            <Badge className="glass-badge-blocked">Override conflict</Badge>
          )}
          {!isEmpty && evidence?.summary && (
            <span className="ml-auto text-xs text-muted-foreground">
              {evidence.summary.activeLinks} linked
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        {actionButtons}
        {dialogs}

        {isEmpty ? (
          <div className="py-4 text-center text-sm text-muted-foreground">
            <Link2 className="mx-auto mb-1 h-6 w-6 opacity-40" />
            No code evidence linked
          </div>
        ) : (
          <>
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
                  {gaps.map((gap) => (
                    <GapItem key={gap.id} gap={gap} />
                  ))}
                </div>
              </div>
            )}

            {legacy && (
              <div className="mt-4 border-t pt-3">
                <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
                  <Code2 className="h-3 w-3" />
                  {legacy.label} (<code>{legacy.storedTarget.id}</code>) —{" "}
                  {legacy.summary.activeLinks} linked
                  {compatibility?.truncation.legacyActiveLinks ? "+ (truncated)" : ""}
                </h4>
                {legacy.groups.map((group) => {
                  if (group.items.length === 0) return null;
                  const Icon = EVIDENCE_ICON[group.evidenceType] ?? Code2;
                  const label = EVIDENCE_LABEL[group.evidenceType] ?? group.evidenceType;
                  return (
                    <div key={`legacy-${group.evidenceType}`} className="mb-3">
                      <h5 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase text-muted-foreground">
                        <Icon className="h-3 w-3" />
                        {label} ({group.items.length})
                      </h5>
                      <div className="space-y-1.5">
                        {group.items.map((item) => (
                          <EvidenceLinkItem key={item.linkId} item={item} />
                        ))}
                      </div>
                    </div>
                  );
                })}
                {legacy.activeGaps.length > 0 && (
                  <div className="mt-3">
                    <h5 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase text-muted-foreground">
                      <AlertTriangle className="h-3 w-3" />
                      Legacy Active Gaps ({legacy.activeGaps.length}
                      {compatibility?.truncation.legacyActiveGaps ? "+ (truncated)" : ""})
                    </h5>
                    <div className="space-y-1.5">
                      {legacy.activeGaps.map((gap) => (
                        <GapItem key={gap.id} gap={gap} />
                      ))}
                    </div>
                  </div>
                )}
                {legacy.groups.every((g) => g.items.length === 0) &&
                  legacy.activeGaps.length === 0 && (
                    <div className="text-xs text-muted-foreground">
                      No active legacy evidence rows under this verified alias pair.
                    </div>
                  )}
              </div>
            )}
          </>
        )}

        {/* Override rows and warnings render in BOTH branches: an
            override-only or conflicting view is never empty and always
            shows every owner, reason and warning. */}
            {overrides.length > 0 && (
              <div className="mt-4 rounded border border-yellow-300 bg-yellow-50 p-2 text-sm dark:border-yellow-800 dark:bg-yellow-950">
                <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase text-yellow-800 dark:text-yellow-200">
                  <Ban className="h-3 w-3" />
                  Not-Applicable Overrides ({overrides.length})
                  {hasOverrideConflict && " — conflict, no winner applied"}
                </h4>
                <div className="space-y-1">
                  {overrides.map((entry) => (
                    <div
                      key={`${entry.storedTarget.type}:${entry.storedTarget.id}`}
                      className="text-xs text-yellow-800 dark:text-yellow-200"
                    >
                      {OVERRIDE_CLASSIFICATION_LABEL[entry.classification]}{" "}
                      <code>{entry.storedTarget.id}</code>
                      {entry.value.reasonCode ? ` — ${entry.value.reasonCode.replace(/_/g, " ")}` : ""}
                      {entry.value.reasonNote ? ` — ${entry.value.reasonNote}` : ""}
                      {/* Actor provenance is part of the row so every override owner is visible. */}
                      {entry.value.actor ? ` (by ${entry.value.actor.type} ${entry.value.actor.id})` : ""}
                    </div>
                  ))}
                </div>
              </div>
            )}

        {evidence?.warnings && evidence.warnings.length > 0 && (
          <div className="mt-3 space-y-1">
            {evidence.warnings.map((w) => (
              <div key={w} className="text-xs text-yellow-600 dark:text-yellow-400">
                {w}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
