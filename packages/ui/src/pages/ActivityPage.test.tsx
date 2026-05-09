import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ActivityPage } from './ActivityPage.js';
import type { EnrichedBoardEvent, Anomaly } from '../types/index.js';

function makeEvent(overrides: Partial<EnrichedBoardEvent> & { id: string }): EnrichedBoardEvent {
  return {
    taskId: 'task-1',
    taskTitle: 'Test Task',
    boardId: 'board-1',
    actorType: 'agent',
    actorId: 'agent-1',
    actorName: 'Agent One',
    action: 'claimed',
    fromColumnId: null,
    toColumnId: 'col-2',
    fromColumnName: null,
    toColumnName: 'In Progress',
    fromStatus: null,
    toStatus: null,
    metadata: {},
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeAnomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    type: 'stale_task',
    severity: 'medium',
    message: 'Task has been stale for 2 hours',
    data: {},
    ...overrides,
  };
}

const mockBoardEvents = vi.fn();
const mockBoardAnomalies = vi.fn();
const mockOpenModal = vi.fn();

vi.mock('../api/index.js', () => ({
  api: {
    boards: {
      events: (...args: any[]) => mockBoardEvents(...args),
      anomalies: (...args: any[]) => mockBoardAnomalies(...args),
    },
  },
}));

vi.mock('../store/habitatStore.js', () => ({
  useBoardStore: (selector: any) =>
    selector({
      board: { id: 'board-1', name: 'Test Board' },
    }),
}));

vi.mock('../store/modalStore.js', () => ({
  useModalStore: (selector: any) =>
    selector({
      openModal: (...args: any[]) => mockOpenModal(...args),
    }),
}));

vi.mock('../components/ui/Button.js', () => ({
  Button: ({ children, onClick, disabled, ...props }: any) => (
    <button onClick={onClick} disabled={disabled} {...props}>
      {children}
    </button>
  ),
}));

