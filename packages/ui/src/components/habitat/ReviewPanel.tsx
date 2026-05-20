import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../ui/Button.js';
import { Tooltip } from '../ui/Tooltip.js';
import { notify } from '../../lib/toast.js';
import { api } from '../../api/index.js';
import type { Artifact, TaskReviewer, Agent } from '../../types/index.js';
import { CheckCircle, XCircle, Link2, ArrowRight, AlertTriangle, User, Bot, ShieldCheck } from 'lucide-react';
import { MarkdownContent } from '../ui/MarkdownContent.js';

interface ReviewPanelProps {
  taskId: string;
  result: string;
  artifacts: Artifact[];
  autoAdvance?: boolean;
  nextColumnName?: string;
  onApprove: (reviewerId: string) => Promise<void>;
  onReject: (reviewerId: string, reason: string) => Promise<void>;
  isSubmitting: boolean;
  reviewers: TaskReviewer[];
  currentUserId: string | undefined;
  currentUserIsReviewer: boolean;
  reviewProgress: { approved: number; total: number };
  agents: Agent[];
}

function getReviewerName(reviewer: TaskReviewer, agents: Agent[]): string {
  if (reviewer.reviewerType === 'agent') {
    const agent = agents.find(a => a.id === reviewer.reviewerId);
    return agent?.name ?? `Agent ${reviewer.reviewerId.slice(0, 4)}`;
  }
  return `Human ${reviewer.reviewerId.slice(0, 4)}`;
}

