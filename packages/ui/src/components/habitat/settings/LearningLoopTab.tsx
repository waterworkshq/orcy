/**
 * Learning Loop settings/operations tab.
 *
 * Policy configuration (extractor, source types, schedule, window/lookback),
 * enable/disable toggle (feature defaults OFF — surface the disabled state
 * honestly), privacy thresholds that may only raise the floor, and manual
 * controls: ensure, fresh rerun (reason required), dry run.
 *
 * Mirrors the ReviewRulesTab pattern (inline mutations, no ref-based save).
 * React Query is the sole server-state authority (ADR-0040).
 *
 * NO Wiki publish affordance (ticket 7). NO Automation Rule create/enable.
 */
import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ToggleSwitch } from "../../ui/ToggleSwitch.js";
import { Button } from "../../ui/Button.js";
import { ConfirmDialog } from "../../ui/ConfirmDialog.js";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogContent,
  DialogFooter,
} from "../../ui/Dialog.js";
import { api } from "../../../api/index.js";
import { notify } from "../../../lib/toast.js";
import { queryKeys } from "../../../lib/queryKeys.js";
import type {
  LearningLoopPolicyRow,
  ExtractionRunHistoryEntry,
} from "../../../types/index.js";

interface LearningLoopTabProps {
  habitatId: string;
}

