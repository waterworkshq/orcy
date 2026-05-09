import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CodeReviewSection } from './CodeReviewSection.js';
import type { Task } from '../../types/index.js';

function makeTask(overrides: Partial<Task> & { id: string; featureId: string }): Task {
  return {
    title: 'Test Task',
    description: '',
    priority: 'medium',
    assignedAgentId: null,
    delegatedToAgentId: null,
    requiredDomain: null,
    requiredCapabilities: [],
    status: 'pending',
    claimedAt: null,
    startedAt: null,
    submittedAt: null,
    completedAt: null,
    rejectedCount: 0,
    rejectionReason: null,
    result: null,
    artifacts: [],
    order: 0,
    createdBy: 'user-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    estimatedMinutes: null,
    actualMinutes: null,
    cycleTimeMinutes: null,
    leadTimeMinutes: null,
    estimationAccuracy: null,
    retryPolicy: null,
    retryCount: 0,
    nextRetryAt: null,
    ...overrides,
  };
}

const { mockCommentsList } = vi.hoisted(() => ({
  mockCommentsList: vi.fn(),
}));

vi.mock('../../api/index.js', () => ({
  api: {
    comments: {
      list: (...args: any[]) => mockCommentsList(...args),
    },
  },
}));

vi.mock('lucide-react', () => ({
  Code: () => <span data-testid="icon-code">&lt;/&gt;</span>,
  FileCode: () => <span data-testid="icon-file-code">📄</span>,
}));

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
  );
}

describe('CodeReviewSection', () => {
  afterEach(() => {
    cleanup();
    mockCommentsList.mockReset();
  });

  it('renders code review header', async () => {
    mockCommentsList.mockResolvedValue({ comments: [], total: 0 });
    renderWithQuery(<CodeReviewSection tasks={[]} />);
    expect(screen.getByText('Code Review')).toBeTruthy();
  });

  it('shows no reviews message when no comments exist', async () => {
    mockCommentsList.mockResolvedValue({ comments: [], total: 0 });
    renderWithQuery(<CodeReviewSection tasks={[]} />);
    await waitFor(() => {
      expect(screen.getByText('No review comments yet')).toBeTruthy();
    });
  });

  it('displays task review groups with comments', async () => {
    const tasks = [
      makeTask({ id: 'task-1', featureId: 'feat-1', title: 'Review Task' }),
    ];
    mockCommentsList.mockResolvedValue({
      comments: [
        {
          id: 'c1',
          taskId: 'task-1',
          parentId: null,
          authorType: 'human',
          authorId: 'user-1',
          content: 'Looks good!',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      total: 1,
    });

    renderWithQuery(<CodeReviewSection tasks={tasks} />);

    await waitFor(() => {
      expect(screen.getByText('Review Task')).toBeTruthy();
      expect(screen.getByText('Looks good!')).toBeTruthy();
      expect(screen.getByText('1 task with reviews')).toBeTruthy();
    });
  });

  it('shows loading state', async () => {
    mockCommentsList.mockReturnValue(new Promise(() => {}));
    const { container } = renderWithQuery(
      <CodeReviewSection tasks={[makeTask({ id: 'task-1', featureId: 'feat-1' })]} />
    );
    expect(container.querySelector('.animate-pulse')).toBeTruthy();
  });
});