function StatusBadge({ status }: { status: TaskReviewer['status'] }) {
  const config: Record<string, { color: string; label: string }> = {
    pending: { color: 'text-amber-600 dark:text-amber-400', label: 'Pending' },
    approved: { color: 'text-green-600 dark:text-green-400', label: 'Approved' },
    rejected: { color: 'text-red-600 dark:text-red-400', label: 'Rejected' },
    skipped: { color: 'text-gray-500 dark:text-gray-400', label: 'Skipped' },
  };
  const { color, label } = config[status] ?? config.pending;

  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${color}`}>
      {status === 'approved' && <CheckCircle className="h-3 w-3" />}
      {status === 'rejected' && <XCircle className="h-3 w-3" />}
      {status === 'pending' && <span className="h-2 w-2 rounded-full bg-amber-500" />}
      {status === 'skipped' && <span className="h-2 w-2 rounded-full bg-gray-400" />}
      {label}
    </span>
  );
}

function ReviewerIcon({ type }: { type: TaskReviewer['reviewerType'] }) {
  if (type === 'agent') return <Bot className="h-3.5 w-3.5 text-blue-500" />;
  return <User className="h-3.5 w-3.5 text-violet-500" />;
}

export function ReviewPanel({
  taskId,
  result,
  artifacts,
  autoAdvance,
  nextColumnName,
  onApprove,
  onReject,
  isSubmitting,
  reviewers,
  currentUserId,
  currentUserIsReviewer,
  reviewProgress,
  agents,
}: ReviewPanelProps) {
  const [rejectReason, setRejectReason] = useState('');
  const [showReject, setShowReject] = useState(false);
  const [showAutoAdvanceConfirm, setShowAutoAdvanceConfirm] = useState(false);
  const [legacyReviewerId, setLegacyReviewerId] = useState('');

  const { data: approvalStatus } = useQuery({
    queryKey: ['approval-status', taskId],
    queryFn: () => api.qualityGates.getApprovalStatus(taskId),
    enabled: !!taskId,
  });

  const qualityBlocked = approvalStatus && !approvalStatus.canBeApproved;
  const hasReviewers = reviewers.length > 0;
  const allApproved = hasReviewers && reviewProgress.approved === reviewProgress.total;

  async function handleApprove() {
    const reviewerId = hasReviewers ? (currentUserId ?? '') : legacyReviewerId.trim();
    if (!reviewerId) {
      notify.warning('Please enter a reviewer ID');
      return;
    }
    if (autoAdvance && !showAutoAdvanceConfirm) {
      setShowAutoAdvanceConfirm(true);
      return;
    }
    await onApprove(reviewerId);
  }

  async function handleReject() {
    const reviewerId = hasReviewers ? (currentUserId ?? '') : legacyReviewerId.trim();
    if (!reviewerId) {
      notify.warning('Please enter a reviewer ID');
      return;
    }
    if (!rejectReason.trim()) {
      notify.warning('Please provide a reason for rejection');
      return;
    }
    await onReject(reviewerId, rejectReason.trim());
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-700 dark:bg-amber-950 p-4">
      <h4 className="mb-3 font-semibold text-amber-900 dark:text-amber-200">Review Required</h4>

      {result && (
        <div className="mb-3 rounded bg-white dark:bg-card p-3 text-sm">
          <MarkdownContent content={result} className="text-gray-700 dark:text-gray-200" />
        </div>
      )}

      {artifacts.length > 0 && (
        <div className="mb-3">
          <p className="mb-1 text-xs font-semibold text-amber-800 dark:text-amber-300">Artifacts:</p>
          {artifacts.map((a, i) => (
            <a
              key={i}
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-sm text-blue-600 hover:underline dark:text-blue-400"
            >
              <Link2 className="h-3 w-3" />
              {a.description || a.type}
            </a>
          ))}
        </div>
      )}

      {qualityBlocked && (
        <div className="mb-3 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" />
            Breach gates not met
          </div>
          <ul className="mt-1 ml-6 list-disc">
            {approvalStatus?.reasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </div>
      )}

      {hasReviewers && !allApproved && (
        <div className="mb-3 space-y-3">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-amber-800 dark:text-amber-300">
                Review Progress
              </span>
              <span className="text-xs text-amber-700 dark:text-amber-400">
                {reviewProgress.approved}/{reviewProgress.total} approvals
              </span>
            </div>
            <div className="h-2 rounded-full bg-amber-200 dark:bg-amber-800 overflow-hidden">
              <div
                className="h-full rounded-full bg-green-500 transition-all duration-300"
                style={{ width: reviewProgress.total > 0 ? `${(reviewProgress.approved / reviewProgress.total) * 100}%` : '0%' }}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            {reviewers.map(reviewer => (
              <div
                key={reviewer.id}
                className={`flex items-center justify-between rounded px-3 py-2 text-sm ${
                  reviewer.reviewerId === currentUserId && reviewer.status === 'pending'
                    ? 'bg-amber-100 dark:bg-amber-900 ring-1 ring-amber-400 dark:ring-amber-600'
                    : 'bg-white dark:bg-card'
                }`}
              >
                <div className="flex items-center gap-2">
                  <ReviewerIcon type={reviewer.reviewerType} />
                  <span className="text-sm text-amber-900 dark:text-amber-100">
                    {getReviewerName(reviewer, agents)}
                  </span>
                  {reviewer.reviewerId === currentUserId && (
                    <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">(you)</span>
                  )}
                </div>
                <StatusBadge status={reviewer.status} />
              </div>
            ))}
          </div>

          {!currentUserIsReviewer && (
            <p className="text-xs text-amber-600 dark:text-amber-400 italic">
              You are not an assigned reviewer for this task.
            </p>
          )}
        </div>
      )}

      {allApproved && (
        <div className="mb-3 flex items-center gap-2 rounded border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-950">
          <ShieldCheck className="h-4 w-4 text-green-600 dark:text-green-400" />
          <span className="text-sm font-medium text-green-800 dark:text-green-200">All reviews complete</span>
        </div>
      )}

      {!hasReviewers && !allApproved && (
        <>
          <div className="mb-3 flex items-center gap-2 rounded border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900">
            <ShieldCheck className="h-4 w-4 text-gray-400" />
            <span className="text-xs text-gray-600 dark:text-gray-400">Review not enforced — no review rules matched this task</span>
          </div>
          <div className="mb-3">
            <label className="mb-1 block text-xs font-medium text-amber-800 dark:text-amber-300">
              Reviewer ID
            </label>
            <input
              type="text"
              value={legacyReviewerId}
              onChange={(e) => setLegacyReviewerId(e.target.value)}
              placeholder="Enter reviewer ID"
              className="w-full rounded border border-amber-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-100"
            />
          </div>
        </>
      )}

      {showReject && (currentUserIsReviewer || !hasReviewers) && (
        <div className="mb-3">
          <label className="mb-1 block text-xs font-medium text-amber-800 dark:text-amber-300">
            Rejection Reason
          </label>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="What needs to be fixed?"
            rows={3}
            className="w-full rounded border border-amber-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-100"
          />
        </div>
      )}

      {showAutoAdvanceConfirm && (currentUserIsReviewer || !hasReviewers) && (
        <div className="mb-3 rounded border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-950">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-blue-900 dark:text-blue-200">
            <ArrowRight className="h-4 w-4" />
            Task will auto-advance to {nextColumnName ?? 'next column'}
          </div>
          <p className="mb-2 text-xs text-blue-700 dark:text-blue-300">
            This task has auto-advance enabled. Approving will move it to the next column automatically.
          </p>
          <div className="flex gap-2">
            <Button
              variant="success"
              size="sm"
              onClick={() => onApprove(currentUserId ?? legacyReviewerId.trim())}
              loading={isSubmitting}
              disabled={isSubmitting}
            >
              Confirm Approve
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowAutoAdvanceConfirm(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {(currentUserIsReviewer || !hasReviewers) && !allApproved && !showAutoAdvanceConfirm && (
        <div className="flex gap-2">
          <Tooltip content={qualityBlocked ? 'Cannot approve: breach gates not met' : 'Accept this work and move forward'}>
            <Button
              variant="success"
              size="sm"
              onClick={handleApprove}
              loading={isSubmitting && !showReject}
              disabled={isSubmitting || !!qualityBlocked}
            >
              <CheckCircle className="h-4 w-4" />
              Approve
            </Button>
          </Tooltip>
          {!showReject ? (
            <Tooltip content="Request changes - task returns to agent with your feedback">
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setShowReject(true)}
                disabled={isSubmitting}
              >
                <XCircle className="h-4 w-4" />
                Reject
              </Button>
            </Tooltip>
          ) : (
            <>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleReject}
                loading={isSubmitting}
                disabled={isSubmitting}
              >
                Confirm Reject
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowReject(false);
                  setRejectReason('');
                }}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