export function LearningLoopTab({ habitatId }: LearningLoopTabProps) {
  const queryClient = useQueryClient();
  const [confirmAction, setConfirmAction] = useState<{
    type: "ensure" | "freshRerun" | "dryRun";
    policyId: string;
  } | null>(null);
  const [freshRerunReason, setFreshRerunReason] = useState("");
  const [freshRerunPolicyId, setFreshRerunPolicyId] = useState<string | null>(null);

  const { data: policies = [], isLoading: loadingPolicies } = useQuery({
    queryKey: queryKeys.extraction.policies(habitatId),
    queryFn: ({ signal }: { signal?: AbortSignal }) =>
      api.extraction.listPolicies(habitatId, signal),
    enabled: !!habitatId,
  });

  const { data: runHistory = [], isLoading: loadingHistory } = useQuery({
    queryKey: queryKeys.extraction.runHistory(habitatId),
    queryFn: ({ signal }: { signal?: AbortSignal }) =>
      api.extraction.getRunHistory(habitatId, signal),
    enabled: !!habitatId,
  });

  function invalidateExtraction() {
    queryClient.invalidateQueries({ queryKey: queryKeys.extraction.all });
  }

  const toggleMutation = useMutation({
    mutationFn: ({
      policyId,
      enabled,
      version,
    }: {
      policyId: string;
      enabled: boolean;
      version: number;
    }) =>
      api.extraction.updatePolicy(habitatId, policyId, {
        expectedVersion: version,
        enabled,
      }),
    onSuccess: () => {
      invalidateExtraction();
      notify.success("Learning Loop policy updated");
    },
    onError: (err: Error) => {
      notify.error(err.message);
    },
  });

  const ensureMutation = useMutation({
    mutationFn: (policyId: string) => api.extraction.ensureRun(habitatId, policyId),
    onSuccess: () => {
      invalidateExtraction();
      notify.success("Ensure run completed");
    },
    onError: (err: Error) => {
      notify.error(err.message);
    },
  });

  const freshRerunMutation = useMutation({
    mutationFn: ({ policyId, reason }: { policyId: string; reason: string }) =>
      api.extraction.freshRerun(habitatId, policyId, reason),
    onSuccess: () => {
      invalidateExtraction();
      notify.success("Fresh rerun completed");
      setFreshRerunReason("");
      setFreshRerunPolicyId(null);
    },
    onError: (err: Error) => {
      notify.error(err.message);
    },
  });

  const dryRunMutation = useMutation({
    mutationFn: (policyId: string) => api.extraction.dryRun(habitatId, policyId),
    onSuccess: () => {
      invalidateExtraction();
      notify.success("Dry run completed — no findings persisted");
    },
    onError: (err: Error) => {
      notify.error(err.message);
    },
  });

  const isAnyEnabled = policies.some((p) => p.enabled);
  const isRunning = ensureMutation.isPending || freshRerunMutation.isPending || dryRunMutation.isPending;

  if (loadingPolicies) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        Loading Learning Loop settings...
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="learning-loop-tab">
      {/* Feature state banner */}
      <div
        className={`rounded border p-3 ${
          isAnyEnabled
            ? "border-border bg-muted/30"
            : "border-border bg-muted/20"
        }`}
      >
        <p className="text-sm font-medium">
          Learning Loop: {isAnyEnabled ? "Enabled" : "Disabled (off by default)"}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          The Learning Loop defaults off globally and per-habitat. No extraction
          runs occur until both layers are enabled. Enable a policy below to
          activate extraction for this habitat.
        </p>
      </div>

      {/* Policy list */}
      {policies.length === 0 && (
        <div className="rounded border border-border p-6 text-center">
          <p className="text-sm text-muted-foreground">
            No extraction policies configured. The Learning Loop is not running
            for this habitat.
          </p>
        </div>
      )}

      {policies.map((policy) => (
        <PolicyCard
          key={policy.id}
          policy={policy}
          habitatId={habitatId}
          isRunning={isRunning}
          onToggle={(enabled) =>
            toggleMutation.mutate({
              policyId: policy.id,
              enabled,
              version: policy.version,
            })
          }
          onEnsure={() => setConfirmAction({ type: "ensure", policyId: policy.id })}
          onFreshRerun={() => {
            setFreshRerunPolicyId(policy.id);
          }}
          onDryRun={() => setConfirmAction({ type: "dryRun", policyId: policy.id })}
        />
      ))}

      {/* Fresh rerun reason dialog */}
      <Dialog
        open={freshRerunPolicyId !== null}
        onClose={() => {
          setFreshRerunPolicyId(null);
          setFreshRerunReason("");
        }}
      >
        <DialogHeader>
          <DialogTitle>Fresh Rerun — Reason Required</DialogTitle>
        </DialogHeader>
        <DialogContent>
          <p className="text-sm text-muted-foreground mb-2">
            Enter a reason for this fresh rerun. This supersedes previous work
            and cannot be undone.
          </p>
          <textarea
            id="fresh-rerun-reason"
            className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            rows={3}
            placeholder="Why is this fresh rerun needed?"
            value={freshRerunReason}
            onChange={(e) => setFreshRerunReason(e.target.value)}
            aria-label="Fresh rerun reason"
          />
        </DialogContent>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              setFreshRerunPolicyId(null);
              setFreshRerunReason("");
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (freshRerunPolicyId && freshRerunReason.trim()) {
                freshRerunMutation.mutate({
                  policyId: freshRerunPolicyId,
                  reason: freshRerunReason.trim(),
                });
              }
            }}
            disabled={!freshRerunReason.trim()}
            loading={freshRerunMutation.isPending}
          >
            {freshRerunReason.trim() ? "Run Fresh Rerun" : "Reason required"}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Ensure confirm */}
      <ConfirmDialog
        open={confirmAction?.type === "ensure"}
        onConfirm={() => {
          if (confirmAction) {
            ensureMutation.mutate(confirmAction.policyId);
          }
          setConfirmAction(null);
        }}
        onCancel={() => setConfirmAction(null)}
        title="Ensure Extraction"
        description="Replay extraction to converge on deduplicated work items. This is the same as a scheduled run."
        confirmLabel="Ensure"
      />

      {/* Dry run confirm */}
      <ConfirmDialog
        open={confirmAction?.type === "dryRun"}
        onConfirm={() => {
          if (confirmAction) {
            dryRunMutation.mutate(confirmAction.policyId);
          }
          setConfirmAction(null);
        }}
        onCancel={() => setConfirmAction(null)}
        title="Dry Run Extraction"
        description="Run extraction diagnostics without persisting any findings. No data is written."
        confirmLabel="Dry Run"
      />

      {/* Run/work history */}
      <RunHistoryList runs={runHistory} loading={loadingHistory} />

      <details className="border border-border rounded-md">
        <summary className="px-3 py-2 text-sm font-medium cursor-pointer hover:bg-muted/50">
          How the Learning Loop works
        </summary>
        <div className="px-3 pb-3 text-xs text-muted-foreground space-y-1">
          <p>
            The Learning Loop extracts lessons, conventions, risks, and rule
            recommendations from your habitat&apos;s activity. It defaults off and
            requires explicit per-habitat enablement.
          </p>
          <p>
            <strong>Ensure</strong> replays extraction to converge on deduplicated
            work — identical to a scheduled run.
          </p>
          <p>
            <strong>Fresh Rerun</strong> supersedes previous work items for a new
            extraction pass. A reason is required and recorded.
          </p>
          <p>
            <strong>Dry Run</strong> executes extraction diagnostics without
            persisting findings. Use it to validate policy configuration.
          </p>
        </div>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Policy card
