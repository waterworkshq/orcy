import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReviewPanel } from './ReviewPanel.js';
import type { TaskReviewer, Agent } from '../../types/index.js';

const mockOnApprove = vi.fn().mockResolvedValue(undefined);
const mockOnReject = vi.fn().mockResolvedValue(undefined);

const { mockGetApprovalStatus } = vi.hoisted(() => ({
  mockGetApprovalStatus: vi.fn().mockResolvedValue({ canBeApproved: true, reasons: [] }),
}));

vi.mock('../../api/index.js', () => ({
  api: {
    qualityGates: {
      getApprovalStatus: (...args: any[]) => mockGetApprovalStatus(...args),
    },
  },
}));

vi.mock('../../lib/toast.js', () => ({
  notify: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('lucide-react', () => ({
  CheckCircle: () => <span data-testid="icon-check">✓</span>,
  XCircle: () => <span data-testid="icon-x">✗</span>,
  Link2: () => <span data-testid="icon-link">🔗</span>,
  ArrowRight: () => <span data-testid="icon-arrow">→</span>,
  AlertTriangle: () => <span data-testid="icon-alert">⚠</span>,
  User: () => <span data-testid="icon-user">👤</span>,
  Bot: () => <span data-testid="icon-bot">🤖</span>,
  ShieldCheck: () => <span data-testid="icon-shield">🛡</span>,
}));

function makeReviewer(overrides: Partial<TaskReviewer> & { id: string; taskId: string }): TaskReviewer {
  return {
    reviewerType: 'human',
    reviewerId: 'user-1',
    status: 'pending',
    assignedAt: new Date().toISOString(),
    reviewedAt: null,
    reviewNote: null,
    ...overrides,
  };
}

function renderPanel(overrides: Record<string, unknown> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = {
    taskId: 'task-1',
    result: '',
    artifacts: [],
    autoAdvance: false,
    nextColumnName: undefined,
    onApprove: mockOnApprove,
    onReject: mockOnReject,
    isSubmitting: false,
    reviewers: [],
    currentUserId: undefined,
    currentUserIsReviewer: false,
    reviewProgress: { approved: 0, total: 0 },
    agents: [],
    ...overrides,
  };
  return render(
    <QueryClientProvider client={qc}>
      <ReviewPanel {...props} />
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ReviewPanel', () => {
  describe('Mode A: Assigned reviewers', () => {
    it('shows progress bar with correct fraction', () => {
      const reviewers = [
        makeReviewer({ id: 'r1', taskId: 'task-1', status: 'approved' }),
        makeReviewer({ id: 'r2', taskId: 'task-1', status: 'pending', reviewerId: 'user-2' }),
        makeReviewer({ id: 'r3', taskId: 'task-1', status: 'pending', reviewerId: 'user-3' }),
      ];
      renderPanel({
        reviewers,
        reviewProgress: { approved: 1, total: 3 },
        currentUserId: 'user-1',
        currentUserIsReviewer: false,
      });

      expect(screen.getByText('1/3 approvals')).toBeTruthy();
    });

    it('shows reviewer names and status badges', () => {
      const reviewers = [
        makeReviewer({ id: 'r1', taskId: 'task-1', status: 'approved', reviewerId: 'user-1' }),
        makeReviewer({ id: 'r2', taskId: 'task-1', status: 'pending', reviewerId: 'agent-abc', reviewerType: 'agent' }),
      ];
      const agents: Agent[] = [{ id: 'agent-abc', name: 'CodeBot' } as Agent];
      renderPanel({
        reviewers,
        reviewProgress: { approved: 1, total: 2 },
        currentUserId: 'user-1',
        currentUserIsReviewer: false,
        agents,
      });

      expect(screen.getByText('Human user')).toBeTruthy();
      expect(screen.getByText('CodeBot')).toBeTruthy();
      expect(screen.getByText('Approved')).toBeTruthy();
      expect(screen.getByText('Pending')).toBeTruthy();
    });

    it('shows "(you)" for current user reviewer', () => {
      const reviewers = [
        makeReviewer({ id: 'r1', taskId: 'task-1', status: 'pending', reviewerId: 'user-1' }),
      ];
      renderPanel({
        reviewers,
        reviewProgress: { approved: 0, total: 1 },
        currentUserId: 'user-1',
        currentUserIsReviewer: true,
      });

      expect(screen.getByText('(you)')).toBeTruthy();
    });

    it('shows approve/reject buttons when current user is reviewer', () => {
      const reviewers = [
        makeReviewer({ id: 'r1', taskId: 'task-1', status: 'pending', reviewerId: 'user-1' }),
      ];
      renderPanel({
        reviewers,
        reviewProgress: { approved: 0, total: 1 },
        currentUserId: 'user-1',
        currentUserIsReviewer: true,
      });

      expect(screen.getByText('Approve')).toBeTruthy();
      expect(screen.getByText('Reject')).toBeTruthy();
    });

    it('shows "not an assigned reviewer" when user is not assigned', () => {
      const reviewers = [
        makeReviewer({ id: 'r1', taskId: 'task-1', status: 'pending', reviewerId: 'user-2' }),
      ];
      renderPanel({
        reviewers,
        reviewProgress: { approved: 0, total: 1 },
        currentUserId: 'user-1',
        currentUserIsReviewer: false,
      });

      expect(screen.getByText(/not an assigned reviewer/i)).toBeTruthy();
      expect(screen.queryByText('Approve')).toBeNull();
    });
  });

  describe('Mode B: No reviewers (legacy)', () => {
    it('shows "review not enforced" banner', () => {
      renderPanel({ reviewers: [], reviewProgress: { approved: 0, total: 0 } });

      expect(screen.getByText(/review not enforced/i)).toBeTruthy();
    });

    it('shows freeform reviewer ID input', () => {
      renderPanel({ reviewers: [], reviewProgress: { approved: 0, total: 0 } });

      expect(screen.getByPlaceholderText('Enter reviewer ID')).toBeTruthy();
      expect(screen.getByText('Approve')).toBeTruthy();
    });

    it('calls onApprove with legacy reviewer ID', async () => {
      renderPanel({ reviewers: [], reviewProgress: { approved: 0, total: 0 } });

      const input = screen.getByPlaceholderText('Enter reviewer ID');
      await fireEvent.change(input, { target: { value: 'human-legacy' } });
      await fireEvent.click(screen.getByText('Approve'));

      expect(mockOnApprove).toHaveBeenCalledWith('human-legacy');
    });
  });

  describe('Mode C: All approved', () => {
    it('shows "all reviews complete" banner', () => {
      const reviewers = [
        makeReviewer({ id: 'r1', taskId: 'task-1', status: 'approved', reviewerId: 'user-1' }),
        makeReviewer({ id: 'r2', taskId: 'task-1', status: 'approved', reviewerId: 'user-2' }),
      ];
      renderPanel({
        reviewers,
        reviewProgress: { approved: 2, total: 2 },
        currentUserId: 'user-1',
        currentUserIsReviewer: false,
      });

      expect(screen.getByText('All reviews complete')).toBeTruthy();
      expect(screen.queryByText('Approve')).toBeNull();
    });
  });

  describe('Quality gate blocking', () => {
    it('shows quality gate warning when blocked', async () => {
      mockGetApprovalStatus.mockResolvedValueOnce({
        canBeApproved: false,
        reasons: ['Code coverage below threshold'],
      });
      const reviewers = [
        makeReviewer({ id: 'r1', taskId: 'task-1', status: 'pending', reviewerId: 'user-1' }),
      ];
      renderPanel({
        reviewers,
        reviewProgress: { approved: 0, total: 1 },
        currentUserId: 'user-1',
        currentUserIsReviewer: true,
      });

      await waitFor(() => {
        expect(screen.getByText('Breach gates not met')).toBeTruthy();
      });
    });
  });

  describe('Agent name resolution', () => {
    it('shows agent name from agents store', () => {
      const reviewers = [
        makeReviewer({ id: 'r1', taskId: 'task-1', status: 'pending', reviewerId: 'agent-xyz', reviewerType: 'agent' }),
      ];
      const agents: Agent[] = [
        { id: 'agent-xyz', name: 'ReviewBot', type: 'opencode', domain: 'backend', capabilities: [], status: 'idle', currentTaskId: null, apiKeyHash: 'x', rateLimitPerMinute: null, createdAt: '', lastHeartbeat: '', metadata: {} },
      ];
      renderPanel({
        reviewers,
        reviewProgress: { approved: 0, total: 1 },
        currentUserId: 'user-1',
        currentUserIsReviewer: false,
        agents,
      });

      expect(screen.getByText('ReviewBot')).toBeTruthy();
    });

    it('falls back to agent ID prefix when agent not in store', () => {
      const reviewers = [
        makeReviewer({ id: 'r1', taskId: 'task-1', status: 'pending', reviewerId: 'agent-unknown', reviewerType: 'agent' }),
      ];
      renderPanel({
        reviewers,
        reviewProgress: { approved: 0, total: 1 },
        currentUserId: 'user-1',
        currentUserIsReviewer: false,
        agents: [],
      });

      expect(screen.getByText('Agent agen')).toBeTruthy();
    });
  });
});
