import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../ui/Button.js';
import { Tooltip } from '../ui/Tooltip.js';
import { notify } from '../../lib/toast.js';
import { api } from '../../api/index.js';
import type { Artifact } from '../../types/index.js';
import { CheckCircle, XCircle, Link2, ArrowRight, AlertTriangle } from 'lucide-react';
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
}: ReviewPanelProps) {
  const [reviewerId, setReviewerId] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [showReject, setShowReject] = useState(false);
  const [showAutoAdvanceConfirm, setShowAutoAdvanceConfirm] = useState(false);

  const { data: approvalStatus } = useQuery({
    queryKey: ['approval-status', taskId],
    queryFn: () => api.qualityGates.getApprovalStatus(taskId),
    enabled: !!taskId,
  });

  const qualityBlocked = approvalStatus && !approvalStatus.canBeApproved;

  async function handleApprove() {
    if (!reviewerId.trim()) {
      notify.warning('Please enter a reviewer ID');
      return;
    }
    if (autoAdvance && !showAutoAdvanceConfirm) {
      setShowAutoAdvanceConfirm(true);
      return;
    }
    await onApprove(reviewerId.trim());
  }

  async function handleReject() {
    if (!reviewerId.trim()) {
      notify.warning('Please enter a reviewer ID');
      return;
    }
    if (!rejectReason.trim()) {
      notify.warning('Please provide a reason for rejection');
      return;
    }
    await onReject(reviewerId.trim(), rejectReason.trim());
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

      <div className="mb-3">
        <label className="mb-1 block text-xs font-medium text-amber-800 dark:text-amber-300">
          Reviewer ID
        </label>
        <input
          type="text"
          value={reviewerId}
          onChange={(e) => setReviewerId(e.target.value)}
          placeholder="Enter reviewer ID"
          className="w-full rounded border border-amber-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-100"
        />
      </div>

      {showReject && (
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

      {showAutoAdvanceConfirm && (
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
              onClick={() => onApprove(reviewerId.trim())}
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
    </div>
  );
}