// ---------------------------------------------------------------------------

interface PolicyCardProps {
  policy: LearningLoopPolicyRow;
  habitatId: string;
  isRunning: boolean;
  onToggle: (enabled: boolean) => void;
  onEnsure: () => void;
  onFreshRerun: () => void;
  onDryRun: () => void;
}

function PolicyCard({
  policy,
  isRunning,
  onToggle,
  onEnsure,
  onFreshRerun,
  onDryRun,
}: PolicyCardProps) {
  return (
    <div className="rounded border border-border p-4 space-y-3" data-testid={`policy-${policy.id}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ToggleSwitch
            checked={policy.enabled}
            onChange={() => onToggle(!policy.enabled)}
            aria-label={`Toggle policy ${policy.extractorKey}`}
          />
          <div>
            <p className="text-sm font-medium">{policy.extractorKey}</p>
            <p className="text-xs text-muted-foreground">
              Schedule: {policy.schedule} · Window: {formatDuration(policy.windowSeconds)} ·
              Lookback: {formatDuration(policy.lookbackSeconds)}
            </p>
          </div>
        </div>
        <span
          className={`text-xs px-2 py-1 rounded ${
            policy.enabled
              ? "bg-green-500/10 text-green-600"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {policy.enabled ? "Enabled" : "Disabled"}
        </span>
      </div>

      <div className="text-xs text-muted-foreground space-y-1">
        <p>
          Sources: {policy.sourceTypes.join(", ")}
          {policy.minConfidence !== null && ` · Min confidence: ${policy.minConfidence}`}
          {policy.minSampleSize !== null && ` · Min sample: ${policy.minSampleSize}`}
        </p>
        <p>Version: {policy.version}</p>
      </div>

      <div className="flex gap-2 pt-2 border-t border-border">
        <Button
          variant="ghost"
          size="sm"
          onClick={onEnsure}
          disabled={isRunning || !policy.enabled}
          aria-label={`Ensure run for ${policy.extractorKey}`}
        >
          Ensure
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onFreshRerun}
          disabled={isRunning}
          aria-label={`Fresh rerun for ${policy.extractorKey}`}
        >
          Fresh Rerun
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDryRun}
          disabled={isRunning}
          aria-label={`Dry run for ${policy.extractorKey}`}
        >
          Dry Run
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run history list
// ---------------------------------------------------------------------------

function RunHistoryList({
  runs,
  loading,
}: {
  runs: ExtractionRunHistoryEntry[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="py-4 text-center text-sm text-muted-foreground">
        Loading run history...
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="rounded border border-border p-4 text-center">
        <p className="text-xs text-muted-foreground">No extraction runs recorded.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="run-history">
      <p className="text-sm font-medium">Run History</p>
      {runs.map((run) => (
        <div
          key={run.id}
          className={`rounded border p-2 text-xs ${
            run.status === "failed"
              ? "border-red-500/30 bg-red-500/5"
              : run.status === "partial"
                ? "border-yellow-500/30 bg-yellow-500/5"
                : run.status === "skipped"
                  ? "border-border bg-muted/20"
                  : "border-border"
          }`}
          data-testid={`run-${run.id}`}
          data-run-status={run.status}
        >
          <div className="flex items-center justify-between">
            <span className="font-medium">
              {run.extractorKey} · {run.status}
            </span>
            <span className="text-muted-foreground">
              {run.deliveryMode}
            </span>
          </div>
          <div className="text-muted-foreground mt-1">
            Candidates: {run.candidateCount} · Persisted: {run.persistedCount} ·
            Deduplicated: {run.deduplicatedCount}
            {run.completedAt && ` · Completed: ${new Date(run.completedAt).toLocaleString()}`}
          </div>
          {run.error && (
            <p className="text-red-600 mt-1" data-testid={`run-error-${run.id}`}>
              Error: {run.error}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(seconds: number): string {
  if (seconds >= 86400) return `${Math.round(seconds / 86400)}d`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}