vi.mock('lucide-react', () => ({
  ArrowLeft: () => <span data-testid="icon-arrow-left">←</span>,
  Activity: ({ className }: any) => (
    <span data-testid="icon-activity" className={className}>
      ⚡
    </span>
  ),
  Loader2: ({ className }: any) => (
    <span data-testid="icon-loader" className={className}>
      ⟳
    </span>
  ),
  CheckCircle: () => <span data-testid="icon-check">✓</span>,
  XCircle: () => <span data-testid="icon-x">✗</span>,
  User: () => <span data-testid="icon-user">👤</span>,
  Circle: () => <span data-testid="icon-circle">○</span>,
  Clock: () => <span data-testid="icon-clock">🕐</span>,
  AlertTriangle: ({ className }: any) => (
    <span data-testid="icon-alert" className={className}>
      ⚠
    </span>
  ),
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/activity']}>
      <Routes>
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/" element={<div>Home Page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('ActivityPage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2024-06-15T14:30:00Z'));
    mockBoardAnomalies.mockResolvedValue({ anomalies: [] });
    mockBoardEvents.mockResolvedValue({ events: [], total: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    mockBoardEvents.mockReset();
    mockBoardAnomalies.mockReset();
    mockOpenModal.mockReset();
  });

  it('renders page header with Activity title', async () => {
    renderPage();

    expect(screen.getByText('Activity')).toBeTruthy();
    expect(screen.getByText('Back')).toBeTruthy();
    expect(screen.getByTestId('icon-activity')).toBeTruthy();
  });

  it('shows loading state during fetch', async () => {
    mockBoardEvents.mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(screen.getByTestId('icon-loader')).toBeTruthy();
    expect(screen.getByText('Loading activity...')).toBeTruthy();
  });

  it('shows empty state when no events', async () => {
    mockBoardEvents.mockResolvedValue({ events: [], total: 0 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No activity yet')).toBeTruthy();
    });
    expect(screen.getByText('Events will appear here as work happens on the board.')).toBeTruthy();
  });

  it('shows error state when fetch fails', async () => {
    mockBoardEvents.mockRejectedValue(new Error('Network error'));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeTruthy();
    });
  });

  it('renders event feed with correct formatting', async () => {
    const events = [
      makeEvent({ id: 'e1', action: 'claimed', actorName: 'Agent One', taskTitle: 'Task A' }),
      makeEvent({ id: 'e2', action: 'approved', actorName: 'Human', taskTitle: 'Task B' }),
    ];
    mockBoardEvents.mockResolvedValue({ events, total: 2 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('event-row-e1')).toBeTruthy();
      expect(screen.getByTestId('event-row-e2')).toBeTruthy();
    });

    expect(screen.getByText('Agent One')).toBeTruthy();
    expect(screen.getByText('Human')).toBeTruthy();
    expect(screen.getByText('"Task A"')).toBeTruthy();
    expect(screen.getByText('"Task B"')).toBeTruthy();
  });

  it('shows relative timestamps for events', async () => {
    const fiveMinAgo = new Date('2024-06-15T14:25:00Z').toISOString();
    const events = [
      makeEvent({ id: 'e1', timestamp: fiveMinAgo }),
    ];
    mockBoardEvents.mockResolvedValue({ events, total: 1 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('5m ago')).toBeTruthy();
    });
  });

  it('shows column transition details', async () => {
    const events = [
      makeEvent({
        id: 'e1',
        action: 'moved',
        fromColumnName: 'Backlog',
        toColumnName: 'In Progress',
      }),
    ];
    mockBoardEvents.mockResolvedValue({ events, total: 1 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Backlog → In Progress')).toBeTruthy();
    });
  });

  it('filter tabs change active filter', async () => {
    mockBoardEvents.mockResolvedValue({ events: [], total: 0 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No activity yet')).toBeTruthy();
    });

    const claimsFilter = screen.getByTestId('filter-claims');
    fireEvent.click(claimsFilter);

    await waitFor(() => {
      expect(mockBoardEvents).toHaveBeenCalledWith('board-1', expect.objectContaining({ action: 'claimed' }));
    });
  });

  it('loads all filter tabs', async () => {
    mockBoardEvents.mockResolvedValue({ events: [], total: 0 });

    renderPage();

    expect(screen.getByTestId('filter-all')).toBeTruthy();
    expect(screen.getByTestId('filter-claims')).toBeTruthy();
    expect(screen.getByTestId('filter-submissions')).toBeTruthy();
    expect(screen.getByTestId('filter-approvals')).toBeTruthy();
    expect(screen.getByTestId('filter-rejections')).toBeTruthy();
  });

  it('Load more button fetches additional events', async () => {
    const firstBatch = Array.from({ length: 50 }, (_, i) =>
      makeEvent({ id: `e${i}`, taskTitle: `Task ${i}` })
    );
    mockBoardEvents.mockResolvedValue({ events: firstBatch, total: 100 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('load-more')).toBeTruthy();
    });

    const secondBatch = Array.from({ length: 50 }, (_, i) =>
      makeEvent({ id: `e${i + 50}`, taskTitle: `Task ${i + 50}` })
    );
    mockBoardEvents.mockResolvedValue({ events: secondBatch, total: 100 });

    fireEvent.click(screen.getByTestId('load-more'));

    await waitFor(() => {
      expect(mockBoardEvents).toHaveBeenCalledTimes(2);
      expect(mockBoardEvents).toHaveBeenLastCalledWith('board-1', expect.objectContaining({ offset: 50 }));
    });
  });

  it('hides load more when all events loaded', async () => {
    const events = [makeEvent({ id: 'e1' })];
    mockBoardEvents.mockResolvedValue({ events, total: 1 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('event-row-e1')).toBeTruthy();
    });

    expect(screen.queryByTestId('load-more')).toBeNull();
  });

  it('event click opens task modal', async () => {
    const events = [makeEvent({ id: 'e1', taskId: 'task-42', taskTitle: 'Click Me' })];
    mockBoardEvents.mockResolvedValue({ events, total: 1 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('"Click Me"')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('event-row-e1'));

    expect(mockOpenModal).toHaveBeenCalledWith('task-42');
  });

  it('task title click opens task modal', async () => {
    const events = [makeEvent({ id: 'e1', taskId: 'task-99', taskTitle: 'Title Click' })];
    mockBoardEvents.mockResolvedValue({ events, total: 1 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('"Title Click"')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('"Title Click"'));

    expect(mockOpenModal).toHaveBeenCalledWith('task-99');
  });

  it('anomaly alerts render when present', async () => {
    const anomalies = [
      makeAnomaly({ type: 'stale_task', severity: 'high', message: 'Task stuck for 4h' }),
      makeAnomaly({ type: 'high_rejection_rate', severity: 'critical', message: 'Rate > 50%' }),
    ];
    mockBoardAnomalies.mockResolvedValue({ anomalies });
    mockBoardEvents.mockResolvedValue({ events: [], total: 0 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Active Anomalies (2)')).toBeTruthy();
    });
    expect(screen.getByText('Task stuck for 4h')).toBeTruthy();
    expect(screen.getByText('Rate > 50%')).toBeTruthy();
    expect(screen.getByText('high')).toBeTruthy();
    expect(screen.getByText('critical')).toBeTruthy();
  });

  it('anomaly type labels are formatted with spaces', async () => {
    mockBoardAnomalies.mockResolvedValue({
      anomalies: [makeAnomaly({ type: 'high_rejection_rate' })],
    });
    mockBoardEvents.mockResolvedValue({ events: [], total: 0 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('high rejection rate')).toBeTruthy();
    });
  });

  it('Back button navigates to workspace', async () => {
    renderPage();

    const backLink = screen.getByText('Back').closest('a');
    expect(backLink?.getAttribute('href')).toBe('/');
  });

  it('shows total event count in header', async () => {
    const events = [makeEvent({ id: 'e1' }), makeEvent({ id: 'e2' })];
    mockBoardEvents.mockResolvedValue({ events, total: 42 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('42 events')).toBeTruthy();
    });
  });

  it('handles anomalies fetch failure gracefully', async () => {
    mockBoardAnomalies.mockRejectedValue(new Error('Anomaly fetch failed'));
    mockBoardEvents.mockResolvedValue({ events: [], total: 0 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No activity yet')).toBeTruthy();
    });
  });

  it('shows loading text on load more button while fetching', async () => {
    const firstBatch = Array.from({ length: 50 }, (_, i) =>
      makeEvent({ id: `e${i}` })
    );
    mockBoardEvents.mockResolvedValue({ events: firstBatch, total: 100 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('load-more')).toBeTruthy();
    });

    let resolveSecond: any;
    mockBoardEvents.mockReturnValue(new Promise((r) => { resolveSecond = r; }));

    fireEvent.click(screen.getByTestId('load-more'));

    expect(screen.getByText('Loading...')).toBeTruthy();

    resolveSecond({ events: [], total: 100 });
  });

  it('displays reason from metadata', async () => {
    const events = [
      makeEvent({
        id: 'e1',
        action: 'rejected',
        fromColumnName: null,
        toColumnName: null,
        metadata: { reason: 'Code quality issues' },
      }),
    ];
    mockBoardEvents.mockResolvedValue({ events, total: 1 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Code quality issues')).toBeTruthy();
    });
  });

  it('uses actor ID substring when no name and not human/system', async () => {
    const longId = 'abc123def456ghi789';
    const events = [
      makeEvent({
        id: 'e1',
        actorType: 'agent' as any,
        actorId: longId,
        actorName: null,
      }),
    ];
    mockBoardEvents.mockResolvedValue({ events, total: 1 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(longId.substring(0, 8))).toBeTruthy();
    });
  });

  it('shows "Human" label for human actors with no name', async () => {
    const events = [
      makeEvent({ id: 'e1', actorType: 'human', actorName: null }),
    ];
    mockBoardEvents.mockResolvedValue({ events, total: 1 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Human')).toBeTruthy();
    });
  });

  it('shows "System" label for system actors with no name', async () => {
    const events = [
      makeEvent({ id: 'e1', actorType: 'system', actorName: null }),
    ];
    mockBoardEvents.mockResolvedValue({ events, total: 1 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('System')).toBeTruthy();
    });
  });

  it('pagination maintains filter state on load more', async () => {
    const firstBatch = Array.from({ length: 50 }, (_, i) =>
      makeEvent({ id: `e${i}`, action: 'claimed' })
    );
    mockBoardEvents.mockResolvedValue({ events: firstBatch, total: 100 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('load-more')).toBeTruthy();
    });

    const secondBatch = Array.from({ length: 50 }, (_, i) =>
      makeEvent({ id: `e${i + 50}`, action: 'claimed' })
    );
    mockBoardEvents.mockResolvedValue({ events: secondBatch, total: 100 });

    fireEvent.click(screen.getByTestId('load-more'));

    await waitFor(() => {
      expect(mockBoardEvents).toHaveBeenLastCalledWith('board-1', expect.objectContaining({ offset: 50 }));
    });
  });

  it('filter change resets and refetches events', async () => {
    const events = [makeEvent({ id: 'e1', action: 'submitted' })];
    mockBoardEvents.mockResolvedValue({ events, total: 1 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('event-row-e1')).toBeTruthy();
    });

    const secondBatch = [makeEvent({ id: 'e2', action: 'approved' })];
    mockBoardEvents.mockResolvedValue({ events: secondBatch, total: 1 });

    fireEvent.click(screen.getByTestId('filter-approvals'));

    await waitFor(() => {
      expect(mockBoardEvents).toHaveBeenCalledWith('board-1', expect.objectContaining({ action: 'approved', offset: 0 }));
    });
  });

  it('renders multiple anomaly severities with correct styling', async () => {
    const anomalies = [
      makeAnomaly({ severity: 'low', message: 'Low issue' }),
      makeAnomaly({ severity: 'medium', message: 'Medium issue' }),
      makeAnomaly({ severity: 'high', message: 'High issue' }),
      makeAnomaly({ severity: 'critical', message: 'Critical issue' }),
    ];
    mockBoardAnomalies.mockResolvedValue({ anomalies });
    mockBoardEvents.mockResolvedValue({ events: [], total: 0 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Active Anomalies (4)')).toBeTruthy();
    });

    expect(screen.getByText('low')).toBeTruthy();
    expect(screen.getByText('medium')).toBeTruthy();
    expect(screen.getByText('high')).toBeTruthy();
    expect(screen.getByText('critical')).toBeTruthy();
  });

  it('does not render empty state when only anomalies exist', async () => {
    mockBoardAnomalies.mockResolvedValue({
      anomalies: [makeAnomaly()],
    });
    mockBoardEvents.mockResolvedValue({ events: [], total: 0 });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Active Anomalies (1)')).toBeTruthy();
    });

    expect(screen.queryByText('No activity yet')).toBeNull();
  });
});
