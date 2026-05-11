import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentReasoningTrace } from './AgentReasoningTrace.js';
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
    labels: [],
    ...overrides,
  };
}

const { mockCommentsList, mockBoardStore } = vi.hoisted(() => ({
  mockCommentsList: vi.fn(),
  mockBoardStore: vi.fn(),
}));

vi.mock('../../api/index.js', () => ({
  api: {
    comments: {
      list: (...args: any[]) => mockCommentsList(...args),
    },
  },
}));

vi.mock('../../store/habitatStore.js', () => ({
  useBoardStore: (selector: any) => selector(mockBoardStore()),
}));

vi.mock('lucide-react', () => ({
  Bot: () => <span data-testid="icon-bot">🤖</span>,
  CheckCircle: () => <span data-testid="icon-check-circle">✓</span>,
}));

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
  );
}

describe('AgentReasoningTrace', () => {
  afterEach(() => {
    cleanup();
    mockCommentsList.mockReset();
  });

  it('renders agent reasoning trace header', async () => {
    mockCommentsList.mockResolvedValue({ comments: [], total: 0 });
    mockBoardStore.mockReturnValue({ agents: [] });
    renderWithQuery(<AgentReasoningTrace tasks={[]} />);
    expect(screen.getByText('Agent Reasoning Trace')).toBeTruthy();
  });

  it('shows no agent reasoning message when no comments exist', async () => {
    mockCommentsList.mockResolvedValue({ comments: [], total: 0 });
    mockBoardStore.mockReturnValue({ agents: [] });
    renderWithQuery(<AgentReasoningTrace tasks={[]} />);
    await waitFor(() => {
      expect(screen.getByText('No agent reasoning yet')).toBeTruthy();
    });
  });

  it('displays agent comments with agent name', async () => {
    const tasks = [
      makeTask({ id: 'task-1', featureId: 'feat-1', title: 'Agent Task' }),
    ];
    mockBoardStore.mockReturnValue({
      agents: [{ id: 'agent-1', name: 'Alpha-1' }],
    });
    mockCommentsList.mockResolvedValue({
      comments: [
        {
          id: 'c1',
          taskId: 'task-1',
          parentId: null,
          authorType: 'agent',
          authorId: 'agent-1',
          content: 'Analyzing cache eviction pattern...',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      total: 1,
    });

    renderWithQuery(<AgentReasoningTrace tasks={tasks} />);

    await waitFor(() => {
      expect(screen.getByText('Alpha-1')).toBeTruthy();
      expect(screen.getByText('Analyzing cache eviction pattern...')).toBeTruthy();
    });
  });

  it('shows loading state', async () => {
    mockCommentsList.mockReturnValue(new Promise(() => {}));
    mockBoardStore.mockReturnValue({ agents: [] });
    const { container } = renderWithQuery(
      <AgentReasoningTrace tasks={[makeTask({ id: 'task-1', featureId: 'feat-1' })]} />
    );
    expect(container.querySelector('.animate-pulse')).toBeTruthy();
  });
});
